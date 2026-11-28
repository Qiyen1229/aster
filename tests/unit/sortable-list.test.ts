// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DragHandle, SortableList } from '@/ui/SortableList';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('SortableList 左側 ≡ 拖曳手柄排序', () => {
  let host: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    if (typeof globalThis.PointerEvent === 'undefined') {
      globalThis.PointerEvent = class PointerEvent extends MouseEvent {
        pointerId: number;
        constructor(type: string, params: PointerEventInit = {}) {
          super(type, params);
          this.pointerId = params.pointerId ?? 1;
        }
      } as unknown as typeof PointerEvent;
    }
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    host.remove();
    vi.restoreAllMocks();
  });

  it('只有按住左側 ≡ 手柄才能拖曳排序，點列的其他區域不觸發拖曳', async () => {
    const onReorder = vi.fn();
    const items = ['A', 'B', 'C'];

    await act(async () => {
      root!.render(
        React.createElement(SortableList<string>, {
          items,
          getKey: (x) => x,
          onReorder,
          renderItem: (x, _i, { handleProps }) =>
            React.createElement(
              'div',
              { className: 'row' },
              React.createElement(DragHandle, { handleProps }),
              React.createElement('span', { className: 'row-main' }, x),
            ),
        }),
      );
    });

    const rows = host.querySelectorAll<HTMLElement>('.sort-item');
    rows.forEach((el) => {
      Object.defineProperty(el, 'offsetHeight', { value: 40, configurable: true });
    });

    // 點擊文字區不應觸發拖曳
    const labelA = host.querySelector<HTMLElement>('.row-main')!;
    await act(async () => {
      labelA.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientY: 10 }));
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientY: 100 }));
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientY: 100 }));
    });
    expect(onReorder).not.toHaveBeenCalled();

    // 按住左側 ≡ 手柄向下拖曳 90px（跨越 2 項）→ A 應移至 C 之後
    const handleA = host.querySelector<HTMLElement>('.sort-handle')!;
    await act(async () => {
      handleA.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientY: 10 }));
    });
    expect(rows[0].classList.contains('is-dragging')).toBe(true);

    await act(async () => {
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientY: 100 }));
    });
    expect(host.querySelector('.sort-insert-line')).toBeTruthy();

    await act(async () => {
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientY: 100 }));
    });

    expect(onReorder).toHaveBeenCalledWith(['B', 'C', 'A']);
  });
});
