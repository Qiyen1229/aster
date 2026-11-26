import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CustomDateInput, CustomSelect } from '@/ui/CustomSelect';

function walkTsx(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkTsx(full));
    else if (name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

describe('自製下拉選單與日期選擇器（禁用 iOS 原生視窗）', () => {
  it('CustomSelect 應渲染為按鈕而非原生 <select>', () => {
    const html = renderToStaticMarkup(
      createElement(CustomSelect, {
        value: 'TWD',
        onChange: () => undefined,
        title: '主幣別',
        options: [
          { value: 'TWD', label: 'TWD 新台幣' },
          { value: 'USD', label: 'USD 美元' },
        ],
      }),
    );
    expect(html).toContain('custom-select-btn');
    expect(html).toContain('TWD 新台幣');
    expect(html).not.toContain('<select');
  });

  it('CustomDateInput 應渲染為按鈕而非原生 <input type="date"|"time">', () => {
    const html = renderToStaticMarkup(
      createElement(CustomDateInput, {
        value: '2026-11-26',
        onChange: () => undefined,
        'aria-label': '開始日期',
      }),
    );
    expect(html).toContain('custom-select-btn');
    expect(html).toContain('2026-11-26');
    expect(html).not.toContain('<input');
  });

  it('全站 src/**/*.tsx 不應再使用原生 <select> 或 <input type="date"|"time">', () => {
    const files = walkTsx(join(process.cwd(), 'src'));
    const violations: string[] = [];
    for (const file of files) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      if (/<select[\s>]/.test(code)) violations.push(`${file}: <select>`);
      if (/<input[^>]*\btype=["'](?:date|time)["']/.test(code)) violations.push(`${file}: <input type="date|time">`);
    }
    expect(violations).toEqual([]);
  });
});
