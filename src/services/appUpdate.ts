/**
 * 手動檢查新版本（設定 → 關於 → 版本）。
 * 平常由 Service Worker 每 30 分鐘、回到前景時自動檢查；這裡讓使用者部署後不用等，立刻更新。
 * 找到新版就切換到新的 Service Worker 並重新整理；資料都在 IndexedDB／伺服器，不會遺失。
 */
import { Capacitor } from '@capacitor/core';

export type UpdateResult = 'reloading' | 'latest' | 'unsupported';

function waitInstalled(sw: ServiceWorker, ms = 30_000): Promise<boolean> {
  return new Promise((resolve) => {
    if (sw.state === 'installed' || sw.state === 'activated') return resolve(true);
    const t = setTimeout(() => resolve(false), ms);
    sw.addEventListener('statechange', () => {
      if (sw.state === 'installed' || sw.state === 'activated') { clearTimeout(t); resolve(true); }
      if (sw.state === 'redundant') { clearTimeout(t); resolve(false); }
    });
  });
}

export interface ApplyUpdateOptions {
  updateSW?: (reloadPage?: boolean) => Promise<void>;
  registration?: ServiceWorkerRegistration | null;
  sw?: ServiceWorker | null;
  fallbackMs?: number;
  onReload?: () => void;
}

/**
 * 觸發 waiting Service Worker 立即接管並重新整理頁面：
 * - 監聽 `controllerchange` 立即重載
 * - 同時透過 `updateSW`（workbox-window）與直接 `registration.waiting.postMessage({ type: 'SKIP_WAITING' })` 雙重發送切換訊號
 * - 若 `controllerchange` 在 iOS Safari / PWA 下延遲或遺漏，於 `fallbackMs` 後保險強制重載
 */
export async function applyServiceWorkerUpdate(options: ApplyUpdateOptions = {}): Promise<void> {
  const {
    updateSW,
    registration,
    sw,
    fallbackMs = 2000,
    onReload = () => location.reload(),
  } = options;

  let done = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const swContainer = typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? navigator.serviceWorker : undefined;

  const reload = () => {
    if (done) return;
    done = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    swContainer?.removeEventListener('controllerchange', reload);
    onReload();
  };

  swContainer?.addEventListener('controllerchange', reload);
  timer = setTimeout(reload, fallbackMs);

  const updatePromise = updateSW
    ? Promise.resolve().then(() => updateSW(true)).catch(() => undefined)
    : Promise.resolve();

  if (done) return;

  let target = sw ?? registration?.waiting ?? null;
  if (!target && swContainer?.getRegistration) {
    try {
      const reg = await swContainer.getRegistration();
      target = reg?.waiting ?? null;
    } catch {
      // ignore
    }
  }

  if (done) return;

  try {
    target?.postMessage({ type: 'SKIP_WAITING' });
  } catch {
    // 即使 postMessage 失敗，保險計時器仍會重載
  }

  await updatePromise;
}

function activateAndReload(sw: ServiceWorker) {
  void applyServiceWorkerUpdate({ sw, fallbackMs: 3000 });
}

/** 連不到伺服器時會丟出錯誤 */
export async function checkForUpdate(): Promise<UpdateResult> {
  if (Capacitor.isNativePlatform()) return 'unsupported';
  if (!('serviceWorker' in navigator)) return 'unsupported';
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return 'unsupported';
  await reg.update();
  const next = reg.waiting ?? reg.installing;
  if (!next || !(await waitInstalled(next))) return 'latest';
  activateAndReload(reg.waiting ?? next);
  return 'reloading';
}

/** 更新提示稍後管理：記錄 dismiss 時間，支援下次前景或 6 小時間隔重新提示 */
export class UpdatePromptManager {
  private hasPendingUpdate = false;
  private dismissedAt: number | null = null;
  readonly cooldownMs: number;

  constructor(cooldownMs = 6 * 60 * 60 * 1000) {
    this.cooldownMs = cooldownMs;
  }

  setPendingUpdate(pending: boolean) {
    this.hasPendingUpdate = pending;
  }

  dismiss(now = Date.now()) {
    this.dismissedAt = now;
  }

  onForeground(): boolean {
    this.dismissedAt = null;
    return this.shouldShow();
  }

  onInterval(now = Date.now()): boolean {
    if (this.dismissedAt !== null && now - this.dismissedAt >= this.cooldownMs) {
      this.dismissedAt = null;
    }
    return this.shouldShow(now);
  }

  shouldShow(now = Date.now()): boolean {
    if (!this.hasPendingUpdate) return false;
    if (this.dismissedAt === null) return true;
    return now - this.dismissedAt >= this.cooldownMs;
  }
}
