/**
 * 自動記帳收件匣（App 端）。
 *
 * 流程：iPhone 捷徑（Apple Pay 交易、銀行簡訊、Siri 一句話）→ POST /api/hook/inbox（捷徑專用權杖）
 * → 伺服器暫存 → App 開啟時取回、解析成帳目草稿 → 使用者確認（或開啟「自動入帳」）→ 記帳並從伺服器刪除。
 *
 * - 入帳成功後才清除通知；固定來源 ID 與本機收據讓失敗重試不重複扣款
 * - 帳戶：學到的卡片對應 → 文字裡的帳戶名稱 → 規則／商家記憶 → 收件匣預設帳戶 → 上次使用的帳戶
 * - 暫存在伺服器上的內容沒有端對端加密（捷徑沒有你的加密密碼）；處理後立即刪除，30 天未處理自動清除
 */
import { Capacitor } from '@capacitor/core';
import { Browser } from '@capacitor/browser';
import { api, getApiOrigin } from './api';
import { useInboxCount } from './inboxCount';
import { extractDate, findAccounts, findAmounts, matchCategory, parseEntries, shortDate, toHalfWidth, type DraftEntry } from '@/domain/nlp';
import { findDuplicate, type DupCandidate } from '@/domain/dedupe';
import { formatMoney, toMinor } from '@/domain/money';
import { addDays, toDateKey, todayKey } from '@/domain/period';
import { db } from '@/db/schema';
import { useSettings } from '@/stores/settings';
import { notifyUser } from './notify';
import { AUTH_ENABLED, useAuth } from '@/stores/auth';
import { suggestAccount, learnImplicitMapping } from './autocat';
import { bookDrafts, fallbackAccount, parseContext, resolveDraft, type ResolvedDraft } from './quickentry';

export interface InboxRaw {
  id: number;
  source: 'auto' | 'voice' | 'applepay' | 'notify' | 'sms' | 'siri' | 'clipboard' | 'share' | 'quick' | 'email' | 'other';
  text: string;
  amount: string;
  merchant: string;
  card: string;
  occurred: string;
  created_at: string;
}

/** 這則可能和已有的帳目、或收件匣裡的另一則是同一次消費 */
export interface InboxDup {
  /** strong：同一天且商家相近或同帳戶；weak：只有金額相同、日期相差 1 天內 */
  level: 'strong' | 'weak';
  /** ledger：已經記在帳本裡；inbox：收件匣裡另一則（例如 Apple Pay 與簡訊通知同一筆付款） */
  from: 'ledger' | 'inbox';
  txId?: string;
  inboxId?: number;
  /** 顯示用：「今天 全聯 $120」「Apple Pay 那筆」 */
  label: string;
  /** 僅供顯示的重複提示，不據此自動合併或刪除 */
  certain?: boolean;
}

export interface InboxEntry {
  item: InboxRaw;
  /** 解析出的帳目（Siri 一句話可能有多筆）；空陣列代表看不懂金額，需要手動記 */
  drafts: ResolvedDraft[];
  dup?: InboxDup;
  /** 來源不夠可信（例如 LINE 聊天訊息裡剛好有金額）：只留在收件匣等你確認，絕不自動入帳 */
  review?: string;
}

/** LINE 裡視為「官方帳號」的發送者：只有這些名稱出現在訊息裡、且像交易通知，才當作消費通知 */
export const LINE_OFFICIAL_SENDERS = [
  'LINE Pay', 'LINE錢包', 'LINE 錢包', 'LINE Bank', '街口', '悠遊付', '悠遊卡', '一卡通', 'iPASS', 'icash', '全支付', '歐付寶',
  '國泰世華', '國泰', '中國信託', '中信', '玉山', '台新', 'Richart', '富邦', '永豐', '聯邦', '兆豐', '第一銀行', '華南',
  '合作金庫', '合庫', '彰化銀行', '彰銀', '凱基', '元大', '新光', '星展', '樂天', '渣打', '滙豐', '匯豐', '王道', '陽信', '遠東商銀', '郵局', '台灣Pay', '台灣 Pay',
];
const TXN_WORDS = /消費|刷卡|扣款|付款成功|支付成功|交易成功|交易通知|授權|繳費成功|入帳|轉帳|退款|退刷|代扣|存款/;
/** 官方通知通常有【標題】、稱呼「您／貴客」，或銀行制式欄位（入帳時間／後四碼／新臺幣金額） */
const OFFICIAL_STYLE = /[【[][^】\]]{1,20}[】\]]|您|貴|(?:通知|明細|帳號|卡號|末四碼|後四碼|時間|金額)\s*[:：]|(?:新[台臺]幣|NT\$)\s*[\d,]+/;

/** 這則通知是不是來自 LINE 聊天（而不是 LINE Pay、LINE Bank 這類支付 App） */
export function isLineChat(card: string): boolean {
  const app = card.split('\n').map((s) => s.trim()).filter(Boolean).pop() ?? '';
  return /^line$/i.test(app) || (/\bLINE\b/i.test(app) && !/pay|bank|錢包|購物/i.test(app));
}

/** 是否為純支付轉發渠道（LINE錢包 / LINE Pay / Apple Pay / Google Pay / Samsung Pay 等），背後可能綁多張卡，不該綁死或誤認現金錢包 */
export function isPaymentRelayCard(card: string): boolean {
  const app = card.split('\n').map((s) => s.trim()).filter(Boolean).pop() ?? '';
  return /^(?:line\s*(?:錢包|pay)|apple\s*pay|google\s*pay|samsung\s*pay)$/i.test(app);
}

function parseLineSenderAndBody(text: string): { sender: string; body: string } | null {
  const norm = text.normalize('NFKC');
  const lines = norm.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return null;
  if (lines.length >= 2) {
    const colon = lines[0].match(/^([^:：]{1,30})[:：]\s*(.+)$/);
    return {
      sender: (colon ? colon[1] : lines[0]).trim().toLowerCase(),
      body: colon ? `${colon[2]}\n${lines.slice(1).join('\n')}` : lines.slice(1).join('\n'),
    };
  }
  const colon = lines[0].match(/^([^:：]{1,30})[:：]\s*(.+)$/);
  if (!colon) return null;
  return { sender: colon[1].trim().toLowerCase(), body: colon[2] };
}

function isOfficialLineSender(sender: string): boolean {
  return LINE_OFFICIAL_SENDERS.some((n) => sender === n.normalize('NFKC').toLowerCase());
}

/** LINE 訊息是否為重點官方帳號的交易通知（支援多行與單行「發送者：內容」，發送者名稱＋交易字眼＋官方格式三者缺一不可） */
export function isTrustedLineNotice(text: string): boolean {
  const parsed = parseLineSenderAndBody(text);
  if (!parsed) return false;
  return isOfficialLineSender(parsed.sender) && TXN_WORDS.test(parsed.body) && OFFICIAL_STYLE.test(parsed.body);
}

/** 官方帳號的交易動作摘要通知（例如 LINE 卡片在 iOS 只顯示「中國信託：你有一筆入帳」，沒有金額） */
export function isOfficialLineActionNotice(text: string): boolean {
  const parsed = parseLineSenderAndBody(text);
  if (!parsed) return false;
  return isOfficialLineSender(parsed.sender) && TXN_WORDS.test(parsed.body);
}

export type NoticeVerdict = { trust: 'ok' } | { trust: 'review'; reason: string } | { trust: 'drop' };

function matchesList(it: Pick<InboxRaw, 'text' | 'merchant'> & { card?: string }, list: string[]): boolean {
  if (!list.length) return false;
  const hay = `${it.card ?? ''}\n${it.merchant ?? ''}\n${it.text ?? ''}`.normalize('NFKC').toLowerCase();
  return list.some((w) => {
    const n = w.trim().normalize('NFKC').toLowerCase();
    return n.length > 0 && hay.includes(n);
  });
}

export function matchesWhitelist(it: Pick<InboxRaw, 'text' | 'merchant'> & { card?: string }, whitelist: string[]): boolean {
  const names = (it.card ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (isLineChat(it.card ?? '')) {
    const lines = it.text.normalize('NFKC').split('\n').map((s) => s.trim()).filter(Boolean);
    names.length = 0;
    if (lines.length > 1) {
      const colon = lines[0].match(/^([^:：]{1,30})[:：]/);
      names.push(colon ? colon[1].trim() : lines[0]);
    } else if (lines.length === 1) {
      const colon = lines[0].match(/^([^:：]{1,30})[:：]/);
      if (colon) names.push(colon[1].trim());
    }
  }
  return names.some((name) => {
    const normName = name.normalize('NFKC').toLowerCase();
    return whitelist.some((w) => {
      const nw = w.trim().normalize('NFKC').toLowerCase();
      if (!nw) return false;
      return normName === nw || (nw.length >= 2 && normName.startsWith(nw));
    });
  });
}

/** 抓取收件匣通知前 4 個字作為白／黑名單自動相符標準（優先來源／LINE 發送者，其次商家／摘要／內文） */
export function inboxPrefix4(it: Pick<InboxRaw, 'text' | 'merchant'> & { card?: string }, draftNote?: string): string {
  let raw = '';
  if (isLineChat(it.card ?? '')) {
    const first = (it.text ?? '').normalize('NFKC').split('\n').map((s) => s.trim()).find(Boolean) ?? '';
    const colon = first.match(/^([^:：]{1,30})[:：]/);
    raw = colon ? colon[1].trim() : first;
  } else {
    raw = (it.card || it.merchant || draftNote || it.text || '').trim();
  }
  const cleaned = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return Array.from(cleaned).slice(0, 4).join('').trim();
}

/** 黑名單比對：發送者／商家／通知內容任一命中即自動略過並清除 */
export function matchesBlacklist(it: Pick<InboxRaw, 'text' | 'merchant'> & { card?: string }, blacklist: string[]): boolean {
  return matchesList(it, blacklist);
}

/**
 * 通知來源把關：黑名單最優先直接丟棄；銀行／支付 App 的通知放行；LINE 聊天只放行重點官方帳號與使用者自訂的白名單。
 * 不是官方的 LINE 訊息：看不出金額的直接丟掉（聊天雜訊）；剛好有金額的留在收件匣等確認，不自動入帳。
 */
export function judgeNotice(it: Pick<InboxRaw, 'source' | 'card' | 'text' | 'merchant'>, hasDrafts: boolean, whitelist: string[] = [], blacklist: string[] = []): NoticeVerdict {
  if (matchesBlacklist(it, blacklist)) return { trust: 'drop' };
  if (matchesWhitelist(it, whitelist)) return { trust: 'ok' };
  if (it.source !== 'notify' || !isLineChat(it.card ?? '')) return { trust: 'ok' };
  if (isTrustedLineNotice(it.text ?? '')) return { trust: 'ok' };
  if (!hasDrafts && isOfficialLineActionNotice(it.text ?? '')) {
    return { trust: 'review', reason: '官方帳號通知未含金額（例如 LINE 卡片只顯示「你有一筆入帳」），請點「手動記」補填金額' };
  }
  return hasDrafts ? { trust: 'review', reason: '這是 LINE 聊天訊息（不是官方帳號的消費通知），確認真的是消費再記' } : { trust: 'drop' };
}

export interface InboxToken { id: number; name: string; hint: string; created_at: string; last_used_at: string | null; use_count?: number }

export const SOURCE_LABEL: Record<InboxRaw['source'], { icon: string; label: string }> = {
  auto: { icon: '⚡', label: '自動' },
  voice: { icon: '🎙', label: '隨手記' },
  notify: { icon: '🔔', label: '通知' },
  applepay: { icon: '💳', label: 'Apple Pay' },
  sms: { icon: '💬', label: '簡訊' },
  siri: { icon: '🎙', label: 'Siri' },
  clipboard: { icon: '📋', label: '剪貼簿' },
  share: { icon: '📤', label: '分享' },
  quick: { icon: '⚡', label: '快速記帳' },
  email: { icon: '✉️', label: 'Email' },
  other: { icon: '📥', label: '捷徑' },
};

/** 首頁提示用的待確認數 */
export { useInboxCount };

export const hookUrl = () => `${getApiOrigin() || location.origin}/api/hook/inbox`;

/** 預先做好、簽署過的捷徑（scripts/make-shortcuts.py 產生 public/shortcuts/aster-<key>.shortcut）；name＝匯入後的捷徑名稱 */
export const SHORTCUTS = [
  { key: 'auto', name: 'Aster 自動記帳', icon: '⚡', title: '銀行 App／LINE Pay／街口／Apple Pay 自動記帳', automation: '通知與錢包', icloud: 'd965a9d8a48642aea3bb847b6525cdaa', hint: '最推薦：刷實體卡、網購、LINE Pay、街口、Apple Pay 跳通知自動記（加入後需至「自動化」勾選銀行與 LINE）' },
  { key: 'voice', name: 'Aster 隨手記', icon: '🎙', title: '對 Siri 說一句話記帳 ＋ 分享選單記帳', automation: null, icloud: 'c9f38f3363294443918b040e21156d46', hint: '先說「嘿 Siri，Aster 隨手記」，等 Siri 問「要記什麼？」再說花費；也可綁定動作按鈕／背面輕點，或在任何 App 分享文字記帳' },
] as const;

type ShortcutDef = (typeof SHORTCUTS)[number];
export const shortcutFileUrl = (s: ShortcutDef) => `/shortcuts/aster-${s.key}.shortcut`;

/**
 * 加入捷徑：直接開 iCloud 分享連結（https://www.icloud.com/shortcuts/<id>），iOS 會用通用連結交給「捷徑」App，跳出「加入捷徑」。
 * 六個捷徑都是通用範本（不含你的連結碼或權杖；連結碼是匯入時才貼上的），所以全部使用者共用同一組 iCloud 連結。
 * 不要用 `shortcuts://import-shortcut?url=<iCloud 連結>`：那個網址要的是「.shortcut 檔案網址」，給 iCloud 網頁連結會顯示「檔案的格式不正確」；
 * 給自架的檔案網址則是「提供的捷徑 URL 無效」。檔案版（`shortcutFileUrl`）只留作備用下載。
 * 捷徑內容更新時：用 scripts/make-shortcuts.py 重做 → 匯入 Mac「捷徑」App → 分享 →「拷貝 iCloud 連結」→ 換掉這裡的 `icloud` 識別碼。
 */
export const shortcutIcloudUrl = (s: ShortcutDef) => `https://www.icloud.com/shortcuts/${s.icloud}`;

export function openShortcutImport(s: ShortcutDef): void {
  const url = shortcutIcloudUrl(s);
  if (Capacitor.isNativePlatform()) {
    void Browser.open({ url });
    return;
  }
  location.href = url;
}

/** 連結碼＝網址＋?t=權杖：捷徑匯入時只要貼上這一串。存在這台裝置（依使用者區分），之後加其他捷徑可重用 */
export const linkCode = (token: string) => `${hookUrl()}?t=${token}`;
const linkKey = () => `clure.inbox.link.${useAuth.getState().user?.id ?? 0}`;

export function savedLink(): { id: number; code: string } | null {
  try {
    const v = JSON.parse(localStorage.getItem(linkKey()) ?? 'null') as { id: number; code: string } | null;
    return v && typeof v.code === 'string' ? v : null;
  } catch { return null; }
}

export function forgetLink() {
  try { localStorage.removeItem(linkKey()); } catch { /* 私密瀏覽 */ }
}

/**
 * 這台裝置的名稱（已連結的裝置清單用）。網頁拿不到 iPhone 的確切型號（iOS 不提供），所以用螢幕尺寸推算：
 * 「iPhone 6.9 吋」「iPad」「Android（SM-S918B）」「Mac」。
 */
export function deviceLabel(nav: Pick<Navigator, 'userAgent'> = navigator, scr: { width: number; height: number } = screen): string {
  const ua = nav.userAgent;
  if (/iPhone/.test(ua)) {
    const w = Math.min(scr.width, scr.height), h = Math.max(scr.width, scr.height);
    const inch: Record<string, string> = { '440x956': '6.9', '430x932': '6.7', '428x926': '6.7', '414x896': '6.1／6.5', '412x915': '6.7', '402x874': '6.3', '393x852': '6.1', '390x844': '6.1', '375x812': '5.4／5.8', '375x667': '4.7', '320x568': '4' };
    const s = inch[`${w}x${h}`];
    return s ? `iPhone ${s} 吋` : 'iPhone';
  }
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1)) return 'iPad';
  const android = ua.match(/Android[^;]*;\s*([^;)]+?)(?:\s+Build|\)|;)/);
  if (android) return `Android（${android[1].trim()}）`;
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  return '這台裝置';
}

/** 取得這台裝置的連結碼；沒有就建立一組以裝置名稱命名的權杖 */
export async function ensureLink(): Promise<{ id: number; code: string; created?: InboxToken }> {
  const saved = savedLink();
  if (saved) return saved;
  const r = await createToken(deviceLabel());
  const link = { id: r.item.id, code: linkCode(r.token) };
  try { localStorage.setItem(linkKey(), JSON.stringify(link)); } catch { /* 私密瀏覽：這次仍可用 */ }
  return { ...link, created: r.item };
}

export const listTokens = () => api<InboxToken[]>('/inbox/tokens');
export const createToken = (name: string) => api<{ token: string; item: InboxToken }>('/inbox/tokens', { method: 'POST', body: { name } });
export const revokeToken = (id: number) => api(`/inbox/tokens/${id}`, { method: 'DELETE' });

export async function fetchInbox(): Promise<InboxRaw[]> {
  const list = await api<InboxRaw[]>('/inbox/items');
  useInboxCount.getState().set(list.length);
  return list;
}

/** 從伺服器移除；回傳實際移除的 id（別台裝置已處理的不會出現） */
export async function ackInbox(ids: number[]): Promise<number[]> {
  if (!ids.length) return [];
  const r = await api<{ ids: number[] }>('/inbox/items/ack', { method: 'POST', body: { ids } });
  invalidateInboxReadOnly();
  const s = useInboxCount.getState();
  s.set(Math.max(0, s.n - r.ids.length));
  return r.ids;
}

/** 通知／簡訊／Email 裡的商店名稱：「商店:全聯」「特店名稱：Uber」「於 全家 消費」「在 7-ELEVEN 付款」 */
export function noticeMerchant(text: string): string {
  const s = toHalfWidth(text);
  const prefixMatch = s.match(/(?:商店|特店|商家|店家|消費地點|交易商店|交易店家|商戶|門市)(?:名稱)?\s*[:：]\s*([^\n,，。;；)）]+)/);
  if (prefixMatch) {
    let m = prefixMatch[1].trim();
    m = m.replace(/\s*(?:NT\$|NTD|TWD|\$|金額|消費|\d{1,2}\/\d{1,2}).*$/i, '').trim();
    if (m) return m;
  }
  const m = s.match(/(?:商店|特店|商家|店家|消費地點|交易商店|交易店家|商戶|門市)\s*[:：]?\s*([^\s\n,，。;；)）]+)/)
    ?? s.match(/(?:於|在)\s*([^\n,，。;；()（）]{2,25}?)\s*(?:消費|刷卡|交易|付款|扣款|支付|成功)/);
  return m?.[1]?.trim() ?? '';
}

/** 捷徑傳來的交易時間：2026/10/28 12:30、2026年10月28日、ISO、英文日期；看不懂就用收到的時間 */
export function itemDate(it: Pick<InboxRaw, 'occurred' | 'created_at'>, today = todayKey()): string {
  if (it.occurred) {
    const d = extractDate(it.occurred, today).date;
    if (d) return d;
    const t = new Date(it.occurred);
    if (!Number.isNaN(t.getTime())) return toDateKey(t);
  }
  // 伺服器時間是 UTC（沒有時區字尾）
  const c = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(it.created_at) ? it.created_at : `${it.created_at}Z`);
  return Number.isNaN(c.getTime()) ? today : toDateKey(c);
}

type Ctx = Awaited<ReturnType<typeof parseContext>>;

/** 卡片名稱 → 帳戶：學過的對應優先，其次是名稱比對（「玉山 Pi 卡」→ 玉山銀行）；LINE 聊天與支付轉發渠道（LINE錢包／LINE Pay 等）不綁死卡片對應 */
export function cardAccount(card: string, ctx: Ctx, cardMap: Record<string, string>): string | undefined {
  if (!card || isLineChat(card)) return undefined;
  if (isPaymentRelayCard(card)) {
    const app = card.split('\n').map((s) => s.trim()).filter(Boolean).pop() ?? '';
    return ctx.accounts.find((a) => a.name.trim().toLowerCase() === app.toLowerCase())?.id;
  }
  const learned = cardMap[card];
  if (learned && ctx.accounts.some((a) => a.id === learned)) return learned;
  return findAccounts(card, ctx.accounts)[0]?.id;
}

/**
 * 多金額／點數折抵／雙幣別的規則優先抽取：
 * 1. 先抓明確的「實付／實際付款／折抵後／扣點後」金額
 * 2. 若同時出現外幣與「約／折合新台幣 X 元」，優先取台幣實付金額
 * 3. 若有多個金額或外幣卻沒有明確實付字眼，標記 ambiguous=true 交由 AI 結構化抽取
 */
export function extractPreferredNoticeAmount(text: string): { amount?: number; currency?: string; ambiguous: boolean } {
  const norm = toHalfWidth(text.normalize('NFKC'));
  const netMatch = norm.match(/(?:實付|實際付款|實際扣款|實際支付|折抵後|扣點後|應付金額)\s*[:：]?\s*(?:NT\$|NTD|TWD|新[台臺]幣|\$)?\s*([\d,]+(?:\.\d+)?)/i);
  if (netMatch) {
    const val = Number(netMatch[1].replace(/,/g, ''));
    if (val > 0) return { amount: val, currency: 'TWD', ambiguous: false };
  }
  const hasFx = /\b(?:USD|JPY|EUR|HKD|KRW|GBP|SGD|CNY|RMB)\b/i.test(norm);
  if (hasFx) {
    const twdMatch = norm.match(/(?:約|折合|換算|計)\s*(?:NT\$|NTD|TWD|(?:新)?[台臺]幣)\s*([\d,]+(?:\.\d+)?)/i);
    if (twdMatch) {
      const val = Number(twdMatch[1].replace(/,/g, ''));
      if (val > 0) return { amount: val, currency: 'TWD', ambiguous: false };
    }
    return { ambiguous: true };
  }
  const hasDiscountWords = /折抵|點數|紅利|折扣|抵用|coupon|點/i.test(norm);
  const nums = norm.match(/\d+(?:,\d{3})*(?:\.\d+)?/g) ?? [];
  if (hasDiscountWords && nums.length >= 2) return { ambiguous: true };
  return { ambiguous: false };
}

function matchAccountByLast4(text: string, accounts: { id: string; name: string; last4?: string; archived?: number; deletedAt?: number }[], excludeId?: string) {
  const norm = toHalfWidth(text.normalize('NFKC'));
  for (const m of norm.matchAll(/(?:帳號|帳戶|尾數|末碼|後四碼|末四碼|轉出至|轉入)\s*[:：]?\s*[*＊Xx]*(\d{4,5})|[*＊Xx]+(\d{4,5})/g)) {
    const digits = m[1] || m[2];
    if (!digits) continue;
    const hit = accounts.find((a) => !a.archived && !a.deletedAt && a.id !== excludeId && (
      (a.last4 && (a.last4 === digits || digits.endsWith(a.last4) || a.last4.endsWith(digits)))
      || a.name.includes(digits)
    ));
    if (hit) return hit;
  }
  return undefined;
}

function detectTopologyTransfer(
  text: string,
  accounts: { id: string; name: string; type: string; last4?: string; archived?: number; deletedAt?: number; credit?: { autoPayAccountId?: string } }[],
  sourceAccId?: string,
): { fromId?: string; toId: string } | null {
  const live = accounts.filter((a) => !a.archived && !a.deletedAt);
  // 1. 自動加值／儲值：銀行／信用卡 → 儲值卡／電子票證
  if (/(?:悠遊卡|一卡通|icash|愛金卡|電子票證)?自動加值|自動儲值|儲值成功/i.test(text) && !/儲值金不足/.test(text)) {
    const stored = live.find((a) => (a.type === 'stored' || a.type === 'epay') && /悠遊|一卡通|icash|愛金/i.test(a.name) && text.includes(a.name.slice(0, 2)))
      ?? live.find((a) => a.type === 'stored');
    if (stored && stored.id !== sourceAccId) return { fromId: sourceAccId, toId: stored.id };
  }
  // 2. 扣繳卡費／繳信用卡費：銀行 → 信用卡
  if (/(?:扣繳|繳納|自動扣款|代扣).{0,10}(?:卡費|信用卡)|信用卡.{0,8}(?:繳款|扣繳|入帳)成功/i.test(text)) {
    const card = live.find((a) => a.type === 'credit' && (text.includes(a.name) || a.credit?.autoPayAccountId === sourceAccId))
      ?? live.find((a) => a.type === 'credit');
    if (card && card.id !== sourceAccId) {
      const bankId = sourceAccId && live.find((a) => a.id === sourceAccId)?.type !== 'credit'
        ? sourceAccId
        : card.credit?.autoPayAccountId ?? live.find((a) => a.type === 'bank')?.id;
      if (bankId && bankId !== card.id) return { fromId: bankId, toId: card.id };
    }
  }
  // 3. 轉出至自己其他帳號末四碼
  if (/轉出|匯出|轉帳/.test(text)) {
    const dest = matchAccountByLast4(text, live, sourceAccId);
    if (dest) return { fromId: sourceAccId, toId: dest.id };
  }
  return null;
}

/** 把一則收件匣項目解析成帳目草稿 */
export async function draftsFromItem(it: InboxRaw, ctx: Ctx, fallback: string): Promise<ResolvedDraft[]> {
  const { cardMap, defaultAccountId } = useSettings.getState().inbox;
  const date = itemDate(it, ctx.today);
  const base = defaultAccountId && ctx.accounts.some((a) => a.id === defaultAccountId) ? defaultAccountId : fallback;
  const byCard = cardAccount(it.card, ctx, cardMap);
  let drafts: DraftEntry[];
  if (it.amount) {
    // Apple Pay：金額、商家、卡片都是分開的欄位
    const hit = findAmounts(it.amount)[0] ?? findAmounts(`${it.amount}元`)[0];
    if (!hit) return [];
    const text = [it.merchant, it.text].filter(Boolean).join(' ');
    const parsed = parseEntries(`${text} ${it.amount}`, { ...ctx, today: date });
    const inferred = parsed.find((d) => d.amount === Math.abs(hit.value)) ?? parsed[0];
    const refund = /退款|退貨|refund/i.test(`${it.text} ${it.amount}`.replace(/(?:退款|退貨)(?:須知|說明|規定|辦法|政策)/g, '')) || hit.value < 0;
    drafts = [{
      ...inferred, kind: refund ? 'income' : inferred?.kind ?? 'expense', amount: Math.abs(hit.value), currency: hit.currency ?? inferred?.currency, date, dateGiven: true,
      note: it.merchant || inferred?.note || it.text, raw: text,
    }];
  } else {
    drafts = parseEntries(it.text, { ...ctx, today: date });
    if (!drafts.length) return [];
    // 通知／簡訊／Email：多個金額時優先取真實交易金額（避開餘額、額度、手續費），並保留轉出／拓樸轉帳優先於入帳
    if (it.source === 'notify' || it.source === 'sms' || it.source === 'email') {
      const merchant = it.merchant || noticeMerchant(it.text);
      const isBalanceOrFee = (d: DraftEntry) => /(?:餘額|結餘|可用額度|信用額度|手續費|(?:帳號|卡號)?(?:後|末)四碼)/.test(d.raw);
      const prefAmt = extractPreferredNoticeAmount(it.text);
      const primary = drafts.find((d) => !isBalanceOrFee(d) && d.amount > 0)
        ?? drafts.find((d) => d.amount > 0)
        ?? drafts[0];
      const chosenAmount = prefAmt.amount ?? primary.amount;
      const chosenCurrency = prefAmt.currency ?? primary.currency;
      // 排除「回饋將於次月入帳」「退款須知」等行銷／說明文字，避免把消費通知誤判為收入
      const strippedForIncome = it.text
        .replace(/(?:點數|回饋|紅利|LINE\s*POINTS)[^。\n]{0,16}入帳/gi, '')
        .replace(/(?:退款|退貨)(?:須知|說明|規定|辦法|政策)/g, '');
      // 優先排除出金語意（「您的轉帳已入帳至對方帳戶」「轉出」「扣款」「自動加值」）避免被「入帳」字眼反判為收入
      const isOutflow = /轉出|匯出|扣款|扣繳|自動加值|儲值|提款|提領|刷卡|消費|付款|已入帳至對方|入帳至對方|轉入他行/.test(strippedForIncome);
      const isExplicitIncome = /退款|退貨|退刷|跨行轉入|薪資|薪水|發薪/.test(strippedForIncome)
        || (!isOutflow && (/入帳|進帳|存入|轉入/.test(strippedForIncome) || primary.kind === 'income'));
      const fallbackNote = primary.note
        .replace(/【[^】]{1,24}】/g, ' ')
        .replace(/(?:消費|刷卡|交易|付款|扣款|支付)通知\s*[:：]?/g, ' ')
        .replace(/(?:實際款項|交易明細).*$/g, ' ')
        .replace(/(?:入帳|交易)時間\s*[:：]?.{0,24}/g, ' ')
        .replace(/(?:入帳)?(?:帳號|卡號)?(?:後|末)四碼\s*[:：]?\s*\d*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40);
      const topo = detectTopologyTransfer(it.text, ctx.accounts, byCard ?? primary.accountId);
      const resolvedKind = (primary.kind === 'transfer' && primary.toAccountId) || topo
        ? 'transfer'
        : isExplicitIncome
          ? 'income'
          : 'expense';
      drafts = [{
        ...primary,
        amount: chosenAmount,
        currency: chosenCurrency,
        note: merchant || fallbackNote,
        kind: resolvedKind,
        ...(topo ? { accountId: topo.fromId ?? primary.accountId, toAccountId: topo.toId } : {}),
      }];
    }
  }
  const out: ResolvedDraft[] = [];
  const isNotice = it.source === 'notify' || it.source === 'sms' || it.source === 'email';
  for (const d of drafts) {
    let targetAcc: string | undefined;
    if (it.source === 'notify') {
      // 若文字中提到非 App 本身的銀行／信用卡帳戶（例如 LINE錢包 通知提及「中信Line Pay卡」→ 中國信託），優先以非現金銀行卡入帳
      const textAccs = findAccounts(it.text, ctx.accounts);
      const nonAppAccs = textAccs.filter((a) => {
        const accObj = ctx.accounts.find((acc) => acc.id === a.id);
        return accObj && accObj.name.toLowerCase() !== (it.card || '').toLowerCase();
      });
      const bankAcc = nonAppAccs.find((a) => ctx.accounts.find((acc) => acc.id === a.id)?.type !== 'cash') ?? nonAppAccs[0];
      targetAcc = bankAcc?.id ?? byCard ?? d.accountId;
    } else {
      targetAcc = byCard ?? d.accountId;
    }
    const cleanMerchant = (it.merchant || d.note || '').trim();
    const matchText = [d.note, it.merchant, it.text].filter(Boolean).join('\n');
    const memoryText = cleanMerchant || d.note;
    // 通知／簡訊／Email 容易夾帶銀行公告或行銷字眼（如「免管理費」、「帳單管理」），分類只採信乾淨商家／備註，不讓內文雜訊劫持
    const dKind = d.kind === 'income' ? 'income' : 'expense';
    const cleanCategoryId = isNotice && d.kind !== 'transfer'
      ? (cleanMerchant ? matchCategory(cleanMerchant, ctx.categories, dKind)?.category.id : undefined)
      : d.categoryId;
    // 使用者在自動分類規則明確「指定帳戶」時，優先於通知文字／卡片推測
    const ruleAcc = d.kind !== 'transfer' && matchText
      ? await suggestAccount(matchText, dKind, d.amount, memoryText).catch(() => undefined)
      : undefined;
    const explicitRuleAcc = ruleAcc?.source === 'rule' && ctx.accounts.some((a) => a.id === ruleAcc.accountId) ? ruleAcc.accountId : undefined;
    const preferredAcc = explicitRuleAcc ?? targetAcc;
    const r = await resolveDraft({ ...d, categoryId: cleanCategoryId, accountId: preferredAcc }, base, matchText, memoryText);
    out.push(
      explicitRuleAcc
        ? { ...r, accountId: explicitRuleAcc, accountSource: 'rule', ruleIds: [...new Set([...(r.ruleIds ?? []), ...(ruleAcc?.ruleId ? [ruleAcc.ruleId] : [])])] }
        : targetAcc
          ? { ...r, accountId: targetAcc, accountSource: 'text' }
          : r,
    );
  }
  return out;
}

/**
 * 標出可能重複的項目：先和收件匣裡較早的一則比（Apple Pay 與銀行簡訊常常通知同一筆付款），
 * 再和帳本裡前後一天的帳目比（電子發票載具、手動記帳）。只標記，不刪除。
 * 一則只標一個最像的；只處理「一則一筆」的項目（Siri 多筆的不比對）。
 */
export async function markDuplicates(entries: InboxEntry[], today = todayKey()): Promise<void> {
  for (const e of entries) delete e.dup;
  const single = entries.filter((e) => e.drafts.length === 1 && e.drafts[0].kind !== 'transfer');
  if (!single.length) return;
  const accounts = new Map((await db.accounts.toArray()).map((a) => [a.id, a]));
  const probeOf = (e: InboxEntry) => {
    const d = e.drafts[0];
    const cur = d.currency ?? accounts.get(d.accountId)?.currency ?? 'TWD';
    return { cur, p: { date: d.date, amountMinor: toMinor(d.amount, cur), currency: cur, accountId: d.accountId, text: `${e.item.merchant} ${d.note}` } };
  };
  const ordered = [...single].sort((a, b) => a.item.id - b.item.id);
  const dates = ordered.map((e) => e.drafts[0].date).sort();
  const rows = await db.transactions.where('date').between(addDays(dates[0], -1), addDays(dates[dates.length - 1], 1), true, true)
    .filter((t) => !t.deletedAt && !t.categoryId.startsWith('sys-') && (t.type === 'expense' || t.type === 'income')).toArray();
  const ledger = new Map(rows.map((t) => [t.id, t]));
  const ledgerCands = (kind: string): DupCandidate[] => rows.filter((t) => t.type === kind)
    .map((t) => ({ id: t.id, date: t.date, amountMinor: t.amountMinor, currency: t.currency, accountId: t.accountId, text: `${t.merchant ?? ''} ${t.note}` }));
  const exp = ledgerCands('expense');
  const inc = ledgerCands('income');

  for (let i = 0; i < ordered.length; i++) {
    const e = ordered[i];
    const { cur, p } = probeOf(e);
    // 收件匣內：較早的、來源不同的另一則
    const earlier = ordered.slice(0, i).filter((o) => o.drafts[0].kind === e.drafts[0].kind).map((o) => {
      const q = probeOf(o);
      return { id: String(o.item.id), ...q.p };
    });
    const inboxHit = findDuplicate(p, earlier);
    if (inboxHit) {
      const other = ordered.find((o) => String(o.item.id) === inboxHit.id)!;
      e.dup = {
        level: inboxHit.level, from: 'inbox', inboxId: other.item.id,
        label: `${SOURCE_LABEL[other.item.source]?.label ?? '另一則'} 那筆`,
      };
      continue;
    }
    const hit = findDuplicate(p, e.drafts[0].kind === 'income' ? inc : exp);
    if (hit) {
      const t = ledger.get(hit.id)!;
      e.dup = { level: hit.level, from: 'ledger', txId: t.id, label: `${shortDate(t.date, today)} ${t.merchant || t.note || '已記的帳'} ${formatMoney(t.amountMinor, cur)}` };
    }
  }
}

export async function loadInbox(): Promise<InboxEntry[]> {
  const [items, ctx, fallback] = await Promise.all([fetchInbox(), parseContext(), fallbackAccount()]);
  const out: InboxEntry[] = [];
  const dropped: InboxEntry[] = [];
  const { whitelist = [], blacklist = [] } = useSettings.getState().inbox;
  for (const item of items) {
    const drafts = await draftsFromItem(item, ctx, fallback).catch(() => []);
    const v = judgeNotice(item, drafts.length > 0, whitelist, blacklist);
    if (v.trust === 'drop') { dropped.push({ item, drafts: [], review: '已忽略，但通知尚未清除，請重新整理或略過' }); continue; }
    out.push({ item, drafts, ...(v.trust === 'review' ? { review: v.reason } : {}) });
  }
  if (dropped.length) {
    try { await ackInbox(dropped.map((e) => e.item.id)); }
    catch { out.push(...dropped); }
  }
  await markDuplicates(out, ctx.today).catch(() => undefined);
  return out;
}

/**
 * 給操作助手預覽用的收件匣：和 loadInbox 一樣解析、標重複，但「唯讀」——
 * 不認領刪除任何項目（包括 LINE 雜訊），因為預覽不該改動伺服器狀態；真的執行時才走 bookInboxEntries／ackInbox。
 * 短時間內重複呼叫（同一份計畫反覆預覽）用快取，避免一直打伺服器。
 */
let roCache: { at: number; dbName: string; policy: string; entries: InboxEntry[] } | null = null;
export async function loadInboxReadOnly(): Promise<InboxEntry[]> {
  if (!AUTH_ENABLED) return [];
  const policy = JSON.stringify(useSettings.getState().inbox);
  if (roCache && roCache.dbName === db.name && roCache.policy === policy && Date.now() - roCache.at < 30_000) return structuredClone(roCache.entries);
  const [items, ctx, fallback] = await Promise.all([fetchInbox(), parseContext(), fallbackAccount()]);
  const out: InboxEntry[] = [];
  for (const item of items) {
    const drafts = await draftsFromItem(item, ctx, fallback).catch(() => []);
    const cfg = useSettings.getState().inbox;
    const v = judgeNotice(item, drafts.length > 0, cfg.whitelist ?? [], cfg.blacklist ?? []);
    if (v.trust === 'drop') continue;
    out.push({ item, drafts, ...(v.trust === 'review' ? { review: v.reason } : {}) });
  }
  await markDuplicates(out, ctx.today).catch(() => undefined);
  roCache = { at: Date.now(), dbName: db.name, policy, entries: structuredClone(out) };
  return out;
}
/** 執行過收件匣操作後清掉唯讀快取，下次預覽重新抓 */
export function invalidateInboxReadOnly(): void { roCache = null; }

/** 「合併」：這則其實是已經記過的那筆，進行多訊源拼圖補全（補商家、卡別或明細進備註），然後從收件匣移除 */
export async function mergeDuplicate(e: InboxEntry): Promise<boolean> {
  const id = e.dup?.from === 'ledger' ? e.dup.txId : e.dup?.inboxId ? `inbox-${e.dup.inboxId}-0` : undefined;
  const t = id ? await db.transactions.get(id) : undefined;
  if (!t || t.deletedAt) throw new Error('請先將被比對的那筆通知入帳，再確認合併');
  const merchant = (e.item.merchant || e.drafts[0]?.note || '').trim();
  const patch: Partial<typeof t> = {};
  if (merchant && (!t.merchant || /^(?:ECPAY|NEWEBPAY|LINEPAY|APPLE\.COM)/i.test(t.merchant))) {
    patch.merchant = merchant.slice(0, 60);
  }
  const extraParts: string[] = [];
  if (merchant && (!t.note || !t.note.includes(merchant))) extraParts.push(merchant);
  if (e.item.card && !isLineChat(e.item.card) && (!t.note || !t.note.includes(e.item.card))) extraParts.push(e.item.card);
  if (extraParts.length) {
    const joined = extraParts.join(' · ');
    patch.note = (t.note ? `${t.note} · ${joined}` : joined).slice(0, 200);
  }
  if (Object.keys(patch).length) {
    patch.updatedAt = Date.now();
    await db.transactions.update(t.id, patch);
  }
  await ackInbox([e.item.id]);
  learnCard(e.item.card, t.accountId);
  invalidateInboxReadOnly();
  return true;
}

/** 記住「這張卡 → 這個帳戶」（使用者已設定過的對應不會被自動覆蓋；LINE 聊天與支付轉發渠道不學習） */
export function learnCard(card: string | undefined, accountId: string | undefined, opts: { overwrite?: boolean } = {}) {
  if (!card || !accountId) return;
  if (!opts.overwrite && (isLineChat(card) || isPaymentRelayCard(card))) return;
  const s = useSettings.getState();
  const existing = s.inbox.cardMap[card];
  if (existing && !opts.overwrite) return;
  if (existing === accountId) return;
  s.set('inbox', { ...s.inbox, cardMap: { ...s.inbox.cardMap, [card]: accountId } });
}

/** 一次記下多則；先寫入本機資料庫，入帳成功後才向伺服器認領刪除（避免入帳中途失敗導致伺服器資料永久遺失）。skipDuplicates：很可能重複的留在收件匣等你確認 */
export async function bookInboxEntries(entries: InboxEntry[], opts: { skipDuplicates?: boolean; travelProjectId?: string } = {}) {
  const txIds: string[] = [], transferIds: string[] = [];
  const bookedItemIds: number[] = [], clearedItemIds: number[] = [], failedItemIds: number[] = [];
  let alreadyBooked = 0;
  for (const e of entries) {
    if (bookedItemIds.includes(e.item.id)) continue;
    try {
      const sourceId = `inbox-${e.item.id}`;
      const receipt = await db.meta.get(`booked:${sourceId}`);
      const existing = receipt || await db.transactions.get(`${sourceId}-0`) || await db.transfers.get(`${sourceId}-0`);
      const cfg = useSettings.getState().inbox;
      if (!existing && (matchesBlacklist(e.item, cfg.blacklist ?? []) || !e.drafts.length || (opts.skipDuplicates && (e.dup?.level === 'strong' || e.review)))) continue;
      const res = existing ? { txIds: [], transferIds: [] } : await bookDrafts(e.drafts, { sourceId, travelProjectId: opts.travelProjectId });
      txIds.push(...res.txIds);
      transferIds.push(...res.transferIds);
      if (!res.txIds.length && !res.transferIds.length) alreadyBooked++;
      bookedItemIds.push(e.item.id);
      const first = e.drafts[0];
      if (first && first.accountSource !== 'default' && !(e.item.source === 'notify' && (isLineChat(e.item.card) || isPaymentRelayCard(e.item.card)))) learnCard(e.item.card, first.accountId);
    } catch (err) {
      failedItemIds.push(e.item.id);
      console.warn(`[inbox] 入帳失敗，保留於收件匣：item ${e.item.id}`, err);
    }
  }
  if (bookedItemIds.length) {
    try {
      await ackInbox(bookedItemIds);
      clearedItemIds.push(...bookedItemIds);
    } catch (err) {
      console.warn('[inbox] 帳目已儲存，收件匣清除待重試', err);
    }
  }
  invalidateInboxReadOnly();
  return {
    count: txIds.length + transferIds.length, skipped: failedItemIds.length, failedItemIds, alreadyBooked,
    ackPending: bookedItemIds.length - clearedItemIds.length, clearedItemIds, txIds, transferIds,
  };
}

/** 在記帳面板手動記好後呼叫：從收件匣移除、學習卡片，並隱式學習商家別名與分類規則 */
export async function finishInboxItem(id: string, opts: {
  card?: string;
  accountId?: string;
  rawKeyword?: string;
  note?: string;
  categoryId?: string;
  kind?: 'expense' | 'income';
}) {
  await ackInbox([Number(id)]);
  learnCard(opts.card, opts.accountId);
  if (opts.rawKeyword && (opts.note || opts.categoryId)) {
    await learnImplicitMapping({
      rawKeyword: opts.rawKeyword,
      note: opts.note,
      categoryId: opts.categoryId,
      kind: opts.kind,
      accountId: opts.accountId,
    }).catch(() => undefined);
  }
}

/** 規則試跑預覽：輸入測試通知文字，回傳會被黑名單擋掉、或自動記成的名稱／分類／帳戶 */
export async function previewAutoBook(text: string, card = '', merchant = '', opts: { source?: InboxRaw['source']; amount?: string } = {}): Promise<{
  verdict: NoticeVerdict;
  whitelisted: boolean;
  drafts: ResolvedDraft[];
  dup?: InboxDup;
}> {
  const [ctx, fallback] = await Promise.all([parseContext(), fallbackAccount()]);
  const fake: InboxRaw = { id: 0, source: opts.source ?? 'notify', text, amount: opts.amount ?? '', merchant, card, occurred: '', created_at: new Date().toISOString() };
  const cfg = useSettings.getState().inbox;
  const wl = cfg.whitelist ?? [];
  const bl = cfg.blacklist ?? [];
  const drafts = await draftsFromItem(fake, ctx, fallback);
  const entry: InboxEntry = { item: fake, drafts };
  await markDuplicates([entry]);
  return {
    dup: entry.dup,
    verdict: judgeNotice(fake, drafts.length > 0, wl, bl),
    whitelisted: matchesWhitelist(fake, wl),
    drafts,
  };
}

/**
 * 特殊情況 AI 救援：當規則、商家記憶與關鍵字都無法判斷（例如沒見過的商店名、或完全看不懂金額）且使用者有開啟 AI 時，
 * 才交給 AI 協助解析／補分類，單次最多處理 5 筆避免過度消耗額度；失敗靜默退回原本規則結果。
 */
async function enrichAmbiguousInboxWithAi(entries: InboxEntry[]): Promise<void> {
  const ai = await import('./ai').catch(() => null);
  if (!ai?.aiEnabledLocally()) return;
  const targets = entries.filter((e) =>
    !e.drafts.length
    || extractPreferredNoticeAmount(e.item.text).ambiguous
    || e.drafts.some((d) => d.kind !== 'transfer' && d.categorySource === 'default' && (d.categoryId === 'exp-other_exp' || d.categoryId === 'inc-other_inc')),
  ).slice(0, 8);
  if (!targets.length) return;
  const fallback = await fallbackAccount();
  for (const e of targets) {
    const raw = (e.item.merchant ? `${e.item.merchant} ${e.item.text}` : e.item.text).trim();
    if (!raw) continue;
    try {
      const { drafts } = await ai.aiParseText(raw);
      if (!drafts.length) continue;
      if (!e.drafts.length) {
        e.drafts = await Promise.all(drafts.map((d) => resolveDraft(d, fallback, raw, e.item.merchant || d.note)));
      } else {
        for (let i = 0; i < e.drafts.length; i++) {
          const cur = e.drafts[i];
          const aiHit = drafts[i] ?? drafts[0];
          if (cur.categorySource === 'default' && aiHit?.categoryId && aiHit.categoryId !== 'exp-other_exp' && aiHit.categoryId !== 'inc-other_inc') {
            e.drafts[i] = { ...cur, categoryId: aiHit.categoryId, categorySource: 'text' };
          }
        }
      }
    } catch { /* AI 失敗或超額時保留規則結果，不阻斷自動入帳 */ }
  }
}

/** 開啟 App 時：開啟「自動入帳」就直接記下看得懂的項目；白名單發送者即使沒開全域自動入帳也直接記；其餘留在收件匣 */
export async function processInboxOnStartup(): Promise<{ booked: number; pending: number; merged: number } | null> {
  if (!AUTH_ENABLED) return null;
  const entries = await loadInbox();
  if (!entries.length) return { booked: 0, pending: 0, merged: 0 };
  const st = useSettings.getState().inbox;
  const wl = st.whitelist ?? [];
  const auto = (e: InboxEntry) => st.autoBook || matchesWhitelist(e.item, wl);
  if (!entries.some(auto)) return { booked: 0, pending: entries.length, merged: 0 };
  const autoReady = entries.filter((e) => auto(e) && !e.review);
  await enrichAmbiguousInboxWithAi(autoReady);
  await markDuplicates(entries);
  const r = await bookInboxEntries(autoReady, { skipDuplicates: true });
  const pending = entries.filter((e) => !r.clearedItemIds.includes(e.item.id)).length;
  useInboxCount.getState().set(pending);
  return { booked: r.count, pending, merged: 0 };
}

/** 下拉刷新／回到前景：和開啟 App 一樣處理收件匣（自動入帳、合併重複），有入帳就提示 */
export async function refreshInbox(): Promise<void> {
  const r = await processInboxOnStartup();
  if (r?.booked || r?.merged) notifyUser({ text: `收件匣：自動記下 ${r.booked} 筆${r.merged ? `、合併 ${r.merged} 筆重複通知` : ''}${r.pending ? `，${r.pending} 筆待確認` : ''}` });
}
