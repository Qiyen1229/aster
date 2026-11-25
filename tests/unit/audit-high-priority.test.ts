import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/schema';
import { addAccount } from '@/db/repo/accounts';
import { addTransaction, updateTransaction } from '@/db/repo/ledger';
import { DEFAULT_SETTINGS } from '@/db/repo/settings';
import { useSettings } from '@/stores/settings';
import { useAuth } from '@/stores/auth';
import { invalidateAutocat, suggestCategory } from '@/services/autocat';
import { applyFixes } from '@/services/reconcile';
import { applyPlan, previewPlan, undoOp } from '@/services/agent';
import { planWhatsNew } from '@/features/whatsnew/WhatsNew';
import pkg from '../../package.json';

const cat = (id: string, name: string, kind: 'expense' | 'income' = 'expense', parentId = '') => ({
  id,
  name,
  kind,
  parentId,
  icon: '',
  color: '',
  sort: 0,
  archived: 0,
  createdAt: 1,
  updatedAt: 1,
});

describe('高優先稽核修復驗證 (#1, #3, #4, #5, #6, #8)', () => {
  let accId = '';

  beforeEach(async () => {
    await db.delete();
    await db.open();
    invalidateAutocat();
    useSettings.setState({ ...DEFAULT_SETTINGS, baseCurrency: 'TWD', monthStartDay: 1 } as never);
    await db.categories.bulkAdd([
      cat('exp-food', '飲食'),
      cat('exp-other', '其他'),
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

  it('#1 尚有未同步 outbox 時，logout(false) 會阻止登出，logout(true) 才強制登出', async () => {
    await db.sync_outbox.clear();
    await db.sync_outbox.add({
      id: 'outbox-1',
      table: 'transactions',
      rowId: 'tx-unsynced',
      op: 'put',
      ts: Date.now(),
    } as never);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    useAuth.setState({ user: { id: 1, username: 'u1', email: 'u1@example.com', role: 'user' } as never });

    await expect(useAuth.getState().logout(false)).rejects.toThrow('仍有 1 筆資料尚未同步到伺服器');
    expect(useAuth.getState().user).not.toBeNull();

    await useAuth.getState().logout(true);
    expect(useAuth.getState().user).toBeNull();
    vi.restoreAllMocks();
  });

  it('#3 自動記帳可正確將 sukiya 歸類為飲食而非其他', async () => {
    const suggested = await suggestCategory('sukiya 牛肉飯', 'expense');
    expect(suggested?.categoryId).toBe('exp-food');
  });

  it('#4 關聯帳目（股票/股利/轉帳手續費）禁止修改關鍵財務欄位，僅允許改備註等非財務欄位', async () => {
    const tx = await addTransaction({
      type: 'expense',
      accountId: accId,
      categoryId: 'exp-other',
      amountMinor: 1425,
      currency: 'TWD',
      date: '2026-11-25',
      ts: Date.now(),
      note: '手續費',
      stockTradeId: 'trade-1',
    });

    await expect(
      updateTransaction(tx.id, {
        type: 'expense',
        accountId: accId,
        categoryId: 'exp-other',
        amountMinor: 2000,
        currency: 'TWD',
        date: '2026-11-25',
        ts: tx.ts,
        note: '手續費',
      }),
    ).rejects.toThrow('自動連動產生');

    const updated = await updateTransaction(tx.id, {
      type: 'expense',
      accountId: accId,
      categoryId: 'exp-other',
      amountMinor: 1425,
      currency: 'TWD',
      date: '2026-11-25',
      ts: tx.ts,
      note: '手續費（備註更新）',
    });
    expect(updated.note).toBe('手續費（備註更新）');
    expect(updated.amountMinor).toBe(1425);
  });

  it('#5 applyFixes 具原子性：中途失敗時整個批次全部回滾，不留部分帳目', async () => {
    const acc = (await db.accounts.get(accId))!;
    const beforeBal = acc.balanceMinor;
    let count = 0;
    const origAdd = db.transactions.add.bind(db.transactions);
    const spy = vi.spyOn(db.transactions, 'add').mockImplementation((async (item: unknown) => {
      count += 1;
      if (count === 2) throw new Error('simulated failure');
      return origAdd(item as never);
    }) as never);

    await expect(
      applyFixes(acc, {
        missing: [
          { row: { id: 'm1', date: '2026-11-25', kind: 'expense', amountMinor: 500, text: '第一筆' }, categoryId: 'exp-other' },
          { row: { id: 'm2', date: '2026-11-25', kind: 'expense', amountMinor: 600, text: '第二筆' }, categoryId: 'exp-other' },
        ],
        variances: [],
        adjustTo: null,
      }),
    ).rejects.toThrow('simulated failure');
    spy.mockRestore();

    expect(await db.transactions.count()).toBe(0);
    expect((await db.accounts.get(accId))!.balanceMinor).toBe(beforeBal);
  });

  it('#6 Cilo 復原新建專案時，若有後續帳目引用則改為封存，無引用才刪除', async () => {
    const steps = await previewPlan([
      { tool: 'add_project', args: { name: '日本旅費', currency: 'TWD', budget: 50000, start_date: null, end_date: null, note: '' } },
    ]);
    const res = await applyPlan(steps, '建立日本旅費專案');
    const projects = await db.projects.toArray();
    expect(projects).toHaveLength(1);
    const projId = projects[0].id;

    await addTransaction({
      type: 'expense',
      accountId: accId,
      categoryId: 'exp-food',
      amountMinor: 1000,
      currency: 'TWD',
      date: '2026-11-25',
      ts: Date.now(),
      note: '拉麵',
      projectId: projId,
    });

    const undoRes = await undoOp(res.id);
    expect(undoRes.restored).toBeGreaterThanOrEqual(1);
    const afterProj = await db.projects.get(projId);
    expect(afterProj).toBeDefined();
    expect(afterProj!.status).toBe('archived');
  });

  it('#8 已在另一裝置看過目前版本（synced seenWhatsNew）時，新裝置不應彈出更新說明', () => {
    const syncedSeen = pkg.version;
    const plan = planWhatsNew({
      current: pkg.version,
      onboarded: true,
      read: () => syncedSeen,
      write: () => {},
    });
    expect(plan).toBeNull();
  });
});
