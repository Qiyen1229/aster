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
});
