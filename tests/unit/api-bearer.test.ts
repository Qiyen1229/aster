// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  apiSse,
  clearAuthTokens,
  getAccessToken,
  getApiBase,
  getApiOrigin,
  getRefreshToken,
  isBearerMode,
  setAuthTokens,
  setUnauthorizedHandler,
} from '@/services/api';
import { hookUrl } from '@/services/inbox';
import { defaultProxyBase, getJson, proxied } from '@/services/quotes/http';
import { useSettings } from '@/stores/settings';

describe('跨源 VITE_API_URL 與 Bearer JWT 認證', () => {
  const originalFetch = globalThis.fetch;
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    });
    clearAuthTokens();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    setUnauthorizedHandler(() => {});
    clearAuthTokens();
    useSettings.setState((s) => ({ quote: { ...s.quote, proxyUrl: '', proxyToken: '' } }));
  });

  it('VITE_API_URL 基底網址拼接與模式判斷', () => {
    expect(getApiOrigin('')).toBe('');
    expect(getApiOrigin('   ')).toBe('');
    expect(getApiBase('')).toBe('/api');
    expect(isBearerMode('')).toBe(false);

    expect(getApiOrigin('https://nas.example.com///')).toBe('https://nas.example.com');
    expect(getApiBase('https://nas.example.com/')).toBe('https://nas.example.com/api');
    expect(isBearerMode('https://nas.example.com')).toBe(true);
  });

  it('hookUrl() 在設定 VITE_API_URL 時使用後端網址，未設定時維持 location.origin', () => {
    vi.stubEnv('VITE_API_URL', '');
    expect(hookUrl()).toBe(`${location.origin}/api/hook/inbox`);

    vi.stubEnv('VITE_API_URL', 'https://nas.example.com/');
    expect(hookUrl()).toBe('https://nas.example.com/api/hook/inbox');
  });

  it('Bearer 模式登入儲存權杖、帶 Authorization 呼叫 API，且不觸發 CSRF 預取', async () => {
    vi.stubEnv('VITE_API_URL', 'https://nas.example.com');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 1,
            username: 'alice',
            email: 'alice@example.com',
            role: 'user',
            must_change_password: false,
            created_at: '2026-01-01T00:00:00Z',
            last_login_at: null,
            access_token: 'acc-1',
            refresh_token: 'ref-1',
            token_type: 'bearer',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 1, username: 'alice' }), { status: 200 }));
    globalThis.fetch = fetchMock;

    await api('/auth/login', { method: 'POST', body: { identifier: 'alice', password: 'Password1' } });
    expect(getAccessToken()).toBe('acc-1');
    expect(getRefreshToken()).toBe('ref-1');

    const [loginUrl, loginInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(loginUrl).toBe('https://nas.example.com/api/auth/login');
    expect(loginInit.credentials).toBe('omit');
    expect((loginInit.headers as Record<string, string>)['X-Auth-Mode']).toBe('bearer');
    expect((loginInit.headers as Record<string, string>)['X-CSRF-Token']).toBeUndefined();

    await api('/auth/me');
    const [meUrl, meInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(meUrl).toBe('https://nas.example.com/api/auth/me');
    expect(meInit.credentials).toBe('omit');
    expect((meInit.headers as Record<string, string>).Authorization).toBe('Bearer acc-1');
  });

  it('Bearer 模式 401 時以 refresh_token 刷新輪替並重試原請求', async () => {
    vi.stubEnv('VITE_API_URL', 'https://nas.example.com');
    setAuthTokens('acc-old', 'ref-old');
    const onUnauth = vi.fn();
    setUnauthorizedHandler(onUnauth);

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: '未登入' }), { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'acc-new', refresh_token: 'ref-new', token_type: 'bearer' }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    globalThis.fetch = fetchMock;

    const res = await api<{ ok: boolean }>('/sync/pull', { method: 'POST', body: { since: 0 } });
    expect(res.ok).toBe(true);
    expect(onUnauth).not.toHaveBeenCalled();
    expect(getAccessToken()).toBe('acc-new');
    expect(getRefreshToken()).toBe('ref-new');

    const [refUrl, refInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(refUrl).toBe('https://nas.example.com/api/auth/refresh');
    expect(JSON.parse(String(refInit.body))).toEqual({ refresh_token: 'ref-old' });

    const [, retryInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect((retryInit.headers as Record<string, string>).Authorization).toBe('Bearer acc-new');
  });

  it('Bearer 模式刷新回傳 401 時清除本機權杖並觸發 onUnauthorized', async () => {
    vi.stubEnv('VITE_API_URL', 'https://nas.example.com');
    setAuthTokens('acc-old', 'ref-expired');
    const onUnauth = vi.fn();
    setUnauthorizedHandler(onUnauth);

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: '未登入' }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: '登入已過期' }), { status: 401 }));

    await expect(api('/auth/me')).rejects.toMatchObject({ status: 401 });
    expect(onUnauth).toHaveBeenCalledTimes(1);
    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
  });

  it('Bearer 模式刷新遇 502 暫時錯誤時保留本機權杖且不登出', async () => {
    vi.stubEnv('VITE_API_URL', 'https://nas.example.com');
    setAuthTokens('acc-old', 'ref-valid');
    const onUnauth = vi.fn();
    setUnauthorizedHandler(onUnauth);

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: '未登入' }), { status: 401 }))
      .mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }));

    await expect(api('/auth/me')).rejects.toMatchObject({ status: 0 });
    expect(onUnauth).not.toHaveBeenCalled();
    expect(getAccessToken()).toBe('acc-old');
    expect(getRefreshToken()).toBe('ref-valid');
  });

  it('Bearer 模式登出自動帶 refresh_token 並清除本機權杖', async () => {
    vi.stubEnv('VITE_API_URL', 'https://nas.example.com');
    setAuthTokens('acc-1', 'ref-1');
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ message: '已登出' }), { status: 200 }));
    globalThis.fetch = fetchMock;

    await api('/auth/logout', { method: 'POST' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://nas.example.com/api/auth/logout');
    expect(JSON.parse(String(init.body))).toEqual({ refresh_token: 'ref-1' });
    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
  });

  it('Bearer 模式 apiSse 指向 VITE_API_URL 並帶 Authorization 標頭', async () => {
    vi.stubEnv('VITE_API_URL', 'https://nas.example.com');
    setAuthTokens('acc-sse', 'ref-sse');
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('event: done\ndata: {"answer":"ok"}\n\n'));
        c.close();
      },
    });
    const fetchMock = vi.fn(async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }));
    globalThis.fetch = fetchMock;

    const r = await apiSse<{ answer: string }>('/ai/ask/stream', { question: 'hi' }, () => undefined);
    expect(r.answer).toBe('ok');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://nas.example.com/api/ai/ask/stream');
    expect(init.credentials).toBe('omit');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer acc-sse');
  });

  it('報價代理 proxied() 與 getJson() 支援 VITE_API_URL 及 401 刷新權杖重試', async () => {
    vi.stubEnv('VITE_API_URL', 'https://nas.example.com');
    setAuthTokens('acc-q1', 'ref-q1');

    const p = proxied('https://mis.twse.com.tw/stock/api/getStockInfo.jsp');
    expect(p.url).toBe('https://nas.example.com/proxy/fetch?url=https%3A%2F%2Fmis.twse.com.tw%2Fstock%2Fapi%2FgetStockInfo.jsp');
    expect(p.headers.Authorization).toBe('Bearer acc-q1');

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'acc-q2', refresh_token: 'ref-q2', token_type: 'bearer' }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ price: 100 }), { status: 200 }));
    globalThis.fetch = fetchMock;

    const data = await getJson<{ price: number }>('https://mis.twse.com.tw/stock/api/getStockInfo.jsp', { retries: 0 });
    expect(data.price).toBe(100);
    expect(getAccessToken()).toBe('acc-q2');
    const [, retryInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect((retryInit.headers as Record<string, string>).Authorization).toBe('Bearer acc-q2');
  });

  it('defaultProxyBase() 與並發 401 共用單一刷新鎖（含報價代理失敗登出）', async () => {
    vi.stubEnv('VITE_API_URL', '');
    expect(defaultProxyBase()).toBe('/proxy');

    vi.stubEnv('VITE_API_URL', 'https://nas.example.com/');
    expect(defaultProxyBase()).toBe('https://nas.example.com/proxy');

    setAuthTokens('acc-c1', 'ref-c1');
    const onUnauth = vi.fn();
    setUnauthorizedHandler(onUnauth);

    let refreshCount = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/refresh')) {
        refreshCount++;
        return new Response(JSON.stringify({ detail: '過期' }), { status: 401 });
      }
      return new Response(JSON.stringify({ detail: '未登入' }), { status: 401 });
    });

    await Promise.allSettled([
      api('/auth/me'),
      getJson('https://mis.twse.com.tw/stock/api/getStockInfo.jsp', { retries: 0 }),
    ]);
    expect(refreshCount).toBe(1);
    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
    expect(onUnauth).toHaveBeenCalled();
  });

  it('LegalPages useContact 在 VITE_API_URL 模式下跨源呼叫 /api/auth/forgot-info', async () => {
    vi.stubEnv('VITE_API_URL', 'https://nas.example.com');
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ mail: false, contact: 'admin@nas.example.com' }), { status: 200 }));
    globalThis.fetch = fetchMock;

    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { StaticRouter } = await import('react-router-dom/server');
    const { PrivacyPage } = await import('@/features/legal/LegalPages');
    const html = renderToStaticMarkup(createElement(StaticRouter, { location: '/privacy' }, createElement(PrivacyPage)));
    expect(html).toContain('隱私權政策');

    // 直接測試 useContact 的 fetch 行為（透過 jsdom mount）
    const { createRoot } = await import('react-dom/client');
    const { act } = await import('react');
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(StaticRouter, { location: '/privacy' }, createElement(PrivacyPage)));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://nas.example.com/api/auth/forgot-info',
      expect.objectContaining({ credentials: 'omit' }),
    );
    expect(container.textContent).toContain('admin@nas.example.com');
    await act(async () => { root.unmount(); });
  });
});
