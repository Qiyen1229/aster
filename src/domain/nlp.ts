/**
 * 中文一句話解析（純函式）：一句話／語音記帳、收件匣（簡訊、Siri）與「用問的查帳」共用。
 * - 金額：1,234、1.5、NT$120、一百五、兩千三、5萬2、1.5萬、3k；避開 7-11、85度C、2杯、3號 這類非金額數字
 * - 日期：今天／昨天／前天／大前天、3 天前、上週五、週三、10/25、10月25日、25號（未來的日期往前推一年／一個月）
 * - 一句話多筆：「早餐 60 午餐 120」拆成兩筆；只出現一次的日期與帳戶套用到每一筆
 */

import { addDays, fromDateKey, toDateKey, type DateKey } from './period';
import { CURRENCY_WORDS, detectCurrency, findAmounts, toHalfWidth, type AmountHit } from './nlp-amount';
import { extractClock, extractDate } from './nlp-date';
import { findAccounts, matchCategory, type CategoryMatch, type NlpAccount, type NlpCategory } from './nlp-entities';

// 舊的匯入路徑（@/domain/nlp）維持可用：數字、金額、日期、帳戶／分類的函式都從這裡轉出
export * from './nlp-amount';
export * from './nlp-date';
export * from './nlp-entities';

// ───────────── 一句話記帳 ─────────────

export type EntryKind = 'expense' | 'income' | 'transfer';

export interface DraftEntry {
  kind: EntryKind;
  amount: number;
  currency?: string;
  date: DateKey;
  /** 有沒有在文字中寫到日期（沒寫就是今天） */
  dateGiven: boolean;
  /** 文字中寫到的時間（HH:MM）；排程提醒用，沒寫就沒有 */
  time?: string;
  accountId?: string;
  toAccountId?: string;
  categoryId?: string;
  installmentPeriods?: number;
  note: string;
  raw: string;
}

export interface ParseContext {
  today: DateKey;
  accounts: NlpAccount[];
  categories: NlpCategory[];
}

const INCOME_RE = /薪水|薪資|月薪|領薪|發薪|收入|進帳|入帳|收到|領到|拿到|賺了|賺到|獎金|年終|收紅包|紅包收入|退款|退費|退稅|退刷|退貨|刷退|折讓|利息|股利|中獎|報帳|還我|還錢給我/;
// 「轉5000到錢包」「轉 3000 入 零用金」「轉5000玉山到中國信託」也算轉帳
const TRANSFER_RE = /轉帳|轉到|轉入|轉進|轉給|轉\s*[\d０-９,.]+\s*(?:元|塊|圓)?\s*[^到入進至給。\n]{0,12}?(?:到|入|進|至|給)|存到|存入|存進|提款|提領|領錢|領現/;
const CASH_OUT_RE = /提款|提領|領錢|領現/;
/** 備註裡不需要保留的贅字 */
const FILLER_RE = /(花了|花掉|總共|一共|大概|付了|付款|消費了?|買了|用掉|共計|金額|元整|全部都是|都是|全部|都用|都刷|都付|皆為|各自|統一|一起|我|了)/g;
const VERB_BEFORE_ACCOUNT = /(用|刷|拿|以|從|由|透過|轉到|轉入|轉進|轉給|存到|存入|存進|付|全部都是|都是|都用|都刷|都付)\s*$/;
/** 逗號後面接三位數字是千分位（1,234），不是分隔 */
const SEPARATORS = /,(?!\d{3}(?:\D|$))|[，、;；。\n]|還有|然後|另外|以及/;

interface Segment { text: string; amount?: AmountHit }

/** 依金額把文字切成多筆：每個金額結束一筆，金額後面的文字併到最後一筆；緊接在金額後的帳戶（「早餐60刷玉山」）保留在該筆 */
function segment(text: string, accounts?: NlpAccount[]): Segment[] {
  const chunks = text.split(SEPARATORS).map((x) => x.trim()).filter(Boolean);
  const out: Segment[] = [];
  const orphans: string[] = [];
  for (const chunk of chunks) {
    const amounts = findAmounts(chunk);
    if (!amounts.length) {
      // 沒有金額的片段（「昨天」「都刷玉山卡」）：先接在前一筆，等一下再看是否套用到全部
      if (out.length) out[out.length - 1].text += ` ${chunk}`;
      else orphans.push(chunk);
      continue;
    }
    // 有標記的金額優先：「咖啡 2 杯 NT$120」只算 120；同一段有多個無標記金額時才拆成多筆
    // 有標記的金額優先：標記「前面」沒標記的數字多半是數量或卡號末四碼，忽略；
    // 標記「後面」又說了一筆夠大的（「早餐 100 塊 手搖飲 230」）視為另一筆
    const marked = amounts.filter((a) => a.marked);
    const list = marked.length && marked.length < amounts.length ? amounts.filter((a) => a.marked || Math.abs(a.value) >= 10) : amounts;
    let from = 0;
    list.forEach((a, i) => {
      if (a.index < from) return;
      let end = a.index + a.length;
      const isLast = i === list.length - 1;
      if (!isLast && accounts?.length) {
        const tail = chunk.slice(end, list[i + 1].index);
        const accInTail = findAccounts(tail, accounts)[0];
        if (accInTail?.term && /^\s*(?:用|刷|拿|以|從|由|透過|付)?\s*$/.test(tail.slice(0, accInTail.index))) {
          const alreadyHasAcc = findAccounts(chunk.slice(from, end), accounts).length > 0;
          const afterAccRaw = tail.slice(accInTail.index + accInTail.term.length);
          const afterAcc = afterAccRaw.match(/^(?:信用卡|金融卡|卡|銀行|帳戶)/)?.[0] ?? '';
          const restAfterAcc = afterAccRaw.slice(afterAcc.length);
          const looksLikeNextPrefix = /^\s+(?:用|刷|拿|以|從|由|透過|付)\s*$/.test(tail.slice(0, accInTail.index)) && /^\S/.test(restAfterAcc);
          if (!alreadyHasAcc && !looksLikeNextPrefix) {
            end += accInTail.index + accInTail.term.length + afterAcc.length;
          }
        }
      }
      out.push({ text: chunk.slice(from, isLast ? chunk.length : end), amount: { ...a, index: a.index - from } });
      from = end;
    });
  }
  if (orphans.length) {
    const head = `${orphans.join(' ')} `;
    if (out.length) out[0] = { text: head + out[0].text, amount: out[0].amount && { ...out[0].amount, index: out[0].amount.index + head.length } };
    else out.push({ text: orphans.join(' ') });
  }
  return out;
}

function cleanNote(s: string): string {
  return s.replace(FILLER_RE, ' ').replace(/[$＄]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[的在跟和與]\s*|\s*[的在跟和與]$/g, '');
}

/** 「吃科學麵」「喝了咖啡」的動詞不是備註的一部分；整段只剩動詞或標點就當作沒有備註 */
const LEAD_VERB = /^(?:吃|喝|買|點|叫|訂|去|看|搭|坐|刷|付)\s*(?=\S{2,})/;
const ONLY_NOISE = /^[\s吃喝買點叫訂去看搭坐刷付的在了跟和與、,，。.\-—_/\\]*$/;

/**
 * 認出分類之後整理備註：分類本身說過了就不用再寫（「晚餐 320」→ 沒有備註；「早餐科學麵」→「科學麵」），
 * 收入的「領到／收到」只是在說明類型，也拿掉。具體的東西或店名（Uber、珍奶）仍然保留。
 */
function tidyNote(note: string, match: CategoryMatch | undefined, kind: EntryKind): string {
  let n = note;
  if (match?.generic) n = n.replace(match.term, ' ');
  if (kind === 'income') n = n.replace(new RegExp(INCOME_RE.source, 'g'), ' ').replace(/領到|領了|領|收到|收了|拿到|賺到|賺了|入帳|進帳/g, ' ');
  n = cleanNote(n).replace(LEAD_VERB, '').trim();
  return ONLY_NOISE.test(n) ? '' : n;
}

/** 把一句話解析成一筆或多筆帳 */
export function parseEntries(input: string, ctx: ParseContext): DraftEntry[] {
  const text = toHalfWidth(input).trim();
  if (!text || /(?:不要|別|不用|請勿|暫不)\s*記帳/.test(text)) return [];
  const segs = segment(text, ctx.accounts);
  const drafts: DraftEntry[] = [];
  const allAccounts = findAccounts(text, ctx.accounts);
  const globalCurrency = detectCurrency(text);
  const datesFound: DateKey[] = [];

  for (const seg of segs) {
    if (!seg.amount) continue;
    // 1. 金額：先挖掉，避免日期規則把金額當成「25 號」
    const a = seg.amount;
    if (drafts.length >= 2) {
      const beforeAmt = seg.text.slice(0, a.index).trim();
      const sum = drafts.reduce((s, d) => s + d.amount, 0);
      if (/^(?:[和與跟、，,\s]*)(?:總共|一共|合計|總計|共計|小計|共)\s*(?:是|為|約|花|花了|消費)?\s*$/.test(beforeAmt)
        || (/(?:總共|一共|合計|總計|共計|小計|共)/.test(beforeAmt) && Math.abs(a.value) === sum)) {
        continue;
      }
    }
    let rest = `${seg.text.slice(0, a.index)} ${seg.text.slice(a.index + a.length)}`;
    // 分期期數（「分12期」）
    let installmentPeriods: number | undefined;
    const instMatch = rest.match(/(?:分期?|共分)\s*(\d{1,2})\s*期(?:\s*(?:0|零)\s*利率)?/);
    if (instMatch) {
      const p = Number(instMatch[1]);
      if (p >= 2 && p <= 60) {
        installmentPeriods = p;
        rest = rest.replace(instMatch[0], ' ');
      }
    }
    // 2. 日期
    const dt = extractDate(rest, ctx.today);
    rest = dt.rest;
    const clock = extractClock(rest);
    rest = clock.rest;
    if (dt.date) datesFound.push(dt.date);
    // 3. 帳戶（連同前面的「用／刷／從」一起拿掉）
    const accountText = rest;
    const accs = findAccounts(accountText, ctx.accounts);
    for (const h of [...accs].sort((x, y) => y.index - x.index)) {
      if (!h.term) continue;
      const before = rest.slice(0, h.index).replace(VERB_BEFORE_ACCOUNT, '');
      // 「刷玉山卡」比對到「玉山」時，後面的「卡」一起拿掉
      rest = `${before} ${rest.slice(h.index + h.term.length).replace(/^(信用卡|金融卡|卡|銀行|帳戶)/, '')}`;
    }
    rest = rest.replace(/刷卡|信用卡/g, ' ');
    // 4. 類型：「收到您的刷卡消費通知／已收到付款／回饋點數將於次月入帳／退款須知」是消費通知，不是本人收到收入
    const incomeText = seg.text
      .replace(/(?:點數|回饋|紅利|LINE\s*POINTS)[^。\n]{0,16}入帳/gi, '')
      .replace(/(?:退款|退貨)(?:須知|說明|規定|辦法|政策)/g, '');
    const hasCoreIncome = /薪水|薪資|月薪|領薪|發薪|收入|進帳|入帳|領到|拿到|賺了|賺到|獎金|年終|收紅包|紅包收入|退款|退費|退稅|退刷|退貨|刷退|折讓|利息|股利|中獎|報帳|還我|還錢給我|還款/.test(incomeText);
    const isPaymentNotice = /(?:通知|消費|刷卡|扣款|付款|帳單|發票|訂單)/.test(incomeText);
    let kind: EntryKind = (INCOME_RE.test(incomeText) && !(isPaymentNotice && !hasCoreIncome)) ? 'income' : 'expense';
    let accountId: string | undefined = accs[0]?.id;
    let toAccountId: string | undefined;
    if (TRANSFER_RE.test(seg.text)) {
      const cash = ctx.accounts.find((x) => x.type === 'cash');
      if (accs.length >= 2) {
        kind = 'transfer';
        const between = accountText.slice(accs[0].index + (accs[0].term?.length ?? 0), accs[1].index);
        const receiverFirst = /收到|接收|收取|入帳.*來自|自.*轉入/.test(between);
        accountId = accs[receiverFirst ? 1 : 0].id;
        toAccountId = accs[receiverFirst ? 0 : 1].id;
      }
      else if (CASH_OUT_RE.test(seg.text) && cash && accs[0]?.id !== cash.id) { kind = 'transfer'; toAccountId = cash.id; }
      else if (kind !== 'income' && !/跨行轉入/.test(seg.text) && accs.length === 1 && accs[0].term) {
        // 「轉 3000 到 零用金」只說了轉入的帳戶：記成轉帳，轉出帳戶留空，之後帶入預設／上次使用的帳戶
        const at = seg.text.indexOf(accs[0].term);
        if (at > 0 && /(轉|存|匯)[^到入進至給]{0,15}(到|入|進|至|給)\s*$/.test(seg.text.slice(0, at))) { kind = 'transfer'; toAccountId = accs[0].id; accountId = undefined; }
      }
    }
    if (kind === 'expense' && /(?:存入|轉入|跨行轉入)/.test(seg.text)) {
      kind = 'income';
    }
    if (a.value < 0 && kind === 'expense') kind = 'income';
    const currency = a.currency ?? detectCurrency(seg.text) ?? globalCurrency;
    for (const [re] of CURRENCY_WORDS) rest = rest.replace(re, ' ');
    const rawNote = cleanNote(rest.replace(TRANSFER_RE, kind === 'transfer' ? ' ' : '$&'));
    const match = kind === 'transfer' ? undefined : matchCategory(rawNote || seg.text, ctx.categories, kind);
    const cat = match?.category;
    // 轉帳的備註只留真正的說明；「轉」「到」「從」這類連接詞不是備註
    const note = kind === 'transfer' ? rawNote.replace(/轉帳|轉出|轉|匯款|匯|到|至|去|從|由|給|的/g, ' ').replace(/\s+/g, ' ').trim() : tidyNote(rawNote, match, kind);
    drafts.push({
      kind, amount: Math.abs(a.value), currency, date: dt.date ?? ctx.today, dateGiven: !!dt.date, ...(clock.time ? { time: clock.time } : {}),
      ...(installmentPeriods ? { installmentPeriods } : {}),
      accountId, toAccountId, categoryId: cat?.id, note, raw: seg.text.trim(),
    });
  }

  // 只寫一次的日期、帳戶套用到沒寫的那幾筆（「昨天 早餐 60 午餐 120 都刷玉山」）
  const distinctDates = [...new Set(datesFound)];
  // 帳戶只在「都／全部」或整句沒有逗號分隔時才套用到每一筆（「午餐 150 刷玉山卡，全聯 356」的全聯另外判斷）
  const oneChunk = text.split(SEPARATORS).filter((x) => x.trim()).length <= 1;
  const sharedAccount = allAccounts.length === 1 && (oneChunk || /都|全部|一起|統一/.test(text)) ? allAccounts[0].id : undefined;
  for (const d of drafts) {
    if (!d.dateGiven && distinctDates.length === 1) { d.date = distinctDates[0]; d.dateGiven = true; }
    if (!d.accountId && sharedAccount && d.kind !== 'transfer') d.accountId = sharedAccount;
  }
  return drafts;
}

/** 方便顯示：今天／昨天／10/25 */
export function shortDate(d: DateKey, today: DateKey): string {
  if (d === today) return '今天';
  if (d === addDays(today, -1)) return '昨天';
  if (d === addDays(today, -2)) return '前天';
  const x = fromDateKey(d);
  return d.slice(0, 4) === today.slice(0, 4) ? `${x.getMonth() + 1}/${x.getDate()}` : toDateKey(x).replace(/-/g, '/');
}
