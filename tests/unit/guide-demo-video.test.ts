// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GuideDemoVideo, type GuideDemoScene } from '@/features/inbox/GuideDemoVideo';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('GuideDemoVideo iPhone 實機／Gmail 網頁版模擬器', () => {
  let host: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => {
      root?.unmount();
    });
    host.remove();
  });

  const iosScenes: GuideDemoScene[] = ['shortcut-step1', 'shortcut-step2', 'shortcut-step3', 'email-step1'];
  const gmailScenes: GuideDemoScene[] = ['email-step2', 'email-step3', 'email-step4'];

  it.each(iosScenes)('iOS 場景 %s 應顯示 iPhone 實機外框、9:41 狀態列與模擬指標並推進 4 個階段', async (scene) => {
    await act(async () => {
      root!.render(React.createElement(GuideDemoVideo, { scene }));
    });

    expect(host.querySelector('.gdemo-iphone')).toBeTruthy();
    expect(host.querySelector('.gdemo-ios-time')?.textContent).toBe('9:41');
    expect(host.querySelector('.gdemo-cursor')).toBeTruthy();
    expect(host.querySelector('.gdemo-badge')?.textContent).toBe('步驟 1／4');

    // 推進 1750ms 到步驟 2／4
    await act(async () => {
      vi.advanceTimersByTime(1750);
    });
    expect(host.querySelector('.gdemo-badge')?.textContent).toBe('步驟 2／4');

    // 點擊第 4 個步驟圓點跳至步驟 4／4
    const dots = host.querySelectorAll<HTMLButtonElement>('.gdemo-step-dots button');
    expect(dots.length).toBe(4);
    await act(async () => {
      dots[3].click();
    });
    expect(host.querySelector('.gdemo-badge')?.textContent).toBe('步驟 4／4');
  });

  it.each(gmailScenes)('Gmail 場景 %s 應顯示桌面瀏覽器視窗與模擬指標並推進 4 個階段', async (scene) => {
    await act(async () => {
      root!.render(React.createElement(GuideDemoVideo, { scene }));
    });

    expect(host.querySelector('.gdemo-browser-win')).toBeTruthy();
    expect(host.querySelector('.gdemo-url-pill')?.textContent).toContain('mail.google.com');
    expect(host.querySelector('.gdemo-cursor')).toBeTruthy();
    expect(host.querySelector('.gdemo-badge')?.textContent).toBe('步驟 1／4');

    await act(async () => {
      vi.advanceTimersByTime(1750 * 2);
    });
    expect(host.querySelector('.gdemo-badge')?.textContent).toBe('步驟 3／4');
  });
});
