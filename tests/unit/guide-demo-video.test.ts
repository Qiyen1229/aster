// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GuideDemoVideo, type GuideDemoScene } from '@/features/inbox/GuideDemoVideo';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('GuideDemoVideo 真實截圖與動態指標教學', () => {
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

  const realScenes: Array<{ scene: GuideDemoScene; expectedSteps: number; expectedImgPrefix: string }> = [
    { scene: 'shortcut-step1', expectedSteps: 3, expectedImgPrefix: '/guides/sc-1' },
    { scene: 'shortcut-step2', expectedSteps: 3, expectedImgPrefix: '/guides/sc-2' },
    { scene: 'email-step2', expectedSteps: 4, expectedImgPrefix: '/guides/gm-2' },
    { scene: 'email-step3', expectedSteps: 3, expectedImgPrefix: '/guides/gm-3' },
    { scene: 'email-step4', expectedSteps: 3, expectedImgPrefix: '/guides/gm-4' },
  ];

  it.each(realScenes)(
    '真實截圖場景 $scene 應渲染去敏截圖、動態指標與步驟切換',
    async ({ scene, expectedSteps, expectedImgPrefix }) => {
      await act(async () => {
        root!.render(React.createElement(GuideDemoVideo, { scene }));
      });

      const img = host.querySelector<HTMLImageElement>('.gdemo-real-img');
      expect(img).toBeTruthy();
      expect(img?.getAttribute('src')).toContain(expectedImgPrefix);
      expect(host.querySelector('.gdemo-cursor')).toBeTruthy();
      expect(host.querySelector('.gdemo-badge')?.textContent).toBe(`步驟 1／${expectedSteps}`);

      await act(async () => {
        vi.advanceTimersByTime(1850);
      });
      expect(host.querySelector('.gdemo-badge')?.textContent).toBe(`步驟 2／${expectedSteps}`);

      const dots = host.querySelectorAll<HTMLButtonElement>('.gdemo-step-dots button');
      expect(dots.length).toBe(expectedSteps);
      await act(async () => {
        dots[expectedSteps - 1].click();
      });
      expect(host.querySelector('.gdemo-badge')?.textContent).toBe(
        `步驟 ${expectedSteps}／${expectedSteps}`,
      );
    },
  );

  it('shortcut-step3 應顯示 iPhone 連線驗收示意與模擬指標並推進 4 個階段', async () => {
    await act(async () => {
      root!.render(React.createElement(GuideDemoVideo, { scene: 'shortcut-step3' }));
    });

    expect(host.querySelector('.gdemo-iphone')).toBeTruthy();
    expect(host.querySelector('.gdemo-cursor')).toBeTruthy();
    expect(host.querySelector('.gdemo-badge')?.textContent).toBe('步驟 1／4');

    await act(async () => {
      vi.advanceTimersByTime(1850 * 2);
    });
    expect(host.querySelector('.gdemo-badge')?.textContent).toBe('步驟 3／4');
  });
});
