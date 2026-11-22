import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UpdatePromptManager, applyServiceWorkerUpdate } from '@/services/appUpdate';

describe('UpdatePromptManager', () => {
  it('未有更新時不提示', () => {
    const mgr = new UpdatePromptManager();
    expect(mgr.shouldShow()).toBe(false);
  });

  it('有更新時正常提示', () => {
    const mgr = new UpdatePromptManager();
    mgr.setPendingUpdate(true);
    expect(mgr.shouldShow()).toBe(true);
  });

  it('點擊稍後後不再立即提示，直到間隔或回到前景', () => {
    const mgr = new UpdatePromptManager(6 * 60 * 60 * 1000); // 6 hours
    mgr.setPendingUpdate(true);
    expect(mgr.shouldShow()).toBe(true);

    const now = 1000000;
    mgr.dismiss(now);
    // 立即檢查：不提示
    expect(mgr.shouldShow(now + 1000)).toBe(false);
    // 1 小時後檢查：仍不提示
    expect(mgr.shouldShow(now + 3600 * 1000)).toBe(false);

    // 間隔 6 小時到達：重新提示
    expect(mgr.onInterval(now + 6 * 3600 * 1000)).toBe(true);
    expect(mgr.shouldShow(now + 6 * 3600 * 1000)).toBe(true);

    // 再次點擊稍後
    mgr.dismiss(now + 6 * 3600 * 1000);
    expect(mgr.shouldShow(now + 6 * 3600 * 1000 + 1000)).toBe(false);

    // 下次回景（onForeground）：重新提示
    expect(mgr.onForeground()).toBe(true);
    expect(mgr.shouldShow()).toBe(true);
  });
});

describe('applyServiceWorkerUpdate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('收到 controllerchange 時立即重載且不重複觸發', async () => {
    const listeners = new Map<string, Set<() => void>>();
    const waitingPost = vi.fn();
    const swContainer = {
      addEventListener: (ev: string, fn: () => void) => {
        if (!listeners.has(ev)) listeners.set(ev, new Set());
        listeners.get(ev)!.add(fn);
      },
      removeEventListener: (ev: string, fn: () => void) => {
        listeners.get(ev)?.delete(fn);
      },
      getRegistration: vi.fn(),
    };
    vi.stubGlobal('navigator', { serviceWorker: swContainer });

    const onReload = vi.fn();
    const updateSW = vi.fn().mockResolvedValue(undefined);
    const registration = { waiting: { postMessage: waitingPost } } as unknown as ServiceWorkerRegistration;

    await applyServiceWorkerUpdate({ updateSW, registration, fallbackMs: 2000, onReload });

    expect(updateSW).toHaveBeenCalledWith(true);
    expect(waitingPost).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(onReload).not.toHaveBeenCalled();

    listeners.get('controllerchange')?.forEach((fn) => fn());
    expect(onReload).toHaveBeenCalledTimes(1);

    // 超過 fallbackMs 不會重複重載
    vi.advanceTimersByTime(3000);
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('controllerchange 未觸發時（例如 iOS Safari PWA 遺漏），於 fallbackMs 後保險重載', async () => {
    const swContainer = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getRegistration: vi.fn().mockResolvedValue({ waiting: { postMessage: vi.fn() } }),
    };
    vi.stubGlobal('navigator', { serviceWorker: swContainer });

    const onReload = vi.fn();
    const updateSW = vi.fn().mockRejectedValue(new Error('workbox failed'));

    await applyServiceWorkerUpdate({ updateSW, fallbackMs: 2000, onReload });
    expect(onReload).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000);
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('updateSW 卡住未結束時，仍會立即對 waiting SW 送出 SKIP_WAITING 並於 fallbackMs 後重載', async () => {
    const waitingPost = vi.fn();
    const swContainer = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getRegistration: vi.fn(),
    };
    vi.stubGlobal('navigator', { serviceWorker: swContainer });

    const onReload = vi.fn();
    const hangingUpdateSW = vi.fn(() => new Promise<void>(() => {}));
    const registration = { waiting: { postMessage: waitingPost } } as unknown as ServiceWorkerRegistration;

    const p = applyServiceWorkerUpdate({ updateSW: hangingUpdateSW, registration, fallbackMs: 2000, onReload });
    await Promise.resolve();

    expect(hangingUpdateSW).toHaveBeenCalledWith(true);
    expect(waitingPost).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(onReload).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000);
    expect(onReload).toHaveBeenCalledTimes(1);
    void p;
  });
});
