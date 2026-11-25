import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/schema';
import { addAccount } from '@/db/repo/accounts';
import { addTransaction } from '@/db/repo/ledger';
import { deleteBudget, saveBudget } from '@/db/repo/plan';
import { deleteDividend, restoreDividend, saveDividend } from '@/db/repo/invest';
import { DEFAULT_SETTINGS } from '@/db/repo/settings';
import { useSettings } from '@/stores/settings';
import { formatPnlCompact } from '@/domain/invest/pnlCalendar';
import { scaleMinor } from '@/domain/money';
import { reconcile } from '@/domain/reconcile';
import { adjustmentNote, loadLedgerRows } from '@/services/reconcile';
import { buildBackup, restoreBackup } from '@/services/backup';

describe('中／低優先稽核修復驗證 (#11-#13, #28-#31)', () => {
  let accId = '';

  beforeEach(async () => {
    await db.delete();
    await db.open();
    useSettings.setState({ ...DEFAULT_SETTINGS, baseCurrency: 'TWD', monthStartDay: 1 } as never);
    await db.categories.bulkAdd([
      { id: 'exp-food', name: '飲食', kind: 'expense', parentId: '', icon: '', color: '', sort: 0, archived: 0, createdAt: 1, updatedAt: 1 },
      { id: 'inc-salary', name: '薪水', kind: 'income', parentId: '', icon: '', color: '', sort: 0, archived: 0, createdAt: 1, updatedAt: 1 },
      { id: 'inc-div', name: '股利', kind: 'income', parentId: '', icon: '', color: '', sort: 0, archived: 0, createdAt: 1, updatedAt: 1 },
    ] as never);
    accId = (
      await addAccount({
        name: '現金',
        icon: '',
        color: '',
        type: 'cash',
        currency: 'TWD',
        initialBalanceMinor: 100000,
        includeInNetWorth: true,
        isLiability: false,
      })
    ).id;
  });

  it('#11 restoreBackup(replace) 會清空備份中存在的資料表，未出現的資料表保留', async () => {
    const json = JSON.parse(await (await buildBackup(false)).text());
    await db.tags.add({ id: 't1', name: '保留標籤', color: '#000', createdAt: 1, updatedAt: 1 } as never);
    delete json.data.tags;
    json.data.accounts = [];
    json.data.transactions = [];
    const file = new File([JSON.stringify(json)], 'backup.json', { type: 'application/json' });
    await restoreBackup(file, 'replace');
    expect(await db.tags.count()).toBe(1);
    expect(await db.accounts.count()).toBe(0);
  });

  it('#12 對帳 adjustmentNote 可匹配 rec-/inst-/inbox- 等非十六進位 ID 尾碼', async () => {
    const recId = 'rec-monthly-0';
    await addTransaction({
      id: recId,
      type: 'expense',
      accountId: accId,
      categoryId: 'exp-food',
      amountMinor: 10000,
      currency: 'TWD',
      date: '2026-11-25',
      ts: Date.now(),
      note: 'Netflix',
    });
    await addTransaction({
      type: 'expense',
      accountId: accId,
      categoryId: 'exp-food',
      amountMinor: 500,
      currency: 'TWD',
      date: '2026-11-25',
      ts: Date.now(),
      note: adjustmentNote('Netflix', recId),
    });

    const rows = await loadLedgerRows(accId, [
      { id: 's1', date: '2026-11-25', amountMinor: 10500, kind: 'expense', text: 'Netflix' },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].accountMinor).toBe(10500);
  });

  it('#13 formatPnlCompact 對日圓/韓圓等零小數幣別不會縮小 100 倍', () => {
    const txt = formatPnlCompact({ currency: 'JPY', pnlMinor: 1500, baseValueMinor: 10000, pnlPct: 15 });
    expect(txt).toBe('$+1,500');
  });

  it('#28 reconcile 對非退款關鍵字的收入差異不再一律標記為 refund', () => {
    const report = reconcile(
      [{ id: 's1', date: '2026-11-25', amountMinor: 10500, kind: 'income', text: '匯款入帳' }],
      [{ id: 'l1', date: '2026-11-25', accountMinor: 10000, origMinor: 10000, origCurrency: 'TWD', kind: 'income', text: '匯款入帳' }],
      'TWD',
    );
    expect(report.variances).toHaveLength(1);
    expect(report.variances[0].reason).not.toBe('refund');
  });

  it('#29 deleteBudget 會在單一交易中同時刪除 budgets 與 budget_periods', async () => {
    const bid = await saveBudget({
      name: '餐飲預算',
      periodType: 'month',
      startDate: '2026-11-01',
      amountMinor: 100000,
      currency: 'TWD',
      categoryId: 'exp-food',
      projectId: '',
      rollover: false,
      alertPercents: [80],
      active: 1,
    });
    await db.budget_periods.add({ id: 'bp1', budgetId: bid, periodKey: '2026-11', limitMinor: 100000, rolloverMinor: 0, spentMinor: 0, updatedAt: 1 } as never);
    await deleteBudget(bid);
    expect(await db.budgets.get(bid)).toBeUndefined();
    expect(await db.budget_periods.where('budgetId').equals(bid).count()).toBe(0);
  });

  it('#30 scaleMinor 使用 BigInt 精確四捨五入', () => {
    expect(scaleMinor(10000, 1, 3)).toBe(3333);
    expect(scaleMinor(10000, 2, 3)).toBe(6667);
  });

  it('#31 deleteDividend 回傳快照並可透過 restoreDividend 完整還原', async () => {
    await db.stocks.add({
      id: 'stk-1',
      market: 'TW',
      symbol: '2330',
      name: '台積電',
      currency: 'TWD',
      assetType: 'stock',
      lotSize: 1000,
      createdAt: 1,
      updatedAt: 1,
    } as never);
    const did = await saveDividend({
      stockId: 'stk-1',
      accountId: accId,
      kind: 'cash',
      exDate: '2026-11-01',
      payDate: '2026-11-25',
      sharesHeldDec: '1000',
      perShareDec: '2',
      grossMinor: 200000,
      withholdingTaxMinor: 0,
      nhiSupplementMinor: 0,
      feeMinor: 0,
      netMinor: 200000,
      currency: 'TWD',
      status: 'paid',
      syncToLedger: false,
    });
    const snap = await deleteDividend(did);
    expect(snap).not.toBeNull();
    expect(await db.dividends.get(did)).toBeUndefined();

    await restoreDividend(snap!);
    expect(await db.dividends.get(did)).toBeDefined();
    vi.restoreAllMocks();
  });
});
