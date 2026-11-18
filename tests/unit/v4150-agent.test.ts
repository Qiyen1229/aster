import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/schema';
import { addAccount, recomputeBalances } from '@/db/repo/accounts';
import { addTransaction } from '@/db/repo/ledger';
import { addTrade } from '@/db/repo/invest';
import { saveGoal, saveProject, saveRecurring } from '@/db/repo/plan';
import { DEFAULT_SETTINGS, saveSetting } from '@/db/repo/settings';
import { buildDefaultCategories } from '@/db/seed/categories';
import { applyPlan, listAgentOps, previewPlan, undoOp } from '@/services/agent';
import { invalidateInboxReadOnly, type InboxRaw } from '@/services/inbox';
import { invalidateAutocat } from '@/services/autocat';
import { addDays, todayKey } from '@/domain/period';
import { useSettings } from '@/stores/settings';

const server = vi.hoisted(() => ({ items: [] as InboxRaw[], failAck: false, acked: [] as number[] }));
vi.mock('@/services/api', async (original) => ({
  ...await original<typeof import('@/services/api')>(),
  api: vi.fn(async (path: string, opts?: { body?: { ids: number[] } }) => {
    if (path === '/inbox/items') return structuredClone(server.items);
    if (path === '/inbox/items/booking') return { message: '已登記' };
    if (path === '/inbox/items/ack') {
      if (server.failAck) throw new Error('離線');
      const ids = opts!.body!.ids;
      server.acked.push(...ids);
      server.items = server.items.filter((i) => !ids.includes(i.id));
      return { ids };
    }
    throw new Error(`未預期的 API：${path}`);
  }),
}));

const today = todayKey();
const step = (tool: string, args: Record<string, unknown>) => ({ tool, args });
let bank = '';
const expense = (amount = 100) => step('add_transaction', { type: 'expense', account: '銀行', category: '早餐', amount, note: '新帳目' });
const input = (amountMinor = 10000) => ({ type: 'expense' as const, accountId: bank, categoryId: 'exp-food-breakfast', amountMinor, currency: 'TWD', date: today, ts: Date.now(), note: '原本帳目' });
const balance = async () => (await db.accounts.get(bank))!.balanceMinor;
const notice = (id = 1, text = '早餐 100'): InboxRaw => ({ id, source: 'siri', text, card: '', merchant: '', amount: '', occurred: today, created_at: new Date().toISOString() });

beforeEach(async () => {
  await db.delete(); await db.open();
  await db.categories.bulkAdd(buildDefaultCategories());
  invalidateInboxReadOnly(); invalidateAutocat();
  server.items = []; server.acked = []; server.failAck = false;
  useSettings.setState(structuredClone(DEFAULT_SETTINGS));
  bank = (await addAccount({ name: '銀行', type: 'bank', currency: 'TWD', initialBalanceMinor: 100000, icon: '', color: '', includeInNetWorth: true, isLiability: false })).id;
  useSettings.setState({ lastAccountId: bank });
});
afterEach(() => vi.restoreAllMocks());

describe('v4.1.50 Cilo 預覽與執行', () => {
  it('確認週期後自行修改產生的帳目，復原不刪掉後續修改', async () => {
    const id = await saveRecurring({ kind: 'normal', name: '早餐', template: input(), rule: { freq: 'month', interval: 1 }, startDate: today, mode: 'confirm', remindDaysBefore: 0, active: 1 });
    await db.recurring_rules.update(id, { pendingDates: [today] });
    const steps = await previewPlan([step('manage_recurring', { name: '早餐', action: 'confirm', date: today })]);
    expect(steps[0].preview.blocked).toBeFalsy();
    const log = await applyPlan(steps, '確認週期');
    const tx = (await db.transactions.toArray())[0];
    await db.transactions.update(tx.id, { note: '之後手動補的備註' });
    expect((await undoOp(log.id)).skipped).toBeGreaterThan(0);
    expect((await db.transactions.get(tx.id))?.deletedAt).toBeFalsy();
    expect((await db.transactions.get(tx.id))?.note).toBe('之後手動補的備註');
    expect((await db.recurring_rules.get(id))?.pendingDates).toEqual([]);
  });

  it.each(['parent', 'child'])('分期的 %s 被修改後，整組復原都略過', async (target) => {
    const log = await applyPlan(await previewPlan([step('add_installment', { name: '電腦', account: '銀行', amount: 600, periods: 3, category: '早餐', first_date: today })]), '分期');
    const installment = (await db.installments.toArray())[0];
    const tx = (await db.transactions.toArray())[0];
    if (target === 'parent') await db.installments.update(installment.id, { name: '後續修改' });
    else await db.transactions.update(tx.id, { note: '後續修改' });
    expect((await undoOp(log.id)).skipped).toBe(2);
    expect(await db.installments.get(installment.id)).toBeDefined();
    expect((await db.transactions.get(tx.id))?.deletedAt).toBeFalsy();
    expect(await balance()).toBe(80000);
  });

  it('同計畫兩次存入目標，第二次預覽累加第一次', async () => {
    const id = await saveGoal({ name: '日本', start: today, currency: 'JPY', targetMinor: 10000, manualSavedMinor: 0, linkedAccountIds: [], status: 'active', icon: '', color: '' });
    const steps = await previewPlan([step('goal_deposit', { goal: '日本', amount: 100 }), step('goal_deposit', { goal: '日本', amount: 200 })]);
    expect(steps[1].preview.lines.join(' ')).toContain('300');
    await applyPlan(steps, '分次存入');
    expect((await db.goals.get(id))?.manualSavedMinor).toBe(300);
  });

  it('先新增再改最近一筆只修改新帳目，後續餘額預覽包含修改', async () => {
    const old = await addTransaction(input(5000));
    const steps = await previewPlan([expense(), step('edit_transaction', { match: { latest: true }, set: { amount: 200 } }), expense(10)]);
    expect(steps.every((s) => !s.preview.blocked)).toBe(true);
    expect(steps[1].ops?.[0]).toMatchObject({ kind: 'tx_edit', id: steps[0].op?.kind === 'tx' ? steps[0].op.draftId : '' });
    expect(steps[2].preview.lines.join(' ')).toContain('750');
    const log = await applyPlan(steps, '新增再修改');
    expect((await db.transactions.get(old.id))?.amountMinor).toBe(5000);
    expect(await balance()).toBe(74000);
    expect((await db.transactions.toArray()).filter((t) => t.note === '新帳目').map((t) => t.amountMinor).sort((a, b) => a - b)).toEqual([1000, 20000]);
    expect((await undoOp(log.id)).skipped).toBe(0);
    expect(await balance()).toBe(95000);
  });

  it('刪除的帳目會立即回補後續預覽餘額', async () => {
    await addTransaction(input());
    const steps = await previewPlan([step('delete_transaction', { match: { latest: true } }), expense(20)]);
    expect(steps[1].preview.lines.join(' ')).toContain('1,000');
    await applyPlan(steps, '刪除後新增');
    expect(await balance()).toBe(98000);
  });

  it('相同時間戳的後續修改也會讓舊預覽失效', async () => {
    const old = await addTransaction(input());
    const steps = await previewPlan([step('edit_transaction', { match: { latest: true }, set: { amount: 200 } })]);
    await db.transactions.update(old.id, { note: '後來自行修改' });
    await expect(applyPlan(steps, '過期預覽')).rejects.toThrow('重新預覽');
    expect((await db.transactions.get(old.id))?.amountMinor).toBe(10000);
    expect(await listAgentOps()).toEqual([]);
  });

  it('同時送出與重新載入後重試同一計畫只建立一次', async () => {
    const steps = await previewPlan([expense()]);
    const [a, b] = await Promise.all([applyPlan(steps, '同一份', 'same-plan'), applyPlan(steps, '同一份', 'same-plan')]);
    expect(a.id).toBe(b.id);
    db.close(); await db.open();
    await applyPlan(steps, '同一份', 'same-plan');
    expect(await db.transactions.count()).toBe(1);
    expect(await balance()).toBe(90000);
    expect(await listAgentOps()).toHaveLength(1);
  });

  it('寫入還原紀錄失敗時，帳目與餘額一起回復', async () => {
    const steps = await previewPlan([expense()]);
    const put = db.meta.put.bind(db.meta);
    vi.spyOn(db.meta, 'put').mockImplementation((row, key) => row.key === 'agent.ops' ? Promise.reject(new Error('紀錄寫入失敗')) as never : put(row, key));
    await expect(applyPlan(steps, '寫入故障')).rejects.toThrow('紀錄寫入失敗');
    expect(await db.transactions.count()).toBe(0);
    expect(await balance()).toBe(100000);
  });

  it('通知清除失敗仍保留帳目與還原紀錄，重試只清除通知', async () => {
    server.items = [notice()]; server.failAck = true;
    const steps = await previewPlan([step('manage_inbox', { action: 'book' }), step('manage_inbox', { action: 'book' })]);
    expect(steps[1].preview.blocked).toBeTruthy();
    const log = await applyPlan(steps, '收件匣', 'inbox-plan');
    expect(log.warnings?.join(' ')).toContain('尚未清除');
    expect(log.changes).toHaveLength(1);
    expect((await listAgentOps())[0].changes).toHaveLength(1);
    server.failAck = false;
    const retry = await applyPlan(steps, '收件匣', 'inbox-plan');
    expect(retry.pendingInboxIds).toEqual([]);
    expect(await db.transactions.count()).toBe(1);
    expect(await balance()).toBe(90000);
    await undoOp(log.id);
    expect(await balance()).toBe(100000);
  });

  it('略過通知失敗會明確回報，不假裝已清除', async () => {
    server.items = [notice()]; server.failAck = true;
    const log = await applyPlan(await previewPlan([step('manage_inbox', { action: 'skip' })]), '略過');
    expect(log.pendingInboxIds).toEqual([1]);
    expect(log.warnings?.length).toBe(1);
    expect(server.items).toHaveLength(1);
    expect(await db.transactions.count()).toBe(0);
  });

  it('後續本機寫入失敗時連收件匣入帳也回復，且不清除通知', async () => {
    server.items = [notice()];
    const steps = await previewPlan([step('manage_inbox', { action: 'book' }), expense()]);
    if (steps[1].op?.kind === 'tx') steps[1].op.input.accountId = 'missing';
    await expect(applyPlan(steps, '全部回復')).rejects.toThrow();
    expect(await db.transactions.count()).toBe(0);
    expect(await balance()).toBe(100000);
    expect(server.acked).toEqual([]);
    expect(await listAgentOps()).toEqual([]);
  });

  it('外幣目標使用目標最小單位，而非主幣別', async () => {
    const id = await saveGoal({ name: '日本', start: today, currency: 'JPY', targetMinor: 10000, manualSavedMinor: 0, linkedAccountIds: [], status: 'active', icon: '', color: '' });
    const log = await applyPlan(await previewPlan([step('goal_deposit', { goal: '日本', amount: 100 })]), '日圓目標');
    expect((await db.goals.get(id))?.manualSavedMinor).toBe(100);
    await undoOp(log.id);
    expect((await db.goals.get(id))?.manualSavedMinor).toBe(0);
  });

  it.each([100, -100])('信用卡期初 %s 以欠款儲存', async (amount) => {
    await applyPlan(await previewPlan([step('add_account', { name: '新卡', type: 'credit', initial_balance: amount })]), '新信用卡');
    expect((await db.accounts.toArray()).find((a) => a.name === '新卡')?.balanceMinor).toBe(-10000);
  });

  it('旅遊模式切換與外幣通知同計畫採用相同幣別、專案與匯率，不在交易中連網', async () => {
    server.items = [notice()];
    await db.exchange_rates.put({ base: 'JPY', quote: 'TWD', rateDec: '0.2', source: 'manual', updatedAt: Date.now() });
    const steps = await previewPlan([
      step('add_project', { name: '東京', currency: 'JPY', is_travel: true }),
      step('set_travel_mode', { project: '東京' }),
      step('manage_inbox', { action: 'book' }),
    ]);
    expect(steps.map((s) => s.preview.blocked)).toEqual([undefined, undefined, undefined]);
    expect(steps[2].preview.lines.join(' ')).toContain('20');
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('不得連網'));
    const log = await applyPlan(steps, '東京入帳');
    const tx = (await db.transactions.toArray())[0];
    const project = (await db.projects.toArray())[0];
    expect(tx).toMatchObject({ currency: 'JPY', amountMinor: 100, accountAmountMinor: 2000, projectId: project.id });
    expect(await balance()).toBe(98000);
    expect(network).not.toHaveBeenCalled();
    await undoOp(log.id);
    expect(await balance()).toBe(100000);
  });

  it('還原新帳戶不能刪掉後來使用者新增帳目所需的帳戶', async () => {
    const steps = await previewPlan([step('add_account', { name: '新錢包', type: 'cash' }), step('add_transaction', { type: 'expense', account: '新錢包', amount: 100, category: '早餐' })]);
    const log = await applyPlan(steps, '新帳戶');
    const account = (await db.accounts.toArray()).find((a) => a.name === '新錢包')!;
    const own = await addTransaction({ ...input(), accountId: account.id, note: '後來的帳目' });
    const result = await undoOp(log.id);
    expect(result.skipped).toBeGreaterThan(0);
    expect(await db.accounts.get(account.id)).toBeDefined();
    expect((await db.transactions.get(own.id))?.deletedAt).toBeFalsy();
    await recomputeBalances();
    expect((await db.accounts.get(account.id))?.balanceMinor).toBe(-10000);
  });

  it('還原旅遊設定不覆蓋後來手動切換的專案', async () => {
    const p1 = await saveProject({ name: '東京', isTravel: true, currency: 'TWD', start: today, status: 'active', icon: '', color: '' });
    const p2 = await saveProject({ name: '大阪', isTravel: true, currency: 'TWD', start: today, status: 'active', icon: '', color: '' });
    const log = await applyPlan(await previewPlan([step('set_travel_mode', { project: '東京' })]), '旅遊');
    expect(useSettings.getState().travelModeProjectId).toBe(p1);
    await saveSetting('travelModeProjectId', p2);
    useSettings.setState({ travelModeProjectId: p2 });
    expect((await undoOp(log.id)).skipped).toBe(1);
    expect((await db.settings.get('travelModeProjectId'))?.value).toBe(p2);
    expect(useSettings.getState().travelModeProjectId).toBe(p2);
  });

  it('歷史股利用除息前持股，預設不扣匯費，也允許指定實際匯費', async () => {
    await db.stocks.put({ id: 'stock', symbol: '0050', name: 'ETF', market: 'TWSE', currency: 'TWD', assetType: 'etf', lotSize: 1000, createdAt: 1, updatedAt: 1 });
    for (const [type, shares, days] of [['buy', 1000, -60], ['sell', 900, -30], ['buy', 50, -5]] as const) {
      await addTrade({ stockId: 'stock', accountId: bank, type, sharesDec: String(shares), priceDec: '10', date: addDays(today, days), ts: 1, feeMinor: 0, taxMinor: 0, fxRateDec: '1', isDCA: false, syncToLedger: false, note: '' });
    }
    const args = { symbol: '0050', per_share: 2, account: '銀行', ex_date: addDays(today, -45), pay_date: addDays(today, -40) };
    const steps = await previewPlan([step('add_dividend', args)]);
    expect(steps[0].op).toMatchObject({ kind: 'dividend', input: { sharesHeldDec: '1000', grossMinor: 200000, feeMinor: 0, netMinor: 200000 } });
    const log = await applyPlan(steps, '歷史股利');
    expect(await balance()).toBe(300000);
    await undoOp(log.id);
    expect(await balance()).toBe(100000);
    const withFee = await previewPlan([step('add_dividend', { ...args, fee: 10 })]);
    expect(withFee[0].op).toMatchObject({ kind: 'dividend', input: { feeMinor: 1000, netMinor: 199000 } });
  });
});
