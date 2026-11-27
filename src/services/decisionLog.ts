/**
 * 自動記帳決策日誌、回饋訊號與規則生命週期管理。
 * 所有紀錄僅保存於本機 IndexedDB（auto_decisions / feedback_signals），不跨裝置同步，
 * 且原始通知只保存雜湊（rawHash）與 <= 160 字元摘要（snippet），不留存完整原文。
 */
import { db, uid } from '@/db/schema';
import type {
  AutoDecision,
  AutoDecisionCandidate,
  AutoDecisionOutcome,
  CategoryRule,
  ConfidenceLevel,
  FeedbackField,
  FeedbackSignal,
  FeedbackSignalType,
  RuleStats,
  RuleStatus,
} from '@/db/types';

export const SNIPPET_MAX_LEN = 160;
export const DECISION_RETENTION_DAYS = 90;
export const DECISION_MAX_ROWS = 2000;
const DAY_MS = 86_400_000;

export const SIGNAL_WEIGHTS: Record<FeedbackSignalType, number> = {
  confirm_clean: 1.0,
  external_reconcile: 1.2,
  external_einvoice: 1.2,
  edit_field: 1.0,
  undo_delete: 1.5,
  skip_ignore: 0.3,
  skip_non_tx: 0,
  skip_duplicate: 0,
  merge_duplicate: 0,
};

/** 截斷摘要至 <= 160 字元 */
export function truncateSnippet(text: string, maxLen = SNIPPET_MAX_LEN): string {
  if (maxLen <= 0) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  if (maxLen === 1) return clean.slice(0, 1);
  return clean.slice(0, maxLen - 1) + '…';
}

/** 計算原文雜湊（優先使用 Web Crypto SHA-256，環境不支援時退回 FNV-1a） */
export async function hashRawText(text: string): Promise<string> {
  if (!text) return '';
  try {
    if (typeof crypto !== 'undefined' && crypto.subtle && typeof TextEncoder !== 'undefined') {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    // 非安全環境或測試環境不支援 subtle 时退回 FNV-1a
  }
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c + i;
    h2 = Math.imul(h2, 0x01000193);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

export interface RecordDecisionInput {
  id?: string;
  ts?: number;
  source: string;
  sourceEventId?: string;
  txId?: string;
  inboxItemId?: string;
  outcome: AutoDecisionOutcome;
  parserVersion?: string;
  /** 僅用於產生 rawHash 與截斷 snippet，不會寫入資料庫 */
  rawText?: string;
  rawHash?: string;
  snippet?: string;
  matchedRuleId?: string;
  confidence?: number;
  confidenceLevel?: ConfidenceLevel;
  candidates?: AutoDecisionCandidate[];
  chosen?: AutoDecision['chosen'];
  duplicateOfTxId?: string;
}

/** 清理超過 90 天或超過 2000 筆的舊決策紀錄 */
export async function pruneDecisions(now = Date.now()): Promise<number> {
  const cutoff = now - DECISION_RETENTION_DAYS * DAY_MS;
  let deleted = await db.auto_decisions.where('ts').below(cutoff).delete();
  const total = await db.auto_decisions.count();
  if (total > DECISION_MAX_ROWS) {
    const excess = total - DECISION_MAX_ROWS;
    const oldestKeys = await db.auto_decisions.orderBy('ts').limit(excess).primaryKeys();
    if (oldestKeys.length) {
      await db.auto_decisions.bulkDelete(oldestKeys);
      deleted += oldestKeys.length;
    }
  }
  return deleted;
}

/** 記錄一筆自動記帳決策（含摘要截斷與過期清理） */
export async function recordDecision(input: RecordDecisionInput): Promise<AutoDecision> {
  const ts = input.ts ?? Date.now();
  const rawHash = input.rawHash ?? (input.rawText ? await hashRawText(input.rawText) : '');
  const snippet = truncateSnippet(input.snippet ?? input.rawText ?? '', SNIPPET_MAX_LEN);

  const decision: AutoDecision = {
    id: input.id ?? uid(),
    ts,
    source: input.source,
    sourceEventId: input.sourceEventId,
    txId: input.txId,
    inboxItemId: input.inboxItemId,
    outcome: input.outcome,
    parserVersion: input.parserVersion,
    rawHash,
    snippet,
    matchedRuleId: input.matchedRuleId,
    confidence: input.confidence,
    confidenceLevel: input.confidenceLevel,
    candidates: input.candidates,
    chosen: input.chosen,
    duplicateOfTxId: input.duplicateOfTxId,
  };

  await db.auto_decisions.put(decision);
  await pruneDecisions(ts);
  return decision;
}

/** 將已建帳的交易 ID 關聯回決策紀錄 */
export async function attachDecisionToTx(decisionId: string, txId: string): Promise<void> {
  await db.auto_decisions.update(decisionId, { txId });
}

/** 計算規則信心分數（Laplace 平滑 + 久未命中向先驗 0.5 衰減） */
export function computeRuleConfidence(
  rule: Pick<CategoryRule, 'stats'>,
  now = Date.now(),
): { score: number; level: ConfidenceLevel } {
  const stats = rule.stats;
  if (!stats) {
    return { score: 0.5, level: 'medium' };
  }
  const feedbackTotal =
    stats.cleanAccepted +
    stats.editedCategory +
    stats.editedAccount +
    stats.editedAmount +
    stats.rejected;
  const effectiveShown = Math.max(stats.shown, feedbackTotal);
  const rawScore = (stats.cleanAccepted + 2) / (effectiveShown + 4);

  let score = rawScore;
  if (stats.lastMatchedAt !== undefined && now > stats.lastMatchedAt) {
    const daysSince = (now - stats.lastMatchedAt) / DAY_MS;
    if (daysSince > DECISION_RETENTION_DAYS) {
      const decay = Math.pow(0.5, (daysSince - DECISION_RETENTION_DAYS) / 180);
      score = 0.5 + (rawScore - 0.5) * decay;
    }
  }

  const level: ConfidenceLevel = score >= 0.75 ? 'high' : score >= 0.45 ? 'medium' : 'low';
  return { score, level };
}

export interface RecordFeedbackInput {
  id?: string;
  ts?: number;
  decisionId?: string;
  ruleId?: string;
  txId?: string;
  signalType: FeedbackSignalType;
  field?: FeedbackField;
  weight?: number;
  beforeValue?: string;
  afterValue?: string;
  note?: string;
}

export interface RecordFeedbackResult {
  signal: FeedbackSignal;
  rule?: CategoryRule;
}

function emptyStats(): RuleStats {
  return {
    shown: 0,
    autoBooked: 0,
    cleanAccepted: 0,
    editedCategory: 0,
    editedAccount: 0,
    editedAmount: 0,
    rejected: 0,
  };
}

/** 記錄回饋訊號，並依規則統計更新規則生命週期（觀察期自動啟用／高修正率自動暫停） */
export async function recordFeedback(input: RecordFeedbackInput): Promise<RecordFeedbackResult> {
  const ts = input.ts ?? Date.now();
  const weight = input.weight ?? SIGNAL_WEIGHTS[input.signalType];

  let ruleId = input.ruleId;
  if (!ruleId && input.decisionId) {
    const decision = await db.auto_decisions.get(input.decisionId);
    if (decision?.matchedRuleId) ruleId = decision.matchedRuleId;
  }

  const signal: FeedbackSignal = {
    id: input.id ?? uid(),
    ts,
    decisionId: input.decisionId,
    ruleId,
    txId: input.txId,
    signalType: input.signalType,
    field: input.field,
    weight,
    beforeValue: input.beforeValue,
    afterValue: input.afterValue,
    note: input.note,
  };

  await db.feedback_signals.put(signal);

  if (!ruleId) {
    return { signal };
  }

  const rule = await db.rules.get(ruleId);
  if (!rule) {
    return { signal };
  }

  const stats: RuleStats = { ...emptyStats(), ...rule.stats };
  let status: RuleStatus = rule.status ?? 'active';
  let statusReason = rule.statusReason;
  let statsChanged = false;

  if (input.signalType === 'confirm_clean') {
    stats.cleanAccepted += 1;
    stats.lastMatchedAt = ts;
    statsChanged = true;

    const totalEdits = stats.editedCategory + stats.editedAccount + stats.editedAmount;
    if (status === 'shadow' && stats.cleanAccepted >= 2 && totalEdits === 0) {
      status = 'active';
      statusReason = '觀察期通過自動啟用';
    }
  } else if (input.signalType === 'edit_field') {
    if (input.field === 'category') stats.editedCategory += 1;
    else if (input.field === 'account') stats.editedAccount += 1;
    else if (input.field === 'amount') stats.editedAmount += 1;
    stats.lastMatchedAt = ts;
    statsChanged = true;
  } else if (input.signalType === 'undo_delete') {
    stats.rejected += 1;
    stats.lastMatchedAt = ts;
    statsChanged = true;
  }
  // skip_non_tx / skip_duplicate / merge_duplicate / skip_ignore / external_*:
  // 不對規則的分類／帳戶準確率計負分（僅記錄訊號供去重或雜訊分析）

  if (
    (input.signalType === 'edit_field' || input.signalType === 'undo_delete') &&
    status === 'active'
  ) {
    const recentSince = ts - 30 * DAY_MS;
    const allRuleSignals = await db.feedback_signals.where('ruleId').equals(ruleId).toArray();
    const recentRuleSignals = allRuleSignals.filter((s) => s.ts >= recentSince && s.ts <= ts);
    const hasOlderSignals = allRuleSignals.some((s) => s.ts < recentSince);

    const recentEditsAndRejects = recentRuleSignals.filter(
      (s) => s.signalType === 'edit_field' || s.signalType === 'undo_delete',
    ).length;
    const recentUndoDeletes = recentRuleSignals.filter(
      (s) => s.signalType === 'undo_delete',
    ).length;

    const statsEditsAndRejects =
      stats.editedCategory + stats.editedAccount + stats.editedAmount + stats.rejected;
    const effectiveEditsAndRejects = hasOlderSignals
      ? recentEditsAndRejects
      : Math.max(recentEditsAndRejects, statsEditsAndRejects);
    const effectiveUndoDeletes = hasOlderSignals
      ? recentUndoDeletes
      : Math.max(recentUndoDeletes, stats.rejected);

    const { score } = computeRuleConfidence({ stats }, ts);
    if ((effectiveEditsAndRejects >= 3 && score < 0.6) || effectiveUndoDeletes >= 2) {
      status = 'paused';
      statusReason = '近期修正率過高，已轉為待確認';
    }
  }

  if (statsChanged || status !== (rule.status ?? 'active') || statusReason !== rule.statusReason) {
    const updated: CategoryRule = {
      ...rule,
      stats,
      status,
      statusReason,
      updatedAt: ts,
    };
    await db.rules.put(updated);
    return { signal, rule: updated };
  }

  return { signal, rule };
}

export interface HealthMetrics {
  days: number;
  sinceTs: number;
  totalDecisions: number;
  autoBookedCount: number;
  reviewCount: number;
  skippedCount: number;
  /** North Star：自動記帳後未經使用者修正或撤銷的比例（0–1） */
  uneditedAutoBookRate: number;
  /** 自動記帳覆蓋率（autoBookedCount / totalDecisions） */
  autoCoverageRate: number;
  /** 人工待確認率（reviewCount / totalDecisions） */
  reviewRate: number;
  /** 各欄位修正率 */
  fieldEditRates: {
    amount: number;
    currency: number;
    date: number;
    account: number;
    category: number;
  };
  /** 重複判定誤判率 */
  duplicateFalsePositiveRate: number;
  /** 修正次數最多的規則 */
  mostEditedRules: Array<{
    ruleId: string;
    keyword?: string;
    editCount: number;
    rejectCount: number;
    status?: RuleStatus;
  }>;
  /** 候選規則衝突清單 */
  candidateConflicts: Array<{
    decisionId: string;
    ts: number;
    snippet: string;
    candidateCount: number;
    ruleIds: string[];
    categoryIds: string[];
  }>;
}

/** 計算近 N 天的自動記帳健康度指標 */
export async function computeHealthMetrics(
  days = 30,
  now = Date.now(),
): Promise<HealthMetrics> {
  const sinceTs = now - days * DAY_MS;
  const decisions = await db.auto_decisions.where('ts').between(sinceTs, now, true, true).toArray();
  const signals = await db.feedback_signals.where('ts').between(sinceTs, now, true, true).toArray();

  const totalDecisions = decisions.length;
  const autoBooked = decisions.filter((d) => d.outcome === 'auto_booked');
  const review = decisions.filter((d) => d.outcome === 'review');
  const skipped = decisions.filter(
    (d) =>
      d.outcome === 'skipped_non_tx' ||
      d.outcome === 'skipped_duplicate' ||
      d.outcome === 'skipped_ignored',
  );

  const autoBookedCount = autoBooked.length;
  const reviewCount = review.length;
  const skippedCount = skipped.length;

  const autoBookedIds = new Set(autoBooked.map((d) => d.id));
  const editedAutoIds = new Set(
    signals
      .filter(
        (s) =>
          s.decisionId &&
          autoBookedIds.has(s.decisionId) &&
          (s.signalType === 'edit_field' || s.signalType === 'undo_delete'),
      )
      .map((s) => s.decisionId as string),
  );

  const uneditedAutoBookRate =
    autoBookedCount > 0 ? Math.max(0, (autoBookedCount - editedAutoIds.size) / autoBookedCount) : 0;

  const autoCoverageRate = totalDecisions > 0 ? autoBookedCount / totalDecisions : 0;
  const reviewRate = totalDecisions > 0 ? reviewCount / totalDecisions : 0;

  const reviewIds = new Set(review.map((d) => d.id));
  const editDenom = autoBookedCount + reviewCount;
  const countFieldEdits = (field: string): number => {
    const seen = new Set<string>();
    for (const s of signals) {
      if (s.signalType === 'edit_field' && s.field === field) {
        if (s.decisionId && !autoBookedIds.has(s.decisionId) && !reviewIds.has(s.decisionId)) {
          continue;
        }
        seen.add(s.decisionId ?? s.id);
      }
    }
    return seen.size;
  };

  const fieldEditRates = {
    amount: editDenom > 0 ? Math.min(1, countFieldEdits('amount') / editDenom) : 0,
    currency: editDenom > 0 ? Math.min(1, countFieldEdits('currency') / editDenom) : 0,
    date: editDenom > 0 ? Math.min(1, countFieldEdits('date') / editDenom) : 0,
    account: editDenom > 0 ? Math.min(1, countFieldEdits('account') / editDenom) : 0,
    category: editDenom > 0 ? Math.min(1, countFieldEdits('category') / editDenom) : 0,
  };

  const flaggedDuplicates = decisions.filter((d) => d.outcome === 'skipped_duplicate');
  const flaggedDupIds = new Set(flaggedDuplicates.map((d) => d.id));
  const falsePositiveDupIds = new Set(
    signals
      .filter(
        (s) =>
          s.decisionId &&
          flaggedDupIds.has(s.decisionId) &&
          (s.signalType === 'confirm_clean' || s.signalType === 'undo_delete'),
      )
      .map((s) => s.decisionId as string),
  );
  const duplicateFalsePositiveRate =
    flaggedDuplicates.length > 0 ? falsePositiveDupIds.size / flaggedDuplicates.length : 0;

  // 統計修正次數最多的規則
  const ruleAgg = new Map<string, { editCount: number; rejectCount: number }>();
  for (const s of signals) {
    if (!s.ruleId) continue;
    if (s.signalType !== 'edit_field' && s.signalType !== 'undo_delete') continue;
    const cur = ruleAgg.get(s.ruleId) ?? { editCount: 0, rejectCount: 0 };
    if (s.signalType === 'edit_field') cur.editCount += 1;
    else cur.rejectCount += 1;
    ruleAgg.set(s.ruleId, cur);
  }

  const ruleIdsToFetch = [...ruleAgg.keys()];
  const fetchedRules = ruleIdsToFetch.length ? await db.rules.bulkGet(ruleIdsToFetch) : [];
  const ruleMap = new Map<string, CategoryRule>();
  for (const r of fetchedRules) {
    if (r) ruleMap.set(r.id, r);
  }

  const mostEditedRules = [...ruleAgg.entries()]
    .map(([ruleId, counts]) => {
      const r = ruleMap.get(ruleId);
      return {
        ruleId,
        keyword: r?.keyword,
        editCount: counts.editCount,
        rejectCount: counts.rejectCount,
        status: r?.status ?? (r ? 'active' : undefined),
      };
    })
    .sort((a, b) => b.editCount + b.rejectCount - (a.editCount + a.rejectCount))
    .slice(0, 10);

  // 候選規則衝突：同一筆決策有多個候選且建議不同分類或帳戶
  const candidateConflicts: HealthMetrics['candidateConflicts'] = [];
  for (const d of decisions) {
    if (!d.candidates || d.candidates.length < 2) continue;
    const catSet = new Set(d.candidates.map((c) => c.categoryId).filter(Boolean) as string[]);
    const accSet = new Set(d.candidates.map((c) => c.accountId).filter(Boolean) as string[]);
    if (catSet.size > 1 || accSet.size > 1) {
      candidateConflicts.push({
        decisionId: d.id,
        ts: d.ts,
        snippet: d.snippet,
        candidateCount: d.candidates.length,
        ruleIds: d.candidates.map((c) => c.ruleId).filter(Boolean) as string[],
        categoryIds: [...catSet],
      });
    }
  }

  return {
    days,
    sinceTs,
    totalDecisions,
    autoBookedCount,
    reviewCount,
    skippedCount,
    uneditedAutoBookRate,
    autoCoverageRate,
    reviewRate,
    fieldEditRates,
    duplicateFalsePositiveRate,
    mostEditedRules,
    candidateConflicts,
  };
}
