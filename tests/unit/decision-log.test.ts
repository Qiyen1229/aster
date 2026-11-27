import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { beforeEach, describe, expect, it } from 'vitest';
import { AsterDB, db } from '@/db/schema';
import { SYNCED_TABLES } from '@/db/sync-tracking';
import type { CategoryRule } from '@/db/types';
import {
  attachDecisionToTx,
  computeHealthMetrics,
  computeRuleConfidence,
  DECISION_MAX_ROWS,
  recordDecision,
  recordFeedback,
  SIGNAL_WEIGHTS,
  SNIPPET_MAX_LEN,
} from '@/services/decisionLog';

const DAY_MS = 86_400_000;

function makeRule(overrides: Partial<CategoryRule> = {}): CategoryRule {
  const now = Date.now();
  return {
    id: 'rule-1',
    keyword: '星巴克',
    match: 'contains',
    kind: 'expense',
    categoryId: 'cat-coffee',
    priority: 10,
    enabled: true,
    hits: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('DecisionLog & Rule Lifecycle (Wave 1A)', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  describe('Dexie v8 schema & non-sync', () => {
    it('建立 auto_decisions / feedback_signals / merchant_aliases 且不進入 sync_outbox', async () => {
      expect(SYNCED_TABLES).not.toContain('auto_decisions');
      expect(SYNCED_TABLES).not.toContain('feedback_signals');
      expect(SYNCED_TABLES).not.toContain('merchant_aliases');

      const now = Date.now();
      await db.auto_decisions.put({
        id: 'd-1',
        ts: now,
        source: 'notify',
        outcome: 'auto_booked',
        rawHash: 'abc',
        snippet: '星巴克 150元',
      });
      await db.feedback_signals.put({
        id: 'f-1',
        ts: now,
        decisionId: 'd-1',
        signalType: 'confirm_clean',
        weight: 1.0,
      });
      await db.merchant_aliases.put({
        id: 'm-1',
        rawKey: 'starbucks tw',
        alias: '星巴克',
        createdAt: now,
        updatedAt: now,
      });

      expect(await db.auto_decisions.count()).toBe(1);
      expect(await db.feedback_signals.count()).toBe(1);
      expect(await db.merchant_aliases.count()).toBe(1);
      expect(await db.sync_outbox.count()).toBe(0);
    });

    it('從 v7 升級至 v8 保留既有舊規則（無 status/stats）且可正常接收回饋', async () => {
      const upgradeDbName = 'aster-v7-upgrade-test';
      await Dexie.delete(upgradeDbName);

      const v7 = new Dexie(upgradeDbName);
      v7.version(4).stores({
        rules: 'id, priority, categoryId',
      });
      v7.version(7).stores({
        errors: '++id, ts, type',
      });
      await v7.open();
      const now = Date.now();
      await v7.table('rules').put({
        id: 'legacy-rule-1',
        keyword: '全聯',
        match: 'contains',
        kind: 'expense',
        categoryId: 'cat-grocery',
        priority: 10,
        enabled: true,
        hits: 5,
        createdAt: now - 10000,
        updatedAt: now - 10000,
      });
      v7.close();

      const v8 = new AsterDB(upgradeDbName);
      await v8.open();
      expect(v8.verno).toBe(8);
      const legacy = await v8.rules.get('legacy-rule-1');
      expect(legacy).toBeDefined();
      expect(legacy?.status).toBeUndefined();
      expect(legacy?.stats).toBeUndefined();
      expect(await v8.auto_decisions.count()).toBe(0);
      v8.close();
      await Dexie.delete(upgradeDbName);
    });
  });

  describe('recordDecision & attachDecisionToTx & pruning', () => {
    it('截斷摘要至 160 字元以內、產生 rawHash 且不儲存完整原文', async () => {
      const longRaw = '國泰世華信用卡消費通知：您於 2026/11/27 在星巴克門市刷卡消費 TWD 185 元，'.repeat(5);
      const decision = await recordDecision({
        source: 'notify',
        sourceEventId: 'evt-1',
        outcome: 'auto_booked',
        parserVersion: 'v2',
        rawText: longRaw,
      });

      expect(decision.rawHash).toBeTruthy();
      expect(decision.snippet.length).toBeLessThanOrEqual(SNIPPET_MAX_LEN);
      expect('rawText' in decision).toBe(false);

      await attachDecisionToTx(decision.id, 'tx-999');
      const stored = await db.auto_decisions.get(decision.id);
      expect(stored?.txId).toBe('tx-999');
    });

    it('清理超過 90 天的舊決策紀錄', async () => {
      const now = Date.now();
      const oldTs = now - 91 * DAY_MS;
      const freshTs = now - 5 * DAY_MS;

      await recordDecision({ id: 'old-1', ts: oldTs, source: 'notify', outcome: 'review', rawText: 'old msg' });
      await recordDecision({ id: 'fresh-1', ts: freshTs, source: 'notify', outcome: 'auto_booked', rawText: 'fresh msg' });
      await recordDecision({ id: 'now-1', ts: now, source: 'notify', outcome: 'auto_booked', rawText: 'now msg' });

      expect(await db.auto_decisions.get('old-1')).toBeUndefined();
      expect(await db.auto_decisions.get('fresh-1')).toBeDefined();
      expect(await db.auto_decisions.get('now-1')).toBeDefined();
    });

    it('超過 2000 筆上限時保留最新 2000 筆', async () => {
      const now = Date.now();
      const rows = Array.from({ length: DECISION_MAX_ROWS + 5 }, (_, i) => ({
        id: `d-${i}`,
        ts: now - (DECISION_MAX_ROWS + 5 - i) * 1000,
        source: 'notify',
        outcome: 'auto_booked' as const,
        rawHash: `h-${i}`,
        snippet: `msg-${i}`,
      }));
      await db.auto_decisions.bulkPut(rows);

      await recordDecision({ id: 'd-latest', ts: now + 1000, source: 'notify', outcome: 'auto_booked', rawText: 'latest' });

      expect(await db.auto_decisions.count()).toBe(DECISION_MAX_ROWS);
      expect(await db.auto_decisions.get('d-0')).toBeUndefined();
      expect(await db.auto_decisions.get('d-latest')).toBeDefined();
    });
  });

  describe('Rule Lifecycle: shadow -> active & active -> paused', () => {
    it('shadow 規則累積 2 次無修正 confirm_clean 後自動升為 active', async () => {
      await db.rules.put(
        makeRule({
          id: 'r-shadow',
          status: 'shadow',
          stats: {
            shown: 2,
            autoBooked: 0,
            cleanAccepted: 0,
            editedCategory: 0,
            editedAccount: 0,
            editedAmount: 0,
            rejected: 0,
          },
        }),
      );

      const res1 = await recordFeedback({ ruleId: 'r-shadow', signalType: 'confirm_clean' });
      expect(res1.rule?.status).toBe('shadow');
      expect(res1.rule?.stats?.cleanAccepted).toBe(1);

      const res2 = await recordFeedback({ ruleId: 'r-shadow', signalType: 'confirm_clean' });
      expect(res2.rule?.status).toBe('active');
      expect(res2.rule?.statusReason).toBe('觀察期通過自動啟用');
      expect(res2.rule?.stats?.cleanAccepted).toBe(2);
    });

    it('shadow 規則若有修正紀錄則不會因 confirm_clean 自動升為 active', async () => {
      await db.rules.put(
        makeRule({
          id: 'r-shadow-edited',
          status: 'shadow',
          stats: {
            shown: 3,
            autoBooked: 0,
            cleanAccepted: 1,
            editedCategory: 1,
            editedAccount: 0,
            editedAmount: 0,
            rejected: 0,
          },
        }),
      );

      const res = await recordFeedback({ ruleId: 'r-shadow-edited', signalType: 'confirm_clean' });
      expect(res.rule?.status).toBe('shadow');
      expect(res.rule?.stats?.cleanAccepted).toBe(2);
    });

    it('active 規則近期修正 >= 3 次且平滑信心 < 0.6 時自動降為 paused', async () => {
      const now = Date.now();
      await db.rules.put(
        makeRule({
          id: 'r-active',
          status: 'active',
          stats: {
            shown: 3,
            autoBooked: 3,
            cleanAccepted: 0,
            editedCategory: 0,
            editedAccount: 0,
            editedAmount: 0,
            rejected: 0,
          },
        }),
      );

      await recordFeedback({ ruleId: 'r-active', signalType: 'edit_field', field: 'category', ts: now - 2000 });
      await recordFeedback({ ruleId: 'r-active', signalType: 'edit_field', field: 'account', ts: now - 1000 });
      const res3 = await recordFeedback({ ruleId: 'r-active', signalType: 'edit_field', field: 'amount', ts: now });

      expect(res3.rule?.status).toBe('paused');
      expect(res3.rule?.statusReason).toBe('近期修正率過高，已轉為待確認');
      expect(res3.rule?.stats?.editedCategory).toBe(1);
      expect(res3.rule?.stats?.editedAccount).toBe(1);
      expect(res3.rule?.stats?.editedAmount).toBe(1);
    });

    it('active 規則收到 >= 2 次 undo_delete 時自動降為 paused', async () => {
      const now = Date.now();
      await db.rules.put(makeRule({ id: 'r-undo', status: 'active' }));

      const r1 = await recordFeedback({ ruleId: 'r-undo', signalType: 'undo_delete', ts: now - 1000 });
      expect(r1.rule?.status).toBe('active');

      const r2 = await recordFeedback({ ruleId: 'r-undo', signalType: 'undo_delete', ts: now });
      expect(r2.rule?.status).toBe('paused');
      expect(r2.rule?.statusReason).toBe('近期修正率過高，已轉為待確認');
      expect(r2.rule?.stats?.rejected).toBe(2);
    });

    it('超過 30 天的舊撤銷紀錄不會導致重新啟用的規則在單次修正後立刻降為 paused', async () => {
      const now = Date.now();
      const oldTs = now - 45 * DAY_MS;
      await db.rules.put(
        makeRule({
          id: 'r-reenabled',
          status: 'active',
          stats: {
            shown: 10,
            autoBooked: 10,
            cleanAccepted: 1,
            editedCategory: 0,
            editedAccount: 0,
            editedAmount: 0,
            rejected: 2,
          },
        }),
      );
      await db.feedback_signals.bulkPut([
        { id: 'old-u1', ts: oldTs, ruleId: 'r-reenabled', signalType: 'undo_delete', weight: 1.5 },
        { id: 'old-u2', ts: oldTs + 1000, ruleId: 'r-reenabled', signalType: 'undo_delete', weight: 1.5 },
      ]);

      const res = await recordFeedback({
        ruleId: 'r-reenabled',
        signalType: 'edit_field',
        field: 'category',
        ts: now,
      });
      expect(res.rule?.status).toBe('active');
    });

    it('computeRuleConfidence 計算平滑信心並對超過 90 天未命中的規則做衰減', () => {
      const now = Date.now();
      const fresh = makeRule({
        stats: {
          shown: 4,
          autoBooked: 4,
          cleanAccepted: 4,
          editedCategory: 0,
          editedAccount: 0,
          editedAmount: 0,
          rejected: 0,
          lastMatchedAt: now - 5 * DAY_MS,
        },
      });
      const freshConf = computeRuleConfidence(fresh, now);
      expect(freshConf.score).toBeCloseTo(6 / 8, 5);
      expect(freshConf.level).toBe('high');

      const stale = makeRule({
        stats: {
          ...fresh.stats!,
          lastMatchedAt: now - 270 * DAY_MS,
        },
      });
      const staleConf = computeRuleConfidence(stale, now);
      expect(staleConf.score).toBeLessThan(freshConf.score);
      expect(staleConf.score).toBeGreaterThan(0.5);
    });
  });

  describe('Feedback signal differentiation & weights', () => {
    it('依訊號類型套用正確權重，且 skip_non_tx / skip_duplicate 不扣分類與帳戶準確率', async () => {
      expect(SIGNAL_WEIGHTS.confirm_clean).toBe(1.0);
      expect(SIGNAL_WEIGHTS.external_reconcile).toBe(1.2);
      expect(SIGNAL_WEIGHTS.external_einvoice).toBe(1.2);
      expect(SIGNAL_WEIGHTS.edit_field).toBe(1.0);
      expect(SIGNAL_WEIGHTS.undo_delete).toBe(1.5);
      expect(SIGNAL_WEIGHTS.skip_ignore).toBe(0.3);
      expect(SIGNAL_WEIGHTS.skip_non_tx).toBe(0);
      expect(SIGNAL_WEIGHTS.skip_duplicate).toBe(0);

      await db.rules.put(makeRule({ id: 'r-diff', status: 'active' }));
      const dec = await recordDecision({
        id: 'dec-diff',
        source: 'notify',
        outcome: 'auto_booked',
        matchedRuleId: 'r-diff',
        rawText: '測試交易 100',
      });

      const sNonTx = await recordFeedback({ decisionId: dec.id, signalType: 'skip_non_tx' });
      const sDup = await recordFeedback({ decisionId: dec.id, signalType: 'skip_duplicate' });
      const sExt = await recordFeedback({ decisionId: dec.id, signalType: 'external_einvoice' });
      const sIgnore = await recordFeedback({ decisionId: dec.id, signalType: 'skip_ignore' });

      expect(sNonTx.signal.ruleId).toBe('r-diff');
      expect(sNonTx.signal.weight).toBe(0);
      expect(sDup.signal.weight).toBe(0);
      expect(sExt.signal.weight).toBe(1.2);
      expect(sIgnore.signal.weight).toBe(0.3);

      const ruleAfter = await db.rules.get('r-diff');
      expect(ruleAfter?.status ?? 'active').toBe('active');
      expect(ruleAfter?.stats?.editedCategory ?? 0).toBe(0);
      expect(ruleAfter?.stats?.editedAccount ?? 0).toBe(0);
      expect(ruleAfter?.stats?.editedAmount ?? 0).toBe(0);
      expect(ruleAfter?.stats?.rejected ?? 0).toBe(0);
    });
  });

  describe('computeHealthMetrics', () => {
    it('空資料庫回傳安全零值', async () => {
      const m = await computeHealthMetrics(30);
      expect(m.totalDecisions).toBe(0);
      expect(m.uneditedAutoBookRate).toBe(0);
      expect(m.autoCoverageRate).toBe(0);
      expect(m.reviewRate).toBe(0);
      expect(m.duplicateFalsePositiveRate).toBe(0);
      expect(m.mostEditedRules).toEqual([]);
      expect(m.candidateConflicts).toEqual([]);
    });

    it('正確計算 North Star、各欄位修正率、重複誤判率、高修正規則與候選衝突', async () => {
      const now = Date.now();
      await db.rules.put(makeRule({ id: 'r-bad', keyword: 'Uber', status: 'active' }));

      // 2 筆 auto_booked（其中 1 筆被修正分類）、1 筆 review（被修正金額）、1 筆 skipped_duplicate（被撤銷誤判）
      await recordDecision({
        id: 'd-auto-1',
        ts: now - 1000,
        source: 'notify',
        outcome: 'auto_booked',
        matchedRuleId: 'r-bad',
        rawText: 'Uber 120',
      });
      await recordDecision({
        id: 'd-auto-2',
        ts: now - 900,
        source: 'notify',
        outcome: 'auto_booked',
        rawText: '全聯 350',
        candidates: [
          { ruleId: 'r-a', categoryId: 'cat-grocery', score: 0.8 },
          { ruleId: 'r-b', categoryId: 'cat-daily', score: 0.7 },
        ],
      });
      await recordDecision({
        id: 'd-rev-1',
        ts: now - 800,
        source: 'email',
        outcome: 'review',
        rawText: 'Amazon USD 20',
      });
      await recordDecision({
        id: 'd-dup-1',
        ts: now - 700,
        source: 'notify',
        outcome: 'skipped_duplicate',
        rawText: '星巴克 150',
      });

      await recordFeedback({ decisionId: 'd-auto-1', ruleId: 'r-bad', signalType: 'edit_field', field: 'category', ts: now - 500 });
      await recordFeedback({ decisionId: 'd-rev-1', signalType: 'edit_field', field: 'amount', ts: now - 400 });
      await recordFeedback({ decisionId: 'd-dup-1', signalType: 'undo_delete', ts: now - 300 });

      const m = await computeHealthMetrics(30, now);

      expect(m.totalDecisions).toBe(4);
      expect(m.autoBookedCount).toBe(2);
      expect(m.reviewCount).toBe(1);
      expect(m.skippedCount).toBe(1);
      expect(m.uneditedAutoBookRate).toBeCloseTo(0.5, 5);
      expect(m.autoCoverageRate).toBeCloseTo(0.5, 5);
      expect(m.reviewRate).toBeCloseTo(0.25, 5);
      expect(m.fieldEditRates.category).toBeCloseTo(1 / 3, 5);
      expect(m.fieldEditRates.amount).toBeCloseTo(1 / 3, 5);
      expect(m.fieldEditRates.account).toBe(0);
      expect(m.duplicateFalsePositiveRate).toBeCloseTo(1, 5);
      expect(m.mostEditedRules[0]).toMatchObject({
        ruleId: 'r-bad',
        keyword: 'Uber',
        editCount: 1,
      });
      expect(m.candidateConflicts).toHaveLength(1);
      expect(m.candidateConflicts[0].decisionId).toBe('d-auto-2');
      expect(m.candidateConflicts[0].categoryIds).toEqual(['cat-grocery', 'cat-daily']);
    });

    it('計算健康指標時忽略超過 now 的未來資料且重複誤判率不超過 1', async () => {
      const now = Date.now();
      await recordDecision({
        id: 'd-dup-only',
        ts: now - 1000,
        source: 'notify',
        outcome: 'skipped_duplicate',
        rawText: '重複測試',
      });
      await recordDecision({
        id: 'd-future',
        ts: now + 5000,
        source: 'notify',
        outcome: 'auto_booked',
        rawText: '未來測試',
      });
      await recordFeedback({ decisionId: 'd-dup-only', signalType: 'confirm_clean', ts: now - 500 });
      await recordFeedback({ decisionId: 'd-dup-only', signalType: 'undo_delete', ts: now - 400 });

      const m = await computeHealthMetrics(30, now);
      expect(m.totalDecisions).toBe(1);
      expect(m.duplicateFalsePositiveRate).toBe(1);
    });
  });
});
