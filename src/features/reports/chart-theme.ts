/** 由目前 CSS token 取得圖表配色（不依賴 ECharts，可在任何地方引用） */
import { useEffect, useState } from 'react';
import { useSettings } from '@/stores/settings';

export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** 由目前 CSS token 組出圖表共用樣式 */
export function chartTheme() {
  return {
    text: cssVar('--text'),
    text2: cssVar('--text-2'),
    text3: cssVar('--text-3'),
    sep: cssVar('--sep'),
    accent: cssVar('--accent'),
    pos: cssVar('--c-pos'),
    neg: cssVar('--c-neg'),
    surface: cssVar('--surface'),
    font: getComputedStyle(document.body).fontFamily,
  };
}

/** 追蹤影響圖表配色的全部設定與系統深淺色狀態 */
export function useChartTheme(): string {
  const pref = useSettings((s) => `${s.theme}-${s.themePalette}-${s.accent}-${s.upColor}-${s.travelModeProjectId ?? ''}`);
  const [sysDark, setSysDark] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSysDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return `${pref}-${sysDark ? 'd' : 'l'}`;
}

