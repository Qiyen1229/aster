/**
 * 共用垂直拖曳排序列表：
 * - 每項最左側附帶 ≡ 拖曳手柄（僅按住手柄才啟動拖曳，點其他區域不觸發、手機可正常滑動捲動）
 * - 拖曳時項目線性跟隨游標／手指，帶陰影與半透明浮起效果
 * - 其他項目即時平滑讓位，並顯示插入位置指示線，放開後固定順序並儲存
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
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

interface DragState {
  activeKey: string;
  startIndex: number;
  overIndex: number;
  startY: number;
  currentY: number;
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
  const [dragState, setDragState] = useState<DragState | null>(null);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const dragRef = useRef<DragState | null>(null);
  const itemsRef = useRef(items);
  const onReorderRef = useRef(onReorder);
  dragRef.current = dragState;
  itemsRef.current = items;
  onReorderRef.current = onReorder;

  useEffect(() => {
    if (!dragState) return;

    const onMove = (ev: PointerEvent) => {
      const ds = dragRef.current;
      if (!ds) return;
      const dy = ev.clientY - ds.startY;
      const listLen = itemsRef.current.length;
      let cumulative = 0;
      let target = ds.startIndex;

      if (dy > 0) {
        for (let i = ds.startIndex + 1; i < listLen; i++) {
          const step = (ds.itemHeights[i] ?? 48) + ds.gap;
          cumulative += step;
          if (dy > cumulative - step / 2) target = i;
          else break;
        }
      } else if (dy < 0) {
        for (let i = ds.startIndex - 1; i >= 0; i--) {
          const step = (ds.itemHeights[i] ?? 48) + ds.gap;
          cumulative -= step;
          if (dy < cumulative + step / 2) target = i;
          else break;
        }
      }

      if (target !== ds.overIndex) haptic('selection');
      setDragState((prev) => (prev ? { ...prev, currentY: ev.clientY, overIndex: target } : null));
    };

    const finish = (commit: boolean) => {
      const ds = dragRef.current;
      setDragState(null);
      if (!ds || !commit) return;
      if (ds.startIndex !== ds.overIndex) {
        haptic('success');
        const next = [...itemsRef.current];
        const [moved] = next.splice(ds.startIndex, 1);
        next.splice(ds.overIndex, 0, moved);
        void onReorderRef.current(next);
      }
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
  }, [Boolean(dragState)]); // eslint-disable-line react-hooks/exhaustive-deps

  const startDrag = (e: React.PointerEvent<HTMLElement>, key: string, index: number) => {
    if (disabled || e.button > 0 || items.length < 2) return;
    e.preventDefault();
    e.stopPropagation();
    window.getSelection()?.removeAllRanges();

    const heights = items.map((it) => itemRefs.current.get(getKey(it))?.offsetHeight ?? 48);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    haptic('medium');
    setDragState({
      activeKey: key,
      startIndex: index,
      overIndex: index,
      startY: e.clientY,
      currentY: e.clientY,
      itemHeights: heights,
      gap,
    });
  };

  return (
    <div className={className}>
      {items.map((item, index) => {
        const key = getKey(item);
        const isDraggingThis = dragState?.activeKey === key;
        let translateY = 0;
        let insertEdge: 'top' | 'bottom' | null = null;

        if (dragState) {
          const { startIndex, overIndex, itemHeights } = dragState;
          const activeH = (itemHeights[startIndex] ?? 48) + dragState.gap;
          if (isDraggingThis) {
            translateY = dragState.currentY - dragState.startY;
          } else if (startIndex < overIndex && index > startIndex && index <= overIndex) {
            translateY = -activeH;
            if (index === overIndex) insertEdge = 'bottom';
          } else if (startIndex > overIndex && index >= overIndex && index < startIndex) {
            translateY = activeH;
            if (index === overIndex) insertEdge = 'top';
          }
        }

        const style: CSSProperties = {
          transform: translateY !== 0 ? `translate3d(0, ${translateY}px, 0)` : undefined,
          transition: isDraggingThis
            ? 'box-shadow 140ms ease, opacity 140ms ease'
            : dragState
              ? 'transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1)'
              : undefined,
        };

        return (
          <div
            key={key}
            ref={(el) => {
              if (el) itemRefs.current.set(key, el);
              else itemRefs.current.delete(key);
            }}
            className={`sort-item${isDraggingThis ? ' is-dragging' : ''}`}
            style={style}
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
