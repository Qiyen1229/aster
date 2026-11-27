/**
 * 全域浮層：Snackbar（復原）、長按動作選單、新版本提示、背景隱私遮罩。
 */
import { Capacitor } from '@capacitor/core';
import { ICON_192 } from '@/ui/assets';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useUI } from '@/stores/ui';
import { useSettings } from '@/stores/settings';
import { useLock } from '@/services/lock';
import { applyServiceWorkerUpdate } from '@/services/appUpdate';
import { Sheet, trapTabKey } from '@/ui/Sheet';
import { CatIcon } from '@/ui/Icon';

export function SnackbarHost() {
  const snack = useUI((s) => s.snack);
  const dismiss = useUI((s) => s.dismissSnack);
  useEffect(() => {
    if (!snack) return;
    const t = setTimeout(dismiss, snack.duration ?? 3000);
    return () => clearTimeout(t);
  }, [snack, dismiss]);
  if (!snack) return null;
  const node = (
    <div className="snackbar-wrap" aria-live="polite">
      <div className="snackbar" key={snack.id} role="status">
        <span>{snack.text}</span>
        {snack.actionLabel && (
          <button onClick={() => { snack.onAction?.(); dismiss(); }}>{snack.actionLabel}</button>
        )}
        {snack.actionLabel && snack.duration && (
          <i className="snack-timer" style={{ animationDuration: `${snack.duration}ms` }} aria-hidden="true" />
        )}
      </div>
    </div>
  );
  return typeof document !== 'undefined' ? createPortal(node, document.body) : node;
}

/**
 * 確認視窗（自製，取代瀏覽器／iOS 內建的 confirm）：置中的圓角卡片，點背景或按 Esc＝取消，
 * 預設焦點在「取消」（誤按 Enter 不會執行破壞性操作）。比一般彈窗層級更高，可疊在記帳面板上。
 */
export function ConfirmHost() {
  const c = useUI((s) => s.confirm);
  const close = useUI((s) => s.closeConfirm);
  const locked = useLock((s) => s.locked);
  const prevFocus = useRef<HTMLElement | null>(null);
  const dlgRef = useRef<HTMLDivElement>(null);

  // App 鎖定時自動關閉確認視窗，杜絕鎖屏繞過
  useEffect(() => {
    if (locked && c) close(false);
  }, [locked, c, close]);

  // 開啟前記住原本的焦點（按鈕或抽屜內的元件），關閉後還回去，鍵盤與讀屏使用者不會掉到頁面最上面
  useEffect(() => {
    if (!c || locked) return;
    prevFocus.current = document.activeElement as HTMLElement | null;
    return () => { const el = prevFocus.current; prevFocus.current = null; setTimeout(() => el?.isConnected && el.focus?.({ preventScroll: true }), 0); };
  }, [c?.id, locked]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!c || locked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(false); }
      else trapTabKey(dlgRef.current, e);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [c, close, locked]);
  if (!c || locked) return null;
  const node = (
    <div className="dlg-wrap" key={c.id}>
      <div className="dlg-backdrop" onClick={() => close(false)} aria-hidden="true" />
      <div ref={dlgRef} className="dlg" role="alertdialog" aria-modal="true" aria-labelledby={`dlg-t-${c.id}`} aria-describedby={c.message ? `dlg-m-${c.id}` : undefined}>
        <div className="dlg-body">
          <h2 id={`dlg-t-${c.id}`}>{c.title}</h2>
          {c.message && <p id={`dlg-m-${c.id}`}>{c.message}</p>}
        </div>
        <div className="dlg-actions">
          <button autoFocus onClick={() => close(false)}>{c.cancelText ?? '取消'}</button>
          <button className={c.danger ? 'danger' : 'primary'} onClick={() => close(true)}>{c.confirmText ?? '確定'}</button>
        </div>
      </div>
    </div>
  );
  return typeof document !== 'undefined' ? createPortal(node, document.body) : node;
}

export function ActionSheetHost() {
  const actions = useUI((s) => s.actions);
  const close = useUI((s) => s.closeActions);
  return (
    <Sheet open={!!actions} onClose={close} title={actions?.title}>
      <div className="list">
        {actions?.items.map((it) => (
          <button key={it.label} className={`row${it.danger ? ' danger' : ''}`}
            onClick={() => { close(); setTimeout(it.onSelect, 120); }}>
            {it.icon && <span aria-hidden="true"><CatIcon icon={it.icon} size={18} /></span>}
            <span className="row-main row-title" style={{ color: it.danger ? 'var(--danger)' : undefined }}>{it.label}</span>
          </button>
        ))}
      </div>
      <button className="btn secondary" onClick={close}>取消</button>
    </Sheet>
  );
}

/** 輸入視窗（自製，取代 window.prompt）：和確認視窗同樣式；Enter 送出、Esc／點背景取消 */
export function InputHost() {
  const r = useUI((s) => s.input);
  const close = useUI((s) => s.closeInput);
  const locked = useLock((s) => s.locked);
  const [value, setValue] = useState('');
  const prevFocus = useRef<HTMLElement | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (locked && r) close(null);
  }, [locked, r, close]);

  useEffect(() => {
    if (!r || locked) return;
    setValue(r.defaultValue ?? '');
    prevFocus.current = document.activeElement as HTMLElement | null;
    return () => { const el = prevFocus.current; prevFocus.current = null; setTimeout(() => el?.isConnected && el.focus?.({ preventScroll: true }), 0); };
  }, [r?.id, locked]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!r || locked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
      else trapTabKey(formRef.current, e);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [r, close, locked]);
  if (!r || locked) return null;
  const text = value.trim();
  const ok = !r.required || !!text;
  const node = (
    <div className="dlg-wrap" key={r.id}>
      <div className="dlg-backdrop" onClick={() => close(null)} aria-hidden="true" />
      <form ref={formRef} className="dlg" role="dialog" aria-modal="true" aria-labelledby={`dlg-t-${r.id}`} onSubmit={(e) => { e.preventDefault(); if (ok) close(text); }}>
        <div className="dlg-body">
          <h2 id={`dlg-t-${r.id}`}>{r.title}</h2>
          {r.message && <p>{r.message}</p>}
          <input className="dlg-input" value={value} onChange={(e) => setValue(e.target.value)} placeholder={r.placeholder} autoFocus maxLength={r.maxLength ?? 200}
            type={r.secret ? 'password' : 'text'} inputMode={r.inputMode} autoComplete={r.secret ? 'current-password' : 'off'} autoCapitalize="none" autoCorrect="off" spellCheck={false}
            onFocus={(e) => e.target.select()} aria-label={r.title} />
        </div>
        <div className="dlg-actions">
          <button type="button" onClick={() => close(null)}>取消</button>
          <button type="submit" className={r.danger ? 'danger' : 'primary'} disabled={!ok}>{r.confirmText ?? '確定'}</button>
        </div>
      </form>
    </div>
  );
  return typeof document !== 'undefined' ? createPortal(node, document.body) : node;
}

/** Service Worker 更新提示：「有新版本，點擊更新」（鎖定中維持掛載以保留 SW 註冊，僅隱藏橫幅） */
export function UpdatePrompt({ locked = false }: { locked?: boolean }) {
  const [updateFn, setUpdateFn] = useState<null | ((reload?: boolean) => Promise<void>)>(null);
  const [updating, setUpdating] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [offlineReady, setOfflineReady] = useState(false);
  const dismissedAtRef = useRef<number | null>(null);
  const regRef = useRef<ServiceWorkerRegistration | null>(null);

  useEffect(() => {
    const isDev = import.meta.env.DEV && import.meta.env.MODE !== 'test';
    if (Capacitor.isNativePlatform() || !('serviceWorker' in navigator) || isDev) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let intervalTimer: ReturnType<typeof setInterval> | null = null;
    let onVis: (() => void) | null = null;
    import('virtual:pwa-register').then(({ registerSW }) => {
      if (cancelled) return;
      const updateSW = registerSW({
        onNeedRefresh: () => {
          setUpdateFn(() => updateSW);
          setDismissed(false);
        },
        onOfflineReady: () => setOfflineReady(true),
        onRegisteredSW: (_url, reg) => {
          // 每 30 分鐘檢查更新
          if (!reg) return;
          regRef.current = reg;
          timer = setInterval(() => reg.update().catch(() => undefined), 30 * 60 * 1000);
        },
      });

      // 回到前景時檢查 SW 更新並重設稍後狀態（重新提示）
      onVis = () => {
        if (document.visibilityState === 'visible') {
          dismissedAtRef.current = null;
          setDismissed(false);
          regRef.current?.update().catch(() => undefined);
        }
      };
      document.addEventListener('visibilitychange', onVis);

      // 每分鐘檢查 6 小時間隔是否已過
      intervalTimer = setInterval(() => {
        if (dismissedAtRef.current && Date.now() - dismissedAtRef.current >= 6 * 60 * 60 * 1000) {
          dismissedAtRef.current = null;
          setDismissed(false);
        }
      }, 60 * 1000);
    });
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      if (intervalTimer) clearInterval(intervalTimer);
      if (onVis) document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  const handleDismiss = () => {
    dismissedAtRef.current = Date.now();
    setDismissed(true);
  };

  const handleUpdate = async () => {
    if (updating || !updateFn) return;
    setUpdating(true);
    // 先收起任何開啟中的記帳/操作彈窗，避免 iOS PWA 重載時 DOM/焦點鎖死
    const ui = useUI.getState();
    if (ui.add.open) ui.closeAdd();
    if (ui.actions) ui.closeActions();
    const guardTimer = setTimeout(() => {
      setUpdating(false);
      useUI.getState().showSnack({ text: '請手動重新整理頁面以套用新版' });
    }, 5000);
    try {
      await applyServiceWorkerUpdate({
        updateSW: updateFn,
        registration: regRef.current,
      });
    } finally {
      // 若尚未導向離開，於 guardTimer 到期前維持更新中避免連點
      void guardTimer;
    }
  };

  useEffect(() => {
    if (!offlineReady) return;
    useUI.getState().showSnack({ text: '已可離線使用 ✓' });
  }, [offlineReady]);

  if (locked || !updateFn || dismissed) return null;
  return (
    <div className="banner" role="alert">
      <span>有新版本，點擊更新（更新後會跳出這次新增的功能說明）</span>
      <button type="button" className="btn small" disabled={updating} onClick={() => void handleUpdate()}>
        {updating ? '更新中…' : '更新'}
      </button>
      <button type="button" className="btn small secondary" disabled={updating} onClick={handleDismiss}>
        稍後
      </button>
    </div>
  );
}

/** App 切到背景（App Switcher）時模糊畫面，避免金額外洩 */
export function PrivacyShield() {
  const enabled = useSettings((s) => s.blurOnHide);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const onVis = () => setHidden(document.visibilityState === 'hidden');
    const onBlur = () => setHidden(true);
    const onFocus = () => setHidden(false);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', onBlur);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', onBlur);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
    };
  }, [enabled]);
  if (!enabled || !hidden) return null;
  return (
    <div className="privacy-shield" aria-hidden="true">
      <img src={ICON_192} alt="" />
    </div>
  );
}
