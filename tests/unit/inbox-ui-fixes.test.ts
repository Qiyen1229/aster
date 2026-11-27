// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { ShortcutWizard } from '@/features/inbox/ShortcutWizard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockLoadInbox = vi.fn();
const mockLoadForecast = vi.fn(async () => ({ rules: [], predicted: [] }));

function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    removeItem: (k: string) => { m.delete(k); },
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
  };
}

vi.mock('@/services/inbox', async (orig) => ({
  ...(await orig<typeof import('@/services/inbox')>()),
  loadInbox: () => mockLoadInbox(),
}));

vi.mock('@/services/forecast', async (orig) => ({
  ...(await orig<typeof import('@/services/forecast')>()),
  loadForecast: () => mockLoadForecast(),
}));

vi.mock('@/stores/auth', async (orig) => ({
  ...(await orig<typeof import('@/stores/auth')>()),
  AUTH_ENABLED: true,
}));

describe('ShortcutWizard 明確確認流程', () => {
  let host: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    vi.stubGlobal('localStorage', memStorage());
    vi.stubGlobal('sessionStorage', memStorage());
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => { root?.unmount(); });
    host?.remove();
    vi.unstubAllGlobals();
  });

  it('visibilitychange 回到前景不自動標記已加入，需點「確認已加入」才計數', async () => {
    const onAdd = vi.fn(async () => undefined);
    await act(async () => {
      root!.render(React.createElement(ShortcutWizard, { preparing: false, hasLink: true, onAdd }));
    });
    expect(host.textContent).toContain('已加入 0／');

    const joinBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === '加入');
    expect(joinBtn).toBeTruthy();
    await act(async () => { joinBtn!.click(); });

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });

    // 不應自動打勾為已加入 1
    expect(host.textContent).toContain('已加入 0／');
    expect(host.textContent).toContain('確認已加入');

    const confirmBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === '確認已加入');
    expect(confirmBtn).toBeTruthy();
    await act(async () => { confirmBtn!.click(); });

    expect(host.textContent).toContain('已加入 1／');
  });

  it('點「還沒加入」或 onAdd 失敗時應清除待確認提示且不計入已加入', async () => {
    const onAdd = vi.fn(async () => { throw new Error('network error'); });
    await act(async () => {
      root!.render(React.createElement(ShortcutWizard, { preparing: false, hasLink: true, onAdd }));
    });

    const joinBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === '加入');
    await act(async () => { joinBtn!.click(); });

    expect(host.textContent).toContain('已加入 0／');
    expect(host.textContent).not.toContain('已從「捷徑」App 返回？');
  });
});

describe('HomeInbox 與 InboxPage 載入錯誤不偽裝成空收件匣', () => {
  let host: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => { root?.unmount(); });
    host.remove();
  });

  it('HomeInbox 讀取失敗時顯示錯誤與重試按鈕，不顯示「沒有待確認」', async () => {
    mockLoadInbox.mockRejectedValueOnce(new Error('伺服器暫時無法回應'));
    const { default: HomeInbox } = await import('@/features/home/HomeInbox');

    await act(async () => {
      root!.render(React.createElement(MemoryRouter, null, React.createElement(HomeInbox)));
    });
    await act(async () => { await Promise.resolve(); });

    expect(host.textContent).toContain('讀取失敗');
    expect(host.textContent).toContain('收件匣暫時讀不到');
    expect(host.textContent).toContain('伺服器暫時無法回應');
    expect(host.textContent).not.toContain('沒有待確認');

    mockLoadInbox.mockResolvedValueOnce([]);
    const retryBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === '重試');
    expect(retryBtn).toBeTruthy();
    await act(async () => { retryBtn!.click(); });
    await act(async () => { await Promise.resolve(); });

    expect(host.textContent).toContain('沒有待確認');
    expect(host.textContent).not.toContain('收件匣暫時讀不到');
  });

  it('InboxPage 讀取失敗時顯示錯誤與重試按鈕，不顯示「收件匣是空的」', async () => {
    mockLoadInbox.mockRejectedValueOnce(new Error('連線逾時'));
    const { default: InboxPage } = await import('@/features/inbox/InboxPage');

    await act(async () => {
      root!.render(React.createElement(MemoryRouter, null, React.createElement(InboxPage)));
    });
    await act(async () => { await Promise.resolve(); });

    expect(host.textContent).toContain('收件匣暫時讀不到：連線逾時');
    expect(host.textContent).not.toContain('收件匣是空的');

    mockLoadInbox.mockResolvedValueOnce([]);
    const retryBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === '重試');
    expect(retryBtn).toBeTruthy();
    await act(async () => { retryBtn!.click(); });
    await act(async () => { await Promise.resolve(); });

    expect(host.textContent).toContain('收件匣是空的');
  });
});
