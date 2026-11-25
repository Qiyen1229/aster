// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { db } from '@/db/schema';
import { buildDefaultCategories } from '@/db/seed/categories';
import { addAccount } from '@/db/repo/accounts';
import { parseRows, runImport } from '@/services/importer';
import { Calendar } from '@/features/home/Calendar';

describe('稽核修復回歸驗證（通知跳轉、Calendar ARIA、CSV 同帳戶防衛）', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await db.delete();
    await db.open();
    await db.categories.bulkAdd(buildDefaultCategories());
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    document.body.innerHTML = '';
  });

  it('CSV 匯入：轉出與轉入帳戶相同時在 parseRows 與 runImport 皆應攔截', async () => {
    await addAccount({ name: '現金', type: 'cash', currency: 'TWD', initialBalanceMinor: 1000_00, icon: 'wallet', color: '#0ea5e9', includeInNetWorth: true, isLiability: false });
    const parsed = parseRows(
      [['2026-11-25', '轉出', '-100', '現金', '現金']],
      { date: 0, type: 1, amount: 2, account: 3, toAccount: 4 },
      { currency: 'TWD', account: '現金' },
    );
    expect(parsed[0].error).toBe('轉出與轉入帳戶不能相同');

    await expect(runImport([{
      ...parsed[0],
      error: undefined,
    }], 'TWD')).rejects.toThrow('轉出與轉入帳戶不能相同');
  });

  it('Calendar：週曆與月曆的 role="grid" 皆由 role="row" 包覆 role="gridcell"', async () => {
    const noop = () => undefined;
    await act(async () => {
      root.render(React.createElement(Calendar, {
        year: 2026,
        month0: 10,
        selected: '2026-11-25',
        weekStart: 0,
        dayTotals: new Map(),
        daysWithRecords: new Set<string>(),
        collapsed: false,
        mode: 'ledger',
        onSelect: noop,
        onMonthShift: noop,
        onWeekShift: noop,
        onToggleCollapse: noop,
        onModeChange: noop,
      }));
    });
    const grids = host.querySelectorAll('[role="grid"]');
    expect(grids.length).toBeGreaterThanOrEqual(2);
    for (const g of grids) {
      const rows = g.querySelectorAll('[role="row"]');
      expect(rows.length).toBeGreaterThanOrEqual(1);
      for (const r of rows) {
        expect(r.querySelectorAll('[role="gridcell"]').length).toBe(7);
      }
    }
  });

  it('sw.ts 與 App.tsx 具備通知點擊導向（await navigate + aster:navigate + Capacitor action listeners）', () => {
    const sw = readFileSync(resolve(process.cwd(), 'src/sw.ts'), 'utf8');
    expect(sw).toContain('await wc.navigate(targetUrl)');
    expect(sw).toContain("wc.postMessage({ type: 'aster:navigate', url: targetPath })");

    const app = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
    expect(app).toContain("d?.type === 'aster:navigate'");
    expect(app).toContain('localNotificationActionPerformed');
    expect(app).toContain('pushNotificationActionPerformed');
  });
});
