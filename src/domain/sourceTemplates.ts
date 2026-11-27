/**
 * Pure domain: Versioned Source Templates & Drift Detection
 * Supports the 6 first-wave financial notification sources:
 * ctbc, esun, cathay, taishin, linepay, applepay.
 */

export const TEMPLATE_VERSION = '1.0.0';

export type SourceId = 'ctbc' | 'esun' | 'cathay' | 'taishin' | 'linepay' | 'applepay';

export type RefundStatus = 'success' | 'pending' | 'cancelled' | 'none';

export interface ParsedSourceTx {
  txAmount?: number;
  txCurrency?: string;
  originalAmount?: number;
  originalCurrency?: string;
  billingAmount?: number;
  billingCurrency?: string;
  balance?: number;
  creditLimit?: number;
  points?: number;
  fee?: number;
  txDate?: string;
  authDate?: string;
  postDate?: string;
  refundStatus?: RefundStatus;
  merchant?: string;
  card?: string;
  kind?: 'expense' | 'income' | 'transfer';
  templateId: string;
  templateVersion: string;
  matched: boolean;
  driftWarning?: string;
}

export interface SourceTemplateDef {
  id: SourceId;
  name: string;
  version: string;
  detectRe: RegExp;
  defaultCard?: string;
}

export const SOURCE_TEMPLATES: readonly SourceTemplateDef[] = [
  {
    id: 'ctbc',
    name: '中國信託',
    version: TEMPLATE_VERSION,
    detectRe: /中國信託|中信卡|中信LINE\s*Pay|CTBC|Home\s*Bank/i,
  },
  {
    id: 'esun',
    name: '玉山銀行',
    version: TEMPLATE_VERSION,
    detectRe: /玉山銀行|玉山卡|玉山\s*Unicard|玉山\s*Pi|玉山\s*U\s*Bear|E\.?SUN/i,
  },
  {
    id: 'cathay',
    name: '國泰世華',
    version: TEMPLATE_VERSION,
    detectRe: /國泰世華|國泰卡|國泰\s*CUBE|CUBE卡|Cathay/i,
  },
  {
    id: 'taishin',
    name: '台新銀行',
    version: TEMPLATE_VERSION,
    detectRe: /台新銀行|台新卡|台新\s*@?GoGo|台新\s*FlyGo|台新\s*Richart|Richart|Taishin/i,
  },
  {
    id: 'linepay',
    name: 'LINE Pay / LINE Bank',
    version: TEMPLATE_VERSION,
    detectRe: /LINE\s*Pay|LINE\s*Bank|LINEPAY|一卡通\s*MONEY/i,
  },
  {
    id: 'applepay',
    name: 'Apple Pay',
    version: TEMPLATE_VERSION,
    detectRe: /Apple\s*Pay|Apple\s*Wallet|Apple\s*Card/i,
  },
];

const CURRENCY_TOKEN_TO_CODE: Array<[RegExp, string]> = [
  [/^(?:NT\$|NTD|TWD|新台幣|新臺幣|台幣|臺幣)$/i, 'TWD'],
  [/^(?:US\$|USD|美金|美元)$/i, 'USD'],
  [/^(?:JPY|日幣|日圓|¥|￥)$/i, 'JPY'],
  [/^(?:EUR|歐元|€)$/i, 'EUR'],
  [/^(?:HK\$|HKD|港幣|港元)$/i, 'HKD'],
  [/^(?:KRW|韓元|韓圜|₩)$/i, 'KRW'],
  [/^(?:THB|泰銖)$/i, 'THB'],
  [/^(?:GBP|英鎊|£)$/i, 'GBP'],
  [/^(?:SGD|新幣|新加坡幣)$/i, 'SGD'],
  [/^(?:AUD|澳幣)$/i, 'AUD'],
  [/^(?:CNY|RMB|人民幣)$/i, 'CNY'],
];

const CURRENCY_PATTERN =
  '(?:NT\\$|NTD|TWD|US\\$|USD|HK\\$|HKD|JPY|EUR|KRW|THB|GBP|SGD|AUD|CNY|RMB|新台幣|新臺幣|台幣|臺幣|美金|美元|日幣|日圓|歐元|港幣|港元|韓元|韓圜|泰銖|英鎊|新幣|澳幣|人民幣|[¥￥€£₩$])';

function normalizeCurrencyToken(token?: string): string | undefined {
  if (!token) return undefined;
  const trimmed = token.trim();
  for (const [re, code] of CURRENCY_TOKEN_TO_CODE) {
    if (re.test(trimmed)) return code;
  }
  if (trimmed === '$') return 'TWD';
  return undefined;
}

function parseNumeric(raw: string): number | undefined {
  const cleaned = raw.replace(/,/g, '').trim();
  if (!cleaned) return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeDateString(raw: string, fallbackYear = new Date().getFullYear()): string | undefined {
  const full = raw.match(/(\d{4})[年/\-.](\d{1,2})[月/\-.](\d{1,2})/);
  if (full) {
    const y = full[1];
    const m = full[2].padStart(2, '0');
    const d = full[3].padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const short = raw.match(/(\d{1,2})[月/](\d{1,2})/);
  if (short) {
    const m = short[1].padStart(2, '0');
    const d = short[2].padStart(2, '0');
    return `${fallbackYear}-${m}-${d}`;
  }
  return undefined;
}

function extractLabeledAmount(text: string, labelPattern: string): { amount: number; currency?: string } | undefined {
  const re = new RegExp(
    `(?:${labelPattern})\\s*[:：]?\\s*(${CURRENCY_PATTERN})?\\s*([\\d,]+(?:\\.\\d+)?)\\s*(?:元|圓)?`,
    'i',
  );
  const m = text.match(re);
  if (!m) return undefined;
  const amount = parseNumeric(m[2]);
  if (amount === undefined) return undefined;
  return { amount, currency: normalizeCurrencyToken(m[1]) };
}

function extractDates(text: string, referenceYear: number): { txDate?: string; authDate?: string; postDate?: string } {
  const authMatch = text.match(/(?:授權日期|授權時間)\s*[:：]?\s*(\d{4}[年/\-.]\d{1,2}[月/\-.]\d{1,2}日?|\d{1,2}[月/]\d{1,2}日?)/);
  const postMatch = text.match(/(?:入帳日期|請款日期|入帳日)\s*[:：]?\s*(\d{4}[年/\-.]\d{1,2}[月/\-.]\d{1,2}日?|\d{1,2}[月/]\d{1,2}日?)/);
  const txMatch = text.match(/(?:交易日期|消費日期|交易時間|日期)\s*[:：]?\s*(\d{4}[年/\-.]\d{1,2}[月/\-.]\d{1,2}日?|\d{1,2}[月/]\d{1,2}日?)/);

  const authDate = authMatch ? normalizeDateString(authMatch[1], referenceYear) : undefined;
  const postDate = postMatch ? normalizeDateString(postMatch[1], referenceYear) : undefined;
  let txDate = txMatch ? normalizeDateString(txMatch[1], referenceYear) : undefined;

  if (!txDate) {
    const inlineDate = text.match(/(?:於\s*)?(\d{4}[年/\-.]\d{1,2}[月/\-.]\d{1,2}日?|\d{1,2}[月/]\d{1,2}日?)/);
    if (inlineDate) {
      txDate = normalizeDateString(inlineDate[1], referenceYear);
    } else if (authDate) {
      txDate = authDate;
    }
  }

  return { txDate, authDate, postDate };
}

function extractRefundStatus(text: string): RefundStatus {
  if (/退款取消|取消退款|退刷取消|退貨取消|退款失敗|退款撤回/.test(text)) {
    return 'cancelled';
  }
  if (/退款申請|申請退款|退款處理中|退款審核中|退貨處理中|預計退款|將於[^，。\n]*退款/.test(text)) {
    return 'pending';
  }
  if (/退款成功|已完成退款|退款入帳|已退款|退刷成功|刷退成功|退費成功|已退回/.test(text)) {
    return 'success';
  }
  return 'none';
}

function extractCard(text: string, sourceId: SourceId): string | undefined {
  // Specific named cards
  const namedCard = text.match(
    /(?:您的\s*)?((?:中國信託|中信)\s*LINE\s*Pay卡|國泰\s*CUBE卡|CUBE卡|玉山\s*Unicard|玉山\s*Pi\s*拍錢包卡|玉山\s*U\s*Bear卡|台新\s*@?GoGo卡|台新\s*FlyGo卡|台新\s*玫瑰Giving卡|Apple\s*Pay)/i,
  );
  const last4Match = text.match(/(?:卡號末四碼|帳戶末四碼|末四碼|尾號|卡號\*{2,4}|\*{2,4})\s*(\d{4})/);

  if (namedCard && last4Match) {
    const name = namedCard[1].replace(/\s+/g, ' ').trim();
    return `${name} (${last4Match[1]})`;
  }
  if (namedCard) {
    return namedCard[1].replace(/\s+/g, ' ').trim();
  }
  if (last4Match) {
    return `${sourceId.toUpperCase()} (${last4Match[1]})`;
  }
  if (sourceId === 'applepay') return 'Apple Pay';
  return undefined;
}

function extractMerchant(text: string): string | undefined {
  // Explicit labeled merchant
  const labeled = text.match(/(?:特店名稱|商店名稱|消費店家|特約商店|特店|商店)\s*[:：]\s*([^\n，。,；;]+)/);
  if (labeled) {
    return labeled[1].replace(/\s*\(.*?\)\s*$/, '').trim();
  }

  // Refund merchant pattern: 您的 <Merchant> 退款... or 申請的 <Merchant> 退款...
  const refundMerchant = text.match(/(?:您的|申請的)\s*([^\s，。,：:]{2,30})\s*(?:退款|退刷|退貨)/);
  if (refundMerchant && !/銀行|帳戶|信用卡|卡號/.test(refundMerchant[1])) {
    return refundMerchant[1].trim();
  }

  // "於 <date?> <time?> 在/於 <merchant> 消費/刷卡/付款"
  const atIn = text.match(
    /(?:於\s*(?:\d{4}[年/\-.]\d{1,2}[月/\-.]\d{1,2}日?|\d{1,2}[月/]\d{1,2}日?)(?:\s*\d{1,2}:\d{2}(?::\d{2})?)?\s*)?(?:在|於)\s*([^\n，。,；;]+?)\s*(?:消費|刷卡|授權|付款|交易|透過)/,
  );
  if (atIn) {
    const candidate = atIn[1]
      .replace(/^(?:您的|卡號[^\s]*|末四碼\d{4})\s*/, '')
      .replace(/\s*\([^)]*\)\s*$/, '')
      .trim();
    if (candidate && !/^\d{4}[/-]\d{1,2}/.test(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function detectSource(text: string, hintSource?: SourceId | string): SourceTemplateDef | undefined {
  if (hintSource) {
    const hinted = SOURCE_TEMPLATES.find((t) => t.id === hintSource);
    if (hinted) return hinted;
  }
  // Prioritize bank templates when a bank signature is clearly present,
  // unless it's specifically an Apple Pay / LINE Pay primary notification.
  if (/^Apple\s*Pay\s*(?:交易通知|通知|[:：])/i.test(text.trim())) {
    return SOURCE_TEMPLATES.find((t) => t.id === 'applepay');
  }
  if (/^LINE\s*(?:Pay|Bank)\s*(?:付款|通知|交易|[:：])/i.test(text.trim())) {
    return SOURCE_TEMPLATES.find((t) => t.id === 'linepay');
  }
  return SOURCE_TEMPLATES.find((t) => t.detectRe.test(text));
}

function stripNonTxClauses(text: string): string {
  // Remove balance, creditLimit, points, fee, and card last4 segments so txAmount extraction never grabs them
  return text
    .replace(/(?:可用額度|剩餘額度|信用額度|總額度)\s*[:：]?\s*(?:[A-Za-z$新台幣圓]+\s*)?[\d,]+(?:\.\d+)?\s*(?:元|圓)?/gi, ' ')
    .replace(/(?:帳戶餘額|可用餘額|目前餘額|活存餘額|帳上餘額)\s*[:：]?\s*(?:[A-Za-z$新台幣圓]+\s*)?[\d,]+(?:\.\d+)?\s*(?:元|圓)?/gi, ' ')
    .replace(/(?:LINE\s*POINTS|紅利點數|小樹點|台新\s*Point|現金積點|P幣|點數)\s*(?:餘額|折抵)?\s*[:：]?\s*[\d,]+(?:\.\d+)?\s*點?/gi, ' ')
    .replace(/(?:跨轉手續費|海外交易手續費|國外交易服務費|手續費)\s*[:：]?\s*(?:[A-Za-z$新台幣圓]+\s*)?[\d,]+(?:\.\d+)?\s*(?:元|圓)?/gi, ' ')
    .replace(/(?:卡號末四碼|帳戶末四碼|末四碼|尾號|卡號\*{2,4}|\*{2,4})\s*\d{4}/gi, ' ');
}

function extractTxAmounts(cleanedText: string): {
  txAmount?: number;
  txCurrency?: string;
  originalAmount?: number;
  originalCurrency?: string;
  billingAmount?: number;
  billingCurrency?: string;
} {
  // 1. Check for explicit billing/settlement TWD clause alongside foreign currency
  const billingMatch = cleanedText.match(
    new RegExp(
      `(?:折合新台幣約?|約台幣|約新台幣|折合台幣|請款金額|帳單金額)\\s*[:：]?\\s*(${CURRENCY_PATTERN})?\\s*([\\d,]+(?:\\.\\d+)?)\\s*(?:元|圓)?`,
      'i',
    ),
  );

  // Remove billing clause temporarily to find primary/original tx amount
  const withoutBilling = billingMatch
    ? cleanedText.replace(billingMatch[0], ' ')
    : cleanedText;

  // 2. Match explicit transaction amount with currency
  const txWithCurrencyRe = new RegExp(
    `(?:消費金額|交易金額|授權金額|退款金額|金額|消費|刷卡授權|刷卡|付款|轉出|轉入|跨行轉帳|轉帳|已退款|退款)\\s*[:：]?\\s*(${CURRENCY_PATTERN})\\s*([\\d,]+(?:\\.\\d+)?)\\s*(?:元|圓)?`,
    'i',
  );
  const txNoCurrencyRe =
    /(?:消費金額|交易金額|授權金額|退款金額|金額|消費|刷卡授權|刷卡|付款|轉出|轉入|跨行轉帳|轉帳|已退款|退款)\s*[:：]?\s*([\d,]+(?:\.\d+)?)\s*(元|圓)/i;

  let primaryAmount: number | undefined;
  let primaryCurrency: string | undefined;

  const m1 = withoutBilling.match(txWithCurrencyRe);
  if (m1) {
    primaryAmount = parseNumeric(m1[2]);
    primaryCurrency = normalizeCurrencyToken(m1[1]);
  } else {
    // Try standalone currency + number (e.g. "USD 10.00", "JPY 1,800", "NT$ 165")
    const standaloneCurrencyRe = new RegExp(`(${CURRENCY_PATTERN})\\s*([\\d,]+(?:\\.\\d+)?)`, 'i');
    const mStandalone = withoutBilling.match(standaloneCurrencyRe);
    if (mStandalone) {
      primaryAmount = parseNumeric(mStandalone[2]);
      primaryCurrency = normalizeCurrencyToken(mStandalone[1]);
    } else {
      const m2 = withoutBilling.match(txNoCurrencyRe);
      if (m2) {
        primaryAmount = parseNumeric(m2[1]);
        primaryCurrency = 'TWD';
      }
    }
  }

  let billingAmount: number | undefined;
  let billingCurrency: string | undefined;
  if (billingMatch) {
    billingAmount = parseNumeric(billingMatch[2]);
    billingCurrency = normalizeCurrencyToken(billingMatch[1]) ?? 'TWD';
  }

  if (primaryAmount !== undefined && primaryCurrency && primaryCurrency !== 'TWD') {
    if (billingAmount !== undefined) {
      return {
        txAmount: billingAmount,
        txCurrency: billingCurrency ?? 'TWD',
        originalAmount: primaryAmount,
        originalCurrency: primaryCurrency,
        billingAmount,
        billingCurrency: billingCurrency ?? 'TWD',
      };
    }
    return {
      txAmount: primaryAmount,
      txCurrency: primaryCurrency,
      originalAmount: primaryAmount,
      originalCurrency: primaryCurrency,
    };
  }

  // Check for explicit original foreign currency clause when primary is TWD (e.g. "消費金額 NT$ 320 (原幣 USD 10.00)")
  const originalForeignMatch = cleanedText.match(
    new RegExp(
      `(?:原幣|外幣|原交易金額)\\s*[:：]?\\s*(${CURRENCY_PATTERN})\\s*([\\d,]+(?:\\.\\d+)?)`,
      'i',
    ),
  );
  let originalAmount: number | undefined;
  let originalCurrency: string | undefined;
  if (originalForeignMatch) {
    const origCur = normalizeCurrencyToken(originalForeignMatch[1]);
    const origAmt = parseNumeric(originalForeignMatch[2]);
    if (origCur && origCur !== 'TWD' && origAmt !== undefined) {
      originalAmount = origAmt;
      originalCurrency = origCur;
    }
  }

  return {
    txAmount: primaryAmount,
    txCurrency: primaryCurrency ?? (primaryAmount !== undefined ? 'TWD' : undefined),
    originalAmount,
    originalCurrency,
    billingAmount,
    billingCurrency,
  };
}

/**
 * Parses a raw bank/wallet notification using versioned first-wave source templates.
 */
export function parseSourceTemplate(
  rawText: string,
  options?: { hintSource?: SourceId | string; referenceYear?: number },
): ParsedSourceTx {
  const text = (rawText ?? '').normalize('NFKC').trim();
  const template = detectSource(text, options?.hintSource);
  const templateId = template?.id ?? (options?.hintSource ? String(options.hintSource) : 'unknown');
  const templateVersion = template?.version ?? TEMPLATE_VERSION;

  if (!text || !template) {
    return {
      templateId,
      templateVersion,
      matched: false,
      refundStatus: 'none',
    };
  }

  // Reject OTP / pure promotional / non-transaction notices
  if (/驗證碼|動態密碼|\bOTP\b/i.test(text) && !/消費|刷卡|轉出|轉入|退款/.test(text)) {
    return {
      templateId,
      templateVersion,
      matched: false,
      refundStatus: 'none',
    };
  }

  const creditLimitHit = extractLabeledAmount(text, '可用額度|剩餘額度|信用額度|總額度');
  const balanceHit = extractLabeledAmount(text, '帳戶餘額|可用餘額|目前餘額|活存餘額|帳上餘額');
  const feeHit = extractLabeledAmount(text, '跨轉手續費|海外交易手續費|國外交易服務費|手續費');
  const pointsMatch = text.match(
    /(?:LINE\s*POINTS|紅利點數|小樹點|台新\s*Point|現金積點|P幣|點數)\s*(?:餘額|折抵)?\s*[:：]?\s*([\d,]+(?:\.\d+)?)\s*點?/i,
  );
  const points = pointsMatch ? parseNumeric(pointsMatch[1]) : undefined;

  const cleanedForTx = stripNonTxClauses(text);
  const amounts = extractTxAmounts(cleanedForTx);
  const refundStatus = extractRefundStatus(text);
  const dates = extractDates(text, options?.referenceYear ?? new Date().getFullYear());
  const merchant = extractMerchant(text);
  const card = extractCard(text, template.id);

  // Determine kind carefully:
  // Pending or cancelled refunds MUST NOT be booked as income!
  let kind: 'expense' | 'income' | 'transfer' | undefined;
  if (refundStatus === 'success') {
    kind = 'income';
  } else if (refundStatus === 'pending' || refundStatus === 'cancelled') {
    kind = undefined;
  } else if (/跨行轉出|轉出|匯出|提款|提領/.test(text)) {
    kind = 'transfer';
  } else if (/轉入|存入|入帳|薪資|股利|利息|收款/.test(text) && !/將於.*入帳/.test(text)) {
    kind = 'income';
  } else if (/跨行轉帳|轉帳|匯款/.test(text)) {
    kind = 'transfer';
  } else if (amounts.txAmount !== undefined) {
    kind = 'expense';
  }

  const matched = amounts.txAmount !== undefined;

  return {
    ...amounts,
    balance: balanceHit?.amount,
    creditLimit: creditLimitHit?.amount,
    points,
    fee: feeHit?.amount,
    ...dates,
    refundStatus,
    merchant,
    card,
    kind,
    templateId,
    templateVersion,
    matched,
  };
}

export interface TemplateParseRecord {
  templateId: string;
  matched: boolean;
  ts?: number;
}

export interface DriftDetectionOptions {
  templateId?: string;
  windowSize?: number;
  consecutiveFailureThreshold?: number;
  failureRateThreshold?: number;
  minSamplesForRate?: number;
}

export interface DriftDetectionResult {
  drifted: boolean;
  templateId?: string;
  consecutiveFailures: number;
  recentFailureRate: number;
  sampleCount: number;
  reason?: string;
}

/**
 * Detects if a source template has drifted (e.g. bank changed notification format),
 * based on >= 3 consecutive failures or > 40% failure rate in the recent window.
 */
export function detectTemplateDrift(
  history: TemplateParseRecord[],
  options?: DriftDetectionOptions,
): DriftDetectionResult {
  const windowSize = options?.windowSize ?? 10;
  const consecutiveThreshold = options?.consecutiveFailureThreshold ?? 3;
  const failureRateThreshold = options?.failureRateThreshold ?? 0.4;
  const minSamplesForRate = options?.minSamplesForRate ?? 5;

  const filtered = options?.templateId
    ? history.filter((r) => r.templateId === options.templateId)
    : history;

  if (filtered.length === 0) {
    return {
      drifted: false,
      templateId: options?.templateId,
      consecutiveFailures: 0,
      recentFailureRate: 0,
      sampleCount: 0,
    };
  }

  const recent = filtered.slice(-windowSize);
  const templateId = options?.templateId ?? recent[recent.length - 1]?.templateId;

  let consecutiveFailures = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (!recent[i].matched) {
      consecutiveFailures++;
    } else {
      break;
    }
  }

  const failedCount = recent.filter((r) => !r.matched).length;
  const recentFailureRate = failedCount / recent.length;

  if (consecutiveFailures >= consecutiveThreshold) {
    return {
      drifted: true,
      templateId,
      consecutiveFailures,
      recentFailureRate,
      sampleCount: recent.length,
      reason: `Template "${templateId ?? 'unknown'}" has ${consecutiveFailures} consecutive parse failures (threshold: ${consecutiveThreshold}).`,
    };
  }

  if (recent.length >= minSamplesForRate && recentFailureRate > failureRateThreshold) {
    return {
      drifted: true,
      templateId,
      consecutiveFailures,
      recentFailureRate,
      sampleCount: recent.length,
      reason: `Template "${templateId ?? 'unknown'}" failure rate ${(recentFailureRate * 100).toFixed(0)}% exceeds ${(failureRateThreshold * 100).toFixed(0)}% in last ${recent.length} messages.`,
    };
  }

  return {
    drifted: false,
    templateId,
    consecutiveFailures,
    recentFailureRate,
    sampleCount: recent.length,
  };
}
