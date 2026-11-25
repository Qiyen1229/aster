/**
 * 中文一句話解析：帳戶與分類比對（純函式）
 * 從一句話裡找出提到的帳戶（完整名稱或去掉「銀行／卡」的簡稱）與分類。
 */
import { SYNONYMS } from './merchant-synonyms';

export interface NlpAccount { id: string; name: string; type?: string }
export interface NlpCategory { id: string; name: string; kind: 'expense' | 'income'; parentId: string }

const ACCOUNT_SUFFIX = /(銀行|帳戶|账户|戶頭|信用卡|金融卡|簽帳卡|卡片|卡|錢包|帳號)$/;
/** 多詞帳戶拆詞時略過過於通用的字眼，避免「Line Money」讓所有 LINE 通知都被誤判為該帳戶 */
const GENERIC_ACCOUNT_WORDS = new Set([
  'line', 'money', 'pay', 'bank', 'card', 'cash', 'wallet', 'account',
  'twd', 'usd', 'jpy', 'eur', 'hkd', 'cny', 'rmb', 'plus', 'pro', 'max',
]);

/** 台灣常見銀行／發卡品牌簡稱（僅在帳本存在對應非現金帳戶時啟用，讓「中信Line Pay卡」可對應「中國信託」） */
const BANK_ALIASES: [RegExp, string[]][] = [
  [/中國信託|ctbc/i, ['中信', 'ctbc']],
  [/國泰世華|國泰/i, ['國泰', 'cube']],
  [/玉山/i, ['玉山', 'unicard', 'pi卡']],
  [/台新/i, ['台新', 'richart', 'gogo', 'flygo']],
  [/台北富邦|富邦/i, ['富邦', 'j卡']],
  [/永豐/i, ['永豐', '大戶', 'dawho']],
  [/合作金庫|合庫/i, ['合庫']],
  [/彰化銀行|彰銀/i, ['彰銀']],
  [/第一銀行|一銀/i, ['一銀']],
  [/台灣銀行|臺灣銀行|台銀/i, ['台銀']],
  [/華南/i, ['華南']],
  [/兆豐/i, ['兆豐']],
  [/聯邦/i, ['聯邦', '吉鶴卡']],
  [/凱基/i, ['凱基']],
  [/元大/i, ['元大']],
  [/遠東/i, ['遠銀']],
  [/星展|dbs/i, ['星展', 'dbs']],
  [/滙豐|匯豐|hsbc/i, ['滙豐', '匯豐', 'hsbc']],
  [/渣打/i, ['渣打']],
  [/中華郵政|郵局/i, ['郵局', '郵政']],
];

/** 帳戶的比對詞：完整名稱、去掉「銀行／卡／帳戶」的簡稱、銀行常用別名（至少 2 個字） */
function accountTerms(a: NlpAccount): string[] {
  const n = a.name.trim();
  const short = n.replace(ACCOUNT_SUFFIX, '').trim();
  const terms = [n];
  if (short.length >= 2 && short !== n) terms.push(short);
  // 「台新 Richart」「國泰 CUBE 卡」：每個詞也可以單獨稱呼（排除過於通用的字眼）
  for (const w of short.split(/\s+/)) {
    if (w.length >= 2 && w !== short && !ACCOUNT_SUFFIX.test(w) && !GENERIC_ACCOUNT_WORDS.has(w.toLowerCase())) {
      terms.push(w);
    }
  }
  if (a.type !== 'cash') {
    for (const [re, aliases] of BANK_ALIASES) {
      if (re.test(n)) terms.push(...aliases);
    }
  }
  if (a.type === 'cash') terms.push('現金');
  return [...new Set(terms.map((x) => x.toLowerCase()))];
}

export interface AccountHit { id: string; index: number; term: string }

function findTermIndex(lower: string, term: string, from = 0): number {
  const slice = from > 0 ? lower.slice(from) : lower;
  if (/^[a-z0-9]+$/.test(term)) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).exec(slice);
    return m ? from + m.index : -1;
  }
  const idx = slice.indexOf(term);
  return idx >= 0 ? from + idx : -1;
}

const NON_ACCOUNT_FOLLOW = /^(?:醫院|三越|百貨|人壽|產險|高鐵|台鐵|大哥大|大車隊|啤酒|電力|房屋|建商|建設|兄弟|象|金控|證券|名|次|天|家|樓|街|路|店|館|市場)/;
const WALLET_CHANNEL_PREFIX = /(?:line\s*|街口|電子|行動|數位|虛擬|悠遊|全支付|apple\s*|google\s*)$/;

/** 依出現位置找出提到的帳戶（同一段文字只算最長的那個詞） */
export function findAccounts(text: string, accounts: NlpAccount[]): AccountHit[] {
  const lower = text.toLowerCase();
  const hits: AccountHit[] = [];
  for (const a of accounts) {
    const fullLower = a.name.trim().toLowerCase();
    for (const term of accountTerms(a)) {
      let from = 0;
      while (from < lower.length) {
        const i = findTermIndex(lower, term, from);
        if (i < 0) break;
        if (term !== fullLower && a.type !== 'cash' && NON_ACCOUNT_FOLLOW.test(lower.slice(i + term.length, i + term.length + 4))) {
          from = i + term.length;
          continue;
        }
        // 避免「LINE錢包」「街口錢包」「電子錢包」等支付通道名稱中的「錢包」被誤認為現金「錢包」帳戶
        if (term === '錢包' && WALLET_CHANNEL_PREFIX.test(lower.slice(Math.max(0, i - 8), i))) {
          from = i + term.length;
          continue;
        }
        hits.push({ id: a.id, index: i, term });
        break;
      }
    }
  }
  // 「信用卡」這種泛稱：只有一張信用卡時才對應
  const credits = accounts.filter((a) => a.type === 'credit');
  if (credits.length === 1 && /信用卡|刷卡/.test(text) && !hits.some((h) => h.id === credits[0].id)) {
    hits.push({ id: credits[0].id, index: text.search(/信用卡|刷卡/), term: '' });
  }
  hits.sort((a, b) => a.index - b.index || b.term.length - a.term.length);
  const out: AccountHit[] = [];
  for (const h of hits) {
    const prev = out[out.length - 1];
    if (out.some((o) => o.id === h.id)) continue;
    if (prev && h.index < prev.index + prev.term.length) continue; // 被較長的詞涵蓋
    out.push(h);
  }
  return out;
}

/**
 * 常見說法 → 分類名稱。使用者的分類可以自己改，所以只在「真的有這個名稱的分類」時才採用，不會憑空捏造。
 * generic：說的就是分類本身（「手搖飲」「晚餐」），認出來後從備註拿掉；
 * 其他是具體的東西或店名（「珍奶」「Uber」「星巴克」），只用來判斷分類，仍然留在備註。
 */
export interface CategoryMatch {
  category: NlpCategory;
  /** 文字裡認出分類的那個詞 */
  term: string;
  /** true：這個詞就是在說分類本身，備註不需要再寫一次 */
  generic: boolean;
}

/**
 * 找出文字提到的分類。
 * 1. 分類名稱本身（「早餐」「晚餐」「計程車」）；「其他」不算
 * 2. 常見說法（「手搖飲」→ 飲料、「小黃」→ 計程車）；只在使用者真的有這個名稱的分類時才採用
 * 取最長的詞；一樣長時優先子分類，再優先先出現的。
 */
const NOISE_PREFIX = /(?:免|零|無|減免|折抵|帳號|帳戶|紅利|點數|系統|後台|風險)$/;
const NOISE_SUFFIX = /^(?:優惠|減免|折抵|通知|提醒|系統|功能|設定|說明|條款|公告|活動|規範|辦法|標準)/;
const isBoilerplateMatch = (lower: string, index: number, len: number) => {
  if (NOISE_PREFIX.test(lower.slice(Math.max(0, index - 4), index)) || NOISE_SUFFIX.test(lower.slice(index + len, index + len + 4))) return true;
  // 「全家」後接「人／吃／聚／出／一起／福」代表家庭而非全家便利商店
  if (lower.slice(index, index + len) === '全家' && /^(?:人|福|一起|大小|吃|出|去|都|聚)/.test(lower.slice(index + len, index + len + 2))) return true;
  return false;
};

export function matchCategory(text: string, cats: NlpCategory[], kind?: 'expense' | 'income'): CategoryMatch | undefined {
  const lower = text.toLowerCase();
  const cands: (CategoryMatch & { index: number })[] = [];
  const sub = (c: NlpCategory) => (c.parentId ? 1 : 0);
  const byName = (names: string[], k: 'expense' | 'income') => {
    for (const n of names) {
      const hits = cats.filter((c) => c.name === n && c.kind === k).sort((a, b) => sub(b) - sub(a));
      if (hits[0]) return hits[0];
    }
    return undefined;
  };
  for (const c of cats) {
    if (c.name === '其他' || c.name.length < 2 || (kind && c.kind !== kind)) continue;
    const i = lower.indexOf(c.name.toLowerCase());
    if (i >= 0 && !isBoilerplateMatch(lower, i, c.name.length)) cands.push({ category: c, term: c.name, generic: true, index: i });
  }
  for (const syn of SYNONYMS) {
    if (kind && syn.kind !== kind) continue;
    const target = byName(syn.names, syn.kind);
    if (!target) continue;
    for (const [list, generic] of [[syn.generic, true], [syn.specific ?? [], false]] as const) {
      for (const w of list) {
        const i = findTermIndex(lower, w.toLowerCase());
        if (i >= 0 && !isBoilerplateMatch(lower, i, w.length)) cands.push({ category: target, term: text.slice(i, i + w.length), generic, index: i });
      }
    }
  }
  cands.sort((a, b) => (b.generic ? 1 : 0) - (a.generic ? 1 : 0) || b.term.length - a.term.length || sub(b.category) - sub(a.category) || a.index - b.index);
  const best = cands[0];
  return best && { category: best.category, term: best.term, generic: best.generic };
}

/** 分類名稱出現在文字中：取最長的名稱（「其他」不算） */
export function findCategory(text: string, cats: NlpCategory[], kind?: 'expense' | 'income'): NlpCategory | undefined {
  return matchCategory(text, cats, kind)?.category;
}

