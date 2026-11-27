/**
 * Pure domain: Merchant Alias Normalization
 * Normalizes payment-gateway prefixes & noisy store codes into clean canonical
 * merchant aliases while preserving rawText and sub-tokens for context matching.
 */

export interface MerchantAliasOverride {
  rawKey: string;
  alias: string;
}

export interface NormalizedMerchant {
  /** Clean canonical merchant alias, e.g. 'Uber', '星巴克', '7-ELEVEN', '統一超商' */
  alias: string;
  /** Detected payment gateway / aggregator prefix, e.g. 'ECPAY', '藍新', '街口', 'LINEPAY', 'JKOPAY' */
  gateway?: string;
  /** Sub-context token preserved for context matching, e.g. 'TRIP', 'EATS' */
  subContext?: string;
  /** Tokenized sub-tokens extracted from raw text */
  subTokens: string[];
  /** Original raw text preserved untouched for keyword matching */
  rawText: string;
  /** Whether a user-learned override matched */
  fromOverride: boolean;
}

const GATEWAY_PREFIX_RE =
  /^(ECPAY|ECPay|綠界科技|綠界|NEWEBPAY|藍新金流|藍新|PAYUNI|統一金流|JKOPAY|JKO|街口支付|街口|LINE\s*PAY|LINEPAY|PXPAY|PX\s*PAY|全支付|EASYWALLET|悠遊付|ICASH\s*PAY|ICASHPAY|愛金卡|PI拍錢包|PI錢包|TAPPAY|TAPAY|PAYPAL|STRIPE|SHOPLINE|CYBERBIZ|91APP)\s*[*＊\-_:：/]\s*(.+)$/i;

const CANONICAL_BRANDS: Array<[RegExp, string]> = [
  [/^uber$/i, 'Uber'],
  [/^(7-eleven|7-11|seven-eleven|7eleven)$/i, '7-ELEVEN'],
  [/^starbucks$/i, 'Starbucks'],
  [/^(mcdonald'?s)$/i, "McDonald's"],
  [/^netflix$/i, 'Netflix'],
  [/^spotify$/i, 'Spotify'],
  [/^grab$/i, 'Grab'],
  [/^foodpanda$/i, 'foodpanda'],
  [/^coupang$/i, 'Coupang'],
  [/^shopee$/i, 'Shopee'],
  [/^momo$/i, 'momo'],
  [/^pchome$/i, 'PChome'],
  [/^costco$/i, 'Costco'],
  [/^ikea$/i, 'IKEA'],
  [/^uniqlo$/i, 'UNIQLO'],
  [/^muji$/i, 'MUJI'],
  [/^kfc$/i, 'KFC'],
  [/^apple\.com\/bill$/i, 'Apple'],
  [/^google$/i, 'Google'],
];

const UPPERCASE_BRANDS = new Set(['7-ELEVEN', 'IKEA', 'UNIQLO', 'MUJI', 'KFC', 'H&M', 'COS', 'ZARA', 'IBM', 'AWS', 'HBO']);

const TW_CITIES_DISTRICTS =
  '(?:台北市|臺北市|新北市|桃園市|台中市|臺中市|台南市|臺南市|高雄市|基隆市|新竹市|新竹縣|苗栗縣|彰化縣|南投縣|雲林縣|嘉義市|嘉義縣|屏東縣|宜蘭縣|花蓮縣|台東縣|臺東縣|澎湖縣|金門縣|連江縣|台北|臺北|新北|桃園|台中|臺中|台南|臺南|高雄|信義|大安|中山|松山|內湖|南港|士林|北投|萬華|中正|大同|文山|板橋|中和|永和|新莊|三重|新店|蘆洲|汐止|樹林|淡水|竹北|西屯|北屯|南屯|左營|鼓山|三民|苓雅|前鎮)';

function toHalfWidthBasic(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[＊]/g, '*')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeOverrideKey(s: string): string {
  return toHalfWidthBasic(s).toLowerCase();
}

function tokenize(raw: string): string[] {
  return Array.from(
    new Set(
      toHalfWidthBasic(raw)
        .split(/[\s*＊\-_/|:：]+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0),
    ),
  );
}

function stripNoisySuffixes(name: string): string {
  let s = name.trim();
  // Remove corporate suffixes
  s = s.replace(/(?:股份有限公司|有限公司|台灣分公司|臺灣分公司)$/g, '').trim();
  // Remove trailing store codes like #1234, NO.123, STORE 0421, POS01, -00123
  s = s.replace(/\s*(?:#\d+|NO\.?\s*\d+|STORE\s*\d+|POS\s*\d+|-\d{3,}|_\d{2,})\s*$/i, '').trim();
  // Remove trailing long numeric terminal/branch IDs (4+ digits)
  s = s.replace(/\s+\d{4,}$/, '').trim();
  // Strip parenthesized branch suffixes like 統一超商(信義門市) or 星巴克（台北101店）
  s = s.replace(/\s*[（(][^)）]{1,16}(?:門市|分店|營業所|店|站)[)）]$/, '').trim();
  // Strip Chinese branch suffixes like 台北市信義門市, 台北101門市, 第0123門市, 大安分店
  const branchRe = new RegExp(
    `(?:[-\\s]*(?:${TW_CITIES_DISTRICTS}[\\u4e00-\\u9fffA-Za-z0-9]{0,8}|第?[0-9一二三四五六七八九十]+)[分]?(?:門市|分店|營業所|店|站))$`,
  );
  const strippedBranch = s.replace(branchRe, '').trim();
  if (strippedBranch !== s && strippedBranch.length >= 2) {
    s = strippedBranch;
  } else {
    // Fallback: strip separated branch suffixes like "全聯福利中心 新竹巨城店" or "星巴克-天母門市"
    const separatedBranch = s.replace(/[-\s]+[\u4e00-\u9fffA-Za-z0-9]{1,8}(?:門市|分店|營業所|店)$/, '').trim();
    if (separatedBranch !== s && separatedBranch.length >= 2) {
      s = separatedBranch;
    } else {
      // Fallback: strip explicit 門市/分店/營業所 suffix with preceding location token if brand remains >= 2 chars
      const genericBranch = s.replace(/[\u4e00-\u9fffA-Za-z0-9]{1,6}(?:門市|分店|營業所)$/, '').trim();
      if (genericBranch !== s && genericBranch.length >= 2) {
        s = genericBranch;
      }
    }
  }
  return s.replace(/[-_\s]+$/, '').trim();
}

function canonicalizeBrand(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '';
  for (const [re, canonical] of CANONICAL_BRANDS) {
    if (re.test(trimmed)) return canonical;
  }
  if (UPPERCASE_BRANDS.has(trimmed.toUpperCase())) {
    return trimmed.toUpperCase();
  }
  // Title-case pure ASCII all-caps tokens (e.g. AIRBNB -> Airbnb)
  if (/^[A-Z0-9\s&'.-]+$/.test(trimmed) && /[A-Z]{2,}/.test(trimmed)) {
    return trimmed
      .split(/\s+/)
      .map((word) => {
        if (UPPERCASE_BRANDS.has(word)) return word;
        if (/^\d/.test(word)) return word;
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      })
      .join(' ');
  }
  return trimmed;
}

/**
 * Normalizes a raw merchant string into a clean canonical alias while
 * preserving gateway, subContext, subTokens, and rawText.
 */
export function normalizeMerchantAlias(
  rawText: string,
  overrides: MerchantAliasOverride[] = [],
): NormalizedMerchant {
  const raw = rawText ?? '';
  const half = toHalfWidthBasic(raw);
  const subTokens = tokenize(raw);

  if (!half) {
    return {
      alias: '',
      subTokens: [],
      rawText: raw,
      fromOverride: false,
    };
  }

  // Strip gateway prefix(es)
  let working = half;
  let gateway: string | undefined;
  for (let i = 0; i < 2; i++) {
    const gwMatch = working.match(GATEWAY_PREFIX_RE);
    if (!gwMatch) break;
    if (!gateway) {
      gateway = gwMatch[1].replace(/\s+/g, '').toUpperCase();
    }
    working = gwMatch[2].trim();
  }

  // Extract subContext like "UBER *TRIP", "UBER *EATS", "UBER *EATS #1234", "GOOGLE *YOUTUBE"
  let subContext: string | undefined;
  const starSubMatch = working.match(/^(.+?)\s*\*\s*([A-Za-z0-9_\u4e00-\u9fff-]+)(?:\s+.*)?$/);
  if (starSubMatch) {
    const basePart = starSubMatch[1].trim();
    const subPart = starSubMatch[2].trim();
    if (basePart.length >= 2 && subPart.length >= 2) {
      working = basePart;
      subContext = subPart.toUpperCase();
    }
  } else {
    const uberSpaceSub = working.match(/^(UBER)\s+(TRIP|EATS|ONE)\b(.*)$/i);
    if (uberSpaceSub) {
      working = uberSpaceSub[1];
      subContext = uberSpaceSub[2].toUpperCase();
    }
  }

  const cleaned = stripNoisySuffixes(working);

  // Check user-learned overrides (exact raw match -> stripped working match -> cleaned suffix-stripped match)
  if (overrides.length > 0) {
    const rawNorm = normalizeOverrideKey(half);
    const workNorm = normalizeOverrideKey(working);
    const cleanedNorm = normalizeOverrideKey(cleaned || working);
    const exactOverride = overrides.find((o) => normalizeOverrideKey(o.rawKey) === rawNorm);
    if (exactOverride) {
      return {
        alias: exactOverride.alias.trim(),
        gateway,
        subContext,
        subTokens,
        rawText: raw,
        fromOverride: true,
      };
    }
    const strippedOverride = overrides.find((o) => normalizeOverrideKey(o.rawKey) === workNorm);
    if (strippedOverride) {
      return {
        alias: strippedOverride.alias.trim(),
        gateway,
        subContext,
        subTokens,
        rawText: raw,
        fromOverride: true,
      };
    }
    const cleanedOverride = overrides.find((o) => normalizeOverrideKey(o.rawKey) === cleanedNorm);
    if (cleanedOverride) {
      return {
        alias: cleanedOverride.alias.trim(),
        gateway,
        subContext,
        subTokens,
        rawText: raw,
        fromOverride: true,
      };
    }
  }

  const alias = canonicalizeBrand(cleaned || working);

  return {
    alias,
    gateway,
    subContext,
    subTokens,
    rawText: raw,
    fromOverride: false,
  };
}
