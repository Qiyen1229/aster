// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface RegisterCallbacks {
  onNeedRefresh?: () => void;
  onOfflineReady?: () => void;
  onRegisteredSW?: (url: string, reg?: ServiceWorkerRegistration) => void;
}

const mocks = vi.hoisted(() => ({
  callbacks: null as RegisterCallbacks | null,
  updateSW: vi.fn(async () => undefined),
}));

vi.mock('virtual:pwa-register', () => ({
  registerSW: vi.fn((opts: RegisterCallbacks) => {
    mocks.callbacks = opts;
    return mocks.updateSW;
  }),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => false },
}));

describe('UpdatePrompt 更新提示', () => {
  let container: HTMLDivElement;
  let root: Root;
  let swListeners: Map<string, Set<() => void>>;
  let waitingPostMessage: ReturnType<typeof vi.fn>;
  let regUpdate: ReturnType<typeof vi.fn>;
  let reloadMock: ReturnType<typeof vi.fn>;
  const origLocation = window.location;

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.callbacks = null;
    mocks.updateSW.mockClear();

    swListeners = new Map();
    waitingPostMessage = vi.fn();
    regUpdate = vi.fn().mockResolvedValue(undefined);
    reloadMock = vi.fn();

    const mockReg = {
      waiting: { postMessage: waitingPostMessage },
      update: regUpdate,
    } as unknown as ServiceWorkerRegistration;

    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        addEventListener: (ev: string, fn: () => void) => {
          if (!swListeners.has(ev)) swListeners.set(ev, new Set());
          swListeners.get(ev)!.add(fn);
        },
        removeEventListener: (ev: string, fn: () => void) => {
          swListeners.get(ev)?.delete(fn);
        },
        getRegistration: vi.fn().mockResolvedValue(mockReg),
      },
    });

    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...origLocation, reload: reloadMock },
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    Object.defineProperty(window, 'location', { configurable: true, value: origLocation });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('點擊「更新」會送出 SKIP_WAITING、顯示更新中並在 controllerchange 或逾時後重載', async () => {
    const { UpdatePrompt } = await import('@/app/overlays');

    await act(async () => {
      root.render(React.createElement(UpdatePrompt));
    });
    await act(async () => {
      await vi.dynamicImportSettled();
    });

    expect(mocks.callbacks).not.toBeNull();

    const mockReg = await navigator.serviceWorker.getRegistration();
    await act(async () => {
      mocks.callbacks?.onRegisteredSW?.('/sw.js', mockReg);
      mocks.callbacks?.onNeedRefresh?.();
    });

    const buttons = Array.from(container.querySelectorAll('button'));
    const updateBtn = buttons.find((b) => b.textContent === '更新');
    expect(updateBtn).toBeDefined();

    await act(async () => {
      updateBtn!.click();
      await Promise.resolve();
    });

    expect(updateBtn!.disabled).toBe(true);
    expect(updateBtn!.textContent).toBe('更新中…');
    expect(mocks.updateSW).toHaveBeenCalledWith(false);
    expect(waitingPostMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });

    // 模擬 controllerchange 未觸發（iOS Safari / PWA 常見狀況），保險計時器仍應重載
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it('點擊「稍後」會暫時隱藏，回到前景時重新顯示並檢查更新', async () => {
    const { UpdatePrompt } = await import('@/app/overlays');

    await act(async () => {
      root.render(React.createElement(UpdatePrompt));
    });
    await act(async () => {
      await vi.dynamicImportSettled();
    });

    const mockReg = await navigator.serviceWorker.getRegistration();
    await act(async () => {
      mocks.callbacks?.onRegisteredSW?.('/sw.js', mockReg);
      mocks.callbacks?.onNeedRefresh?.();
    });

    const laterBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '稍後');
    expect(laterBtn).toBeDefined();

    await act(async () => {
      laterBtn!.click();
    });
    expect(container.querySelector('.banner')).toBeNull();

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(container.querySelector('.banner')).not.toBeNull();
    expect(regUpdate).toHaveBeenCalled();
  });
});
