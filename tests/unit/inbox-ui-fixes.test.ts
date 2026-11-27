// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { ShortcutWizard } from '@/features/inbox/ShortcutWizard';
import { SHORTCUTS, type InboxToken } from '@/services/inbox';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockLoadInbox = vi.fn();
const mockLoadForecast = vi.fn(async () => ({ rules: [], predicted: [] }));
const mockListTokens = vi.fn(async (): Promise<InboxToken[]> => []);

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
  listTokens: () => mockListTokens(),
}));

vi.mock('@/services/forecast', async (orig) => ({
  ...(await orig<typeof import('@/services/forecast')>()),
  loadForecast: () => mockLoadForecast(),
}));

vi.mock('@/stores/auth', async (orig) => ({
  ...(await orig<typeof import('@/stores/auth')>()),
  AUTH_ENABLED: true,
}));

describe('ShortcutWizard 3 步驟引導與明確確認流程', () => {
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

  const baseToken: InboxToken = {
    id: 1,
    name: 'iPhone',
    hint: 'abcd',
    created_at: '2026-11-27 00:00:00',
    last_used_at: null,
    use_count: 0,
  };

  it('visibilitychange 回到前景不自動推進步驟，需點「確認已加入」才進入步驟 2，並可至步驟 3 透過 use_count 驗收', async () => {
    const onAdd = vi.fn(async () => undefined);
    const onSendTest = vi.fn(async () => true);
    const onRefreshTokens = vi.fn(async () => [{ ...baseToken, last_used_at: '2026-11-27 01:00:00', use_count: 1 }]);
    const onClose = vi.fn();

    await act(async () => {
      root!.render(React.createElement(ShortcutWizard, {
        open: true,
        onClose,
        shortcut: SHORTCUTS[0],
        preparing: false,
        hasLink: true,
        tokens: [baseToken],
        onAdd,
        onSendTest,
        onRefreshTokens,
      }));
    });
    expect(document.body.textContent).toContain('步驟 1／3');

    const joinBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes('加入「Aster 自動記帳」'));
    expect(joinBtn).toBeTruthy();
    await act(async () => { joinBtn!.click(); });

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });

    // 不應自動跳到步驟 2
    expect(document.body.textContent).toContain('步驟 1／3');
    expect(document.body.textContent).toContain('確認已加入');

    const confirmBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === '確認已加入');
    expect(confirmBtn).toBeTruthy();
    await act(async () => { confirmBtn!.click(); });

    // 步驟 2：自動化引導與 shortcuts://
    expect(document.body.textContent).toContain('步驟 2／3');
    expect(document.body.textContent).toContain('捷徑 → 自動化');
    expect(document.body.textContent).toContain('立即執行');
    expect(document.body.textContent).toContain('訊息');
    expect(document.body.textContent).toContain('請勿加入 Gmail 或 Outlook');
    const shortcutsLink = document.body.querySelector('a[href="shortcuts://"]');
    expect(shortcutsLink).toBeTruthy();

    const nextTo3 = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes('我已開啟自動化'));
    expect(nextTo3).toBeTruthy();
    await act(async () => { nextTo3!.click(); });

    // 步驟 3：傳送測試後 listTokens() use_count 增加才顯示驗收通過
    expect(document.body.textContent).toContain('步驟 3／3');
    expect(document.body.textContent).toContain('尚未接收到資料');

    const testBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === '傳送測試');
    expect(testBtn).toBeTruthy();
    await act(async () => { testBtn!.click(); });

    expect(onSendTest).toHaveBeenCalledWith('auto');
    expect(onRefreshTokens).toHaveBeenCalled();

    // 重新渲染更新後的 tokens
    await act(async () => {
      root!.render(React.createElement(ShortcutWizard, {
        open: true,
        onClose,
        shortcut: SHORTCUTS[0],
        preparing: false,
        hasLink: true,
        tokens: [{ ...baseToken, last_used_at: '2026-11-27 01:00:00', use_count: 1 }],
        onAdd,
        onSendTest,
        onRefreshTokens,
      }));
    });
    expect(document.body.textContent).toContain('連線驗收通過');
  });

  it('onAdd 失敗時應清除待確認提示且停留在步驟 1', async () => {
    const onAdd = vi.fn(async () => { throw new Error('network error'); });
    await act(async () => {
      root!.render(React.createElement(ShortcutWizard, {
        open: true,
        onClose: vi.fn(),
        shortcut: SHORTCUTS[0],
        preparing: false,
        hasLink: true,
        tokens: [baseToken],
        onAdd,
        onSendTest: vi.fn(async () => false),
        onRefreshTokens: vi.fn(async () => [baseToken]),
      }));
    });

    const joinBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes('加入「Aster 自動記帳」'));
    expect(joinBtn).toBeTruthy();
    await act(async () => { joinBtn!.click(); });

    expect(document.body.textContent).toContain('步驟 1／3');
    expect(document.body.textContent).not.toContain('已從「捷徑」App 返回？');
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

describe('ShortcutsPage 2 渠道中心與狀態顯示', () => {
  let host: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('localStorage', memStorage());
    vi.stubGlobal('sessionStorage', memStorage());
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => { root?.unmount(); });
    host.remove();
    vi.unstubAllGlobals();
  });

  it('只顯示 2 個核心渠道（無 Siri）並依 listTokens() 顯示未設定 / 待啟用 / 已連線狀態', async () => {
    mockListTokens.mockResolvedValueOnce([]);
    const { default: ShortcutsPage } = await import('@/features/settings/ShortcutsPage');

    await act(async () => {
      root!.render(React.createElement(MemoryRouter, null, React.createElement(ShortcutsPage)));
    });
    await act(async () => { await Promise.resolve(); });

    expect(host.textContent).toContain('iPhone 自動記帳捷徑');
    expect(host.textContent).not.toContain('Siri');
    expect(host.textContent).toContain('未設定');
    expect(host.textContent).toContain('設定');

    // 待啟用狀態（有 token 但 use_count = 0）
    mockListTokens.mockResolvedValueOnce([
      { id: 1, name: 'iPhone', hint: 'abcd', created_at: '2026-11-27 00:00:00', last_used_at: null, use_count: 0 },
    ]);
    await act(async () => { root!.unmount(); });
    root = createRoot(host);
    await act(async () => {
      root!.render(React.createElement(MemoryRouter, null, React.createElement(ShortcutsPage)));
    });
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toContain('待啟用');

    // 已連線狀態（use_count = 3）
    mockListTokens.mockResolvedValueOnce([
      { id: 1, name: 'iPhone', hint: 'abcd', created_at: '2026-11-27 00:00:00', last_used_at: '2026-11-27 01:00:00', use_count: 3 },
    ]);
    await act(async () => { root!.unmount(); });
    root = createRoot(host);
    await act(async () => {
      root!.render(React.createElement(MemoryRouter, null, React.createElement(ShortcutsPage)));
    });
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toContain('已連線 · 已接收 3 筆');
    expect(host.textContent).toContain('管理');

    // 開啟「進階設定與裝置管理」抽屜
    const advBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('進階設定與裝置管理'));
    expect(advBtn).toBeTruthy();
    await act(async () => { advBtn!.click(); });
    expect(document.body.textContent).toContain('已連結的裝置');
    expect(document.body.textContent).toContain('備用：直接下載 .shortcut 捷徑檔');
  });
});
