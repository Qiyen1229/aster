import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/schema';
import { addAccount } from '@/db/repo/accounts';
import { addTransaction } from '@/db/repo/ledger';
import { DEFAULT_SETTINGS } from '@/db/repo/settings';
import { buildDefaultCategories } from '@/db/seed/categories';
import { parseQuery } from '@/domain/nlquery';
import { answerQuestion } from '@/services/nlquery';
import { useSettings } from '@/stores/settings';

describe('用問的查帳：通用頻率／間隔週期分析', () => {
  const cats = buildDefaultCategories();
  const ctx = {
    today: '2026-11-26',
    weekStart: 1,
    monthStartDay: 1,
    accounts: [{ id: 'acc-1', name: '中國信託', type: 'credit' }],
    categories: cats.map((c) => ({ id: c.id, name: c.name, kind: c.kind, parentId: c.parentId })),
  };

  let accId = '';

  beforeEach(async () => {
    await db.delete();
    await db.open();
    useSettings.setState({ ...DEFAULT_SETTINGS, baseCurrency: 'TWD', monthStartDay: 1 } as never);
    await db.categories.bulkAdd(cats as never);
    accId = (
      await addAccount({
        name: '中國信託',
        icon: '',
        color: '',
        type: 'credit',
        currency: 'TWD',
        initialBalanceMinor: 0,
        includeInNetWorth: true,
        isLiability: true,
      })
    ).id;
  });

  it('可通用解析各種「平均多久…一次」問句（不僅限加油）', () => {
    const q1 = parseQuery('我平均多久加一次油', ctx)!;
    expect(q1.metric).toBe('interval');
    expect(q1.categoryLabel).toBe('加油');
    expect(q1.rangeLabel).toBe('近一年');

    const q2 = parseQuery('平均多久剪一次髮', ctx)!;
    expect(q2.metric).toBe('interval');
    expect(q2.categoryLabel).toBe('美髮');

    const q3 = parseQuery('多久吃一次 Sukiya', ctx)!;
    expect(q3.metric).toBe('interval');
    expect(q3.categoryLabel).toBe('午餐');
  });

  it('能實際算出 6 筆加油的平均間隔天數、最短/最長與平均每次金額', async () => {
    const entries = [
      ['2026-10-12', 11300],
      ['2026-10-25', 12400],
      ['2026-10-29', 11300],
      ['2026-11-04', 12400],
      ['2026-11-15', 12900],
      ['2026-11-21', 13000],
    ] as const;

    for (const [date, amountMinor] of entries) {
      await addTransaction({
        type: 'expense',
        accountId: accId,
        categoryId: 'exp-transport-fuel',
        amountMinor,
        currency: 'TWD',
        date,
        ts: new Date(`${date}T12:00:00`).getTime(),
        note: '加油',
      });
    }

    const q = parseQuery('我平均多久加一次油', ctx)!;
    const ans = await answerQuestion(q);
    expect(ans.items).toHaveLength(6);
    expect(ans.answer).toContain('平均約每 8 天一次');
    expect(ans.answer).toContain('$122');
    expect(ans.detail).toContain('最短間隔 4 天、最長 13 天');
  });
});
