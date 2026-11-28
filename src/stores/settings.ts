/**
 * 設定狀態：啟動時從 IndexedDB 載入一次，之後寫入時同步更新記憶體與 DB。
 * 主題相關設定會即時套用到 <html> 的 data-* 屬性。
 */
import { create } from 'zustand';
import { DEFAULT_SETTINGS, normalizeThemePalette, saveSetting, type Settings } from '@/db/repo/settings';
import { setFontSizePreference } from '@/app/viewport';

interface SettingsState extends Settings {
  ready: boolean;
  /** 每位往來對象最後使用的結清帳戶（personId → accountId） */
  personSettleAccMap: Record<string, string>;
  hydrate: (s: Settings) => void;
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  setPersonSettleAcc: (personId: string, accountId: string) => void;
}

export const useSettings = create<SettingsState>((set) => ({
  ...DEFAULT_SETTINGS,
  ready: false,
  personSettleAccMap: {},
  hydrate: (s) => {
    const personSettleAccMap = (s as Partial<SettingsState>).personSettleAccMap ?? {};
    const settings = { ...s, personSettleAccMap, themePalette: normalizeThemePalette(s.themePalette) };
    set({ ...settings, ready: true });
    applyTheme(settings);
    setFontSizePreference(s.fontSize);
  },
  set: (key, value) => {
    set({ [key]: value } as Partial<SettingsState>);
    void saveSetting(key, value);
    if (key === 'theme' || key === 'themePalette' || key === 'accent' || key === 'upColor' || key === 'travelModeProjectId') applyTheme(useSettings.getState());
    if (key === 'fontSize') setFontSizePreference(value as Settings['fontSize']);
  },
  setPersonSettleAcc: (personId, accountId) => {
    if (!personId || !accountId) return;
    const next = { ...useSettings.getState().personSettleAccMap, [personId]: accountId };
    set({ personSettleAccMap: next });
    void saveSetting('personSettleAccMap' as keyof Settings, next as never);
  },
}));

const media = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
media?.addEventListener('change', () => applyTheme(useSettings.getState()));

const THEME_CACHE_KEY = 'aster.themeCache';

export function readCachedTheme(): Partial<Pick<Settings, 'theme' | 'accent' | 'upColor' | 'themePalette' | 'travelModeProjectId'>> | null {
  try {
    const raw = localStorage.getItem(THEME_CACHE_KEY);
    return raw ? (JSON.parse(raw) as Partial<Settings>) : null;
  } catch {
    return null;
  }
}

export function applyTheme(s: Partial<Pick<Settings, 'theme' | 'accent' | 'upColor' | 'themePalette' | 'travelModeProjectId'>>) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const dark = s.theme === 'dark' || (s.theme === 'system' && !!media?.matches);
  if (s.theme !== undefined) root.dataset.theme = dark ? 'dark' : 'light';
  if (s.accent !== undefined) root.dataset.accent = s.accent;
  if (s.upColor !== undefined) root.dataset.updown = s.upColor;
  root.dataset.palette = normalizeThemePalette(s.themePalette);
  if (s.travelModeProjectId) {
    root.dataset.mode = 'travel';
  } else {
    delete root.dataset.mode;
  }
  try {
    localStorage.setItem(THEME_CACHE_KEY, JSON.stringify({
      theme: s.theme ?? DEFAULT_SETTINGS.theme,
      themePalette: normalizeThemePalette(s.themePalette),
      accent: s.accent ?? DEFAULT_SETTINGS.accent,
      upColor: s.upColor ?? DEFAULT_SETTINGS.upColor,
      travelModeProjectId: s.travelModeProjectId ?? null,
    }));
  } catch { /* 忽略 */ }
  const metaColor = getComputedStyle(root).getPropertyValue('--bg').trim();
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    m.setAttribute('content', metaColor);
    // iOS Safari / PWA 動態切換模式時，重新掛載同一個節點可強制重繪頂部狀態列
    m.parentNode?.appendChild(m);
  });
}
