/**
 * 自動記帳來源去重：Apple Pay、銀行簡訊、電子發票、手動記帳常常是同一次消費。
 * 「同金額＋同幣別＋日期相差 1 天內」是候選；同一天且商家相近或同一帳戶算「很可能重複」（strong），
 * 其餘只是提醒（weak）。只用來提示，不會偷偷刪除任何帳目。
 */
import { fromDateKey } from './period';

export interface DupCandidate {
  id: string;
  date: string;
  amountMinor: number;
  currency: string;
  accountId?: string;
  /** 商家、備註（比對店名用） */
  text: string;
  source?: string;
  eventAt?: number;
  sourceEventId?: string;
}

export interface DupProbe {
  date: string;
  amountMinor: number;
  currency: string;
  accountId?: string;
  text: string;
  source?: string;
  eventAt?: number;
  sourceEventId?: string;
}

const RETRY_WINDOW_MS = 120_000;

export interface DupHit { id: string; level: 'strong' | 'weak' }

export function dayGap(a: string, b: string): number {
  return Math.abs(Math.round((fromDateKey(a).getTime() - fromDateKey(b).getTime()) / 86_400_000));
}

const NOISE = /[\s\d.,，。:：;；()（）[\]「」\-_/\\#*＊·・]|nt\$|twd|台幣|新台幣|元|刷卡|消費|交易|付款|支付|行動支付|apple\s*pay/gi;

const CHAIN_ALIASES: [RegExp, string][] = [
  [/familymart/gi, '全家'],
  [/7[\s-]*eleven|7[\s-]*11|統一超商/gi, '統一超商'],
  [/starbucks/gi, '星巴克'],
  [/mcdonald'?s?/gi, '麥當勞'],
  [/pxmart|全聯福利中心/gi, '全聯'],
  [/carrefour/gi, '家樂福'],
  [/costco/gi, '好市多'],
  [/uniqlo/gi, '優衣庫'],
  [/ikea/gi, '宜家'],
  [/hilife/gi, '萊爾富'],
  [/okmart|ok超商/gi, 'ok超商'],
  [/watsons/gi, '屈臣氏'],
  [/cosmed/gi, '康是美'],
];

/** 比對用的店名：統一常見連鎖店中英文別名，並去掉空白、數字、標點與「刷卡」「消費」等通用字 */
export function normalizeShop(s: string): string {
  let out = s.toLowerCase();
  for (const [re, canonical] of CHAIN_ALIASES) out = out.replace(re, canonical);
  return out.replace(NOISE, '');
}

/** 兩段文字的店名相近：其中一個包含另一個，或共用連續 2 個字以上 */
export function shopSimilar(a: string, b: string): boolean {
  const x = normalizeShop(a);
  const y = normalizeShop(b);
  if (x.length < 2 || y.length < 2) return false;
  if (x.includes(y) || y.includes(x)) return true;
  return false;
}

/** 在已有的帳目裡找最像的一筆；沒有就回傳 null */
export function findDuplicate(probe: DupProbe, existing: DupCandidate[]): DupHit | null {
  let best: { hit: DupHit; rank: number } | null = null;
  for (const c of existing) {
    if (c.amountMinor !== probe.amountMinor || c.currency !== probe.currency) continue;
    const exactEvent = Boolean(probe.sourceEventId && c.sourceEventId && probe.sourceEventId === c.sourceEventId);
    const gap = dayGap(c.date, probe.date);
    if (!exactEvent && gap > 1) continue;
    const sameSource = Boolean(probe.source && c.source && probe.source === c.source);
    const withinRetry = probe.eventAt !== undefined && c.eventAt !== undefined
      && Math.abs(probe.eventAt - c.eventAt) <= RETRY_WINDOW_MS;
    const sameSourceOutsideRetry = sameSource && !exactEvent && !withinRetry;
    const sameShop = shopSimilar(c.text, probe.text);
    const sameAcc = !!probe.accountId && c.accountId === probe.accountId;
    const strong = exactEvent || (!sameSourceOutsideRetry && gap === 0 && sameShop && (!c.accountId || !probe.accountId || sameAcc));
    const rank = (exactEvent ? 8 : 0) + (strong ? 4 : 0) + (sameShop ? 2 : 0) + (sameAcc ? 1 : 0) + (gap === 0 ? 0.5 : 0);
    if (!best || rank > best.rank) best = { hit: { id: c.id, level: strong ? 'strong' : 'weak' }, rank };
  }
  return best?.hit ?? null;
}
