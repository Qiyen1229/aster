// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { TabBar } from '@/app/TabBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function LocationSpy() {
  const { pathname, search } = useLocation();
  return React.createElement('div', { 'data-testid': 'loc' }, `${pathname}${search}`);
}

describe('TabBar 子分頁點擊導航列返回主頁', () => {
  let host: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    if (typeof globalThis.ResizeObserver === 'undefined') {
      globalThis.ResizeObserver = class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
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

  it.each([
    { initial: '/settings/notifications', tabTo: '/settings', expected: '/settings' },
    { initial: '/settings/shortcuts', tabTo: '/settings', expected: '/settings' },
    { initial: '/accounts/acc-1', tabTo: '/accounts', expected: '/accounts' },
    { initial: '/accounts?tab=invest', tabTo: '/accounts', expected: '/accounts' },
    { initial: '/plan/projects/p-1', tabTo: '/plan', expected: '/plan' },
    { initial: '/reports/fire', tabTo: '/reports', expected: '/reports' },
  ])('在 $initial 點按 $tabTo 應返回 $expected', async ({ initial, tabTo, expected }) => {
    await act(async () => {
      root!.render(
        React.createElement(
          MemoryRouter,
          { initialEntries: [initial] },
          React.createElement(LocationSpy),
          React.createElement(TabBar),
        ),
      );
    });

    expect(host.querySelector('[data-testid="loc"]')?.textContent).toBe(initial);

    const tab = host.querySelector<HTMLElement>(`.tab[data-to="${tabTo}"]`);
    expect(tab).toBeTruthy();

    await act(async () => {
      tab!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: 20, clientY: 20 }));
      tab!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: 20, clientY: 20 }));
    });

    expect(host.querySelector('[data-testid="loc"]')?.textContent).toBe(expected);
  });
});
