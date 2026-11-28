/**
 * 共用垂直拖曳排序列表（120fps 零重繪版）：
 * - 每項最左側附帶 ≡ 拖曳手柄（僅按住手柄才啟動拖曳，點其他區域不觸發、手機可正常滑動捲動）
 * - 拖曳過程中透過 requestAnimationFrame 直接寫入 DOM transform（不觸發 React 重繪），達到 120fps 絲滑跟手
 * - 其他項目在跨過邊界時即時平滑讓位，並顯示插入位置指示線，放開後固定順序並儲存
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { haptic } from '@/services/haptics';
import { Icon } from '@/ui/Icon';

export interface DragHandleProps {
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  'aria-label': string;
  title: string;
}

export function DragHandle({
  handleProps,
  className = '',
}: {
  handleProps: DragHandleProps;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`sort-handle${className ? ` ${className}` : ''}`}
      {...handleProps}
    >
      <Icon name="dragBars" size={16} stroke={2} />
    </button>
  );
}

interface DragRuntime {
  activeKey: string;
  startIndex: number;
  overIndex: number;
  startY: number;
  latestY: number;
  rafId: number;
  itemKeys: string[];
  itemHeights: number[];
  gap: number;
}

export function SortableList<T>({
  items,
  getKey,
  onReorder,
  className = 'list',
  gap = 0,
  disabled = false,
  renderItem,
}: {
  items: T[];
  getKey: (item: T) => string;
  onReorder: (next: T[]) => void | Promise<void>;
  className?: string;
  gap?: number;
  disabled?: boolean;
  renderItem: (
    item: T,
    index: number,
    ctx: {
      handleProps: DragHandleProps;
      isDragging: boolean;
    },
  ) => ReactNode;
}) {
  // 僅於開始／結束或跨越插槽時更新，拖曳移動過程中完全不重繪 React
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [insertSlot, setInsertSlot] = useState<{ index: number; edge: 'top' | 'bottom' } | null>(null);

  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const runtimeRef = useRef<DragRuntime | null>(null);
  const itemsRef = useRef(items);
  const onReorderRef = useRef(onReorder);
  itemsRef.current = items;
  onReorderRef.current = onReorder;

  const applySiblingTransforms = (rt: DragRuntime) => {
    const { startIndex, overIndex, itemHeights, itemKeys, gap: g } = rt;
    const activeH = (itemHeights[startIndex] ?? 48) + g;
    let nextSlot: { index: number; edge: 'top' | 'bottom' } | null = null;

    for (let i = 0; i < itemKeys.length; i++) {
      if (i === startIndex) continue;
      const el = itemRefs.current.get(itemKeys[i]);
      if (!el) continue;
      let shift = 0;
      if (startIndex < overIndex && i > startIndex && i <= overIndex) {
        shift = -activeH;
        if (i === overIndex) nextSlot = { index: i, edge: 'bottom' };
      } else if (startIndex > overIndex && i >= overIndex && i < startIndex) {
        shift = activeH;
        if (i === overIndex) nextSlot = { index: i, edge: 'top' };
      }
      el.style.transition = 'transform 170ms cubic-bezier(0.2, 0.8, 0.2, 1)';
      el.style.transform = shift !== 0 ? `translate3d(0, ${shift}px, 0)` : '';
    }
    setInsertSlot(nextSlot);
  };

  const clearAllTransforms = (keys: string[]) => {
    for (const k of keys) {
      const el = itemRefs.current.get(k);
      if (!el) continue;
      el.style.transition = '';
      el.style.transform = '';
    }
  };

  useEffect(() => {
    if (!activeKey) return;

    const flushFrame = () => {
      const rt = runtimeRef.current;
      if (!rt) return;
      rt.rafId = 0;

      const dy = rt.latestY - rt.startY;
      const activeEl = itemRefs.current.get(rt.activeKey);
      if (activeEl) {
        activeEl.style.transition = 'none';
        activeEl.style.transform = `translate3d(0, ${dy}px, 0)`;
      }

      const listLen = rt.itemKeys.length;
      let cumulative = 0;
      let target = rt.startIndex;
      if (dy > 0) {
        for (let i = rt.startIndex + 1; i < listLen; i++) {
          const step = (rt.itemHeights[i] ?? 48) + rt.gap;
          cumulative += step;
          if (dy > cumulative - step / 2) target = i;
          else break;
        }
      } else if (dy < 0) {
        for (let i = rt.startIndex - 1; i >= 0; i--) {
          const step = (rt.itemHeights[i] ?? 48) + rt.gap;
          cumulative -= step;
          if (dy < cumulative + step / 2) target = i;
          else break;
        }
      }

      if (target !== rt.overIndex) {
        rt.overIndex = target;
        haptic('selection');
        applySiblingTransforms(rt);
      }
    };

    const onMove = (ev: PointerEvent) => {
      const rt = runtimeRef.current;
      if (!rt) return;
      rt.latestY = ev.clientY;
      if (!rt.rafId) {
        rt.rafId = window.requestAnimationFrame(flushFrame);
      }
    };

    const finish = (commit: boolean) => {
      const rt = runtimeRef.current;
      runtimeRef.current = null;
      if (rt?.rafId) window.cancelAnimationFrame(rt.rafId);
      if (rt) clearAllTransforms(rt.itemKeys);
      setActiveKey(null);
      setInsertSlot(null);

      if (!rt || !commit || rt.startIndex === rt.overIndex) return;
      haptic('success');
      const next = [...itemsRef.current];
      const [moved] = next.splice(rt.startIndex, 1);
      next.splice(rt.overIndex, 0, moved);
      void onReorderRef.current(next);
    };

    const onUp = () => finish(true);
    const onCancel = () => finish(false);

    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerup', onUp, { once: true });
    window.addEventListener('pointercancel', onCancel, { once: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [activeKey]);

  const startDrag = (e: React.PointerEvent<HTMLElement>, key: string, index: number) => {
    if (disabled || e.button > 0 || items.length < 2) return;
    e.preventDefault();
    e.stopPropagation();
    window.getSelection()?.removeAllRanges();

    const itemKeys = items.map(getKey);
    const itemHeights = itemKeys.map((k) => itemRefs.current.get(k)?.offsetHeight ?? 48);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    haptic('medium');
    runtimeRef.current = {
      activeKey: key,
      startIndex: index,
      overIndex: index,
      startY: e.clientY,
      latestY: e.clientY,
      rafId: 0,
      itemKeys,
      itemHeights,
      gap,
    };
    setActiveKey(key);
    setInsertSlot(null);
  };

  return (
    <div className={className}>
      {items.map((item, index) => {
        const key = getKey(item);
        const isDraggingThis = activeKey === key;
        const insertEdge = insertSlot?.index === index ? insertSlot.edge : null;

        return (
          <div
            key={key}
            ref={(el) => {
              if (el) itemRefs.current.set(key, el);
              else itemRefs.current.delete(key);
            }}
            className={`sort-item${isDraggingThis ? ' is-dragging' : ''}`}
          >
            {insertEdge === 'top' && <div className="sort-insert-line is-top" aria-hidden="true" />}
            {renderItem(item, index, {
              handleProps: {
                onPointerDown: (e) => startDrag(e, key, index),
                'aria-label': '拖曳調整順序',
                title: '按住拖曳調整順序',
              },
              isDragging: isDraggingThis,
            })}
            {insertEdge === 'bottom' && <div className="sort-insert-line is-bottom" aria-hidden="true" />}
          </div>
        );
      })}
    </div>
  );
}
