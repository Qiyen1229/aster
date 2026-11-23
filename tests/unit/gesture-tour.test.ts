// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { db } from '@/db/schema';
import { DEFAULT_SETTINGS } from '@/db/repo/settings';
import { useSettings } from '@/stores/settings';
import { GestureTour } from '@/features/onboarding/GestureTour';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function pointer(el: EventTarget, type: string, init: { clientX?: number; clientY?: number; button?: number; pointerId?: number } = {}) {
  const ev = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX ?? 195,
    clientY: init.clientY ?? 790,
    button: init.button ?? 0,
  });
  Object.defineProperty(ev, 'pointerId', { value: init.pointerId ?? 1 });
  el.dispatchEvent(ev);
}

describe('首頁互動式手勢教學（GestureTour）', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await db.delete();
    await db.open();
    vi.useFakeTimers();
    useSettings.getState().hydrate({ ...structuredClone(DEFAULT_SETTINGS), onboarded: true, gestureTourDone: false });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => {
      root?.unmount();
    });
    host?.remove();
    document.body.innerHTML = '';
  });

  it('預設設定 DEFAULT_SETTINGS.gestureTourDone 為 true（升級用戶不打擾）', () => {
    expect(DEFAULT_SETTINGS.gestureTourDone).toBe(true);
  });

  it('手機版 3 步實際手勢過關：上滑開 Cilo → 長按 350ms 語音 → 輕點結束並標記完成', async () => {
    await act(async () => {
      root.render(React.createElement(GestureTour, { desktop: false }));
    });

    expect(host.textContent).toContain('第 1 / 3 步');

    // Step 0：上滑超過 18px → 進入下滑關閉指引 → 下滑超過 18px
    const target0 = host.querySelector<HTMLButtonElement>('.tour-target')!;
    await act(async () => {
      pointer(target0, 'pointerdown', { clientY: 800 });
      pointer(target0, 'pointermove', { clientY: 750 });
      pointer(target0, 'pointerup', { clientY: 750 });
    });
    expect(host.textContent).toContain('接著往下滑，關閉 Cilo 面板');
    await act(async () => {
      pointer(target0, 'pointerdown', { clientY: 750 });
      pointer(target0, 'pointermove', { clientY: 800 });
      pointer(target0, 'pointerup', { clientY: 800 });
    });
    expect(host.textContent).toContain('做到了');
    await act(async () => { vi.advanceTimersByTime(500); });

    // Step 1：按住超過 350ms
    expect(host.textContent).toContain('第 2 / 3 步');
    const target1 = host.querySelector<HTMLButtonElement>('.tour-target')!;
    await act(async () => {
      pointer(target1, 'pointerdown', { clientY: 800 });
      vi.advanceTimersByTime(360);
    });
    expect(host.textContent).toContain('手感對了');
    await act(async () => {
      pointer(target1, 'pointerup', { clientY: 800 });
      vi.advanceTimersByTime(500);
    });

    // Step 2：輕點按鈕結束教學
    expect(host.textContent).toContain('第 3 / 3 步');
    const target2 = host.querySelector<HTMLButtonElement>('.tour-target')!;
    await act(async () => {
      pointer(target2, 'pointerdown', { clientY: 800 });
      pointer(target2, 'pointerup', { clientY: 800 });
    });

    expect(useSettings.getState().gestureTourDone).toBe(true);
  });

  it('點擊「略過」可立即完成並不再打擾', async () => {
    await act(async () => {
      root.render(React.createElement(GestureTour, { desktop: false }));
    });
    const skip = host.querySelector<HTMLButtonElement>('.tour-skip')!;
    await act(async () => { skip.click(); });
    expect(useSettings.getState().gestureTourDone).toBe(true);
  });

  it('桌機寬屏顯示快捷鍵導覽卡片，點擊「開始使用」完成教學', async () => {
    await act(async () => {
      root.render(React.createElement(GestureTour, { desktop: true }));
    });
    expect(host.textContent).toContain('歡迎來到 Aster 寬屏模式');
    const btn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('開始使用'))!;
    await act(async () => { btn.click(); });
    expect(useSettings.getState().gestureTourDone).toBe(true);
  });
});
