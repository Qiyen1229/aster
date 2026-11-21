// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { db } from '@/db/schema';
import { bootstrap } from '@/db/bootstrap';
import { hasSampleData, loadSampleData } from '@/db/seed/sample';
import { useSettings } from '@/stores/settings';
import Onboarding from '@/features/onboarding/Onboarding';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

async function waitOnboarded() {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const row = await db.settings.get('onboarded');
    if (useSettings.getState().onboarded && row?.value === true) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
  }
  throw new Error('等待 Onboarding 完成逾時');
}

function clickButton(container: HTMLElement, text: string) {
  const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(text));
  if (!btn) throw new Error(`找不到按鈕：${text}`);
  btn.click();
}

describe('首次引導 Onboarding：文案與範例資料行為', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await db.delete();
    const settings = await bootstrap();
    useSettings.getState().hydrate(settings);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  const renderOnboarding = async (route = '/onboarding') => {
    await act(async () => {
      root.render(React.createElement(MemoryRouter, { initialEntries: [route] }, React.createElement(Onboarding)));
    });
    await flush();
  };

  it('新用戶不顯示關閉鈕、功能介紹顯示「Aster 必備技能」，選「從空白開始」不載入範例並啟用首頁手勢教學', async () => {
    await renderOnboarding();
    expect(host.querySelector('button[aria-label="關閉導覽"]')).toBeNull();

    // Step 0 -> Step 1
    await act(async () => { clickButton(host, '開始設定'); });
    expect(host.textContent).toContain('Aster 必備技能，左右滑動看看。');
    expect(host.textContent).not.toContain('最強的 6 招');

    // Step 1 -> Step 2 -> Step 3 -> Step 4
    await act(async () => { clickButton(host, '下一步'); });
    await act(async () => { clickButton(host, '下一步'); });
    await act(async () => { clickButton(host, '下一步'); });

    expect(host.textContent).toContain('要先看看範例嗎？');

    await act(async () => { clickButton(host, '從空白開始'); });
    await waitOnboarded();

    expect(await hasSampleData()).toBe(false);
    expect(await db.transactions.count()).toBe(0);
    const accounts = await db.accounts.toArray();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].name).toBe('錢包');
    expect(accounts[0].isSample).toBeFalsy();
    expect((await db.settings.get('onboarded'))?.value).toBe(true);
    expect(useSettings.getState().gestureTourDone).toBe(false);
    expect((await db.settings.get('gestureTourDone'))?.value).toBe(false);
  });

  it('既有已引導用戶（?replay=1 或 onboarded=true）右上角顯示關閉「×」，點擊可直接取消離開', async () => {
    useSettings.setState({ onboarded: true, gestureTourDone: true });
    await renderOnboarding('/onboarding?replay=1');

    const closeBtn = host.querySelector<HTMLButtonElement>('button[aria-label="關閉導覽"]');
    expect(closeBtn).not.toBeNull();

    await act(async () => { closeBtn?.click(); });
    await flush();

    // 取消重看不會建立帳戶或載入範例資料，也不重置手勢教學狀態
    expect(await db.accounts.count()).toBe(0);
    expect(await hasSampleData()).toBe(false);
    expect(useSettings.getState().gestureTourDone).toBe(true);
  });

  it('若先前已有殘留範例資料，選擇「從空白開始」會一併清除', async () => {
    await loadSampleData();
    expect(await hasSampleData()).toBe(true);

    await renderOnboarding();
    await act(async () => { clickButton(host, '開始設定'); });
    await act(async () => { clickButton(host, '下一步'); });
    await act(async () => { clickButton(host, '下一步'); });
    await act(async () => { clickButton(host, '略過'); });
    await act(async () => { clickButton(host, '從空白開始'); });
    await waitOnboarded();

    expect(await hasSampleData()).toBe(false);
    expect(await db.transactions.count()).toBe(0);
    expect(await db.accounts.count()).toBe(0);
  });

  it('明確點擊「載入範例資料」會載入範例帳戶與帳目', async () => {
    let now = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);

    await renderOnboarding();
    await act(async () => { clickButton(host, '開始設定'); });
    await act(async () => { clickButton(host, '下一步'); });
    await act(async () => { clickButton(host, '下一步'); });
    await act(async () => { clickButton(host, '略過'); });

    // 過了防連點門檻後才按下「載入範例資料」
    now += 500;
    await act(async () => { clickButton(host, '載入範例資料'); });
    await waitOnboarded();

    expect(await hasSampleData()).toBe(true);
    expect(await db.transactions.count()).toBeGreaterThan(0);
    expect((await db.settings.get('onboarded'))?.value).toBe(true);
  });
});
