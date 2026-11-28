// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { db } from '@/db/schema';
import { buildDefaultCategories } from '@/db/seed/categories';
import { addAccount } from '@/db/repo/accounts';
import { addDebts, addLoan } from '@/db/repo/plan';
import { DEFAULT_SETTINGS } from '@/db/repo/settings';
import { toMinor } from '@/domain/money';
import { parseSourceTemplate, SOURCE_TEMPLATES } from '@/domain/sourceTemplates';
import {
  invalidateInboxReadOnly,
  loadInbox,
  processInboxOnStartup,
  settleInboxEntryWithDebt,
  type InboxRaw,
} from '@/services/inbox';
import { useInboxCount } from '@/services/inboxCount';
import { useSettings } from '@/stores/settings';
import InboxPage from '@/features/inbox/InboxPage';
import HomeInbox from '@/features/home/HomeInbox';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mock = vi.hoisted(() => ({
  items: [] as InboxRaw[],
  ackBatches: [] as number[][],
}));

vi.mock('@/services/api', async (orig) => ({
  ...await orig<typeof import('@/services/api')>(),
  api: vi.fn(async (path: string, opts?: { body?: { ids?: number[] } }) => {
    if (path === '/inbox/items') {
      return structuredClone(mock.items);
    }
    if (path === '/inbox/items/booking') {
      return { message: '已登記' };
    }
    if (path === '/inbox/items/ack') {
      const ids = opts?.body?.ids ?? [];
      mock.ackBatches.push(ids);
      mock.items = mock.items.filter((i) => !ids.includes(i.id));
      return { ids };
    }
    throw new Error(`Unexpected API: ${path}`);
  }),
}));

vi.mock('@/services/forecast', async (orig) => ({
  ...await orig<typeof import('@/services/forecast')>(),
  loadForecast: vi.fn(async () => ({ rules: [], predicted: [] })),
}));

vi.mock('@/stores/auth', async (orig) => ({
  ...await orig<typeof import('@/stores/auth')>(),
  AUTH_ENABLED: true,
}));

const raw = (id: number, patch: Partial<InboxRaw> = {}): InboxRaw => ({
  id,
  source: 'notify',
  text: '',
  amount: '',
  merchant: '',
  card: '',
  occurred: '2026-11-28',
  created_at: '2026-11-28T08:00:00Z',
  ...patch,
});

let fubonAccId = '';
let cathayAccId = '';

beforeEach(async () => {
  await db.delete();
  await db.open();
  await db.categories.bulkAdd(buildDefaultCategories());
  invalidateInboxReadOnly();
  mock.items = [];
  mock.ackBatches = [];
  useInboxCount.getState().set(0);
  useSettings.setState(structuredClone(DEFAULT_SETTINGS));

  fubonAccId = (await addAccount({
    name: '台北富邦',
    type: 'bank',
    currency: 'TWD',
    icon: 'bank',
    color: '#0088cc',
    initialBalanceMinor: 100000,
    includeInNetWorth: true,
    isLiability: false,
  })).id;

  cathayAccId = (await addAccount({
    name: '國泰世華',
    type: 'bank',
    currency: 'TWD',
    icon: 'bank',
    color: '#00aa55',
    initialBalanceMinor: 50000,
    includeInNetWorth: true,
    isLiability: false,
  })).id;

  useSettings.setState({
    lastAccountId: cathayAccId,
    inbox: { ...DEFAULT_SETTINGS.inbox, defaultAccountId: cathayAccId, autoBook: true },
  });
});

describe('Fubon template & transfer metadata', () => {
  it('registers fubon in SOURCE_TEMPLATES and parses incoming transfer with senderLast5 and transferMemo', () => {
    expect(SOURCE_TEMPLATES.some((t) => t.id === 'fubon')).toBe(true);

    const parsed = parseSourceTemplate(
      '【台北富邦銀行】您的帳戶於 2026/11/28 10:30 跨行轉入 NT$450，對方帳號末五碼12345，附言：午餐分帳，帳戶餘額 NT$12,450',
      { referenceYear: 2026 },
    );
    expect(parsed.matched).toBe(true);
    expect(parsed.templateId).toBe('fubon');
    expect(parsed.kind).toBe('income');
    expect(parsed.txAmount).toBe(450);
    expect(parsed.txCurrency).toBe('TWD');
    expect(parsed.balance).toBe(12450);
    expect(parsed.senderLast5).toBe('12345');
    expect(parsed.transferMemo).toBe('午餐分帳');
  });

  it('parses Fubon+ card consumption notification', () => {
    const parsed = parseSourceTemplate(
      'Fubon+ 消費通知：您的富邦 J卡於 11/28 在 全聯福利中心 消費 NT$320，可用額度 NT$49,680',
      { referenceYear: 2026 },
    );
    expect(parsed.matched).toBe(true);
    expect(parsed.templateId).toBe('fubon');
    expect(parsed.kind).toBe('expense');
    expect(parsed.txAmount).toBe(320);
    expect(parsed.merchant).toBe('全聯福利中心');
    expect(parsed.card).toBe('富邦 J卡');
  });

  it('does not bleed transferMemo across newlines and parses 入帳 without currency prefix', () => {
    const parsed = parseSourceTemplate(
      '台北富邦銀行通知：您的帳戶於 11/28 入帳 450 元，附言：\n帳戶餘額 NT$12,450',
      { referenceYear: 2026 },
    );
    expect(parsed.matched).toBe(true);
    expect(parsed.templateId).toBe('fubon');
    expect(parsed.kind).toBe('income');
    expect(parsed.txAmount).toBe(450);
    expect(parsed.transferMemo).toBeUndefined();
  });
});

describe('Inbox receivable auto-match & 1-tap settlement', () => {
  it('holds incoming bank transfer from auto-booking when an open they_owe_me debt matches amount + currency within 45 days', async () => {
    await addLoan({
      personName: '小明',
      direction: 'they_owe_me',
      amountMinor: toMinor(450, 'TWD'),
      currency: 'TWD',
      date: '2026-11-20',
      ts: Date.now(),
      note: '聚餐代墊',
    });

    mock.items = [
      raw(10, {
        source: 'notify',
        card: '台北富邦',
        text: '【台北富邦銀行】您的帳戶於 2026/11/28 跨行轉入 NT$450，對方帳號末五碼12345，附言：聚餐',
      }),
    ];

    const res = await processInboxOnStartup();
    expect(res?.booked).toBe(0);
    expect(res?.pending).toBe(1);
    expect(mock.ackBatches).toHaveLength(0);

    const entries = await loadInbox();
    expect(entries).toHaveLength(1);
    expect(entries[0].matchedDebts).toHaveLength(1);
    expect(entries[0].matchedDebts![0].personName).toBe('小明');
    expect(entries[0].matchedDebts![0].amountMinor).toBe(toMinor(450, 'TWD'));
    expect(entries[0].review).toContain('疑似朋友還款');
  });

  it('does not match debts older than 45 days, settled debts, or i_owe_them debts', async () => {
    await addLoan({
      personName: '過期朋友',
      direction: 'they_owe_me',
      amountMinor: toMinor(450, 'TWD'),
      currency: 'TWD',
      date: '2026-09-01',
      ts: Date.now(),
      note: '太久以前',
    });
    await addLoan({
      personName: '我欠別人',
      direction: 'i_owe_them',
      amountMinor: toMinor(450, 'TWD'),
      currency: 'TWD',
      date: '2026-11-25',
      ts: Date.now(),
      note: '反向債務',
    });

    mock.items = [
      raw(11, {
        source: 'notify',
        card: '國泰世華',
        text: '國泰世華通知：您的帳戶轉入 NT$450',
      }),
    ];

    const entries = await loadInbox();
    expect(entries[0].matchedDebts).toBeUndefined();
    expect(entries[0].review).toBeUndefined();
  });

  it('settleInboxEntryWithDebt settles debt into parsed bank account without inflating income stats, records feedback, learns card, and acks inbox', async () => {
    const { debtId } = await addLoan({
      personName: '小明',
      direction: 'they_owe_me',
      amountMinor: toMinor(450, 'TWD'),
      currency: 'TWD',
      date: '2026-11-20',
      ts: Date.now(),
      note: '聚餐代墊',
    });

    mock.items = [
      raw(12, {
        source: 'notify',
        card: '台北富邦',
        text: '【台北富邦銀行】您的帳戶於 2026/11/28 跨行轉入 NT$450，對方帳號末五碼12345',
      }),
    ];

    const entries = await loadInbox();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.drafts[0].accountId).toBe(fubonAccId);
    expect(entry.matchedDebts?.[0].debtId).toBe(debtId);

    await settleInboxEntryWithDebt(entry, debtId);

    const debt = await db.debts.get(debtId);
    expect(debt?.settled).toBe(1);
    expect(debt?.settleTransferId).toBeTruthy();

    const tx = await db.transactions.get(debt!.settleTransferId!);
    expect(tx).toBeTruthy();
    expect(tx?.type).toBe('income');
    expect(tx?.accountId).toBe(fubonAccId);
    expect(tx?.amountMinor).toBe(toMinor(450, 'TWD'));
    expect(tx?.excludeFromStats).toBe(true);

    const fubonAcc = await db.accounts.get(fubonAccId);
    expect(fubonAcc?.balanceMinor).toBe(100000 + toMinor(450, 'TWD'));

    expect(mock.ackBatches).toEqual([[12]]);
    expect(useInboxCount.getState().n).toBe(0);
    expect(useSettings.getState().inbox.cardMap['台北富邦']).toBe(fubonAccId);

    if (entry.decisionId) {
      const feedbacks = await db.feedback_signals.where('decisionId').equals(entry.decisionId).toArray();
      expect(feedbacks.some((f) => f.signalType === 'confirm_clean')).toBe(true);
    }
  });

  it('matches USD receivable against USD incoming transfer and does not learn cardMap from default fallback account', async () => {
    await db.exchange_rates.put({
      base: 'USD',
      quote: 'TWD',
      rateDec: '32',
      source: 'manual',
      updatedAt: Date.now(),
    });
    const usdAccId = (await addAccount({
      name: '外幣帳戶',
      type: 'bank',
      currency: 'USD',
      icon: 'bank',
      color: '#2266aa',
      initialBalanceMinor: 10000,
      includeInNetWorth: true,
      isLiability: false,
    })).id;

    const { debtId } = await addLoan({
      personName: 'Alex',
      direction: 'they_owe_me',
      amountMinor: toMinor(25, 'USD'),
      currency: 'USD',
      date: '2026-11-26',
      ts: Date.now(),
      note: 'USD split',
    });

    mock.items = [
      raw(13, {
        source: 'notify',
        card: '未知銀行App',
        text: '外幣帳戶 轉入 USD 25',
      }),
      raw(14, {
        source: 'notify',
        card: 'UnmappedCard',
        text: '收到轉入 NT$450',
      }),
    ];

    await addLoan({
      personName: '小美',
      direction: 'they_owe_me',
      amountMinor: toMinor(450, 'TWD'),
      currency: 'TWD',
      date: '2026-11-27',
      ts: Date.now(),
      note: '飲料',
    });

    const entries = await loadInbox();
    const usdEntry = entries.find((e) => e.item.id === 13)!;
    expect(usdEntry.matchedDebts).toHaveLength(1);
    expect(usdEntry.matchedDebts![0].debtId).toBe(debtId);
    expect(usdEntry.matchedDebts![0].currency).toBe('USD');
    await settleInboxEntryWithDebt(usdEntry, debtId, { accountId: usdAccId });
    expect((await db.debts.get(debtId))?.settled).toBe(1);

    const defaultEntry = entries.find((e) => e.item.id === 14)!;
    expect(defaultEntry.drafts[0].accountSource).toBe('default');
    const twdDebtId = defaultEntry.matchedDebts![0].debtId;
    await settleInboxEntryWithDebt(defaultEntry, twdDebtId, { accountId: defaultEntry.drafts[0].accountId });
    expect(useSettings.getState().inbox.cardMap['UnmappedCard']).toBeUndefined();
  });
});

describe('InboxPage & HomeInbox 1-tap settle UI', () => {
  let host: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => { root?.unmount(); });
    host?.remove();
  });

  it('InboxPage renders 1-tap 沖銷 小明 應收 button and settles debt on click', async () => {
    const { debtId } = await addLoan({
      personName: '小明',
      direction: 'they_owe_me',
      amountMinor: toMinor(450, 'TWD'),
      currency: 'TWD',
      date: '2026-11-25',
      ts: Date.now(),
      note: '咖啡',
    });

    mock.items = [
      raw(21, {
        source: 'notify',
        card: '台北富邦',
        text: '【台北富邦銀行】跨行轉入 NT$450，對方帳號末五碼12345',
      }),
    ];

    await act(async () => {
      root!.render(
        React.createElement(MemoryRouter, null, React.createElement(InboxPage)),
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(host.textContent).toContain('疑為朋友還款：小明 $450');
    const settleBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('沖銷 小明 應收'));
    expect(settleBtn).toBeTruthy();

    await act(async () => {
      settleBtn!.click();
      await new Promise((r) => setTimeout(r, 50));
    });

    const debt = await db.debts.get(debtId);
    expect(debt?.settled).toBe(1);
    expect(mock.ackBatches).toContainEqual([21]);
  });

  it('HomeInbox renders quick buttons for multiple matched friends and settles selected candidate', async () => {
    const p1 = await db.people.add({ id: 'p1', name: '小明', createdAt: Date.now(), updatedAt: Date.now() });
    const p2 = await db.people.add({ id: 'p2', name: '小華', createdAt: Date.now(), updatedAt: Date.now() });
    const [d1, d2] = await addDebts([
      { personId: String(p1), direction: 'they_owe_me', amountMinor: toMinor(500, 'TWD'), currency: 'TWD', date: '2026-11-26', note: '晚餐' },
      { personId: String(p2), direction: 'they_owe_me', amountMinor: toMinor(500, 'TWD'), currency: 'TWD', date: '2026-11-27', note: '電影票' },
    ]);

    mock.items = [
      raw(22, {
        source: 'notify',
        card: '國泰世華',
        text: '國泰世華通知：您的帳戶跨行轉入 NT$500',
      }),
    ];

    await act(async () => {
      root!.render(
        React.createElement(MemoryRouter, null, React.createElement(HomeInbox)),
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const btn1 = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === '沖銷 小明');
    const btn2 = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === '沖銷 小華');
    expect(btn1).toBeTruthy();
    expect(btn2).toBeTruthy();

    await act(async () => {
      btn2!.click();
      await new Promise((r) => setTimeout(r, 50));
    });

    const debt1 = await db.debts.get(d1);
    const debt2 = await db.debts.get(d2);
    expect(debt1?.settled).toBe(0);
    expect(debt2?.settled).toBe(1);
    expect(mock.ackBatches).toContainEqual([22]);
  });
});
