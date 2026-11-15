// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { db } from '@/db/schema';
import { useUI } from '@/stores/ui';
import { AddSheet } from '@/features/add/AddSheet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('全螢幕記帳畫布（AddSheet）', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await db.delete();
    await db.open();
    useUI.setState({ add: { open: false, seq: 0 }, confirm: null, snack: null, actions: null });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('以全螢幕 .add-screen 掛載（不使用半遮罩 .sheet），並從靈動島 .dynamic-fab 位置展開', async () => {
    const fab = document.createElement('button');
    fab.className = 'dynamic-fab';
    fab.getBoundingClientRect = () => ({ left: 180, top: 760, width: 56, height: 56, right: 236, bottom: 816, x: 180, y: 760, toJSON: () => ({}) });
    document.body.appendChild(fab);

    await act(async () => {
      useUI.getState().openAdd();
      root.render(React.createElement(AddSheet));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 40)); });

    const screen = document.body.querySelector<HTMLElement>('.add-screen');
    expect(screen).not.toBeNull();
    expect(screen?.getAttribute('role')).toBe('dialog');
    expect(screen?.getAttribute('aria-modal')).toBe('true');
    expect(screen?.style.getPropertyValue('--add-ox')).toBe('208px');
    expect(screen?.style.getPropertyValue('--add-oy')).toBe('788px');
    // 外層不再是 Bottom Sheet
    expect(document.body.querySelector('.sheet-backdrop')).toBeNull();

    // 精簡頂列：關閉、類型切換、常用／釘選 ⚡
    expect(screen?.querySelector('.add-topbar button[aria-label="關閉"]')).not.toBeNull();
    expect(screen?.querySelector('.add-topbar [role="group"][aria-label="記帳類型"]')).not.toBeNull();
    expect(screen?.querySelector('.add-topbar button[aria-label="常用與釘選"]')).not.toBeNull();
    // 原本佔據金額與分類之間的橫向膠囊列已移除
    expect(screen?.querySelector('.note-sugs')).toBeNull();

    // 切換到轉帳模式時隱藏 ⚡，切回收入模式時顯示 ⚡
    const transferTab = Array.from(screen!.querySelectorAll('.add-topbar [role="group"] button')).find((b) => b.textContent === '轉帳') as HTMLButtonElement;
    await act(async () => { transferTab.click(); });
    expect(screen?.querySelector('.add-topbar button[aria-label="常用與釘選"]')).toBeNull();
    const incomeTab = Array.from(screen!.querySelectorAll('.add-topbar [role="group"] button')).find((b) => b.textContent === '收入') as HTMLButtonElement;
    await act(async () => { incomeTab.click(); });
    expect(screen?.querySelector('.add-topbar button[aria-label="常用與釘選"]')).not.toBeNull();
  });

  it('點擊「進階」收起數字鍵盤並原地展開垂直列表；點「收起」或金額區可叫回鍵盤，並顯示已選數量徽章', async () => {
    await act(async () => {
      useUI.getState().openAdd();
      root.render(React.createElement(AddSheet));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 40)); });

    const screen = document.body.querySelector<HTMLElement>('.add-screen')!;
    expect(screen.querySelector('.keypad-dock')).not.toBeNull();
    expect(screen.querySelector('.add-advanced-dock')).toBeNull();

    // 點擊「進階」
    const advBtn = Array.from(screen.querySelectorAll('button')).find((b) => b.textContent?.includes('進階'))!;
    expect(advBtn).toBeTruthy();
    await act(async () => { advBtn.click(); });

    expect(screen.querySelector('.keypad-dock')).toBeNull();
    const advDock = screen.querySelector('.add-advanced-dock');
    expect(advDock).not.toBeNull();
    expect(advDock?.textContent).toContain('標籤');
    expect(advDock?.textContent).toContain('分帳');
    expect(advDock?.textContent).toContain('耐用品');
    expect(advDock?.textContent).toContain('收據照片');
    expect(advDock?.textContent).toContain('不計入預算');
    expect(advDock?.textContent).toContain('複製上一筆');

    // 切換「不計入預算」→ 徽章顯示 1
    const skipInput = advDock!.querySelector<HTMLInputElement>('input[aria-label="不計入預算"]')!;
    await act(async () => { skipInput.click(); });
    expect(advBtn.querySelector('.adv-badge')?.textContent).toBe('1');

    // 點「收起」叫回數字鍵盤
    const closeAdvBtn = advDock!.querySelector<HTMLButtonElement>('.add-adv-close')!;
    await act(async () => { closeAdvBtn.click(); });
    expect(screen.querySelector('.keypad-dock')).not.toBeNull();
    expect(screen.querySelector('.add-advanced-dock')).toBeNull();
    // 收起後徽章仍保留
    expect(advBtn.querySelector('.adv-badge')?.textContent).toBe('1');

    // 再次展開並點擊金額區，也能立刻叫回數字鍵盤
    await act(async () => { advBtn.click(); });
    expect(screen.querySelector('.add-advanced-dock')).not.toBeNull();
    const amountArea = screen.querySelector<HTMLElement>('.add-amount')!;
    await act(async () => { amountArea.click(); });
    expect(screen.querySelector('.keypad-dock')).not.toBeNull();
    expect(screen.querySelector('.add-advanced-dock')).toBeNull();
  });

  it('點擊 ⚡ 可開啟「常用與釘選」選單；有未儲存輸入時關閉會觸發確認防呆', async () => {
    await act(async () => {
      useUI.getState().openAdd();
      root.render(React.createElement(AddSheet));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 40)); });

    const screen = document.body.querySelector<HTMLElement>('.add-screen')!;
    const zapBtn = screen.querySelector<HTMLButtonElement>('button[aria-label="常用與釘選"]')!;
    await act(async () => { zapBtn.click(); });
    expect(document.body.querySelector('.sheet[aria-label="常用與釘選"]')).not.toBeNull();

    // 關閉 ⚡ 選單
    const sheetClose = document.body.querySelector<HTMLButtonElement>('.sheet[aria-label="常用與釘選"] button[aria-label="關閉"]');
    await act(async () => { sheetClose?.click(); });

    // 輸入備註使表單為 dirty，點擊頂列關閉按鈕應跳出確認視窗
    const noteInput = screen.querySelector<HTMLInputElement>('input[aria-label="備註"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(noteInput, '午餐');
      noteInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const closeBtn = screen.querySelector<HTMLButtonElement>('.add-topbar button[aria-label="關閉"]')!;
    await act(async () => { closeBtn.click(); });
    expect(useUI.getState().confirm?.title).toBe('放棄這筆記帳？');
    await act(async () => { useUI.getState().closeConfirm(false); });
    expect(useUI.getState().add.open).toBe(true);

    // 確認放棄後進入 closing 退出動畫並在完成後卸載
    await act(async () => { closeBtn.click(); });
    await act(async () => { useUI.getState().closeConfirm(true); });
    expect(useUI.getState().add.open).toBe(false);
    expect(document.body.querySelector('.add-screen')?.classList.contains('closing')).toBe(true);
    await act(async () => { await new Promise((r) => setTimeout(r, 270)); });
    expect(document.body.querySelector('.add-screen')).toBeNull();
  });

  it('預設支出大類別為 10 個（5×2），選中含子項的大類後收合為單行返回列並以大格顯示子項目', async () => {
    const { buildDefaultCategories } = await import('@/db/seed/categories');
    const { buildTree } = await import('@/db/repo/categories');
    const { bootstrap } = await import('@/db/bootstrap');

    // 全新資料庫預設種子：10 個支出大類別
    await db.categories.bulkAdd(buildDefaultCategories());
    expect(buildTree(await db.categories.toArray(), 'expense')).toHaveLength(10);

    // 既有使用者的舊類別（如 exp-clothing）不會被 bootstrap 刪除或覆寫
    await db.categories.add({
      id: 'exp-clothing', kind: 'expense', parentId: '', name: '服飾', icon: '👕', color: '#FF6482',
      sort: 99, archived: 0, createdAt: 1, updatedAt: 1,
    });
    await bootstrap();
    expect(await db.categories.get('exp-clothing')).toBeDefined();

    await act(async () => {
      useUI.getState().openAdd();
      root.render(React.createElement(AddSheet));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 40)); });

    const screen = document.body.querySelector<HTMLElement>('.add-screen')!;
    // 初始顯示大類別網格（含既有舊類別共 11 個；預設新使用者為 10 個）
    expect(screen.querySelector('.cat-grid')).not.toBeNull();
    expect(screen.querySelector('.cat-back-bar')).toBeNull();
    expect(screen.querySelector('.sub-grid')).toBeNull();

    // 點選「飲食」（有子項目）→ 大類網格收合為單行返回列，改以 .sub-grid 大格顯示子項目
    const foodBtn = Array.from(screen.querySelectorAll<HTMLButtonElement>('.cat-grid .cat-cell')).find((b) => b.textContent?.includes('飲食'))!;
    await act(async () => { foodBtn.click(); });
    expect(screen.querySelector('.cat-grid')).toBeNull();
    const backBar = screen.querySelector<HTMLButtonElement>('.cat-back-bar')!;
    expect(backBar).not.toBeNull();
    expect(backBar.textContent).toContain('飲食');
    expect(backBar.textContent).toContain('點此重選');
    const subGrid = screen.querySelector('.sub-grid')!;
    expect(subGrid).not.toBeNull();
    expect(subGrid.textContent).toContain('早餐');
    expect(subGrid.textContent).toContain('晚餐');

    // 點上方單行返回列 → 展開回大類別網格重選
    await act(async () => { backBar.click(); });
    expect(screen.querySelector('.cat-grid')).not.toBeNull();
    expect(screen.querySelector('.cat-back-bar')).toBeNull();

    // 重新選「飲食」後切換至「收入」→ 收入尚未選過分類，應顯示收入大類別網格而非直接跳進薪資子項目
    const foodBtn2 = Array.from(screen.querySelectorAll<HTMLButtonElement>('.cat-grid .cat-cell')).find((b) => b.textContent?.includes('飲食'))!;
    await act(async () => { foodBtn2.click(); });
    expect(screen.querySelector('.sub-grid')).not.toBeNull();
    const incomeTab = Array.from(screen.querySelectorAll<HTMLButtonElement>('.add-topbar .segmented button')).find((b) => b.textContent?.includes('收入'))!;
    await act(async () => { incomeTab.click(); });
    expect(screen.querySelector('.cat-grid')).not.toBeNull();
    expect(screen.querySelector('.sub-grid')).toBeNull();

    // 切回「支出」→ 恢復已選中的「飲食」子項目大格
    const expenseTab = Array.from(screen.querySelectorAll<HTMLButtonElement>('.add-topbar .segmented button')).find((b) => b.textContent?.includes('支出'))!;
    await act(async () => { expenseTab.click(); });
    expect(screen.querySelector('.sub-grid')).not.toBeNull();
    await act(async () => { screen.querySelector<HTMLButtonElement>('.cat-back-bar')!.click(); });

    // 點選無子項目的「其他」→ 維持大類別網格不收合
    const otherBtn = Array.from(screen.querySelectorAll<HTMLButtonElement>('.cat-grid .cat-cell')).find((b) => b.textContent?.includes('其他'))!;
    await act(async () => { otherBtn.click(); });
    expect(screen.querySelector('.cat-grid')).not.toBeNull();
    expect(screen.querySelector('.cat-back-bar')).toBeNull();
  });
});
