// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import * as IconModule from '@/ui/Icon';

describe('品牌標記改用金色折疊緞帶 A ＋三柱成長圖表', () => {
  it('brand 為折疊緞帶 A 路徑＋三根遞增柱狀，與全 App 圖示同一套 24×24 currentColor 語言', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(IconModule.Icon, { name: 'brand', size: 26, stroke: 2, className: 'brand' }));
    });
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg?.getAttribute('stroke')).toBe('currentColor');
    const paths = svg?.querySelectorAll('path');
    expect(paths).toHaveLength(1);
    expect(paths?.[0].getAttribute('fill')).toBe('currentColor');
    const rects = svg?.querySelectorAll('rect');
    expect(rects).toHaveLength(3);
    expect(rects?.[0].getAttribute('fill')).toBe('currentColor');
    expect(svg?.classList.contains('brand')).toBe(true);
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('舊立體漸層 Logo 元件與星芒標記已完全移除', async () => {
    expect('Logo' in IconModule).toBe(false);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(IconModule.Icon, { name: 'asterisk' as IconModule.IconName, size: 26 }));
    });
    expect(container.querySelectorAll('path')).toHaveLength(0);
    await act(async () => { root.unmount(); });
    container.remove();
  });
});