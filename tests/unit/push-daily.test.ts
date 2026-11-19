import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/api', async (orig) => ({ ...(await orig<object>()), api: vi.fn(async () => ({})) }));

import { db } from '@/db/schema';
import { DEFAULT_SETTINGS } from '@/db/repo/settings';
import { useSettings } from '@/stores/settings';
import { addDays, toDateKey, todayKey, weekRange } from '@/domain/period';
import { hasLoggedOn, runReminderChecks } from '@/services/notifications';
import { upcomingPushItems } from '@/services/push';

const today = todayKey();
const tx = (id: string, date: string, extra: Record<string, unknown> = {}) => ({
  id, type: 'expense', accountId: 'a1', categoryId: 'exp-food', amountMinor: 100, baseAmountMinor: 100, accountAmountMinor: 100, currency: 'TWD',
  date, ts: 1, note: '', tagIds: [], attachmentIds: [], createdAt: 1, updatedAt: 1, ...extra,
});
const dailyIds = async () => (await upcomingPushItems(14, new Date(`${today}T00:00:00`).getTime())).filter((i) => i.id.startsWith('daily:')).map((i) => i.id);

describe('每日記帳提醒：已記帳就不通知', () => {
  beforeEach(async () => {
    for (const t of ['transactions', 'transfers', 'accounts', 'recurring_rules', 'wishes', 'meta']) await db.table(t).clear();
    useSettings.setState({ ...DEFAULT_SETTINGS, notify: { ...DEFAULT_SETTINGS.notify, daily: true, dailyTime: '23:30', cardDue: false, subscription: false, weekly: false, monthly: false, backup: false } } as never);
  });

  it('今天還沒記帳：今天（晚上 11:30）也排提醒', async () => {
    expect(await dailyIds()).toContain(`daily:${today}`);
  });

  it('今天已手動記帳：不排今天的提醒，之後每天照排', async () => {
    await db.transactions.add(tx('t1', today) as never);
    const ids = await dailyIds();
    expect(ids).not.toContain(`daily:${today}`);
    expect(ids).toContain(`daily:${addDays(today, 1)}`);
  });

  it('只有週期帳目／股票／範例資料／已刪除的帳目：不算使用者今天記過帳', async () => {
    await db.transactions.bulkAdd([
      tx('r', today, { recurringRuleId: 'x' }), tx('i', today, { installmentId: 'x' }), tx('s', today, { stockTradeId: 'x' }),
      tx('d', today, { dividendId: 'x' }), tx('m', today, { isSample: true }), tx('del', today, { deletedAt: 5 }),
    ] as never);
    expect(await hasLoggedOn(today)).toBe(false);
    expect(await dailyIds()).toContain(`daily:${today}`);
  });

  it('手動記一筆轉帳也算已記帳', async () => {
    await db.transfers.add({ id: 'tr', date: today } as never);
    expect(await hasLoggedOn(today)).toBe(true);
  });

  it('備份提醒預設每週（7 天）一次，同週內只會產生一則通知與推播 ID', async () => {
    expect(DEFAULT_SETTINGS.notify.backupDays).toBe(7);
    useSettings.setState({ ...DEFAULT_SETTINGS, weekStart: 1, notify: { ...DEFAULT_SETTINGS.notify, backup: true, backupDays: 7, daily: false, cardDue: false, budget: false, subscription: false, priceAlert: false, weekly: false, monthly: false } } as never);
    const items = await upcomingPushItems(14, new Date(`${today}T00:00:00`).getTime());
    const backupItem = items.find((i) => i.id.startsWith('backup:'));
    expect(backupItem).toBeDefined();
    const expectedPushWeek = weekRange(toDateKey(new Date(backupItem!.at)), 1).start;
    expect(backupItem?.id).toBe(`backup:${expectedPushWeek}`);

    // 本機備份提醒（超過 20 筆帳目且尚未備份）：同週內檢查多次只會寫入一則每週去重紀錄
    await db.transactions.bulkAdd(Array.from({ length: 21 }, (_, idx) => tx(`bulk-${idx}`, today)) as never);
    await db.reminders.clear();
    await runReminderChecks();
    await runReminderChecks();
    const backupReminders = (await db.reminders.toArray()).filter((r) => r.kind === 'backup');
    expect(backupReminders).toHaveLength(1);
    expect(backupReminders[0].id).toBe(`backup:${weekRange(today, 1).start}`);
  });
});
