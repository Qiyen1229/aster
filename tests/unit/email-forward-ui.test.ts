// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { EmailForwardSheet, GMAIL_FILTER_TEMPLATE } from '@/features/inbox/EmailForwardSheet';
import ShortcutsPage from '@/features/settings/ShortcutsPage';
import type { EmailForwardBinding, InboxToken } from '@/services/inbox';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockGetBinding = vi.fn<() => Promise<EmailForwardBinding | null>>();
const mockSetupForward = vi.fn<(email: string) => Promise<EmailForwardBinding>>();
const mockMarkVerified = vi.fn<() => Promise<EmailForwardBinding>>();
const mockRemoveForward = vi.fn<() => Promise<void>>();
const mockListTokens = vi.fn<() => Promise<InboxToken[]>>();
const mockAsk = vi.fn<() => Promise<boolean>>();

vi.mock('@/services/inbox', async (orig) => ({
  ...(await orig<typeof import('@/services/inbox')>()),
  getEmailForwardBinding: () => mockGetBinding(),
  setupEmailForward: (email: string) => mockSetupForward(email),
  markEmailForwardVerified: () => mockMarkVerified(),
  removeEmailForward: () => mockRemoveForward(),
  listTokens: () => mockListTokens(),
}));

vi.mock('@/stores/auth', async (orig) => ({
  ...(await orig<typeof import('@/stores/auth')>()),
  AUTH_ENABLED: true,
}));

vi.mock('@/stores/ui', async (orig) => ({
  ...(await orig<typeof import('@/stores/ui')>()),
  ask: () => mockAsk(),
}));

function makeBinding(overrides: Partial<EmailForwardBinding> = {}): EmailForwardBinding {
  return {
    id: 1,
    source_email: 'user@gmail.com',
    forward_address: 'in-0123456789abcdef0123@qiyen.me',
    status: 'pending_verify',
    verify_url: null,
    verify_code: null,
    verify_received_at: null,
    last_received_at: null,
    received_count: 0,
    created_at: '2026-11-27 00:00:00',
    updated_at: '2026-11-27 00:00:00',
    ...overrides,
  };
}

describe('EmailForwardSheet 4 步驟精靈與 ShortcutsPage 入口', () => {
  let host: HTMLDivElement;
  let root: Root | null = null;
  let clipboardWrite: ReturnType<typeof vi.fn>;
  let openSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    clipboardWrite = vi.fn(async () => undefined);
    openSpy = vi.fn();
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: clipboardWrite },
    });
    vi.stubGlobal('open', openSpy);
    mockGetBinding.mockReset();
    mockSetupForward.mockReset();
    mockMarkVerified.mockReset();
    mockRemoveForward.mockReset();
    mockListTokens.mockReset();
    mockAsk.mockReset();
    mockListTokens.mockResolvedValue([]);
    mockAsk.mockResolvedValue(true);

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => {
      root?.unmount();
    });
    host.remove();
    vi.unstubAllGlobals();
  });

  it('完整 4 步驟流程：輸入 Gmail → 輪詢取得驗證信與確認碼 → 篩選器範本 → 偵測已連線與移除', async () => {
    const initial = makeBinding();
    const withVerify = makeBinding({
      verify_url: 'https://mail-settings.google.com/mail/vf-xyz999',
      verify_code: '987654321',
      verify_received_at: '2026-11-27 00:01:00',
    });
    const verified = makeBinding({
      ...withVerify,
      status: 'verified',
    });
    const connected = makeBinding({
      ...verified,
      received_count: 2,
      last_received_at: '2026-11-27 00:02:00',
    });

    mockSetupForward.mockResolvedValue(initial);
    mockMarkVerified.mockResolvedValue(verified);
    mockRemoveForward.mockResolvedValue(undefined);
    mockGetBinding
      .mockResolvedValueOnce(withVerify) // step 2 poll
      .mockResolvedValueOnce(connected); // step 4 poll

    const onUpdated = vi.fn();
    const onClose = vi.fn();

    await act(async () => {
      root!.render(React.createElement(EmailForwardSheet, {
        open: true,
        onClose,
        binding: null,
        onUpdated,
      }));
    });

    // 步驟 1：輸入 Gmail 並送出
    const input = document.body.querySelector('input[type="email"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'user@gmail.com');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const form = document.body.querySelector('form')!;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(mockSetupForward).toHaveBeenCalledWith('user@gmail.com');
    expect(document.body.textContent).toContain('步驟 2：驗證轉寄地址');
    expect(document.body.textContent).toContain('in-0123456789abcdef0123@qiyen.me');

    // 步驟 2：每 3 秒輪詢取得 Gmail 驗證信
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(mockGetBinding).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('前往完成 Gmail 驗證');
    expect(document.body.textContent).toContain('987654321');

    const verifyBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes('前往完成 Gmail 驗證'))!;
    await act(async () => {
      verifyBtn.click();
    });
    expect(openSpy).toHaveBeenCalledWith('https://mail-settings.google.com/mail/vf-xyz999', '_blank', 'noopener,noreferrer');

    const nextToStep3 = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes('我已完成驗證，下一步'))!;
    await act(async () => {
      nextToStep3.click();
    });
    expect(mockMarkVerified).toHaveBeenCalledTimes(1);

    // 步驟 3：顯示台灣銀行篩選器關鍵字範本並可複製
    expect(document.body.textContent).toContain('步驟 3：設定 Gmail 篩選器');
    expect(document.body.textContent).toContain(GMAIL_FILTER_TEMPLATE);
    const nextToStep4 = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes('下一步：測試通知與完成'))!;
    await act(async () => {
      nextToStep4.click();
    });

    // 步驟 4：輪詢偵測 received_count 更新為已連線
    expect(document.body.textContent).toContain('步驟 4：測試通知與完成');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(document.body.textContent).toContain('已連線 · 已接收 2 筆');

    // 移除這個 Email
    const removeBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes('移除這個 Email'))!;
    await act(async () => {
      removeBtn.click();
    });
    expect(mockAsk).toHaveBeenCalledTimes(1);
    expect(mockRemoveForward).toHaveBeenCalledTimes(1);
    expect(onUpdated).toHaveBeenLastCalledWith(null);
    expect(document.body.textContent).toContain('步驟 1：輸入你的 Gmail');
  });

  it('ShortcutsPage 顯示 Email 自動轉寄（Gmail）卡片與即時狀態', async () => {
    mockGetBinding.mockResolvedValue(makeBinding({
      status: 'verified',
      received_count: 5,
      last_received_at: '2026-11-27 01:00:00',
    }));

    await act(async () => {
      root!.render(
        React.createElement(MemoryRouter, null, React.createElement(ShortcutsPage)),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Email 自動轉寄（Gmail）');
    expect(host.textContent).toContain('已連線 · 已接收 5 筆');
  });

  it('受控模式在步驟 4 輪詢尚未收到測試信時不會被踢回步驟 3', async () => {
    const verifiedPendingTest = makeBinding({ status: 'verified', received_count: 0, last_received_at: null });
    const connected = makeBinding({ status: 'verified', received_count: 1, last_received_at: '2026-11-27T02:00:00Z' });
    mockGetBinding
      .mockResolvedValueOnce(verifiedPendingTest)
      .mockResolvedValueOnce(connected);

    function ControlledHarness() {
      const [binding, setBinding] = React.useState<EmailForwardBinding | null>(verifiedPendingTest);
      return React.createElement(EmailForwardSheet, {
        open: true,
        onClose: () => undefined,
        binding,
        onUpdated: setBinding,
      });
    }

    await act(async () => {
      root!.render(React.createElement(ControlledHarness));
    });

    // 初始為 verified 且未收信，從步驟 3 開始，手動進步驟 4
    expect(document.body.textContent).toContain('步驟 3：設定 Gmail 篩選器');
    const nextToStep4 = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes('下一步：測試通知與完成'))!;
    await act(async () => {
      nextToStep4.click();
    });
    expect(document.body.textContent).toContain('步驟 4：測試通知與完成');

    // 第一次輪詢仍為 received_count=0，應留在步驟 4
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(mockGetBinding).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('步驟 4：測試通知與完成');

    // 第二次輪詢收到測試信，顯示已連線
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(mockGetBinding).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain('已連線 · 已接收 1 筆');
  });
});
