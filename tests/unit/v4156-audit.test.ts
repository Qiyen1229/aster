import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/schema';
import { DEFAULT_SETTINGS } from '@/db/repo/settings';
import { buildDefaultCategories } from '@/db/seed/categories';
import { addAccount } from '@/db/repo/accounts';
import { addTransaction, restoreTransactions } from '@/db/repo/ledger';
import {
  addDebts,
  addInstallment,
  deleteInstallment,
  deleteProject,
  deleteRecurringRule,
  findOrCreatePerson,
  saveBudget,
  saveProject,
  saveRecurring,
  settleDebt,
} from '@/db/repo/plan';
import { addTrade, deleteDividend, deleteTrade, ensureStock, saveDividend } from '@/db/repo/invest';
import { buildBackup, restoreBackup, verifyBackup } from '@/services/backup';
import { computePnlCalendar, formatPnlCompact, formatPnlPct } from '@/domain/invest/pnlCalendar';
import { xirr } from '@/domain/invest/xirr';
import { customProxyUrl, proxied } from '@/services/quotes/http';
import { useSettings } from '@/stores/settings';
import type { PriceCache, Stock, StockTrade } from '@/db/types';

function makeFile(text: string, name = 'backup.json'): File {
  return { text: async () => text, name } as unknown as File;
}

describe('v4.1.56 深度檢測回歸測試', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    await db.categories.bulkPut(buildDefaultCategories());
    useSettings.setState({ ...DEFAULT_SETTINGS });
  });

  it('報價代理：DEFAULT_SETTINGS.quote.proxyUrl 為空且舊預設 /proxy 視同內建代理並正確帶 Bearer', async () => {
    expect(DEFAULT_SETTINGS.quote.proxyUrl).toBe('');
    expect(customProxyUrl('/proxy')).toBe('');
    expect(customProxyUrl('  /proxy  ')).toBe('');
    expect(customProxyUrl('https://worker.example.com')).toBe('https://worker.example.com');

    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    });
    vi.stubEnv('VITE_API_URL', 'https://nas.example.com');
    localStorage.setItem('clure.access_token', 'jwt-123');
    useSettings.setState((s) => ({ quote: { ...s.quote, proxyUrl: '/proxy', proxyToken: '' } }));

    const builtIn = proxied('https://openapi.twse.com.tw/v1/test');
    expect(builtIn.url).toContain('https://nas.example.com/proxy/fetch?url=');
    expect(builtIn.headers.Authorization).toBe('Bearer jwt-123');

    useSettings.setState((s) => ({ quote: { ...s.quote, proxyUrl: 'https://worker.example.com', proxyToken: 'wk' } }));
    const custom = proxied('https://openapi.twse.com.tw/v1/test');
    expect(custom.url).toContain('https://worker.example.com/fetch?url=');
    expect(custom.headers['x-clure-token']).toBe('wk');
    expect(custom.headers.Authorization).toBeUndefined();

    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('備份驗證與還原：含已結清欠款 (settleTransferId) 與無照片備份取代有照片裝置皆不失敗', async () => {
    const acc = await addAccount({ name: '現金', type: 'cash', currency: 'TWD', icon: '💵', color: '#30D158', initialBalanceMinor: 100_000, includeInNetWorth: true, isLiability: false });
    const person = await findOrCreatePerson('小明');
    const [debtId] = await addDebts([{ personId: person.id, direction: 'they_owe_me', amountMinor: 50_000, currency: 'TWD', date: '2026-11-01', note: '午餐' }]);
    await settleDebt(debtId, acc.id, { date: '2026-11-02' });

    const json = await (await buildBackup(false)).text();
    const verifyRes = await verifyBackup(makeFile(json));
    expect(verifyRes.counts.accounts).toBe(1);

    // 本機新增一筆收據照片（關聯到舊交易），模擬「無照片備份」在「完全取代」模式還原
    const attTx = await addTransaction({ type: 'expense', accountId: acc.id, categoryId: 'exp-food', amountMinor: 10_000, currency: 'TWD', date: '2026-11-03', ts: 3000 });
    await db.attachments.add({ id: 'att-local', transactionId: attTx.id, mime: 'image/jpeg', width: 100, height: 100, blob: new Blob(['a']), thumb: new Blob(['b']), createdAt: 3000 });

    const restoreRes = await restoreBackup(makeFile(json), 'replace');
    expect(restoreRes.rows).toBeGreaterThan(0);
    expect(await db.attachments.count()).toBe(0);
  });

  it('部分還款分帳欠款會將 paidId 同步寫入母交易 split.debtIds，通過備份金額一致性驗證', async () => {
    const acc = await addAccount({ name: '錢包', type: 'cash', currency: 'TWD', icon: '💵', color: '#30D158', initialBalanceMinor: 200_000, includeInNetWorth: true, isLiability: false });
    const person = await findOrCreatePerson('小華');
    const tx = await addTransaction({
      type: 'expense', accountId: acc.id, categoryId: 'exp-food', amountMinor: 100_000, currency: 'TWD',
      date: '2026-11-01', ts: 1000, split: { myShareMinor: 40_000, debtIds: [] },
    });
    const [debtId] = await addDebts([{ personId: person.id, direction: 'they_owe_me', amountMinor: 60_000, currency: 'TWD', transactionId: tx.id, date: '2026-11-01', note: '聚餐' }]);
    await db.transactions.update(tx.id, { split: { myShareMinor: 40_000, debtIds: [debtId] } });

    const paidId = await settleDebt(debtId, acc.id, { date: '2026-11-02', amountMinor: 20_000 });
    const parent = (await db.transactions.get(tx.id))!;
    expect(parent.split?.debtIds).toEqual([debtId, paidId]);

    const json = await (await buildBackup(false)).text();
    await expect(verifyBackup(makeFile(json))).resolves.toBeDefined();
  });

  it('刪除週期／分期／專案／股利與復原手續費皆維持外鍵與狀態一致性', async () => {
    const acc = await addAccount({ name: '銀行', type: 'bank', currency: 'TWD', icon: '🏦', color: '#0A84FF', initialBalanceMinor: 1_000_000, includeInNetWorth: true, isLiability: false });
    const projId = await saveProject({ name: '日本', icon: '✈️', color: '#0A84FF', start: '2026-11-01', currency: 'TWD', status: 'active', note: '' });
    const budgetId = await saveBudget({ name: '旅遊預算', periodType: 'month', startDate: '2026-11-01', amountMinor: 100_000, currency: 'TWD', categoryId: '', projectId: projId, rollover: false, alertPercents: [80], active: 1 });
    const ruleId = await saveRecurring({ kind: 'normal', name: '月費', template: { type: 'expense', accountId: acc.id, categoryId: 'exp-other_exp', amountMinor: 10_000, currency: 'TWD', projectId: projId }, rule: { freq: 'month', interval: 1 }, startDate: '2026-11-01', mode: 'auto', remindDaysBefore: 0, active: 1 });
    const postedTx = await addTransaction({ type: 'expense', accountId: acc.id, categoryId: 'exp-other_exp', amountMinor: 10_000, currency: 'TWD', date: '2026-11-01', ts: 1000, recurringRuleId: ruleId, projectId: projId });
    const instId = await addInstallment({ name: '筆電', accountId: acc.id, categoryId: 'exp-other_exp', principalMinor: 60_000, currency: 'TWD', periods: 3, aprDec: '0', feeMinor: 0, feeMode: 'first', firstDate: '2026-11-01' });
    const inst = (await db.installments.get(instId))!;
    const instTxId = inst.schedule[0].transactionId!;

    await deleteProject(projId);
    expect((await db.budgets.get(budgetId))?.projectId).toBe('');
    expect((await db.recurring_rules.get(ruleId))?.template.projectId).toBeUndefined();

    await deleteRecurringRule(ruleId);
    expect((await db.transactions.get(postedTx.id))?.recurringRuleId).toBeUndefined();

    await deleteInstallment(instId);
    expect((await db.transactions.get(instTxId))?.installmentId).toBeUndefined();

    // 股利刪除清除 tx.dividendId，備份驗證不失敗
    const stock = await ensureStock({ market: 'TWSE', symbol: '2330', name: '台積電', currency: 'TWD', assetType: 'stock' });
    const divId = await saveDividend({ stockId: stock.id, accountId: acc.id, kind: 'cash', exDate: '2026-11-01', payDate: '2026-11-10', perShareDec: '4', sharesHeldDec: '1000', grossMinor: 400_000, withholdingTaxMinor: 0, nhiSupplementMinor: 0, feeMinor: 1_000, netMinor: 399_000, currency: 'TWD', status: 'paid', syncToLedger: true });
    const divTxId = (await db.dividends.get(divId))!.transactionId!;
    await deleteDividend(divId);
    expect((await db.transactions.get(divTxId))?.dividendId).toBeUndefined();

    // 復原股票交易手續費不應單獨復活 StockTrade
    const trade = await addTrade({ stockId: stock.id, accountId: acc.id, type: 'buy', date: '2026-11-05', ts: 5000, sharesDec: '1000', priceDec: '100', feeMinor: 14_200, taxMinor: 0, fxRateDec: '1', isDCA: false, syncToLedger: true, cashAccountId: acc.id, note: '' });
    await deleteTrade(trade.id);
    await restoreTransactions([trade.feeTransactionId!]);
    expect((await db.stock_trades.get(trade.id))?.deletedAt).toBeTruthy();

    const json = await (await buildBackup(false)).text();
    await expect(verifyBackup(makeFile(json))).resolves.toBeDefined();
  });

  it('盈虧日曆：週末不重算週五漲跌、同日當沖不重複扣手續費與浮動損益、全清倉不產生極端百分比、支援港幣符號與 XIRR 無效日期防護', () => {
    const stockTw: Stock = { id: 'tw', market: 'TWSE', symbol: '2330', name: '台積電', currency: 'TWD', assetType: 'stock', lotSize: 1000, createdAt: 1, updatedAt: 1 };
    const buyTrade: StockTrade = { id: 't1', stockId: 'tw', accountId: 'a', type: 'buy', date: '2026-11-20', ts: 1000, sharesDec: '1000', priceDec: '1000', feeMinor: 10_000, taxMinor: 0, fxRateDec: '1', isDCA: false, syncToLedger: false, note: '', createdAt: 1, updatedAt: 1 };
    const sellSameDay: StockTrade = { id: 't2', stockId: 'tw', accountId: 'a', type: 'sell', date: '2026-11-20', ts: 2000, sharesDec: '1000', priceDec: '1020', feeMinor: 10_000, taxMinor: 30_000, fxRateDec: '1', isDCA: false, syncToLedger: false, note: '', createdAt: 2, updatedAt: 2 };

    // 1. 同日買進賣出（當沖）：已實現 = (1020-1000)*1000 - (100+100+300) = 19,500 元 = 1,950,000 minor，不再重複計 unreal2
    //    且全數出清不應產生 +495150000.0%
    const dayTradeCal = computePnlCalendar({
      stocks: [stockTw],
      trades: [buyTrade, sellSameDay],
      priceCaches: [],
      priceHistories: [{ stockId: 'tw', date: '2026-11-20', closeDec: '1025' }],
      startDate: '2026-11-20',
      endDate: '2026-11-20',
      today: '2026-11-25',
    });
    const d20 = dayTradeCal.days.get('2026-11-20')!;
    expect(d20.currencies[0].pnlMinor).toBe(1_950_000);
    expect(d20.currencies[0].pnlPct).toBeLessThan(20);

    // 2. 週日打開 App，price_cache.marketTime 仍停在週五 2026-11-20，週日 2026-11-22 不應重計週五漲跌
    const friCache: PriceCache = { stockId: 'tw', priceDec: '1020', prevCloseDec: '1000', changeDec: '20', changePctDec: '2', marketTime: Date.parse('2026-11-20T13:30:00+08:00'), source: 'twse', updatedAt: 1, isManual: false };
    const weekendCal = computePnlCalendar({
      stocks: [stockTw],
      trades: [buyTrade],
      priceCaches: [friCache],
      priceHistories: [],
      startDate: '2026-11-22',
      endDate: '2026-11-22',
      today: '2026-11-22',
    });
    expect(weekendCal.days.get('2026-11-22')?.hasActivity).toBe(false);

    // 3. 港幣符號與百分比上下限、XIRR 無效日期
    expect(formatPnlCompact({ currency: 'HKD', pnlMinor: 12300, baseValueMinor: 100_000, pnlPct: 12.3 }, true)).toBe('HK$+123');
    expect(formatPnlPct(123456)).toBe('+999.9%');
    expect(xirr([{ date: 'bad-date', amount: -100 }, { date: '2026-11-20', amount: 120 }])).toBeNull();
  });
});
