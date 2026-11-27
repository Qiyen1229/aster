// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { db } from '@/db/schema';
import { buildDefaultCategories } from '@/db/seed/categories';
import { addTransaction } from '@/db/repo/ledger';
import { recordDecision } from '@/services/decisionLog';
import { useUI } from '@/stores/ui';
import { AddSheet } from '@/features/add/AddSheet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/services/haptics', () => ({ haptic: vi.fn() }));
vi.mock('@/services/fx', () => ({ getRate: vi.fn(async () => 1) }));

async function flushUi() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
}

describe('AddSheet 編輯轉帳／借貸與自動入帳回饋', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await db.delete();
    await db.open();
    await db.categories.bulkAdd(buildDefaultCategories());
    await db.accounts.bulkAdd([
      { id: 'acc-1', name: '現金', type: 'cash', currency: 'TWD', initialBalanceMinor: 100000, balanceMinor: 100000, includeInNetWorth: true, isLiability: false, icon: '💵', color: '#4caf50', sort: 0, archived: 0, createdAt: 1, updatedAt: 1 },
      { id: 'acc-2', name: '玉山銀行', type: 'bank', currency: 'TWD', initialBalanceMinor: 500000, balanceMinor: 500000, includeInNetWorth: true, isLiability: false, icon: '🏦', color: '#2196f3', sort: 1, archived: 0, createdAt: 1, updatedAt: 1 },
    ]);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    useUI.getState().closeAdd();
    await act(async () => { root.unmount(); });
    container.remove();
    await db.delete();
  });

  it('編輯既有支出帳目時可切換為「轉帳」並取代原交易，不留重複帳目', async () => {
    const tx = await addTransaction({
      type: 'expense',
      accountId: 'acc-1',
      categoryId: 'exp-other_exp',
      amountMinor: 50000,
      currency: 'TWD',
      date: '2026-11-27',
      ts: Date.now(),
      note: '轉給玉山',
      tagIds: [],
    });

    useUI.getState().editTx(tx.id);
    await act(async () => { root.render(React.createElement(AddSheet)); });
    await flushUi();

    const modeTabs = Array.from(document.body.querySelectorAll('[aria-label="記帳類型"] button, [aria-label="記帳類型"] [role="tab"], [role="tablist"] button'));
    const labels = modeTabs.map((b) => b.textContent?.trim());
    expect(labels).toContain('轉帳');
    expect(labels).toContain('借貸');

    const transferBtn = modeTabs.find((b) => b.textContent?.trim() === '轉帳') as HTMLButtonElement;
    await act(async () => { transferBtn.click(); });
    await flushUi();

    const saveBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes('儲存')) as HTMLButtonElement;
    expect(saveBtn).toBeDefined();
    await act(async () => { saveBtn.click(); });
    await flushUi();

    const oldTx = await db.transactions.get(tx.id);
    expect(oldTx?.deletedAt).toBeTypeOf('number');
    const transfers = await db.transfers.filter((x) => !x.deletedAt).toArray();
    expect(transfers.length).toBe(1);
    expect(transfers[0].fromAccountId).toBe('acc-1');
    expect(transfers[0].toAccountId).toBe('acc-2');
    expect(transfers[0].fromAmountMinor).toBe(50000);
  });

  it('編輯自動入帳的交易後會記錄 edit_field 回饋影響規則信心，並學習分類記憶', async () => {
    await db.rules.add({
      id: 'rule-1',
      keyword: '星巴克',
      match: 'contains',
      kind: 'expense',
      categoryId: 'exp-other_exp',
      tagIds: [],
      enabled: true,
      priority: 10,
      hits: 1,
      status: 'active',
      stats: { shown: 1, autoBooked: 1, cleanAccepted: 0, editedCategory: 0, editedAccount: 0, editedAmount: 0, rejected: 0 },
      createdAt: 1,
      updatedAt: 1,
    });

    const decision = await recordDecision({
      source: 'notify',
      rawText: '星巴克消費 150 元',
      candidates: [],
      chosen: { categoryId: 'exp-other_exp', accountId: 'acc-1', amountMinor: 15000, currency: 'TWD' },
      confidence: 0.9,
      matchedRuleId: 'rule-1',
      outcome: 'auto_booked',
    });

    const tx = await addTransaction({
      type: 'expense',
      accountId: 'acc-1',
      categoryId: 'exp-other_exp',
      amountMinor: 15000,
      currency: 'TWD',
      date: '2026-11-27',
      ts: Date.now(),
      note: '星巴克',
      merchant: '星巴克',
      decisionId: decision.id,
      tagIds: [],
    });

    useUI.getState().editTx(tx.id);
    await act(async () => { root.render(React.createElement(AddSheet)); });
    await flushUi();

    // 展開分類選擇器、切換主分類（飲食）並選取子分類（早餐）
    const openCatBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes('其他'));
    expect(openCatBtn).toBeDefined();
    await act(async () => { (openCatBtn as HTMLButtonElement).click(); });
    await flushUi();
    const foodCat = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes('飲食'));
    expect(foodCat).toBeDefined();
    await act(async () => { (foodCat as HTMLButtonElement).click(); });
    await flushUi();
    const subCat = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes('早餐'));
    expect(subCat).toBeDefined();
    await act(async () => { (subCat as HTMLButtonElement).click(); });
    await flushUi();

    const saveBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes('儲存')) as HTMLButtonElement;
    await act(async () => { saveBtn.click(); });
    await flushUi();

    const txAfter = await db.transactions.get(tx.id);
    expect(txAfter?.categoryId).not.toBe('exp-other_exp');

    const signals = await db.feedback_signals.where('decisionId').equals(decision.id).toArray();
    expect(signals.some((s) => s.signalType === 'edit_field' && s.field === 'category')).toBe(true);
    const updatedRule = await db.rules.get('rule-1');
    expect(updatedRule?.stats?.editedCategory).toBe(1);

    const learnedRules = await db.rules.filter((r) => !r.deletedAt && r.keyword === '星巴克').toArray();
    expect(learnedRules.length).toBeGreaterThanOrEqual(1);
    expect(learnedRules.some((r) => r.categoryId !== 'exp-other_exp')).toBe(true);
  });
});
