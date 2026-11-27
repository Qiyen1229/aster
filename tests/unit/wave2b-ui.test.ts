// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { db } from '@/db/schema';
import type { InboxEntry } from '@/services/inbox';
import { todayKey } from '@/domain/period';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockLoadInbox = vi.fn<() => Promise<InboxEntry[]>>(async () => []);
const mockConfirmInboxEntry = vi.fn<typeof import('@/services/inbox').confirmInboxEntry>(async () => ({
  count: 1,
  skipped: 0,
  failedItemIds: [],
  alreadyBooked: 0,
  ackPending: 0,
  clearedItemIds: [1],
  txIds: ['inbox-1-0'],
  transferIds: [],
  decisionId: 'dec-1',
}));
const mockSkipInboxEntry = vi.fn<typeof import('@/services/inbox').skipInboxEntry>(async () => undefined);
const mockLoadForecast = vi.fn(async () => ({ rules: [], predicted: [] }));

vi.mock('@/services/inbox', async (orig) => ({
  ...(await orig<typeof import('@/services/inbox')>()),
  loadInbox: () => mockLoadInbox(),
  confirmInboxEntry: (...args: Parameters<typeof import('@/services/inbox').confirmInboxEntry>) =>
    mockConfirmInboxEntry(...args),
  skipInboxEntry: (...args: Parameters<typeof import('@/services/inbox').skipInboxEntry>) =>
    mockSkipInboxEntry(...args),
}));

vi.mock('@/services/forecast', async (orig) => ({
  ...(await orig<typeof import('@/services/forecast')>()),
  loadForecast: () => mockLoadForecast(),
}));

vi.mock('@/stores/auth', async (orig) => ({
  ...(await orig<typeof import('@/stores/auth')>()),
  AUTH_ENABLED: true,
}));

function makeEntry(overrides: Partial<InboxEntry> = {}): InboxEntry {
  const today = todayKey();
  return {
    item: {
      id: 101,
      source: 'notify',
      text: '玉山 Unicard 於 星巴克 消費 NT$150',
      amount: '150',
      merchant: '星巴克',
      card: '玉山 Unicard',
      occurred: today,
      currency: 'TWD',
      created_at: new Date().toISOString(),
    },
    drafts: [
      {
        kind: 'expense',
        amount: 150,
        currency: 'TWD',
        date: today,
        dateGiven: true,
        note: '星巴克',
        raw: '星巴克 150',
        categoryId: 'exp-food',
        accountId: 'acc-esun',
        tagIds: [],
        categorySource: 'rule',
        accountSource: 'rule',
      },
    ],
    decisionId: 'dec-101',
    confidence: 'high',
    decisionReasons: ['card:玉山 Unicard', 'merchantAlias:星巴克'],
    secondCandidate: {
      label: '咖啡飲料',
      categoryId: 'exp-drink',
      accountId: 'acc-esun',
      ruleId: 'rule-2',
    },
    shadowMatch: {
      ruleId: 'rule-shadow-1',
      categoryId: 'exp-drink',
      label: '觀察期咖啡規則',
    },
    driftWarning: 'Template "esun" has 3 consecutive parse failures',
    ...overrides,
  };
}

async function seedBaseDb() {
  await Promise.all([
    db.accounts.clear(),
    db.categories.clear(),
    db.rules.clear(),
    db.transactions.clear(),
    db.auto_decisions.clear(),
    db.feedback_signals.clear(),
    db.merchant_aliases.clear(),
    db.meta.clear(),
  ]);
  const now = Date.now();
  await db.accounts.bulkPut([
    {
      id: 'acc-esun',
      name: '玉山銀行',
      icon: 'bank',
      color: '#0a8',
      type: 'bank',
      currency: 'TWD',
      initialBalanceMinor: 0,
      balanceMinor: 0,
      includeInNetWorth: true,
      isLiability: false,
      sort: 1,
      archived: 0,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'acc-cash',
      name: '現金',
      icon: 'cash',
      color: '#666',
      type: 'cash',
      currency: 'TWD',
      initialBalanceMinor: 0,
      balanceMinor: 0,
      includeInNetWorth: true,
      isLiability: false,
      sort: 2,
      archived: 0,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await db.categories.bulkPut([
    {
      id: 'exp-food',
      kind: 'expense',
      parentId: '',
      name: '餐飲',
      icon: 'food',
      color: '#e55',
      sort: 1,
      archived: 0,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'exp-drink',
      kind: 'expense',
      parentId: '',
      name: '飲品',
      icon: 'coffee',
      color: '#a52',
      sort: 2,
      archived: 0,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'exp-other_exp',
      kind: 'expense',
      parentId: '',
      name: '其他支出',
      icon: 'dots',
      color: '#999',
      sort: 3,
      archived: 0,
      createdAt: now,
      updatedAt: now,
    },
  ]);
}

function findButton(container: ParentNode, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').includes(text),
  ) as HTMLButtonElement | undefined;
}

describe('Wave 2B UI: InboxPage, HomeInbox, RulesPage', () => {
  let host: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(async () => {
    vi.clearAllMocks();
    await seedBaseDb();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    host.remove();
  });

  it('InboxPage 顯示信心度、決策理由、第二候選、觀察期與漂移警示，並支援切換備選與 editedFields 回報', async () => {
    const entry = makeEntry();
    mockLoadInbox.mockResolvedValue([entry]);

    const { default: InboxPage } = await import('@/features/inbox/InboxPage');
    await act(async () => {
      root!.render(React.createElement(MemoryRouter, null, React.createElement(InboxPage)));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(host.textContent).toContain('信心 高');
    expect(host.textContent).toContain('卡片：玉山 Unicard');
    expect(host.textContent).toContain('改用備選：咖啡飲料');
    expect(host.textContent).toContain('觀察期預測：觀察期咖啡規則');
    expect(host.textContent).toContain('格式漂移：');

    const secondBtn = findButton(host, '改用備選：咖啡飲料');
    expect(secondBtn).toBeTruthy();
    await act(async () => {
      secondBtn!.click();
    });

    const bookBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === '記帳');
    expect(bookBtn).toBeTruthy();
    await act(async () => {
      bookBtn!.click();
    });

    expect(mockConfirmInboxEntry).toHaveBeenCalledTimes(1);
    const [, opts] = mockConfirmInboxEntry.mock.calls[0] as [InboxEntry, { editedFields?: Array<{ field: string; beforeValue?: string; afterValue?: string }> }];
    expect(opts?.editedFields).toEqual([
      { field: 'category', beforeValue: 'exp-food', afterValue: 'exp-drink' },
    ]);
  });

  it('InboxPage 分流略過（非交易 / 重複 / 這次不記）呼叫 skipInboxEntry 並移除項目', async () => {
    const entry = makeEntry({ item: { ...makeEntry().item, id: 202 } });
    mockLoadInbox.mockResolvedValue([entry]);

    const { default: InboxPage } = await import('@/features/inbox/InboxPage');
    await act(async () => {
      root!.render(React.createElement(MemoryRouter, null, React.createElement(InboxPage)));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    const skipToggle = findButton(host, '略過');
    expect(skipToggle).toBeTruthy();
    await act(async () => {
      skipToggle!.click();
    });

    const nonTxBtn = findButton(host, '非交易');
    const dupBtn = findButton(host, '重複');
    const ignoreBtn = findButton(host, '這次不記');
    expect(nonTxBtn).toBeTruthy();
    expect(dupBtn).toBeTruthy();
    expect(ignoreBtn).toBeTruthy();

    await act(async () => {
      nonTxBtn!.click();
    });
    expect(mockSkipInboxEntry).toHaveBeenCalledWith(expect.objectContaining({ item: expect.objectContaining({ id: 202 }) }), 'non_tx');
  });

  it('HomeInbox 顯示決策摘要與一鍵「以後這類都這樣」建立 shadow 規則', async () => {
    const entry = makeEntry({ item: { ...makeEntry().item, id: 303 } });
    mockLoadInbox.mockResolvedValue([entry]);

    const { default: HomeInbox } = await import('@/features/home/HomeInbox');
    await act(async () => {
      root!.render(React.createElement(MemoryRouter, null, React.createElement(HomeInbox)));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(host.textContent).toContain('信心 高');
    expect(host.textContent).toContain('星巴克');

    const scopeBtn = findButton(host, '以後這類都這樣');
    expect(scopeBtn).toBeTruthy();
    await act(async () => {
      scopeBtn!.click();
    });

    // Sheet mounts to document.body via portal
    expect(document.body.textContent).toContain('只此商家');
    expect(document.body.textContent).toContain('此卡＋此商家');
    expect(document.body.textContent).toContain('此來源');
    expect(document.body.textContent).toContain('此金額區間');

    const cardMerchantBtn = findButton(document.body, '此卡＋此商家');
    expect(cardMerchantBtn).toBeTruthy();
    await act(async () => {
      cardMerchantBtn!.click();
    });

    const createBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === '建立');
    expect(createBtn).toBeTruthy();
    await act(async () => {
      createBtn!.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    const rules = await db.rules.toArray();
    expect(rules.length).toBe(1);
    expect(rules[0].status).toBe('shadow');
    expect(rules[0].card).toBe('玉山 Unicard');
    expect(rules[0].merchantAlias).toBe('星巴克');
  });

  it('RulesPage 規則清單可顯示狀態與信心並手動升為啟用；可切換至規則模擬器（含 Dry-run）與規則健康', async () => {
    const now = Date.now();
    const today = todayKey();
    await db.rules.put({
      id: 'rule-shadow',
      keyword: '星巴克',
      match: 'contains',
      kind: 'expense',
      categoryId: 'exp-drink',
      accountId: 'acc-esun',
      priority: 50,
      enabled: true,
      hits: 0,
      status: 'shadow',
      stats: {
        shown: 3,
        autoBooked: 0,
        cleanAccepted: 2,
        editedCategory: 0,
        editedAccount: 0,
        editedAmount: 0,
        rejected: 0,
      },
      createdAt: now,
      updatedAt: now,
    });
    await db.rules.put({
      id: 'rule-active',
      keyword: '全聯',
      match: 'contains',
      kind: 'expense',
      categoryId: 'exp-food',
      priority: 50,
      enabled: true,
      hits: 2,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await db.transactions.put({
      id: 'tx-hist-1',
      type: 'expense',
      accountId: 'acc-cash',
      categoryId: 'exp-other_exp',
      amountMinor: 12000,
      currency: 'TWD',
      accountAmountMinor: 12000,
      baseAmountMinor: 12000,
      date: today,
      ts: now,
      note: '全聯福利中心',
      merchant: '全聯',
      tagIds: [],
      attachmentIds: [],
      createdAt: now,
      updatedAt: now,
    });
    await db.auto_decisions.put({
      id: 'dec-health-1',
      ts: now,
      source: 'notify',
      outcome: 'auto_booked',
      rawHash: 'abc',
      snippet: '全聯 120',
      matchedRuleId: 'rule-active',
      confidence: 0.9,
      confidenceLevel: 'high',
    });
    await db.feedback_signals.put({
      id: 'sig-health-1',
      ts: now,
      decisionId: 'dec-health-1',
      ruleId: 'rule-active',
      signalType: 'edit_field',
      field: 'category',
      weight: 1,
    });

    const { default: RulesPage } = await import('@/features/settings/RulesPage');
    await act(async () => {
      root!.render(React.createElement(MemoryRouter, null, React.createElement(RulesPage)));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    expect(host.textContent).toContain('觀察期');
    expect(host.textContent).toContain('啟用中');
    expect(host.textContent).toContain('信心');

    // Toggle shadow -> active
    const promoteBtn = findButton(host, '升為啟用');
    expect(promoteBtn).toBeTruthy();
    await act(async () => {
      promoteBtn!.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const promoted = await db.rules.get('rule-shadow');
    expect(promoted?.status).toBe('active');

    // Switch to 規則模擬器
    const simTab = findButton(host, '規則模擬器');
    expect(simTab).toBeTruthy();
    await act(async () => {
      simTab!.click();
    });

    const textInput = host.querySelector('input[placeholder*="全聯"]') as HTMLInputElement;
    expect(textInput).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(textInput, '於 全聯 消費 NT$200');
      textInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const runSimBtn = findButton(host, '執行模擬預覽');
    expect(runSimBtn).toBeTruthy();
    await act(async () => {
      runSimBtn!.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(host.querySelector('[data-testid="simulator-preview-result"]')?.textContent).toContain('餐飲');

    const dryRunBtn = findButton(host, '近 90 天歷史資料 Dry-run');
    expect(dryRunBtn).toBeTruthy();
    await act(async () => {
      dryRunBtn!.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    const dryText = host.querySelector('[data-testid="dryrun-result"]')?.textContent ?? '';
    expect(dryText).toContain('共掃描 1 筆近 90 天帳目，有 1 筆分類或帳戶會受影響');
    expect(dryText).toContain('其他支出 → 餐飲');

    // Verify dry-run is read-only
    const txAfter = await db.transactions.get('tx-hist-1');
    expect(txAfter?.categoryId).toBe('exp-other_exp');

    // Switch to 規則健康
    const healthTab = findButton(host, '規則健康');
    expect(healthTab).toBeTruthy();
    await act(async () => {
      healthTab!.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });

    expect(host.querySelector('[data-testid="north-star-card"]')?.textContent).toContain('未修正自動入帳率');
    expect(host.textContent).toContain('最常被改的規則');

    const healthTabEl = host.querySelector('[data-testid="rules-health-tab"]')!;
    const pauseBtn = findButton(healthTabEl, '暫停');
    expect(pauseBtn).toBeTruthy();
    await act(async () => {
      pauseBtn!.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const pausedRule = await db.rules.get('rule-active');
    expect(pausedRule?.status).toBe('paused');
    expect(pausedRule?.enabled).toBe(false);
  });
});
