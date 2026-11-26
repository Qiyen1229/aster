// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { db } from '@/db/schema';
import { buildDefaultCategories } from '@/db/seed/categories';
import { addAccount } from '@/db/repo/accounts';
import { addTrade, deleteTrade, ensureStock } from '@/db/repo/invest';
import { deleteTransactions, restoreTransactions } from '@/db/repo/ledger';
import { useUI } from '@/stores/ui';
import InvestTab, { fmtXirr, pct } from '@/features/invest/InvestTab';
import StockDetailPage from '@/features/invest/StockDetailPage';
import { TradeSheet } from '@/features/invest/TradeSheet';
import { StockSearch } from '@/features/invest/StockSearch';
import { AddSheet } from '@/features/add/AddSheet';
import { Sheet, trapTabKey } from '@/ui/Sheet';
import { AmountField, DateField, TextField } from '@/ui/form';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/services/fx', async (original) => ({
  ...await original<typeof import('@/services/fx')>(),
  getRate: vi.fn(async () => null),
}));

vi.mock('@/services/quotes/registry', async (original) => ({
  ...await original<typeof import('@/services/quotes/registry')>(),
  fetchHistory: vi.fn(async () => ({ bars: [], source: '', offline: false })),
}));

vi.mock('@/features/reports/EChart', () => ({
  default: () => React.createElement('div', { 'data-testid': 'mock-echart' }),
}));

describe('v4.1.56 股票刪除與記帳雙向連動', () => {
  let cashAccId = '';
  let brokAccId = '';

  beforeEach(async () => {
    await db.delete();
    await db.open();
    await db.categories.bulkAdd(buildDefaultCategories());
    await db.settings.put({ key: 'baseCurrency', value: 'TWD' });
    cashAccId = (await addAccount({
      name: '交割銀行',
      type: 'bank',
      currency: 'TWD',
      initialBalanceMinor: 100_000_00,
      icon: 'bank',
      color: '#4f46e5',
      includeInNetWorth: true,
      isLiability: false,
    })).id;
    brokAccId = (await addAccount({
      name: '證券戶',
      type: 'brokerage',
      currency: 'TWD',
      initialBalanceMinor: 0,
      icon: 'chart',
      color: '#10b981',
      includeInNetWorth: true,
      isLiability: false,
    })).id;
  });

  it('從記帳刪除／復原股票交易主帳目時，同步軟刪除與復原 stock_trades 及手續費帳目與帳戶餘額', async () => {
    const stock = await ensureStock({
      market: 'TWSE',
      symbol: '2330',
      name: '台積電',
      currency: 'TWD',
      assetType: 'stock',
    });
    const trade = await addTrade({
      stockId: stock.id,
      accountId: brokAccId,
      type: 'buy',
      date: '2026-11-22',
      ts: new Date('2026-11-22T10:00:00').getTime(),
      sharesDec: '50',
      priceDec: '1000',
      feeMinor: 71_00,
      taxMinor: 0,
      fxRateDec: '1',
      isDCA: false,
      syncToLedger: true,
      cashAccountId: cashAccId,
      note: '台積電測試',
    });
    expect(trade.transactionId).toBeTruthy();
    expect(trade.feeTransactionId).toBeTruthy();
    expect((await db.accounts.get(cashAccId))?.balanceMinor).toBe(100_000_00 - 50_000_00 - 71_00);

    // 模擬在記帳列表左滑刪除主要股票帳目
    await deleteTransactions([trade.transactionId!]);
    const deletedTrade = await db.stock_trades.get(trade.id);
    const deletedMain = await db.transactions.get(trade.transactionId!);
    const deletedFee = await db.transactions.get(trade.feeTransactionId!);
    expect(deletedTrade?.deletedAt).toBeTruthy();
    expect(deletedMain?.deletedAt).toBeTruthy();
    expect(deletedFee?.deletedAt).toBeTruthy();
    expect((await db.accounts.get(cashAccId))?.balanceMinor).toBe(100_000_00);

    // 模擬復原該筆帳目
    await restoreTransactions([trade.transactionId!]);
    const restoredTrade = await db.stock_trades.get(trade.id);
    const restoredMain = await db.transactions.get(trade.transactionId!);
    const restoredFee = await db.transactions.get(trade.feeTransactionId!);
    expect(restoredTrade?.deletedAt).toBeNull();
    expect(restoredMain?.deletedAt).toBeNull();
    expect(restoredFee?.deletedAt).toBeNull();
    expect((await db.accounts.get(cashAccId))?.balanceMinor).toBe(100_000_00 - 50_000_00 - 71_00);
  });

  it('deleteTrade 會一併清理所有以 stockTradeId 關聯的帳目並更新 updatedAt', async () => {
    const stock = await ensureStock({
      market: 'TWSE',
      symbol: '0050',
      name: '元大台灣50',
      currency: 'TWD',
      assetType: 'etf',
    });
    const trade = await addTrade({
      stockId: stock.id,
      accountId: brokAccId,
      type: 'buy',
      date: '2026-11-22',
      ts: new Date('2026-11-22T10:00:00').getTime(),
      sharesDec: '100',
      priceDec: '100',
      feeMinor: 20_00,
      taxMinor: 0,
      fxRateDec: '1',
      isDCA: false,
      syncToLedger: true,
      cashAccountId: cashAccId,
      note: '0050 測試',
    });
    await db.stock_trades.update(trade.id, { transactionId: undefined });
    await deleteTrade(trade.id);
    expect((await db.stock_trades.get(trade.id))?.deletedAt).toBeTruthy();
    expect((await db.transactions.get(trade.transactionId!))?.deletedAt).toBeTruthy();
    expect((await db.transactions.get(trade.feeTransactionId!))?.deletedAt).toBeTruthy();
    expect((await db.accounts.get(cashAccId))?.balanceMinor).toBe(100_000_00);
  });
});

async function waitForSelector<T extends Element>(root: ParentNode, selector: string, timeoutMs = 1500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const el = root.querySelector<T>(selector);
    if (el) return el;
    await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
  }
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`Timeout waiting for ${selector}; html=${(root as HTMLElement).innerHTML?.slice(0, 300)}`);
  return el;
}

describe('v4.1.56 股票列表／個股頁／交易抽屜刪除與溢位修復', () => {
  let host: HTMLDivElement;
  let root: Root;
  let cashAccId = '';
  let brokAccId = '';

  beforeEach(async () => {
    await db.delete();
    await db.open();
    await db.categories.bulkAdd(buildDefaultCategories());
    await db.settings.put({ key: 'baseCurrency', value: 'TWD' });
    cashAccId = (await addAccount({ name: '現金帳戶', type: 'bank', currency: 'TWD', initialBalanceMinor: 200_000_00, icon: 'bank', color: '#4f46e5', includeInNetWorth: true, isLiability: false })).id;
    brokAccId = (await addAccount({ name: '證券戶', type: 'brokerage', currency: 'TWD', initialBalanceMinor: 0, icon: 'chart', color: '#10b981', includeInNetWorth: true, isLiability: false })).id;
    useUI.setState({ snack: null, confirm: null, actions: null });
    if (!window.matchMedia) {
      window.matchMedia = vi.fn().mockImplementation((q: string) => ({
        matches: false,
        media: q,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }));
    }
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    document.body.innerHTML = '';
  });

  it('InvestTab 持股與 StockDetailPage 交易紀錄支援左滑 SwipeRow 刪除，點進 TradeSheet 亦有刪除鈕', async () => {
    const stock = await ensureStock({
      market: 'TWSE',
      symbol: '2330',
      name: '台積電',
      currency: 'TWD',
      assetType: 'stock',
    });
    const t1 = await addTrade({
      stockId: stock.id,
      accountId: brokAccId,
      type: 'buy',
      date: '2026-11-20',
      ts: new Date('2026-11-20T10:00:00').getTime(),
      sharesDec: '100',
      priceDec: '500',
      feeMinor: 71_00,
      taxMinor: 0,
      fxRateDec: '1',
      isDCA: false,
      syncToLedger: true,
      cashAccountId: cashAccId,
      note: '第一筆',
    });

    // 1. InvestTab 渲染 SwipeRow 刪除動作
    await act(async () => {
      root.render(React.createElement(MemoryRouter, null, React.createElement(InvestTab)));
    });
    const holdingSwipe = await waitForSelector<HTMLElement>(host, '.list .swipe');
    expect(holdingSwipe.querySelector('.swipe-action.right')?.textContent).toContain('刪除');

    // 2. StockDetailPage 渲染 SwipeRow 交易紀錄，且點開交易編輯在右上及底部皆有「刪除交易」按鈕
    const detailHost = document.createElement('div');
    document.body.appendChild(detailHost);
    const detailRoot = createRoot(detailHost);
    try {
      await act(async () => {
        detailRoot.render(
          React.createElement(
            MemoryRouter,
            { initialEntries: [`/invest/stock/${stock.id}`] },
            React.createElement(Routes, null, React.createElement(Route, { path: '/invest/stock/:id', element: React.createElement(StockDetailPage) })),
          ),
        );
      });
      const tradeSwipeContent = await waitForSelector<HTMLElement>(detailHost, '.list .swipe .swipe-content');

      // 點擊進入編輯抽屜
      await act(async () => {
        tradeSwipeContent.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });

      const dialog = await waitForSelector<HTMLElement>(document.body, '.sheet[role="dialog"]');
      // 已知 stockId 不應顯示 StockSearch
      expect(dialog.querySelector('input[aria-label="搜尋股票"]')).toBeNull();

      const headerDelBtn = dialog.querySelector<HTMLButtonElement>('button[aria-label="刪除交易"]');
      const footerDelBtn = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button.btn.danger')).find((b) => b.textContent?.includes('刪除交易'));
      expect(headerDelBtn).not.toBeNull();
      expect(footerDelBtn).not.toBeNull();

      await act(async () => {
        footerDelBtn!.click();
      });
      await act(async () => { await new Promise((r) => setTimeout(r, 60)); });

      expect((await db.stock_trades.get(t1.id))?.deletedAt).toBeTruthy();
      expect((await db.accounts.get(cashAccId))?.balanceMinor).toBe(200_000_00);
    } finally {
      await act(async () => { detailRoot.unmount(); });
      detailHost.remove();
    }
  });

  it('TradeSheet 傳入 stockId 但無 initialStock 時也不會閃現 StockSearch', async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(React.createElement(TradeSheet, { open: true, onClose, stockId: 'non-existent-id' }));
    });
    expect(document.body.querySelector('input[aria-label="搜尋股票"]')).toBeNull();
  });

  it('pct 與 fmtXirr 正確截斷極端報酬率與異常大 XIRR', () => {
    expect(pct(12.345)).toBe('+12.35%');
    expect(pct(-5)).toBe('-5.00%');
    expect(pct(Number.POSITIVE_INFINITY)).toBe('—');
    expect(pct(1.2569e71)).toBe('>+9,999%');
    expect(pct(-50000)).toBe('<-999%');

    expect(fmtXirr(null)).toBe('—');
    expect(fmtXirr(Number.NaN)).toBe('—');
    expect(fmtXirr(0.153)).toBe('+15.30%');
    expect(fmtXirr(1.2569e69)).toBe('>+999.9%');
    expect(fmtXirr(-0.5)).toBe('-50.00%');
    expect(fmtXirr(-12)).toBe('<-99.9%');
  });
});

describe('v4.1.56 鍵盤偏移、Sheet 焦點保護、聯絡人自動填寫與 CSS／HTML 防護', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('觸控裝置開啟含 input 的 Sheet 時聚焦於容器而非 input，避免滑入動畫期間誤彈鍵盤，且 trapTabKey 可從容器進到內部元件', async () => {
    const origMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((q: string) => ({
      matches: q.includes('pointer: coarse'),
      media: q,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    try {
      await act(async () => {
        root.render(
          React.createElement(Sheet, {
            open: true,
            onClose: () => {},
            children: [
              React.createElement('input', { key: 'i', type: 'text', 'aria-label': '測試輸入框' }),
              React.createElement('button', { key: 'b', type: 'button' }, '確認'),
            ],
          }),
        );
      });
      await act(async () => { await new Promise((r) => setTimeout(r, 80)); });

      const dialog = document.body.querySelector<HTMLElement>('.sheet[role="dialog"]')!;
      expect(document.activeElement).toBe(dialog);

      const inputEl = dialog.querySelector<HTMLInputElement>('input')!;
      const btnEl = dialog.querySelector<HTMLButtonElement>('button')!;
      Object.defineProperty(inputEl, 'offsetParent', { value: dialog, configurable: true });
      Object.defineProperty(btnEl, 'offsetParent', { value: dialog, configurable: true });

      const tabEv = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
      trapTabKey(dialog, tabEv);
      expect(tabEv.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(inputEl);
    } finally {
      window.matchMedia = origMatchMedia;
    }
  });

  it('StockSearch 與表單元件關閉瀏覽器／聯絡人自動填寫，DateField 點擊整個欄位列可開啟與聚焦日期輸入', async () => {
    await act(async () => {
      root.render(
        React.createElement(
          'div',
          null,
          React.createElement(StockSearch, { onPick: () => {}, autoFocus: false }),
          React.createElement(TextField, { label: '備註', value: '', onChange: () => {} }),
          React.createElement(AmountField, { label: '金額', value: '', onChange: () => {} }),
          React.createElement(DateField, { label: '日期', value: '2026-11-23', onChange: () => {} }),
        ),
      );
    });

    const searchInput = host.querySelector<HTMLInputElement>('input[aria-label="搜尋股票"]')!;
    expect(searchInput.getAttribute('autocomplete')).toBe('off');
    expect(searchInput.getAttribute('autocorrect')).toBe('off');

    expect(host.querySelector('input[type="date"]')).toBeNull();
    const dateBtn = host.querySelector<HTMLButtonElement>('button.custom-select-btn')!;
    expect(dateBtn).toBeTruthy();
    expect(dateBtn.textContent).toContain('2026-11-23');
    await act(async () => {
      dateBtn.click();
    });
    expect(document.body.querySelector('.sheet')).toBeTruthy();
  });

  it('AddSheet 日期與時間膠囊為自訂選擇器按鈕，備註輸入框具 autoComplete="off"', async () => {
    await db.delete();
    await db.open();
    await db.categories.bulkAdd(buildDefaultCategories());
    await addAccount({ name: '現金', type: 'cash', currency: 'TWD', initialBalanceMinor: 1000_00, icon: 'wallet', color: '#0ea5e9', includeInNetWorth: true, isLiability: false });
    useUI.setState({ add: { open: true, seq: 1 }, confirm: null, snack: null, actions: null, selectedDate: '2026-11-23' });

    await act(async () => {
      root.render(React.createElement(AddSheet));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 40)); });

    const screen = document.body.querySelector<HTMLElement>('.add-screen')!;
    const dateBtn = screen.querySelector<HTMLButtonElement>('button.pill[aria-label="日期"]')!;
    const timeBtn = screen.querySelector<HTMLButtonElement>('button.pill[aria-label="時間"]')!;
    const noteInput = screen.querySelector<HTMLInputElement>('input[aria-label="備註"]')!;
    expect(dateBtn).not.toBeNull();
    expect(timeBtn).not.toBeNull();
    expect(screen.querySelector('input[type="date"]')).toBeNull();
    expect(screen.querySelector('input[type="time"]')).toBeNull();
    expect(noteInput.getAttribute('autocomplete')).toBe('off');
  });

  it('index.html 不再包含 interactive-widget=resizes-content，且 app.css 具備 .kb-open .sheet 頂端錨定與 .stat-grid 防溢位規則', () => {
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
    expect(html).not.toContain('interactive-widget=resizes-content');

    const css = readFileSync(resolve(process.cwd(), 'src/theme/app.css'), 'utf8');
    expect(css).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))');
    expect(css).toContain('html:not(.is-desktop).kb-open .sheet');
    expect(css).toContain('top: calc(var(--vvt, 0px) + var(--safe-t) + 8px);');
    expect(css).toContain('transform: none !important;');
    expect(css).toContain('.pill-picker-input::-webkit-date-and-time-value');
  });
});
