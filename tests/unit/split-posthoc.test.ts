import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/schema';
import { buildDefaultCategories } from '@/db/seed/categories';
import { addAccount, recomputeBalances } from '@/db/repo/accounts';
import { addTransaction, updateTransaction, updateTransactionSplit } from '@/db/repo/ledger';
import { settleDebt } from '@/db/repo/plan';
import { DEFAULT_SETTINGS } from '@/db/repo/settings';
import { useSettings } from '@/stores/settings';
import { applyServiceCharge, computeSplit, evalShareMinor } from '@/features/add/SplitSheet';
import { applyPlan, previewPlan, undoOp } from '@/services/agent';

const bal = async (id: string) => (await db.accounts.get(id))!.balanceMinor;

describe('分帳事後編輯、AA 運算與 Cilo 多人分帳', () => {
  let accId = '';
  let accCathay = '';
  let accFubon = '';

  beforeEach(async () => {
    await db.delete();
    await db.open();
    useSettings.setState({ ...DEFAULT_SETTINGS, baseCurrency: 'TWD', monthStartDay: 1, personSettleAccMap: {} } as never);
    await db.categories.bulkAdd(buildDefaultCategories());
    accId = (await addAccount({ name: '玉山', icon: '', color: '', type: 'bank', currency: 'TWD', initialBalanceMinor: 500000, includeInNetWorth: true, isLiability: false })).id;
    accCathay = (await addAccount({ name: '國泰', icon: '', color: '', type: 'bank', currency: 'TWD', initialBalanceMinor: 0, includeInNetWorth: true, isLiability: false })).id;
    accFubon = (await addAccount({ name: '富邦', icon: '', color: '', type: 'bank', currency: 'TWD', initialBalanceMinor: 0, includeInNetWorth: true, isLiability: false })).id;
  });

  it('事後分帳（updateTransactionSplit）：保留 tx.id、decisionId 與帳戶扣款全額，並維護金額不變量', async () => {
    const tx = await addTransaction({
      type: 'expense',
      accountId: accId,
      categoryId: 'exp-food-dinner',
      amountMinor: 120000,
      currency: 'TWD',
      date: '2026-11-28',
      ts: Date.parse('2026-11-28T19:00:00'),
      note: '聚餐',
      decisionId: 'dec-123',
    });
    expect(await bal(accId)).toBe(380000);

    const updated = await updateTransactionSplit(tx.id, [
      { personName: '小明', amountMinor: 40000 },
      { personName: '小華', amountMinor: 35000 },
    ]);

    expect(updated.id).toBe(tx.id);
    expect(updated.decisionId).toBe('dec-123');
    expect(updated.accountAmountMinor).toBe(120000);
    expect(await bal(accId)).toBe(380000);
    expect(updated.split?.myShareMinor).toBe(45000);
    expect(updated.split?.debtIds).toHaveLength(2);

    const debts = (await db.debts.bulkGet(updated.split!.debtIds)).filter(Boolean);
    const debtSum = debts.reduce((s, d) => s + d!.amountMinor, 0);
    expect(updated.split!.myShareMinor + debtSum).toBe(updated.amountMinor);
    expect(debts.every((d) => d!.direction === 'they_owe_me' && d!.transactionId === tx.id && d!.settled === 0)).toBe(true);
    expect(await recomputeBalances(false)).toEqual([]);
  });

  it('編輯分帳時保留已結清項目、軟刪除移除的未結清項目，並阻擋縮小總額低於已結清金額', async () => {
    const tx = await addTransaction({
      type: 'expense',
      accountId: accId,
      categoryId: 'exp-food-dinner',
      amountMinor: 100000,
      currency: 'TWD',
      date: '2026-11-28',
      ts: Date.parse('2026-11-28T19:00:00'),
      note: '熱炒',
    });

    const s1 = await updateTransactionSplit(tx.id, [
      { personName: '小明', amountMinor: 30000 },
      { personName: '小華', amountMinor: 30000 },
      { personName: '小美', amountMinor: 20000 },
    ]);
    const [dMing, dHua, dMei] = s1.split!.debtIds;

    // 小明已結清入國泰
    await settleDebt(dMing, accCathay);
    expect(await bal(accCathay)).toBe(30000);

    // 修改小華金額為 35000、移除小美、新增阿強 15000；小明保持鎖定 30000
    const s2 = await updateTransactionSplit(tx.id, [
      { personName: '小明', amountMinor: 30000, debtId: dMing },
      { personName: '小華', amountMinor: 35000, debtId: dHua },
      { personName: '阿強', amountMinor: 15000 },
    ]);

    expect(s2.split?.myShareMinor).toBe(20000); // 1000 - 300 - 350 - 150 = 200
    expect(s2.split?.debtIds).toHaveLength(3);
    expect(s2.split?.debtIds).toContain(dMing);
    expect(s2.split?.debtIds).toContain(dHua);

    const meiRow = await db.debts.get(dMei);
    expect(meiRow?.deletedAt).toBeTruthy();

    const mingRow = await db.debts.get(dMing);
    expect(mingRow?.settled).toBe(1);
    expect(mingRow?.amountMinor).toBe(30000);

    // 嘗試修改已結清的小明金額 → 拋錯
    await expect(
      updateTransactionSplit(tx.id, [
        { personName: '小明', amountMinor: 25000, debtId: dMing },
      ]),
    ).rejects.toThrow(/已結清/);

    // 嘗試刪除已結清的小明 → 拋錯
    await expect(
      updateTransactionSplit(tx.id, [
        { personName: '小華', amountMinor: 35000, debtId: dHua },
      ]),
    ).rejects.toThrow(/已結清/);

    // 嘗試把總金額縮到低於已結清（30000）→ 拋錯並保持原本狀態
    await expect(
      updateTransaction(
        tx.id,
        {
          type: 'expense',
          accountId: accId,
          categoryId: 'exp-food-dinner',
          amountMinor: 20000,
          currency: 'TWD',
          date: '2026-11-28',
          ts: tx.ts,
          note: '熱炒',
        },
        { splitShares: [{ personName: '小明', amountMinor: 30000, debtId: dMing }] },
      ),
    ).rejects.toThrow(/已結清/);
    expect((await db.transactions.get(tx.id))!.amountMinor).toBe(100000);
  });

  it('SplitSheet 運算式（320+80、400*1.1）與 +10% 服務費（保留鎖定列）', () => {
    expect(evalShareMinor('320+80', 'TWD')).toBe(40000);
    expect(evalShareMinor('400*1.1', 'TWD')).toBe(44000);

    const r = computeSplit(100000, {
      mode: 'custom',
      people: [
        { name: '小明', amount: '320+80' },
        { name: '小華', amount: '300*1.1' },
      ],
    }, 'TWD');
    expect(r.error).toBeUndefined();
    expect(r.shares.map((s) => s.minor)).toEqual([40000, 33000]);
    expect(r.myShare).toBe(27000);

    const charged = applyServiceCharge(
      [
        { name: '小明', amount: '300', debtId: 'd1', locked: true },
        { name: '小華', amount: '400' },
        { name: '小美', amount: '100+50' },
      ],
      'TWD',
    );
    expect(charged[0].amount).toBe('300'); // 已結清鎖定列不變
    expect(charged[1].amount).toBe('440');
    expect(charged[2].amount).toBe('165');

    // 平均分模式若有已鎖定列，應保留已鎖定金額並將餘額均分給未鎖定者＋自己
    const eq = computeSplit(100000, {
      mode: 'equal',
      people: [
        { name: '小明', amount: '400', debtId: 'd1', locked: true },
        { name: '小華', amount: '' },
      ],
    }, 'TWD');
    expect(eq.shares[0].minor).toBe(40000);
    expect(eq.shares[1].minor).toBe(30000);
    expect(eq.myShare).toBe(30000);
  });

  it('Cilo 多人 AA shares：預覽、執行建立多筆應收與一鍵還原', async () => {
    const steps = await previewPlan([{
      tool: 'add_transaction',
      args: {
        type: 'expense',
        account: '玉山',
        category: '飲食',
        amount: 1200,
        note: '居酒屋',
        shares: [
          { person: '小明', amount: 350 },
          { person: '小華', amount: 450 },
        ],
      },
    }]);

    expect(steps[0].preview.blocked).toBeUndefined();
    expect(steps[0].preview.debtsCreated).toBe(2);
    expect(steps[0].preview.lines.join('\n')).toContain('我付 $400');

    const log = await applyPlan(steps, '居酒屋分帳');
    expect(await bal(accId)).toBe(380000); // 帳戶扣全額 1200

    const txs = await db.transactions.filter((t) => !t.deletedAt).toArray();
    expect(txs).toHaveLength(1);
    expect(txs[0].split?.myShareMinor).toBe(40000);
    expect(txs[0].split?.debtIds).toHaveLength(2);

    const debts = await db.debts.filter((d) => !d.deletedAt).toArray();
    expect(debts).toHaveLength(2);
    expect(debts.map((d) => d.amountMinor).sort((a, b) => a - b)).toEqual([35000, 45000]);

    await undoOp(log.id);
    expect(await bal(accId)).toBe(500000);
    expect(await db.transactions.filter((t) => !t.deletedAt).toArray()).toHaveLength(0);
    expect(await db.debts.filter((d) => !d.deletedAt).toArray()).toHaveLength(0);
  });

  it('每位往來對象記住上次使用的結清帳戶（personSettleAccMap）', () => {
    useSettings.getState().setPersonSettleAcc('p-ming', accCathay);
    useSettings.getState().setPersonSettleAcc('p-hua', accFubon);
    expect(useSettings.getState().personSettleAccMap).toEqual({
      'p-ming': accCathay,
      'p-hua': accFubon,
    });
  });
});
