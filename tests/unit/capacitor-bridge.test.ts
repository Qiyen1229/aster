// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  isNative: true,
  fsWriteFile: vi.fn(async () => ({ uri: 'file:///cache/test.json' })),
  share: vi.fn(async () => ({ activityType: 'save' })),
  localCheckPerm: vi.fn(async () => ({ display: 'prompt' as string })),
  localReqPerm: vi.fn(async () => ({ display: 'granted' as string })),
  localSchedule: vi.fn(async () => ({ notifications: [] })),
  pushCheckPerm: vi.fn(async () => ({ receive: 'granted' as string })),
  pushReqPerm: vi.fn(async () => ({ receive: 'granted' as string })),
  pushRegister: vi.fn(async () => undefined),
  pushUnregister: vi.fn(async () => undefined),
  pushListeners: new Map<string, (payload: any) => void>(),
  bioAvailable: vi.fn(async () => ({ isAvailable: true })),
  bioVerify: vi.fn(async () => undefined),
  browserOpen: vi.fn(async () => undefined),
  hapticSelection: vi.fn(async () => undefined),
  hapticImpact: vi.fn(async () => undefined),
  hapticNotification: vi.fn(async () => undefined),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => mockState.isNative,
  },
}));

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' },
  Filesystem: { writeFile: mockState.fsWriteFile },
}));

vi.mock('@capacitor/share', () => ({
  Share: { share: mockState.share },
}));

vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    checkPermissions: mockState.localCheckPerm,
    requestPermissions: mockState.localReqPerm,
    schedule: mockState.localSchedule,
  },
}));

vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: {
    checkPermissions: mockState.pushCheckPerm,
    requestPermissions: mockState.pushReqPerm,
    register: mockState.pushRegister,
    unregister: mockState.pushUnregister,
    addListener: vi.fn(async (event: string, cb: (payload: any) => void) => {
      mockState.pushListeners.set(event, cb);
      return { remove: vi.fn(async () => { mockState.pushListeners.delete(event); }) };
    }),
  },
}));

vi.mock('@capgo/capacitor-native-biometric', () => ({
  NativeBiometric: {
    isAvailable: mockState.bioAvailable,
    verifyIdentity: mockState.bioVerify,
  },
}));

vi.mock('@capacitor/browser', () => ({
  Browser: { open: mockState.browserOpen },
}));

vi.mock('@capacitor/haptics', () => ({
  ImpactStyle: { Light: 'LIGHT', Medium: 'MEDIUM', Heavy: 'HEAVY' },
  NotificationType: { Success: 'SUCCESS', Warning: 'WARNING' },
  Haptics: {
    selectionChanged: mockState.hapticSelection,
    impact: mockState.hapticImpact,
    notification: mockState.hapticNotification,
  },
}));

describe('Capacitor 原生橋接與 Web 雙路徑', () => {
  beforeEach(() => {
    mockState.isNative = true;
    mockState.pushListeners.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('appUpdate: 原生環境略過 Service Worker 檢查並回傳 unsupported；Web 環境無 SW 註冊時亦回傳 unsupported', async () => {
    const { checkForUpdate } = await import('@/services/appUpdate');
    mockState.isNative = true;
    await expect(checkForUpdate()).resolves.toBe('unsupported');

    mockState.isNative = false;
    const getRegistration = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'serviceWorker', { value: { getRegistration }, configurable: true });
    await expect(checkForUpdate()).resolves.toBe('unsupported');
    expect(getRegistration).toHaveBeenCalled();
  });

  it('backup saveFile: 原生環境寫入 Cache 並呼叫 Share.share；取消時回傳 cancelled；Web 走下載路徑', async () => {
    const { saveFile } = await import('@/services/backup');
    const blob = new Blob([JSON.stringify({ ok: true })], { type: 'application/json' });

    mockState.isNative = true;
    await expect(saveFile(blob, 'aster-backup.json', 'application/json')).resolves.toBe('shared');
    expect(mockState.fsWriteFile).toHaveBeenCalledWith(expect.objectContaining({
      path: 'aster-backup.json',
      directory: 'CACHE',
    }));
    expect(mockState.share).toHaveBeenCalledWith(expect.objectContaining({
      title: 'aster-backup.json',
      url: 'file:///cache/test.json',
    }));

    mockState.share.mockRejectedValueOnce(new Error('Share canceled'));
    await expect(saveFile(blob, 'aster-backup.json', 'application/json')).resolves.toBe('cancelled');

    mockState.isNative = false;
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    await expect(saveFile(blob, 'aster-backup.json', 'application/json')).resolves.toBe('downloaded');
    expect(clickSpy).toHaveBeenCalled();
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
  });

  it('notifications: 原生環境使用 LocalNotifications 檢查／請求權限與排程通知，不回傳 needs-install', async () => {
    const { checkNotificationSupport, notificationSupport, notify, requestPermission } = await import('@/services/notifications');
    const { useSettings } = await import('@/stores/settings');
    useSettings.setState((s) => ({ ...s, notify: { ...s.notify, enabled: true } }));

    mockState.isNative = true;
    expect(notificationSupport()).not.toBe('needs-install');
    expect(notificationSupport()).not.toBe('unsupported');

    mockState.localCheckPerm.mockResolvedValueOnce({ display: 'prompt' });
    await expect(checkNotificationSupport()).resolves.toBe('default');

    mockState.localReqPerm.mockResolvedValueOnce({ display: 'granted' });
    await expect(requestPermission()).resolves.toBe('granted');
    expect(notificationSupport()).toBe('granted');

    mockState.localCheckPerm.mockResolvedValueOnce({ display: 'granted' });
    await notify('測試標題', '測試內容', '/', 'daily_log', `test:${Date.now()}`);
    expect(mockState.localSchedule).toHaveBeenCalledWith({
      notifications: [
        expect.objectContaining({
          title: '測試標題',
          body: '測試內容',
          extra: { url: '/' },
        }),
      ],
    });

    mockState.isNative = false;
    expect(notificationSupport()).toBe('unsupported');
  });

  it('push: 原生環境不依賴 PushManager／ServiceWorker，並正確對接 PushNotifications', async () => {
    const { AUTH_ENABLED } = await import('@/stores/auth');
    const { disablePush, ensurePushSubscription, pushSupported } = await import('@/services/push');

    mockState.isNative = true;
    expect(pushSupported()).toBe(AUTH_ENABLED);

    mockState.pushRegister.mockImplementationOnce(async () => {
      const cb = mockState.pushListeners.get('registration');
      cb?.({ value: 'mock-apns-token' });
    });

    const subOk = await ensurePushSubscription();
    expect(subOk).toBe(AUTH_ENABLED);
    if (AUTH_ENABLED) {
      expect(mockState.pushRegister).toHaveBeenCalledTimes(1);
      // 第二次呼叫應使用快取的 APNs token，不重複呼叫 PushNotifications.register()
      await expect(ensurePushSubscription()).resolves.toBe(true);
      expect(mockState.pushRegister).toHaveBeenCalledTimes(1);
    }

    await disablePush();
    expect(mockState.pushUnregister).toHaveBeenCalled();

    mockState.isNative = false;
    expect(pushSupported()).toBe(false);
  });

  it('lock: 原生環境使用 NativeBiometric 檢查可用性、啟用、驗證與停用', async () => {
    const { biometricAvailable, disableBiometric, registerBiometric, verifyBiometric } = await import('@/services/lock');
    const { useSettings } = await import('@/stores/settings');

    mockState.isNative = true;
    await expect(biometricAvailable()).resolves.toBe(true);
    expect(mockState.bioAvailable).toHaveBeenCalled();

    await registerBiometric();
    expect(mockState.bioVerify).toHaveBeenCalledTimes(1);
    expect(useSettings.getState().lock.webauthn).not.toBeNull();

    await expect(verifyBiometric()).resolves.toBe(true);
    expect(mockState.bioVerify).toHaveBeenCalledTimes(2);

    mockState.bioVerify.mockRejectedValueOnce(new Error('User cancelled'));
    await expect(verifyBiometric()).resolves.toBe(false);

    disableBiometric();
    expect(useSettings.getState().lock.webauthn).toBeNull();
    await expect(verifyBiometric()).resolves.toBe(false);

    mockState.isNative = false;
    await expect(biometricAvailable()).resolves.toBe(false);
  });

  it('inbox openShortcutImport: 原生環境使用 Browser.open，Web 環境使用 location.href', async () => {
    const { openShortcutImport, shortcutIcloudUrl, SHORTCUTS } = await import('@/services/inbox');
    const url = shortcutIcloudUrl(SHORTCUTS[0]);

    mockState.isNative = true;
    openShortcutImport(SHORTCUTS[0]);
    expect(mockState.browserOpen).toHaveBeenCalledWith({ url });

    mockState.isNative = false;
    const loc = { href: '' };
    vi.stubGlobal('location', loc);
    openShortcutImport(SHORTCUTS[0]);
    expect(loc.href).toBe(url);
  });

  it('haptics: 原生環境呼叫 @capacitor/haptics，Web 環境呼叫 navigator.vibrate', async () => {
    const { haptic, isHapticsSupported, PATTERNS } = await import('@/services/haptics');

    mockState.isNative = true;
    expect(isHapticsSupported()).toBe(true);
    haptic('light');
    haptic('success');
    expect(mockState.hapticImpact).toHaveBeenCalledWith({ style: 'LIGHT' });
    expect(mockState.hapticNotification).toHaveBeenCalledWith({ type: 'SUCCESS' });

    mockState.isNative = false;
    const vibrateMock = vi.fn();
    Object.defineProperty(navigator, 'vibrate', { value: vibrateMock, configurable: true, writable: true });
    haptic('medium');
    expect(vibrateMock).toHaveBeenCalledWith(PATTERNS.medium);
  });
});
