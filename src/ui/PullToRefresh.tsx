/**
 * 下拉重新整理：頁面捲到最上方時往下拉超過門檻放開即觸發。
 * 使用 position: fixed 浮動膠囊 + translate3d（GPU 合成層、零佈局重繪、拖曳過程不觸發 React 重繪）。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { haptic } from '@/services/haptics';

const PTR_THRESHOLD = 44;

/** Portal 彈窗的 touch 事件會沿 React 樹冒泡回頁面；來源是彈窗時不啟動下拉更新，避免「下滑關彈窗」同時觸發刷新 */
export function isOverlayTouch(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.sheet, .sheet-backdrop, .dlg-wrap, [role="dialog"], [role="alertdialog"]') !== null;
}

export function PullToRefresh({ onRefresh, children }: { onRefresh: () => Promise<unknown>; children: ReactNode }) {
  const [armed, setArmed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const indicatorRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);
  const ptrRef = useRef<{
    startY: number;
    startX: number;
    active: boolean;
    armed: boolean;
    currentY: number;
    rafId: number;
  } | null>(null);

  useEffect(() => () => {
    if (ptrRef.current?.rafId) cancelAnimationFrame(ptrRef.current.rafId);
    if (timerRef.current !== null) clearTimeout(timerRef.current);
  }, []);

  const hideIndicator = () => {
    const el = indicatorRef.current;
    if (!el) return;
    el.style.transition = 'transform 240ms cubic-bezier(0.2, 0, 0, 1), opacity 180ms ease';
    el.style.transform = 'translate3d(0, -60px, 0)';
    el.style.opacity = '0';
  };

  return (
    <div
      onTouchStart={(e) => {
        if (refreshing || window.scrollY > 2 || isOverlayTouch(e.target)) return;
        const t = e.touches[0];
        if (!t) return;
        ptrRef.current = { startY: t.clientY, startX: t.clientX, active: false, armed: false, currentY: 0, rafId: 0 };
      }}
      onTouchMove={(e) => {
        const st = ptrRef.current;
        if (!st || refreshing) return;
        const t = e.touches[0];
        if (!t) return;
        const dy = t.clientY - st.startY;
        const dx = Math.abs(t.clientX - st.startX);
        if (!st.active) {
          if (dy < 8 || dx > dy || window.scrollY > 2) {
            if (dx > 14 || dy < -4) ptrRef.current = null;
            return;
          }
          st.active = true;
          if (indicatorRef.current) indicatorRef.current.style.transition = 'none';
        }
        const damped = Math.max(0, Math.min(78, Math.pow(Math.max(0, dy - 8), 0.76) * 2.2));
        st.currentY = damped;

        if (damped >= PTR_THRESHOLD && !st.armed) {
          st.armed = true;
          setArmed(true);
          haptic('medium');
        } else if (damped < PTR_THRESHOLD && st.armed) {
          st.armed = false;
          setArmed(false);
          haptic('selection');
        }

        if (!st.rafId) {
          st.rafId = requestAnimationFrame(() => {
            if (ptrRef.current) {
              ptrRef.current.rafId = 0;
              const el = indicatorRef.current;
              if (el) {
                const y = ptrRef.current.currentY;
                el.style.transform = `translate3d(0, calc(var(--safe-t, 0px) + ${y + 8}px), 0)`;
                el.style.opacity = `${Math.min(1, y / 28)}`;
              }
            }
          });
        }
      }}
      onTouchCancel={() => {
        const st = ptrRef.current;
        ptrRef.current = null;
        if (st?.rafId) cancelAnimationFrame(st.rafId);
        setArmed(false);
        hideIndicator();
      }}
      onTouchEnd={() => {
        const st = ptrRef.current;
        ptrRef.current = null;
        if (!st || !st.active) return;
        if (st.rafId) cancelAnimationFrame(st.rafId);

        const el = indicatorRef.current;
        if (st.armed && !refreshing) {
          setRefreshing(true);
          if (el) {
            el.style.transition = 'transform 260ms cubic-bezier(0.2, 0.9, 0.3, 1), opacity 200ms ease';
            el.style.transform = 'translate3d(0, calc(var(--safe-t, 0px) + 52px), 0)';
            el.style.opacity = '1';
          }
          Promise.resolve(onRefresh()).finally(() => {
            haptic('success');
            timerRef.current = window.setTimeout(() => {
              hideIndicator();
              timerRef.current = window.setTimeout(() => {
                setRefreshing(false);
                setArmed(false);
              }, 240);
            }, 220);
          });
        } else {
          setArmed(false);
          hideIndicator();
        }
      }}
    >
      <div
        ref={indicatorRef}
        className={`ptr-indicator${refreshing ? ' refreshing' : armed ? ' armed' : ''}`}
        aria-hidden={!refreshing}
      >
        <span className="ptr-pill">
          <span className="ptr-spinner" aria-hidden="true" />
          <span>{refreshing ? '更新中…' : armed ? '放開以更新' : '下拉更新'}</span>
        </span>
      </div>
      {children}
    </div>
  );
}
