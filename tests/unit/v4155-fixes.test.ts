// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { db } from '@/db/schema';
import { buildDefaultCategories } from '@/db/seed/categories';
import { addAccount } from '@/db/repo/accounts';
import { addTrade, deleteDividend, deleteTrade, ensureStock, restoreTrade, saveDividend, updateTrade } from '@/db/repo/invest';
import { useUI } from '@/stores/ui';
import { AddSheet } from '@/features/add/AddSheet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/services/fx', async (original) => ({
  ...await original<typeof import('@/services/fx')>(),
  getRate: vi.fn(async () => null),
}));

describe('v4.1.55 投資交易 IndexedDB store 完整性', () => {
  let cashAccId = '';
  let brokAccId = '';

  beforeEach(async () => {
    await db.delete();
    await db.open();
    await db.categories.bulkAdd(buildDefaultCategories());
    await db.settings.put({ key: 'baseCurrency', value: 'TWD' });
    cashAccId = (await addAccount({ name: '交割銀行', type: 'bank', currency: 'TWD', initialBalanceMinor: 100_000_00, icon: 'bank', color: '#4f46e5', includeInNetWorth: true, isLiability: false })).id;
    brokAccId = (await addAccount({ name: '證券戶', type: 'brokerage', currency: 'TWD', initialBalanceMinor: 0, icon: 'chart', color: '#10b981', includeInNetWorth: true, isLiability: false })).id;
  });

  it('addTrade / updateTrade / deleteTrade / restoreTrade 在 syncToLedger 開啟時不會發生 objectStore NotFoundError', async () => {
    const stock = await ensureStock({
      market: 'TWSE', symbol: '2330', name: '台積電', currency: 'TWD', assetType: 'stock',
    });
    const trade = await addTrade({
      stockId: stock.id,
      accountId: brokAccId,
      type: 'buy',
      date: '2026-11-22',
      ts: new Date('2026-11-22T10:00:00').getTime(),
      sharesDec: '100',
      priceDec: '1000',
      feeMinor: 142_00,
      taxMinor: 0,
      fxRateDec: '1',
      isDCA: false,
      syncToLedger: true,
      cashAccountId: cashAccId,
      note: '買進台積電',
    });
    expect(trade.transactionId).toBeTruthy();
    expect(trade.feeTransactionId).toBeTruthy();

    const accAfterBuy = await db.accounts.get(cashAccId);
    expect(accAfterBuy?.balanceMinor).toBe(100_000_00 - 100_000_00 - 142_00);

    await updateTrade(trade.id, {
      stockId: stock.id,
      accountId: brokAccId,
      type: 'buy',
      date: '2026-11-22',
      ts: new Date('2026-11-22T10:30:00').getTime(),
      sharesDec: '50',
      priceDec: '1000',
      feeMinor: 71_00,
      taxMinor: 0,
      fxRateDec: '1',
      isDCA: false,
      syncToLedger: true,
      cashAccountId: cashAccId,
      note: '改為 50 股',
    });
    const accAfterUpdate = await db.accounts.get(cashAccId);
    expect(accAfterUpdate?.balanceMinor).toBe(100_000_00 - 50_000_00 - 71_00);

    await deleteTrade(trade.id);
    expect((await db.accounts.get(cashAccId))?.balanceMinor).toBe(100_000_00);

    await restoreTrade(trade.id);
    expect((await db.accounts.get(cashAccId))?.balanceMinor).toBe(100_000_00 - 50_000_00 - 71_00);
  });

  it('saveDividend（現金股利與股票股利）與 deleteDividend 不會發生 objectStore NotFoundError', async () => {
    const stock = await ensureStock({
      market: 'TWSE', symbol: '0050', name: '元大台灣50', currency: 'TWD', assetType: 'etf',
    });
    const cashDivId = await saveDividend({
      stockId: stock.id,
      accountId: cashAccId,
      kind: 'cash',
      status: 'paid',
      exDate: '2026-07-01',
      payDate: '2026-08-01',
      sharesHeldDec: '1000',
      perShareDec: '2',
      grossMinor: 2000_00,
      feeMinor: 0,
      withholdingTaxMinor: 0,
      nhiSupplementMinor: 0,
      netMinor: 2000_00,
      currency: 'TWD',
      syncToLedger: true,
    });
    expect((await db.accounts.get(cashAccId))?.balanceMinor).toBe(102_000_00);

    const stockDivId = await saveDividend({
      stockId: stock.id,
      accountId: brokAccId,
      kind: 'stock',
      status: 'paid',
      exDate: '2026-07-01',
      payDate: '2026-08-01',
      sharesHeldDec: '1000',
      perShareDec: '0.1',
      grossMinor: 0,
      feeMinor: 0,
      withholdingTaxMinor: 0,
      nhiSupplementMinor: 0,
      netMinor: 0,
      currency: 'TWD',
      syncToLedger: false,
    });
    const stockDiv = await db.dividends.get(stockDivId);
    expect(stockDiv?.stockTradeId).toBeTruthy();

    await deleteDividend(cashDivId);
    await deleteDividend(stockDivId);
    expect((await db.accounts.get(cashAccId))?.balanceMinor).toBe(100_000_00);
  });
});

describe('v4.1.55 記一筆與表單日期／時間選擇修復', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await db.delete();
    await db.open();
    await db.categories.bulkAdd(buildDefaultCategories());
    await addAccount({ name: '現金', type: 'cash', currency: 'TWD', initialBalanceMinor: 1000_00, icon: 'wallet', color: '#0ea5e9', includeInNetWorth: true, isLiability: false });
    useUI.setState({ add: { open: false, seq: 0 }, confirm: null, snack: null, actions: null, selectedDate: '2026-11-22' });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    document.body.innerHTML = '';
  });

  it('AddSheet 日期與時間改用自訂選擇器（不使用原生 date/time input）且可正常變更數值', async () => {
    await act(async () => {
      useUI.getState().openAdd();
      root.render(React.createElement(AddSheet));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 40)); });

    const screen = document.body.querySelector<HTMLElement>('.add-screen')!;
    expect(screen.querySelector('input[type="date"]')).toBeNull();
    expect(screen.querySelector('input[type="time"]')).toBeNull();

    const dateBtn = screen.querySelector<HTMLButtonElement>('button.pill[aria-label="日期"]')!;
    const timeBtn = screen.querySelector<HTMLButtonElement>('button.pill[aria-label="時間"]')!;
    expect(dateBtn).not.toBeNull();
    expect(timeBtn).not.toBeNull();

    // 開啟自訂日期選擇器並點選 15 日
    await act(async () => { dateBtn.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    const day15 = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.dp-cell:not(.out)'))
      .find((b) => b.textContent?.trim() === '15')!;
    expect(day15).toBeTruthy();
    const expectedDate = day15.getAttribute('aria-label')!;
    await act(async () => { day15.click(); });
    expect(dateBtn.textContent).toContain(`${Number(expectedDate.slice(5, 7))}/${Number(expectedDate.slice(8, 10))}`);

    // 開啟自訂時間選擇器並選 08:45
    await act(async () => { timeBtn.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    const hourOpt = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[aria-label="小時"] .tp-opt'))
      .find((b) => b.textContent?.trim() === '08')!;
    const minChip = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.tp-quick .dp-chip'))
      .find((b) => b.textContent?.trim() === ':45')!;
    const confirmBtn = document.body.querySelector<HTMLButtonElement>('.tp-actions .btn.primary')!;
    await act(async () => {
      hourOpt.click();
      minChip.click();
    });
    await act(async () => { confirmBtn.click(); });
    expect(timeBtn.textContent).toContain('08:45');
  });

  it('app.css 不讓 .pill::after 擋住 .pill-picker-input、表單元件允許 user-select: text 且 .field 日期時間不使用 inline-flex', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/theme/app.css'), 'utf8');
    expect(css).toContain('.pill-picker-input');
    expect(css).toContain('.pill:has(> .pill-picker-input)::after { pointer-events: none; }');
    expect(css).toMatch(/input,\s*textarea,\s*select\s*\{[^}]*user-select:\s*text/);
    const fieldDateBlock = css.match(/\.field input\[type="date"\][\s\S]*?\}/)?.[0] ?? '';
    expect(fieldDateBlock).not.toContain('inline-flex');
  });
});
