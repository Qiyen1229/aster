// @vitest-environment jsdom
/**
 * v4.1.46 回歸與無障礙保護測試：
 * - trapTabKey：對話框內 Tab / Shift+Tab 焦點循環鎖定
 * - AddSheet 進階選項提交鈕、AccountSheet 負債鎖定、IME isComposing 防護靜態回歸檢查
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trapTabKey } from '@/ui/Sheet';
import { matchRule } from '@/domain/rules';
import { reconcile } from '@/domain/reconcile';
import { detectInsights } from '@/domain/anomaly';

function makeBtn() {
  const b = document.createElement('button');
  Object.defineProperty(b, 'offsetParent', { value: document.body, configurable: true });
  return b;
}

describe('v4.1.46 回歸與無障礙檢查', () => {
  it('trapTabKey 在最後一個元素按 Tab 回到第一個、第一個按 Shift+Tab 回到最後一個', () => {
    const wrap = document.createElement('div');
    const b1 = makeBtn();
    const b2 = makeBtn();
    wrap.append(b1, b2);
    document.body.append(wrap);

    b2.focus();
    const e1 = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    trapTabKey(wrap, e1);
    expect(e1.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(b1);

    const e2 = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true });
    trapTabKey(wrap, e2);
    expect(e2.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(b2);

    wrap.remove();
  });

  it('AddSheet 進階選項保有完成按鈕、AccountSheet 鎖定既有帳戶期初金額、IME 輸入框均有 isComposing 防護', () => {
    const addSrc = readFileSync(resolve(process.cwd(), 'src/features/add/AddSheet.tsx'), 'utf8');
    expect(addSrc).toContain('add-adv-head');
    expect(addSrc).toContain('accent-pill');
    expect(addSrc).toContain('isComposing');

    const accSrc = readFileSync(resolve(process.cwd(), 'src/features/accounts/AccountSheet.tsx'), 'utf8');
    expect(accSrc).toContain('disabled={!!account}');
    expect(accSrc).toContain('期初欠款');

    for (const rel of [
      'src/features/add/QuickEntry.tsx',
      'src/features/add/Keypad.tsx',
      'src/features/home/VoiceSheet.tsx',
      'src/features/settings/InboxWhitelistPage.tsx',
    ]) {
      const s = readFileSync(resolve(process.cwd(), rel), 'utf8');
      expect(s).toContain('isComposing');
    }
  });

  it('商家規則支援排除關鍵字與金額區間', () => {
    const rules = [
      { id: 'r1', keyword: '遠東百貨', excludeKeyword: '停車,退貨', match: 'contains' as const, kind: 'expense' as const, categoryId: 'exp-food', priority: 10 },
      { id: 'r2', keyword: '7-ELEVEN', match: 'contains' as const, kind: 'expense' as const, categoryId: 'exp-breakfast', maxAmount: 60, priority: 10 },
      { id: 'r3', keyword: '7-ELEVEN', match: 'contains' as const, kind: 'expense' as const, categoryId: 'exp-dinner', minAmount: 61, priority: 20 },
    ];
    expect(matchRule(rules, '遠東百貨美食街', 'expense', 180)?.id).toBe('r1');
    expect(matchRule(rules, '遠東百貨停車場', 'expense', 60)).toBeUndefined();
    expect(matchRule(rules, '7-ELEVEN 咖啡', 'expense', 45)?.categoryId).toBe('exp-breakfast');
    expect(matchRule(rules, '7-ELEVEN 便當', 'expense', 95)?.categoryId).toBe('exp-dinner');
  });

  it('對帳差異細分手續費、日期差、退款與疑似重複多記', () => {
    const r = reconcile(
      [
        { id: 's1', date: '2026-10-10', amountMinor: 10500, kind: 'expense', text: '跨行匯款手續費' },
        { id: 's2', date: '2026-10-12', amountMinor: 10050, kind: 'expense', text: '星巴克' },
        { id: 's3', date: '2026-10-15', amountMinor: 50000, kind: 'income', text: 'PChome 退款' },
      ],
      [
        { id: 'l1', date: '2026-10-10', accountMinor: 10000, origMinor: 10000, origCurrency: 'TWD', kind: 'expense', text: '跨行匯款' },
        { id: 'l2', date: '2026-10-10', accountMinor: 10000, origMinor: 10000, origCurrency: 'TWD', kind: 'expense', text: '星巴克' },
        { id: 'l3', date: '2026-10-15', accountMinor: 49500, origMinor: 49500, origCurrency: 'TWD', kind: 'income', text: 'PChome' },
        { id: 'l4', date: '2026-10-12', accountMinor: 20000, origMinor: 20000, origCurrency: 'TWD', kind: 'expense', text: '全聯' },
        { id: 'l5', date: '2026-10-12', accountMinor: 20000, origMinor: 20000, origCurrency: 'TWD', kind: 'expense', text: '全聯' },
      ],
      'TWD',
    );
    expect(r.variances.find((v) => v.stmt.id === 's1')?.reason).toBe('fee');
    expect(r.variances.find((v) => v.stmt.id === 's2')?.reason).toBe('date_shift');
    expect(r.variances.find((v) => v.stmt.id === 's3')?.reason).toBe('refund');
    expect(r.extraDuplicates.map((x) => x.id)).toEqual(['l4', 'l5']);
  });

  it('週期帳目金額變少也會觸發變動提示', () => {
    const txs = [
      { id: '1', type: 'expense' as const, accountId: 'a1', categoryId: 'exp-sub', amountMinor: 39000, accountAmountMinor: 39000, baseAmountMinor: 39000, currency: 'TWD', date: '2026-08-01', ts: 1, note: 'Netflix', recurringRuleId: 'rec1', tagIds: [], attachmentIds: [], createdAt: 1, updatedAt: 1 },
      { id: '2', type: 'expense' as const, accountId: 'a1', categoryId: 'exp-sub', amountMinor: 39000, accountAmountMinor: 39000, baseAmountMinor: 39000, currency: 'TWD', date: '2026-09-01', ts: 2, note: 'Netflix', recurringRuleId: 'rec1', tagIds: [], attachmentIds: [], createdAt: 2, updatedAt: 2 },
      { id: '3', type: 'expense' as const, accountId: 'a1', categoryId: 'exp-sub', amountMinor: 29000, accountAmountMinor: 29000, baseAmountMinor: 29000, currency: 'TWD', date: '2026-10-01', ts: 3, note: 'Netflix', recurringRuleId: 'rec1', tagIds: [], attachmentIds: [], createdAt: 3, updatedAt: 3 },
      { id: '4', type: 'expense' as const, accountId: 'a1', categoryId: 'exp-food', amountMinor: 10000, accountAmountMinor: 10000, baseAmountMinor: 10000, currency: 'TWD', date: '2026-10-02', ts: 4, note: '午餐', tagIds: [], attachmentIds: [], createdAt: 4, updatedAt: 4 },
      { id: '5', type: 'expense' as const, accountId: 'a1', categoryId: 'exp-food', amountMinor: 10000, accountAmountMinor: 10000, baseAmountMinor: 10000, currency: 'TWD', date: '2026-10-03', ts: 5, note: '晚餐', tagIds: [], attachmentIds: [], createdAt: 5, updatedAt: 5 },
    ];
    const f = detectInsights({
      txs,
      today: '2026-10-10',
      rules: [],
      catName: () => '訂閱',
      mainOf: (c) => c,
      fmt: (m) => `$${m / 100}`,
    });
    expect(f.some((x) => x.kind === 'price_up' && x.title.includes('金額變少'))).toBe(true);
  });
});
