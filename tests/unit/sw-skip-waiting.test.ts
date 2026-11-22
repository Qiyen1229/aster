import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const swMocks = vi.hoisted(() => ({
  clientsClaim: vi.fn(),
  precacheAndRoute: vi.fn(),
  cleanupOutdatedCaches: vi.fn(),
  createHandlerBoundToURL: vi.fn(() => vi.fn()),
  registerRoute: vi.fn(),
  NavigationRoute: vi.fn(),
  NetworkFirst: vi.fn(),
  StaleWhileRevalidate: vi.fn(),
  ExpirationPlugin: vi.fn(),
  processPushNotification: vi.fn(),
}));

vi.mock('workbox-core', () => ({
  clientsClaim: swMocks.clientsClaim,
}));

vi.mock('workbox-precaching', () => ({
  precacheAndRoute: swMocks.precacheAndRoute,
  cleanupOutdatedCaches: swMocks.cleanupOutdatedCaches,
  createHandlerBoundToURL: swMocks.createHandlerBoundToURL,
}));

vi.mock('workbox-routing', () => ({
  NavigationRoute: swMocks.NavigationRoute,
  registerRoute: swMocks.registerRoute,
}));

vi.mock('workbox-strategies', () => ({
  NetworkFirst: swMocks.NetworkFirst,
  StaleWhileRevalidate: swMocks.StaleWhileRevalidate,
}));

vi.mock('workbox-expiration', () => ({
  ExpirationPlugin: swMocks.ExpirationPlugin,
}));

vi.mock('@/services/pushDedupe', () => ({
  processPushNotification: swMocks.processPushNotification,
}));

describe('Service Worker SKIP_WAITING 與 clientsClaim', () => {
  const listeners = new Map<string, (event: unknown) => void>();
  const skipWaitingMock = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.resetModules();
    listeners.clear();
    skipWaitingMock.mockClear();
    swMocks.clientsClaim.mockClear();

    vi.stubGlobal('self', {
      __WB_MANIFEST: [],
      location: { origin: 'https://aster.local' },
      skipWaiting: skipWaitingMock,
      addEventListener: (type: string, fn: (event: unknown) => void) => {
        listeners.set(type, fn);
      },
      registration: { showNotification: vi.fn() },
      clients: { matchAll: vi.fn(), openWindow: vi.fn() },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('註冊 clientsClaim 並在收到 SKIP_WAITING 訊息時呼叫 self.skipWaiting()', async () => {
    await import('@/sw');

    expect(swMocks.clientsClaim).toHaveBeenCalledTimes(1);

    const onMessage = listeners.get('message');
    expect(onMessage).toBeTypeOf('function');

    const waitUntil = vi.fn();
    onMessage!({ data: { type: 'OTHER_MSG' }, waitUntil });
    expect(skipWaitingMock).not.toHaveBeenCalled();

    onMessage!({ data: { type: 'SKIP_WAITING' }, waitUntil });
    expect(skipWaitingMock).toHaveBeenCalledTimes(1);
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });
});
