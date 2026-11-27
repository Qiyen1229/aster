import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/schema';
import { buildDefaultCategories } from '@/db/seed/categories';
import { addAccount } from '@/db/repo/accounts';
import { addTransaction, deleteTransactions } from '@/db/repo/ledger';
import { DEFAULT_SETTINGS } from '@/db/repo/settings';
import {
  createScopedRule,
  evaluateDraftContext,
  invalidateAutocat,
  saveRule,
  suggestAccount,
  suggestCategory,
} from '@/services/autocat';
import {
  bookInboxEntries,
  confirmInboxEntry,
  invalidateInboxReadOnly,
  loadInbox,
  mergeDuplicate,
  previewAutoBook,
  processInboxOnStartup,
  skipInboxEntry,
  type InboxRaw,
} from '@/services/inbox';
import { applyFixes } from '@/services/reconcile';
import { importInvoices } from '@/services/einvoice';
import { recordDecision } from '@/services/decisionLog';
import { useSettings } from '@/stores/settings';
import { useInboxCount } from '@/services/inboxCount';

const mock = vi.hoisted(() => ({
  items: [] as InboxRaw[],
}));

vi.mock('@/services/api', async (orig) => ({
  ...await orig<typeof import('@/services/api')>(),
  api: vi.fn(async (path: string, opts?: { body?: { ids?: number[] } }) => {
    if (path === '/inbox/items') return structuredClone(mock.items);
    if (path === '/inbox/items/booking') return { message: '已登記' };
    if (path === '/inbox/items/ack') {
      const ids = opts?.body?.ids ?? [];
      mock.items = mock.items.filter((i) => !ids.includes(i.id));
      return { ids };
    }
    throw new Error(`Unexpected API: ${path}`);
  }),
}));

vi.mock('@/services/fx', async (orig) => ({
  ...await orig<typeof import('@/services/fx')>(),
  getRate: vi.fn(async () => null),
}));

const raw = (id: number, patch: Partial<InboxRaw> = {}): InboxRaw => ({
  id,
  source: 'notify',
  text: '',
  amount: '',
  merchant: '',
  card: '',
  occurred: '2026-11-20',
  created_at: '2026-11-20T08:00:00Z',
  ...patch,
});

describe('Wave 2A Service Integration', () => {
  let accId = '';
  let cardAccId = '';

  beforeEach(async () => {
    await db.delete();
    await db.open();
    await db.categories.bulkAdd(buildDefaultCategories());
    invalidateAutocat();
    invalidateInboxReadOnly();
    mock.items = [];
    useInboxCount.getState().set(0);
    useSettings.setState(structuredClone(DEFAULT_SETTINGS));
    accId = (await addAccount({
      name: '預設銀行',
      type: 'bank',
      currency: 'TWD',
      icon: '',
      color: '',
      initialBalanceMinor: 100000,
      includeInNetWorth: true,
      isLiability: false,
    })).id;
    cardAccId = (await addAccount({
      name: '中信卡',
      type: 'credit',
      currency: 'TWD',
      icon: '',
      color: '',
      initialBalanceMinor: 0,
      includeInNetWorth: true,
      isLiability: true,
    })).id;
    useSettings.setState({
      lastAccountId: accId,
      inbox: { ...DEFAULT_SETTINGS.inbox, defaultAccountId: accId },
    });
  });

  describe('autocat.ts: MerchantAlias, ContextRules, Shadow, and Backward Compat', () => {
    it('treats legacy rules with status=undefined as active and integrates normalizeMerchantAlias + context', async () => {
      await saveRule({
        keyword: '星巴克',
        match: 'contains',
        kind: 'expense',
        categoryId: 'exp-food-drink',
        priority: 10,
        enabled: true,
      });

      await saveRule({
        keyword: '',
        match: 'contains',
        kind: 'expense',
        merchantAlias: 'Uber',
        source: 'ctbc',
        card: '8899',
        categoryId: 'exp-transport',
        accountId: cardAccId,
        priority: 20,
        enabled: true,
        status: 'active',
      });

      const legacyHit = await suggestCategory('星巴克信義門市', 'expense', 150);
      expect(legacyHit?.source).toBe('rule');
      expect(legacyHit?.categoryId).toBe('exp-food-drink');

      const ctxCat = await suggestCategory('ECPAY*UBER *TRIP #1234', 'expense', 220, 'ECPAY*UBER *TRIP #1234', {
        source: 'ctbc',
        card: '中信LINE Pay卡 (8899)',
        currency: 'TWD',
      });
      expect(ctxCat?.source).toBe('rule');
      expect(ctxCat?.categoryId).toBe('exp-transport');

      const ctxAcc = await suggestAccount('ECPAY*UBER *TRIP #1234', 'expense', 220, 'ECPAY*UBER *TRIP #1234', {
        source: 'ctbc',
        card: '中信LINE Pay卡 (8899)',
      });
      expect(ctxAcc?.source).toBe('rule');
      expect(ctxAcc?.accountId).toBe(cardAccId);
    });

    it('createScopedRule defaults to shadow status and version 1; evaluateDraftContext returns primary, secondCandidate, shadowPredictions, merchantAlias', async () => {
      const shadow = await createScopedRule({
        merchantAlias: 'Uber',
        categoryId: 'exp-transport',
        source: 'ctbc',
      });
      expect(shadow.status).toBe('shadow');
      expect(shadow.version).toBe(1);

      const r1 = await saveRule({
        keyword: '星巴克',
        match: 'contains',
        kind: 'expense',
        categoryId: 'exp-food-drink',
        source: 'ctbc',
        priority: 10,
        enabled: true,
        status: 'active',
      });
      const r2 = await saveRule({
        keyword: '星巴克',
        match: 'contains',
        kind: 'expense',
        categoryId: 'exp-food-lunch',
        priority: 20,
        enabled: true,
        status: 'active',
      });

      const evalRes = await evaluateDraftContext({
        rawText: '於 星巴克台北101門市 消費 NT$ 165',
        merchant: '星巴克台北101門市',
        kind: 'expense',
        amount: 165,
        source: 'ctbc',
      });
      expect(evalRes.primary?.rule.id).toBe(r1.id);
      expect(evalRes.secondCandidate?.rule.id).toBe(r2.id);
      expect(evalRes.matchedRuleIds).toEqual([r1.id]);
      expect(evalRes.merchantAlias.alias).toBe('星巴克');
      expect(evalRes.confidence).toBe('high');

      const shadowEval = await evaluateDraftContext({
        rawText: 'ECPAY*UBER *TRIP',
        merchant: 'ECPAY*UBER *TRIP',
        kind: 'expense',
        amount: 180,
        source: 'ctbc',
      });
      expect(shadowEval.primary).toBeUndefined();
      expect(shadowEval.shadowPredictions).toHaveLength(1);
      expect(shadowEval.shadowPredictions[0].rule.id).toBe(shadow.id);
    });
  });

  describe('inbox.ts: SourceTemplates, Drift, Shadow Mode, Decisions & Feedback', () => {
    it('forces review on pending/cancelled refunds so they are never auto-booked', async () => {
      useSettings.setState({ inbox: { ...DEFAULT_SETTINGS.inbox, autoBook: true, defaultAccountId: accId } });
      mock.items = [
        raw(101, {
          text: '【中國信託】您的 Uber 退款申請處理中，金額 NT$ 150',
        }),
        raw(102, {
          text: '【玉山銀行】您的 蝦皮 退款取消，金額 NT$ 300',
        }),
      ];

      const entries = await loadInbox();
      expect(entries).toHaveLength(2);
      expect(entries[0].review).toContain('退款處理中');
      expect(entries[1].review).toContain('退款已取消');

      const startup = await processInboxOnStartup();
      expect(startup).toMatchObject({ booked: 0, pending: 2 });
    });

    it('detects template drift after 3 consecutive unparseable failures for a known source', async () => {
      mock.items = [
        raw(201, { text: '中國信託通知：您有一筆消費交易，請查看明細' }),
        raw(202, { text: '中國信託通知：您有一筆刷卡交易，請查看明細' }),
        raw(203, { text: '中國信託通知：您有一筆扣款交易，請查看明細' }),
      ];

      const entries = await loadInbox();
      expect(entries[2].driftWarning).toBeTruthy();
      expect(entries[2].review).toBeTruthy();
    });

    it('shadow rule does NOT auto-book; confirming twice via confirmInboxEntry promotes shadow -> active', async () => {
      const shadow = await createScopedRule({
        merchantAlias: '星巴克',
        categoryId: 'exp-food-drink',
        source: 'ctbc',
      });
      useSettings.setState({ inbox: { ...DEFAULT_SETTINGS.inbox, autoBook: true, defaultAccountId: accId } });

      mock.items = [
        raw(301, {
          text: '【中國信託】消費通知：於 星巴克信義門市 消費 NT$ 165',
        }),
      ];

      const entries1 = await loadInbox();
      expect(entries1[0].decisionId).toBeTruthy();
      expect(entries1[0].shadowMatch?.ruleId).toBe(shadow.id);
      expect(entries1[0].review).toBeTruthy();

      // Auto-booking must NOT book shadow-only entries
      const startup = await processInboxOnStartup();
      expect(startup?.booked).toBe(0);

      // Human confirms clean #1
      await confirmInboxEntry(entries1[0]);
      let updatedRule = await db.rules.get(shadow.id);
      expect(updatedRule?.status).toBe('shadow');
      expect(updatedRule?.stats?.cleanAccepted).toBe(1);

      // Second item confirmed clean #2 -> promotes to active!
      mock.items = [
        raw(302, {
          text: '【中國信託】消費通知：於 星巴克台北101店 消費 NT$ 180',
        }),
      ];
      const entries2 = await loadInbox();
      await confirmInboxEntry(entries2[0]);
      updatedRule = await db.rules.get(shadow.id);
      expect(updatedRule?.status).toBe('active');
      expect(updatedRule?.stats?.cleanAccepted).toBe(2);
    });

    it('auto-booking persists decisionId on Transaction without emitting confirm_clean; manual edit emits edit_field', async () => {
      await saveRule({
        keyword: '全聯',
        match: 'contains',
        kind: 'expense',
        categoryId: 'exp-food-grocery',
        source: 'ctbc',
        priority: 10,
        enabled: true,
        status: 'active',
      });
      useSettings.setState({ inbox: { ...DEFAULT_SETTINGS.inbox, autoBook: true, defaultAccountId: accId } });

      mock.items = [
        raw(401, {
          text: '【中國信託】消費通知：於 全聯福利中心 消費 NT$ 250',
        }),
      ];
      const entries = await loadInbox();
      const decId = entries[0].decisionId!;
      expect(decId).toBeTruthy();

      const res = await bookInboxEntries(entries, { auto: true });
      expect(res.txIds).toHaveLength(1);
      const tx = await db.transactions.get(res.txIds[0]);
      expect(tx?.decisionId).toBe(decId);
      const dec = await db.auto_decisions.get(decId);
      expect(dec?.txId).toBe(tx?.id);
      expect(dec?.outcome).toBe('auto_booked');

      // Must NOT emit confirm_clean on auto-booking
      const autoSignals = await db.feedback_signals.toArray();
      expect(autoSignals.filter((s) => s.signalType === 'confirm_clean')).toHaveLength(0);

      // Manual confirm with edited field emits edit_field
      mock.items = [
        raw(402, {
          text: '【中國信託】消費通知：於 全聯福利中心 消費 NT$ 300',
        }),
      ];
      const entries2 = await loadInbox();
      await confirmInboxEntry(entries2[0], {
        editedFields: [{ field: 'category', beforeValue: 'exp-food-grocery', afterValue: 'exp-food-snack' }],
      });
      const signals = await db.feedback_signals.where('decisionId').equals(entries2[0].decisionId!).toArray();
      expect(signals).toHaveLength(1);
      expect(signals[0].signalType).toBe('edit_field');
      expect(signals[0].field).toBe('category');
    });

    it('skipInboxEntry and mergeDuplicate emit their respective feedback signals', async () => {
      mock.items = [
        raw(501, { text: '【中國信託】消費通知：於 7-ELEVEN 消費 NT$ 85' }),
        raw(502, { text: '【中國信託】消費通知：於 全家 消費 NT$ 65' }),
      ];
      const entries = await loadInbox();
      await skipInboxEntry(entries[0], 'non_tx');
      await skipInboxEntry(entries[1], 'ignore');

      const s1 = await db.feedback_signals.where('decisionId').equals(entries[0].decisionId!).toArray();
      const s2 = await db.feedback_signals.where('decisionId').equals(entries[1].decisionId!).toArray();
      expect(s1[0].signalType).toBe('skip_non_tx');
      expect(s2[0].signalType).toBe('skip_ignore');

      // Merge duplicate
      const existingTx = await addTransaction({
        type: 'expense',
        accountId: accId,
        categoryId: 'exp-food-drink',
        amountMinor: 12000,
        currency: 'TWD',
        date: '2026-11-20',
        ts: Date.now(),
        note: '星巴克',
      });
      mock.items = [raw(503, { text: '【中國信託】消費通知：於 星巴克 消費 NT$ 120' })];
      const dupEntries = await loadInbox();
      dupEntries[0].dup = { level: 'strong', from: 'ledger', txId: existingTx.id, label: '星巴克' };
      await mergeDuplicate(dupEntries[0]);
      const s3 = await db.feedback_signals.where('decisionId').equals(dupEntries[0].decisionId!).toArray();
      expect(s3.some((s) => s.signalType === 'merge_duplicate')).toBe(true);
    });
  });

  describe('ledger.ts, reconcile.ts, einvoice.ts: Downstream Feedback Signals', () => {
    it('deleteTransactions emits undo_delete for recent transaction with decisionId', async () => {
      const dec = await recordDecision({ source: 'ctbc', outcome: 'auto_booked', rawText: 'test' });
      const tx = await addTransaction({
        type: 'expense',
        accountId: accId,
        categoryId: 'exp-food-lunch',
        amountMinor: 10000,
        currency: 'TWD',
        date: '2026-11-20',
        ts: Date.now(),
        note: '便當',
        decisionId: dec.id,
      });
      await deleteTransactions([tx.id]);
      await vi.waitFor(async () => {
        const sigs = await db.feedback_signals.where('decisionId').equals(dec.id).toArray();
        expect(sigs.some((s) => s.signalType === 'undo_delete')).toBe(true);
      });
    });

    it('applyFixes emits external_reconcile for matched ledger transactions with decisionId', async () => {
      const dec = await recordDecision({ source: 'ctbc', outcome: 'auto_booked', rawText: 'test reconcile' });
      const tx = await addTransaction({
        type: 'expense',
        accountId: accId,
        categoryId: 'exp-food-lunch',
        amountMinor: 25000,
        currency: 'TWD',
        date: '2026-11-20',
        ts: Date.now(),
        note: '全聯',
        decisionId: dec.id,
      });
      const acc = (await db.accounts.get(accId))!;
      await applyFixes(acc, {
        missing: [],
        variances: [],
        matched: [
          {
            stmt: { id: 's1', date: '2026-11-20', amountMinor: 25000, kind: 'expense', text: '全聯' },
            ledger: { id: tx.id, date: '2026-11-20', accountMinor: 25000, origMinor: 25000, origCurrency: 'TWD', kind: 'expense', text: '全聯' },
            diffMinor: 0,
            dayGap: 0,
          },
        ],
        adjustTo: null,
      });
      await vi.waitFor(async () => {
        const sigs = await db.feedback_signals.where('decisionId').equals(dec.id).toArray();
        expect(sigs.some((s) => s.signalType === 'external_reconcile')).toBe(true);
      });
    });

    it('importInvoices emits external_einvoice when matching a transaction with decisionId', async () => {
      const dec = await recordDecision({ source: 'ctbc', outcome: 'auto_booked', rawText: 'test einvoice' });
      await addTransaction({
        type: 'expense',
        accountId: accId,
        categoryId: 'exp-food-lunch',
        amountMinor: 15000,
        currency: 'TWD',
        date: '2026-11-20',
        ts: Date.now(),
        note: '統一超商',
        merchant: '統一超商',
        decisionId: dec.id,
      });
      const res = await importInvoices(
        [
          {
            number: 'AB12345678',
            date: '2026-11-20',
            amount: 150,
            sellerId: '12345678',
            sellerName: '統一超商',
            status: '開立',
            items: [{ name: '咖啡' }],
          },
        ],
        { defaultAccountId: accId },
      );
      expect(res.matched).toBe(1);
      await vi.waitFor(async () => {
        const sigs = await db.feedback_signals.where('decisionId').equals(dec.id).toArray();
        expect(sigs.some((s) => s.signalType === 'external_einvoice')).toBe(true);
      });
    });
  });

  describe('Wave 2A Review Edge Cases', () => {
    it('scoped active rule does NOT leak through legacy matchRule fallback when context mismatches', async () => {
      await saveRule({
        keyword: '星巴克',
        match: 'contains',
        kind: 'expense',
        source: 'ctbc',
        categoryId: 'exp-food-drink',
        accountId: cardAccId,
        priority: 1,
        enabled: true,
        status: 'active',
      });

      const catWrongSource = await suggestCategory('星巴克', 'expense', 150, '星巴克', { source: 'esun' });
      expect(catWrongSource?.ruleId).toBeUndefined();

      const accWrongSource = await suggestAccount('星巴克', 'expense', 150, '星巴克', { source: 'esun' });
      expect(accWrongSource?.ruleId).toBeUndefined();
    });

    it('infers source template from item.card and populates previewAutoBook decision context', async () => {
      const shadow = await createScopedRule({
        merchantAlias: '星巴克',
        categoryId: 'exp-food-drink',
        source: 'ctbc',
      });
      mock.items = [
        raw(601, {
          card: '中國信託',
          text: '消費金額 NT$ 165 特店名稱：星巴克',
        }),
      ];
      const entries = await loadInbox();
      expect(entries).toHaveLength(1);
      expect(entries[0].shadowMatch?.ruleId).toBe(shadow.id);
      expect(entries[0].drafts[0].amount).toBe(165);

      const preview = await previewAutoBook('消費金額 NT$ 165 特店名稱：星巴克', '中國信託', '星巴克');
      expect(preview.shadowMatch?.ruleId).toBe(shadow.id);
      expect(preview.confidence).toBe('low');
      expect(preview.decisionReasons).toContain('only_shadow_or_candidate_matched');
    });

    it('editing a shadow-matched entry prevents premature shadow->active promotion; active+shadow still auto-books', async () => {
      const shadow = await createScopedRule({
        merchantAlias: '路易莎',
        categoryId: 'exp-food-drink',
        source: 'ctbc',
      });

      mock.items = [
        raw(701, { text: '【中國信託】消費通知：於 路易莎 消費 NT$ 95' }),
      ];
      const e1 = await loadInbox();
      await confirmInboxEntry(e1[0], {
        editedFields: [{ field: 'category', beforeValue: 'exp-food-drink', afterValue: 'exp-food-snack' }],
      });

      // Confirm 2 more clean -> should remain shadow because totalEdits > 0
      mock.items = [
        raw(702, { text: '【中國信託】消費通知：於 路易莎 消費 NT$ 100' }),
        raw(703, { text: '【中國信託】消費通知：於 路易莎 消費 NT$ 110' }),
      ];
      const e23 = await loadInbox();
      await confirmInboxEntry(e23[0]);
      await confirmInboxEntry(e23[1]);
      const shadowAfter = await db.rules.get(shadow.id);
      expect(shadowAfter?.stats?.editedCategory).toBe(1);
      expect(shadowAfter?.status).toBe('shadow');

      // Active rule + unrelated shadow rule -> still auto-books!
      await saveRule({
        keyword: '全聯',
        match: 'contains',
        kind: 'expense',
        source: 'ctbc',
        categoryId: 'exp-food-grocery',
        priority: 10,
        enabled: true,
        status: 'active',
      });
      await createScopedRule({
        keyword: '全聯',
        categoryId: 'exp-food-snack',
        source: 'ctbc',
      });
      mock.items = [
        raw(704, { text: '【中國信託】消費通知：於 全聯 消費 NT$ 220' }),
      ];
      const e4 = await loadInbox();
      expect(e4[0].review).toBeUndefined();
      expect(e4[0].shadowMatch).toBeTruthy();
      const autoRes = await bookInboxEntries(e4, { auto: true });
      expect(autoRes.txIds).toHaveLength(1);
    });
  });
});
