import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/schema';
import { buildDefaultCategories } from '@/db/seed/categories';
import { addAccount, deleteOrArchiveAccount, recomputeBalances } from '@/db/repo/accounts';
import { addTransaction, deleteTransactions, restoreTransactions, updateTransaction } from '@/db/repo/ledger';
import { addDebts, addLoan, addInstallment, computeBudgets, confirmPending, processRecurring, saveBudget, saveRecurring } from '@/db/repo/plan';
import { parseEntries } from '@/domain/nlp';
import { totals } from '@/domain/ledger';
import { findDuplicate, normalizeShop } from '@/domain/dedupe';
import { bookDrafts, commitManualEntry, parseContext, resolveDraft, type ResolvedDraft } from '@/services/quickentry';
import { bookInboxEntries, draftsFromItem, invalidateInboxReadOnly, loadInboxReadOnly, markDuplicates, matchesWhitelist, processInboxOnStartup, type InboxEntry, type InboxRaw } from '@/services/inbox';
import { invalidateAutocat, saveRule, suggestAccount } from '@/services/autocat';
import { useSettings } from '@/stores/settings';
import { DEFAULT_SETTINGS } from '@/db/repo/settings';

const server = vi.hoisted(() => ({ items: [] as InboxRaw[], failAck: false, failBooking: false, shapes: new Map<number, string>(), acked: [] as number[] }));
vi.mock('@/services/api', async (original) => ({
  ...await original<typeof import('@/services/api')>(),
  api: vi.fn(async (path: string, opts?: { body?: { ids: number[]; id?: number; shape?: string[] } }) => {
    if (path === '/inbox/items') return structuredClone(server.items);
    if (path === '/inbox/items/booking') {
      if (server.failBooking) throw new Error('來源登記離線');
      const id = opts!.body!.id!, shape = JSON.stringify(opts!.body!.shape);
      if (server.shapes.has(id) && server.shapes.get(id) !== shape) throw new Error('來源結構衝突');
      server.shapes.set(id, shape);
      return { message: '已登記' };
    }
    if (path === '/inbox/items/ack') {
      if (server.failAck) throw new Error('離線');
      const ids = opts!.body!.ids.filter((id) => server.items.some((i) => i.id === id));
      server.acked.push(...ids);
      server.items = server.items.filter((i) => !ids.includes(i.id));
      return { ids };
    }
    throw new Error(`未預期的 API：${path}`);
  }),
}));
vi.mock('@/services/ai', () => ({ aiEnabledLocally: () => false }));
vi.mock('@/services/fx', async (original) => ({ ...await original<typeof import('@/services/fx')>(), getRate: vi.fn(async () => null) }));

let accountId = '';
const draft = (patch: Partial<ResolvedDraft> = {}): ResolvedDraft => ({
  kind: 'expense', amount: 100, currency: 'TWD', date: '2026-11-18', dateGiven: true, accountId,
  note: '早餐', raw: '早餐 100', categoryId: 'exp-food-breakfast', tagIds: [], categorySource: 'default', accountSource: 'default', ...patch,
});
const raw = (id: number, patch: Partial<InboxRaw> = {}): InboxRaw => ({
  id, source: 'sms', text: '早餐 100', amount: '', card: '', merchant: '', occurred: '2026-11-18', created_at: '2026-11-18T08:00:00Z', ...patch,
});
const txInput = (amountMinor = 20000) => ({ type: 'expense' as const, amountMinor, accountId, categoryId: 'exp-food', currency: 'TWD', date: '2026-11-18', ts: 1 });
const recurring = (patch: Partial<Parameters<typeof saveRecurring>[0]> = {}) => saveRecurring({
  kind: 'normal', name: '扣款', active: 1, mode: 'auto', remindDaysBefore: 0, startDate: '2026-09-01',
  rule: { freq: 'month', interval: 1 }, template: txInput(10000), ...patch,
});

beforeEach(async () => {
  await db.delete(); await db.open();
  await db.categories.bulkAdd(buildDefaultCategories());
  invalidateAutocat(); invalidateInboxReadOnly();
  server.items = []; server.acked = []; server.failAck = false; server.failBooking = false; server.shapes.clear();
  useSettings.setState(structuredClone(DEFAULT_SETTINGS));
  accountId = (await addAccount({ name: '甲銀行', type: 'bank', currency: 'TWD', icon: '', color: '', initialBalanceMinor: 100000, includeInNetWorth: true, isLiability: false })).id;
  useSettings.setState({ lastAccountId: accountId });
});

describe('v4.1.50 帳務一致性', () => {
  it('手動帳目、欠款與耐用品遇到尾端失敗會全部回復，重試不重複', async () => {
    const save = vi.fn(async () => {
      const tx = await addTransaction({ ...txInput(), id: 'inbox-22-0' });
      await db.people.put({ id: 'person', name: '朋友', createdAt: 0, updatedAt: 0 });
      await addDebts([{ id: `${tx.id}-debt-0`, personId: 'person', direction: 'they_owe_me', amountMinor: 10000, currency: 'TWD', date: tx.date, note: '', transactionId: tx.id }]);
      await db.durables.put({ id: `durable-${tx.id}`, name: '物品', icon: '', purchaseDate: tx.date, costMinor: 10000, currency: 'TWD', status: 'active', txId: tx.id, createdAt: 0, updatedAt: 0 });
    });
    await expect(commitManualEntry('inbox-22', async () => { await save(); throw new Error('失敗'); })).rejects.toThrow('失敗');
    expect(await db.transactions.count()).toBe(0);
    expect(await db.debts.count()).toBe(0);
    expect(await db.durables.count()).toBe(0);
    expect(await db.people.count()).toBe(0);
    expect((await db.accounts.get(accountId))?.balanceMinor).toBe(100000);
    expect(await db.meta.get('booked:inbox-22')).toBeUndefined();
    expect(await commitManualEntry('inbox-22', save)).toBe(true);
    expect(await commitManualEntry('inbox-22', save)).toBe(false);
    expect(save).toHaveBeenCalledTimes(2);
    expect(await db.transactions.count()).toBe(1);
    expect(await db.debts.count()).toBe(1);
    expect(await db.durables.count()).toBe(1);
  });

  it('黑名單通知清除失敗仍列為待處理，不能自動入帳', async () => {
    server.items = [raw(44, { text: '封鎖商家 100' })];
    server.failAck = true;
    useSettings.setState({ inbox: { ...DEFAULT_SETTINGS.inbox, autoBook: true, blacklist: ['封鎖商家'] } });
    expect(await processInboxOnStartup()).toMatchObject({ booked: 0, pending: 1 });
    expect(await db.transactions.count()).toBe(0);
    expect(server.items).toHaveLength(1);
    server.failAck = false;
    expect(await processInboxOnStartup()).toMatchObject({ booked: 0, pending: 0 });
    expect(server.items).toHaveLength(0);
  });

  it('來源登記離線時不入帳；另一裝置改用不同筆數或類型也不能重複', async () => {
    server.failBooking = true;
    await expect(bookDrafts([draft()], { sourceId: 'inbox-30' })).rejects.toThrow('離線');
    expect(await db.transactions.count()).toBe(0);
    server.failBooking = false;
    await bookDrafts([draft(), draft()], { sourceId: 'inbox-30' });
    const accounts = await db.accounts.toArray();
    await db.delete(); await db.open();
    await db.accounts.bulkPut(accounts.map((a) => ({ ...a, balanceMinor: a.initialBalanceMinor })));
    await db.categories.bulkAdd(buildDefaultCategories());
    await expect(bookDrafts([draft()], { sourceId: 'inbox-30' })).rejects.toThrow('衝突');
    await expect(commitManualEntry('inbox-30', async () => {}, ['debts'])).rejects.toThrow('衝突');
    expect(await db.transactions.count()).toBe(0);
    const result = await bookDrafts([draft(), draft()], { sourceId: 'inbox-30' });
    expect(result.txIds).toEqual(['inbox-30-0', 'inbox-30-1']);
    expect((await db.accounts.get(accountId))?.balanceMinor).toBe(80000);
  });

  it('借貸固定來源只記一次；帳戶失敗不留下人或欠款', async () => {
    const input = { id: 'inbox-23-0', direction: 'they_owe_me' as const, personName: '朋友', amountMinor: 10000, currency: 'TWD', date: '2026-11-18', ts: 1, note: '', accountId };
    await expect(addLoan({ ...input, accountId: 'missing' })).rejects.toThrow('帳戶');
    expect(await db.people.count()).toBe(0);
    expect(await db.debts.count()).toBe(0);
    await Promise.all([addLoan(input), addLoan(input)]);
    expect(await db.debts.count()).toBe(1);
    expect(await db.transactions.count()).toBe(1);
    expect((await db.accounts.get(accountId))?.balanceMinor).toBe(90000);
  });

  it('整批第二筆帳戶無效時，不留下第一筆或餘額變化', async () => {
    await expect(bookDrafts([draft(), draft({ accountId: 'missing' })])).rejects.toThrow('帳戶');
    expect(await db.transactions.count()).toBe(0);
    expect((await db.accounts.get(accountId))?.balanceMinor).toBe(100000);
  });

  it('交易中途餘額溢位會回復整批', async () => {
    await db.accounts.update(accountId, { balanceMinor: -Number.MAX_SAFE_INTEGER + 15000 });
    await expect(bookDrafts([draft(), draft()])).rejects.toThrow('餘額');
    expect(await db.transactions.count()).toBe(0);
    expect((await db.accounts.get(accountId))?.balanceMinor).toBe(-Number.MAX_SAFE_INTEGER + 15000);
  });

  it('保留草稿明確指定的時間', async () => {
    const r = await bookDrafts([draft({ time: '08:15' })]);
    const tx = (await db.transactions.get(r.txIds[0]))!;
    expect(new Date(tx.ts).getHours()).toBe(8);
    expect(new Date(tx.ts).getMinutes()).toBe(15);
  });

  it('負數支出正規化為正數收入，帳務與統計方向一致', async () => {
    const parsed = parseEntries('午餐 -100', await parseContext('2026-11-18'))[0];
    expect(parsed).toMatchObject({ kind: 'income', amount: 100 });
    await bookDrafts([await resolveDraft(parsed, accountId)]);
    expect((await db.accounts.get(accountId))?.balanceMinor).toBe(110000);
    expect(totals(await db.transactions.toArray()).income).toBe(10000);
    await expect(addTransaction(txInput(-10000))).rejects.toThrow('非負');
  });

  it.each(['甲銀行收到乙銀行轉入100元', '昨天 甲銀行收到乙銀行轉入100元', '100元 甲銀行收到乙銀行轉入'])('轉帳方向正確：%s', async (text) => {
    const b = await addAccount({ name: '乙銀行', type: 'bank', currency: 'TWD', icon: '', color: '', initialBalanceMinor: 0, includeInNetWorth: true, isLiability: false });
    expect(parseEntries(text, await parseContext('2026-11-18'))[0]).toMatchObject({ kind: 'transfer', accountId: b.id, toAccountId: accountId });
  });

  it('週期首筆失敗不推進日期，修正後可完整補入', async () => {
    const id = await recurring({ template: { ...txInput(10000), currency: 'USD' } });
    expect(await processRecurring('2026-11-18')).toEqual({ created: 0, pending: 0 });
    expect(await db.recurring_rules.get(id)).toMatchObject({ nextDue: '2026-09-01', doneCount: 0 });
    await db.recurring_rules.update(id, { template: txInput(10000) });
    expect(await processRecurring('2026-11-18')).toEqual({ created: 3, pending: 0 });
    expect(await recomputeBalances(false)).toEqual([]);
  });

  it('週期第二筆失敗只推進已成功的一期', async () => {
    await db.accounts.update(accountId, { balanceMinor: -Number.MAX_SAFE_INTEGER + 15000 });
    const id = await recurring();
    expect(await processRecurring('2026-11-18')).toEqual({ created: 1, pending: 0 });
    expect(await db.recurring_rules.get(id)).toMatchObject({ nextDue: '2026-10-01', doneCount: 1 });
    expect(await db.transactions.count()).toBe(1);
  });

  it('確認、復原為待確認、再次確認可恢復入帳並改金額', async () => {
    const id = await recurring({ mode: 'confirm', startDate: '2026-11-01' });
    await processRecurring('2026-11-18');
    const before = (await db.recurring_rules.get(id))!;
    await confirmPending(id, '2026-11-01');
    await deleteTransactions([`rec-${id}-2026-11-01`]);
    await db.recurring_rules.put(before);
    await confirmPending(id, '2026-11-01', 12000);
    expect(await db.transactions.get(`rec-${id}-2026-11-01`)).toMatchObject({ deletedAt: null, amountMinor: 12000 });
    expect((await db.accounts.get(accountId))?.balanceMinor).toBe(88000);
    expect((await db.recurring_rules.get(id))?.pendingDates).toEqual([]);
  });

  it('分帳刪除與復原連動未結清欠款，修改金額按比例分配', async () => {
    const tx = await addTransaction(txInput());
    const [debtId] = await addDebts([{ personId: 'p', direction: 'they_owe_me', amountMinor: 10000, currency: 'TWD', date: tx.date, note: '', transactionId: tx.id }]);
    await db.transactions.update(tx.id, { split: { myShareMinor: 10000, debtIds: [debtId] } });
    await updateTransaction(tx.id, txInput(40001));
    const changed = (await db.transactions.get(tx.id))!;
    const debt = (await db.debts.get(debtId))!;
    expect(changed.split!.myShareMinor + debt.amountMinor).toBe(40001);
    await deleteTransactions([tx.id]);
    expect((await db.debts.get(debtId))?.deletedAt).toBeTruthy();
    await restoreTransactions([tx.id]);
    expect((await db.debts.get(debtId))?.deletedAt).toBeNull();
    await db.debts.update(debtId, { settled: 1 });
    await expect(deleteTransactions([tx.id])).rejects.toThrow('取消結清');
    await expect(updateTransaction(tx.id, txInput(50000))).rejects.toThrow('取消結清');
    expect((await db.transactions.get(tx.id))?.deletedAt).toBeNull();
    expect(await recomputeBalances(false)).toEqual([]);
  });

  it('結轉預算超過 24 期仍使用完整歷史與目前區間', async () => {
    await saveBudget({ name: '週預算', periodType: 'week', startDate: '2026-01-01', amountMinor: 10000, currency: 'TWD', categoryId: '', projectId: '', rollover: true, alertPercents: [80], active: 1 });
    const [v] = await computeBudgets('2026-11-18');
    expect(v.period.start <= '2026-11-18' && v.period.end >= '2026-11-18').toBe(true);
    expect(v.history.length).toBeGreaterThan(24);
    expect(v.carryIn).toBe((v.history.length - 1) * 10000);
  });

  it('尚有未來週期引用的帳戶只封存，不刪除', async () => {
    await recurring({ startDate: '2027-01-01' });
    expect(await deleteOrArchiveAccount(accountId)).toBe('archived');
    expect(await db.accounts.get(accountId)).toMatchObject({ archived: 1 });
  });

  it('新增分期不會順便入帳另一份逾期分期', async () => {
    const input = { name: '分期', accountId, categoryId: 'exp-food', principalMinor: 120000, currency: 'TWD', periods: 12, aprDec: '0', feeMinor: 0, feeMode: 'first' as const, firstDate: '2090-01-01' };
    const old = await addInstallment(input);
    const schedule = (await db.installments.get(old))!.schedule;
    schedule[0].date = '2020-01-01';
    await db.installments.update(old, { schedule });
    await addInstallment(input);
    expect(await db.transactions.count()).toBe(0);
    expect((await db.installments.get(old))?.schedule[0].transactionId).toBeUndefined();
  });
});

describe('v4.1.50 收件匣與規則', () => {
  it('同一通知重入、同時計帳與 ack 失敗重試均只扣一次', async () => {
    const item = raw(1); server.items = [item]; server.failAck = true;
    const e: InboxEntry = { item, drafts: [draft()] };
    const results = await Promise.all([bookInboxEntries([e]), bookInboxEntries([e])]);
    expect(results.reduce((n, r) => n + r.count, 0)).toBe(1);
    expect(results.every((r) => r.ackPending === 1)).toBe(true);
    server.failAck = false;
    const retry = await bookInboxEntries([e]);
    expect(retry).toMatchObject({ count: 0, alreadyBooked: 1, ackPending: 0 });
    expect(await db.transactions.count()).toBe(1);
    expect((await db.accounts.get(accountId))?.balanceMinor).toBe(90000);
    expect(server.acked).toEqual([1]);
  });

  it('多筆與轉帳也採用固定來源識別', async () => {
    const b = await addAccount({ name: '乙銀行', type: 'bank', currency: 'TWD', icon: '', color: '', initialBalanceMinor: 0, includeInNetWorth: true, isLiability: false });
    const e = { item: raw(2), drafts: [draft(), draft({ kind: 'transfer', toAccountId: b.id })] };
    await bookInboxEntries([e]); await bookInboxEntries([e]);
    expect(await db.transactions.count()).toBe(1);
    expect(await db.transfers.count()).toBe(1);
    expect(await recomputeBalances(false)).toEqual([]);
  });

  it('不同商家同金額不自動合併，白名單不會清掉未核准項目', async () => {
    server.items = [raw(1, { merchant: '早餐店' }), raw(2, { source: 'notify', merchant: '電信費' }), raw(3, { card: '玉山銀行', text: '午餐 200' })];
    useSettings.setState({ inbox: { ...DEFAULT_SETTINGS.inbox, whitelist: ['玉山銀行'] } });
    const r = await processInboxOnStartup();
    expect(r).toMatchObject({ booked: 1, merged: 0, pending: 2 });
    expect(server.acked).toEqual([3]);
    expect(findDuplicate({ date: '2026-11-18', amountMinor: 10000, currency: 'TWD', accountId, text: '早餐店' }, [{ id: 'x', date: '2026-11-18', amountMinor: 10000, currency: 'TWD', accountId, text: '電信費' }])?.level).toBe('weak');
  });

  it('失敗的自動入帳仍計入待確認', async () => {
    server.items = [raw(1)];
    await db.accounts.clear();
    useSettings.setState({ inbox: { ...DEFAULT_SETTINGS.inbox, autoBook: true } });
    expect(await processInboxOnStartup()).toMatchObject({ booked: 0, pending: 1 });
    expect(server.items).toHaveLength(1);
  });

  it('唯讀收件匣同樣尊重黑名單，設定更改即失效快取', async () => {
    server.items = [raw(1)];
    expect(await loadInboxReadOnly()).toHaveLength(1);
    useSettings.setState({ inbox: { ...DEFAULT_SETTINGS.inbox, blacklist: ['早餐'] } });
    expect(await loadInboxReadOnly()).toEqual([]);
    expect(server.acked).toEqual([]);
  });

  it('獨立金額欄不會把薪資收入改成支出', async () => {
    const ctx = await parseContext();
    const item = raw(1, { text: '薪資入帳', amount: '30000' });
    expect((await draftsFromItem(item, ctx, accountId))[0]).toMatchObject({ kind: 'income', amount: 30000 });
  });

  it('白名單只比對來源名稱，不因商家或內文提到銀行而放行', () => {
    expect(matchesWhitelist(raw(1, { card: 'LINE', text: '小明\n【中國信託】您已消費 100 元' }), ['中國信託'])).toBe(false);
    expect(matchesWhitelist(raw(1, { card: 'LINE', text: '中國信託\n您已消費 100 元' }), ['中國信託'])).toBe(true);
    expect(matchesWhitelist(raw(1, { text: '玉山銀行', merchant: '玉山銀行' }), ['玉山銀行'])).toBe(false);
  });

  it('完全相同比對分開欄位，kind any 不把支出分類套在收入', async () => {
    await saveRule({ keyword: '全聯', match: 'equals', kind: 'any', categoryId: 'exp-food', renameNote: '採買', enabled: true, priority: 1 });
    const ctx = await parseContext();
    const [d] = await draftsFromItem(raw(1, { merchant: '全聯', text: '全聯消費 100 元' }), ctx, accountId);
    expect(d.note).toBe('採買');
    expect(d.categoryId).toBe('exp-food');
    const income = await resolveDraft(draft({ kind: 'income', note: '全聯', categoryId: undefined }), accountId, '全聯\n全聯退款');
    expect(income.categoryId).toBe('inc-other_inc');
  });

  it('封存帳戶不會繼續透過已快取規則被選用', async () => {
    await saveRule({ keyword: '早餐', match: 'contains', kind: 'expense', categoryId: '', accountId, enabled: true, priority: 1 });
    expect((await suggestAccount('早餐'))?.accountId).toBe(accountId);
    await db.accounts.update(accountId, { archived: 1 });
    expect(await suggestAccount('早餐')).toBeUndefined();
    await expect(bookDrafts([draft()])).rejects.toThrow('封存');
  });

  it('每筆實際入帳累計規則命中，重試不重複計次', async () => {
    const rule = await saveRule({ keyword: '早餐', match: 'contains', kind: 'expense', categoryId: 'exp-food', accountId, enabled: true, priority: 1 });
    const d = await resolveDraft(draft({ accountId: undefined }), accountId);
    await bookDrafts([d], { sourceId: 'test-source' });
    await bookDrafts([d], { sourceId: 'test-source' });
    expect((await db.rules.get(rule.id))?.hits).toBe(1);
  });

  it('規則金額範圍不接受倒置', async () => {
    await expect(saveRule({ keyword: '早餐', match: 'contains', kind: 'expense', categoryId: '', accountId, minAmount: 200, maxAmount: 100, enabled: true, priority: 1 })).rejects.toThrow('最低');
  });

  it('AI 新草稿重新去重時清除舊標記並對帳本比對', async () => {
    const tx = await addTransaction({ ...txInput(10000), note: '早餐' });
    const e: InboxEntry = { item: raw(1), drafts: [], dup: { from: 'inbox', inboxId: 9, label: '舊結果', level: 'strong' } };
    await markDuplicates([e]); expect(e.dup).toBeUndefined();
    e.drafts = [draft()]; await markDuplicates([e]);
    expect(e.dup).toMatchObject({ from: 'ledger', txId: tx.id, level: 'strong' });
  });

  it('7-ELEVEN 各種別名都有非空的一致結果', () => {
    const normalized = ['7eleven', '7-11', '7-ELEVEN', '統一超商'].map(normalizeShop);
    expect(new Set(normalized).size).toBe(1);
    expect(normalized[0]).not.toBe('');
  });
});
