import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/schema';
import { buildDefaultCategories } from '@/db/seed/categories';
import { addAccount } from '@/db/repo/accounts';
import { addTransaction } from '@/db/repo/ledger';
import { DEFAULT_SETTINGS } from '@/db/repo/settings';
import { saveRule } from '@/services/autocat';
import { findDuplicate } from '@/domain/dedupe';
import {
  ackInbox,
  bookInboxEntries,
  draftsFromItem,
  enrichAmbiguousInboxWithAi,
  extractPreferredNoticeAmount,
  getInboxSyncState,
  invalidateInboxReadOnly,
  loadInbox,
  markDuplicates,
  processInboxOnStartup,
  type InboxEntry,
  type InboxRaw,
} from '@/services/inbox';
import { parseContext } from '@/services/quickentry';
import { useInboxCount } from '@/services/inboxCount';
import { useSettings } from '@/stores/settings';

const mock = vi.hoisted(() => ({
  items: [] as InboxRaw[],
  fetchError: null as string | null,
  ackBatches: [] as number[][],
  failAckOnCall: 0,
  ackCallCount: 0,
  aiEnabled: false,
  aiDrafts: [] as Array<{ kind: 'expense' | 'income' | 'transfer'; amount: number; currency?: string; date: string; dateGiven: boolean; note: string; raw: string; categoryId?: string; accountId?: string }>,
}));

vi.mock('@/services/api', async (orig) => ({
  ...await orig<typeof import('@/services/api')>(),
  api: vi.fn(async (path: string, opts?: { body?: { ids?: number[] } }) => {
    if (path === '/inbox/items') {
      if (mock.fetchError) throw new Error(mock.fetchError);
      return structuredClone(mock.items);
    }
    if (path === '/inbox/items/booking') return { message: '已登記' };
    if (path === '/inbox/items/ack') {
      mock.ackCallCount++;
      const ids = opts?.body?.ids ?? [];
      mock.ackBatches.push(ids);
      if (mock.failAckOnCall > 0 && mock.ackCallCount >= mock.failAckOnCall) {
        throw new Error('chunk ack failed');
      }
      mock.items = mock.items.filter((i) => !ids.includes(i.id));
      return { ids };
    }
    throw new Error(`Unexpected API: ${path}`);
  }),
}));

vi.mock('@/services/ai', () => ({
  aiEnabledLocally: () => mock.aiEnabled,
  aiParseText: vi.fn(async () => ({ drafts: structuredClone(mock.aiDrafts) })),
}));

vi.mock('@/services/fx', async (orig) => ({
  ...await orig<typeof import('@/services/fx')>(),
  getRate: vi.fn(async () => null),
}));

const raw = (id: number, patch: Partial<InboxRaw> = {}): InboxRaw => ({
  id,
  source: 'notify',
  text: '',
  amount: '',
  merchant: '',
  card: '',
  occurred: '2026-11-18',
  created_at: '2026-11-18T08:00:00Z',
  ...patch,
});

let twdAccId = '';

beforeEach(async () => {
  await db.delete();
  await db.open();
  await db.categories.bulkAdd(buildDefaultCategories());
  invalidateInboxReadOnly();
  mock.items = [];
  mock.fetchError = null;
  mock.ackBatches = [];
  mock.failAckOnCall = 0;
  mock.ackCallCount = 0;
  mock.aiEnabled = false;
  mock.aiDrafts = [];
  useInboxCount.getState().set(0);
  useSettings.setState(structuredClone(DEFAULT_SETTINGS));
  twdAccId = (await addAccount({
    name: '國泰世華',
    type: 'bank',
    currency: 'TWD',
    icon: '',
    color: '',
    initialBalanceMinor: 100000,
    includeInNetWorth: true,
    isLiability: false,
  })).id;
  useSettings.setState({
    lastAccountId: twdAccId,
    inbox: { ...DEFAULT_SETTINGS.inbox, defaultAccountId: twdAccId },
  });
});

describe('Wave 2 Inbox integration', () => {
  it('Item 1: extractPreferredNoticeAmount 不誤判外幣實付為 TWD，且缺匯率標記為需確認', async () => {
    expect(extractPreferredNoticeAmount('實付 20 USD')).toEqual({ amount: 20, currency: 'USD', ambiguous: false });
    expect(extractPreferredNoticeAmount('實付 EUR 20')).toEqual({ amount: 20, currency: 'EUR', ambiguous: false });
    expect(extractPreferredNoticeAmount('實付 US$20')).toEqual({ amount: 20, currency: 'USD', ambiguous: false });
    expect(extractPreferredNoticeAmount('實付 $20 USD')).toEqual({ amount: 20, currency: 'USD', ambiguous: false });
    expect(extractPreferredNoticeAmount('實付 $20', 'USD')).toEqual({ amount: 20, currency: 'USD', ambiguous: false });
    expect(extractPreferredNoticeAmount('原價 $25 USD，實付 $20')).toEqual({ amount: 20, currency: 'USD', ambiguous: false });
    expect(extractPreferredNoticeAmount('實付 150 元')).toEqual({ amount: 150, currency: 'TWD', ambiguous: false });

    const ctx = await parseContext('2026-11-18');
    const drafts = await draftsFromItem(raw(1, { source: 'applepay', amount: '20', currency: 'USD', merchant: 'Steam' }), ctx, twdAccId);
    expect(drafts[0].currency).toBe('USD');
    const noticeWithCurrency = await draftsFromItem(raw(12, { source: 'notify', text: '消費成功，實付 $20', currency: 'USD', merchant: 'Steam' }), ctx, twdAccId);
    expect(noticeWithCurrency[0].currency).toBe('USD');

    mock.items = [raw(2, { source: 'applepay', amount: '20', currency: 'USD', merchant: 'Steam' })];
    useSettings.setState({ inbox: { ...DEFAULT_SETTINGS.inbox, autoBook: true, defaultAccountId: twdAccId } });
    const loaded = await loadInbox();
    expect(loaded[0].review).toContain('匯率');
    const startup = await processInboxOnStartup();
    expect(startup).toMatchObject({ booked: 0, pending: 1 });
  });

  it('Item 3: Email 來源在 merchant 為空時擷取商家並掃描 text+card 匹配帳戶', async () => {
    const esunId = (await addAccount({
      name: '玉山銀行',
      type: 'credit',
      currency: 'TWD',
      icon: '',
      color: '',
      initialBalanceMinor: 0,
      includeInNetWorth: true,
      isLiability: true,
    })).id;
    const ctx = await parseContext('2026-11-18');
    const drafts = await draftsFromItem(
      raw(3, {
        source: 'email',
        card: '銀行通知',
        merchant: '',
        text: '您使用玉山銀行信用卡於 全家 消費 NT$120',
      }),
      ctx,
      twdAccId,
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0].note).toBe('全家');
    expect(drafts[0].accountId).toBe(esunId);
  });

  it('Item 4: ambiguous 項目無 AI 時留在待確認；有 AI 時覆寫金額/幣別/類型/日期並遵守使用者規則', async () => {
    mock.items = [raw(10, { text: '消費 200 元，點數折抵 50 點', merchant: '全家', card: '國泰世華' })];
    useSettings.setState({ inbox: { ...DEFAULT_SETTINGS.inbox, autoBook: true, defaultAccountId: twdAccId } });

    // 無 AI：不可自動入帳成 200
    const noAi = await processInboxOnStartup();
    expect(noAi).toMatchObject({ booked: 0, pending: 1 });
    expect(await db.transactions.count()).toBe(0);

    // 設一條高優先分類規則 + cardMap，並啟用 AI 回傳實付 150
    const esunId = (await addAccount({
      name: '玉山銀行',
      type: 'credit',
      currency: 'TWD',
      icon: '',
      color: '',
      initialBalanceMinor: 0,
      includeInNetWorth: true,
      isLiability: true,
    })).id;
    await saveRule({
      keyword: '全家',
      match: 'contains',
      kind: 'expense',
      categoryId: 'exp-food',
      enabled: true,
      priority: 10,
    });
    useSettings.setState({
      inbox: {
        ...DEFAULT_SETTINGS.inbox,
        autoBook: true,
        defaultAccountId: twdAccId,
        cardMap: { 國泰世華: esunId },
      },
    });
    mock.aiEnabled = true;
    mock.aiDrafts = [{
      kind: 'expense',
      amount: 150,
      currency: 'TWD',
      date: '2026-11-17',
      dateGiven: true,
      note: '全家',
      raw: '全家 150',
      categoryId: 'exp-other_exp',
    }];

    const withAi = await processInboxOnStartup();
    expect(withAi).toMatchObject({ booked: 1, pending: 0 });
    const txs = await db.transactions.toArray();
    expect(txs).toHaveLength(1);
    expect(txs[0].amountMinor).toBe(15000);
    expect(txs[0].date).toBe('2026-11-17');
    expect(txs[0].categoryId).toBe('exp-food');
    expect(txs[0].accountId).toBe(esunId);

    // AI 回傳無效金額時維持 review，不自動入帳
    mock.items = [raw(11, { text: '消費 200 元，點數折抵 50 點', merchant: '全家' })];
    mock.aiDrafts = [{ kind: 'expense', amount: 0, date: '2026-11-18', dateGiven: true, note: '全家', raw: '' }];
    const entry: InboxEntry = {
      item: mock.items[0],
      drafts: await draftsFromItem(mock.items[0], await parseContext('2026-11-18'), twdAccId),
      ambiguous: true,
    };
    await enrichAmbiguousInboxWithAi([entry]);
    expect(entry.ambiguous).toBe(true);
    expect(entry.review).toBeTruthy();
  });

  it('Item 5: 同來源同日兩筆消費不誤判 strong 重複；inbox weak 不會蓋過 ledger strong', async () => {
    // findDuplicate 同來源不同時間不算 strong
    expect(findDuplicate(
      { date: '2026-11-18', amountMinor: 15000, currency: 'TWD', accountId: twdAccId, text: '星巴克', source: 'applepay', eventAt: Date.parse('2026-11-18T15:00:00Z') },
      [{ id: '1', date: '2026-11-18', amountMinor: 15000, currency: 'TWD', accountId: twdAccId, text: '星巴克', source: 'applepay', eventAt: Date.parse('2026-11-18T09:00:00Z') }],
    )?.level).toBe('weak');

    // 同日兩筆同來源不同時間（含斜線格式 occurred）→ markDuplicates 不標為重複、可全部自動入帳
    mock.items = [
      raw(20, { source: 'applepay', amount: '150', merchant: '星巴克', occurred: '2026/11/18 09:00', created_at: '2026-11-18T01:00:00Z' }),
      raw(21, { source: 'applepay', amount: '150', merchant: '星巴克', occurred: '2026/11/18 15:00', created_at: '2026-11-18T07:00:00Z' }),
    ];
    useSettings.setState({ inbox: { ...DEFAULT_SETTINGS.inbox, autoBook: true, defaultAccountId: twdAccId } });
    const r = await processInboxOnStartup();
    expect(r).toMatchObject({ booked: 2, pending: 0 });

    // inboxHit (weak) vs ledgerHit (strong)：不應因 continue 而漏掉 ledger strong
    await db.transactions.clear();
    const tx = await addTransaction({
      type: 'expense',
      accountId: twdAccId,
      categoryId: 'exp-food',
      amountMinor: 15000,
      currency: 'TWD',
      date: '2026-11-18',
      ts: 1,
      note: '星巴克',
      merchant: '星巴克',
    });
    const ctx = await parseContext('2026-11-18');
    const e1: InboxEntry = { item: raw(30, { source: 'sms', text: '不同店 150', merchant: '不同店' }), drafts: await draftsFromItem(raw(30, { source: 'sms', text: '不同店 150', merchant: '不同店' }), ctx, twdAccId) };
    const e2: InboxEntry = { item: raw(31, { source: 'applepay', amount: '150', merchant: '星巴克' }), drafts: await draftsFromItem(raw(31, { source: 'applepay', amount: '150', merchant: '星巴克' }), ctx, twdAccId) };
    await markDuplicates([e1, e2], '2026-11-18');
    expect(e2.dup).toMatchObject({ from: 'ledger', txId: tx.id, level: 'strong' });
  });

  it('Item 6: 空白金額 applepay 項目保留在待確認 (review)，不被丟棄', async () => {
    mock.items = [raw(40, { source: 'applepay', amount: '', text: '', merchant: '', card: '中國信託' })];
    useSettings.setState({ inbox: { ...DEFAULT_SETTINGS.inbox, autoBook: true, whitelist: ['中國信託'] } });
    const entries = await loadInbox();
    expect(entries).toHaveLength(1);
    expect(entries[0].review).toBeTruthy();
    const startup = await processInboxOnStartup();
    expect(startup).toMatchObject({ booked: 0, pending: 1 });
  });

  it('Item 8: ackInbox 分批上限 200 筆、部分失敗保留已成功進度，且持久化 sync state', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => i + 1);
    useInboxCount.getState().set(250);
    mock.failAckOnCall = 2; // 第 1 批 200 筆成功，第 2 批 50 筆失敗
    let caught: (Error & { ackedIds?: number[] }) | null = null;
    try {
      await ackInbox(ids);
    } catch (e) {
      caught = e as Error & { ackedIds?: number[] };
    }
    expect(caught).toBeTruthy();
    expect(mock.ackBatches.map((b) => b.length)).toEqual([200, 50]);
    expect(caught?.ackedIds).toHaveLength(200);
    expect(useInboxCount.getState().n).toBe(50);

    // alreadyBooked 且已 ack 過的項目不會再次送出 ack
    mock.failAckOnCall = 0;
    mock.ackBatches = [];
    const ctx = await parseContext('2026-11-18');
    const item = raw(50, { source: 'applepay', amount: '99', merchant: '早餐' });
    const entry: InboxEntry = { item, drafts: await draftsFromItem(item, ctx, twdAccId) };
    await bookInboxEntries([entry]);
    expect(mock.ackBatches).toEqual([[50]]);
    mock.ackBatches = [];
    const second = await bookInboxEntries([entry]);
    expect(second).toMatchObject({ count: 0, alreadyBooked: 1, ackPending: 0 });
    expect(mock.ackBatches).toEqual([]);

    // sync state 持久化
    mock.fetchError = '網路離線';
    await expect(loadInbox()).rejects.toThrow('網路離線');
    expect((await getInboxSyncState()).lastError).toBe('網路離線');
    mock.fetchError = null;
    await loadInbox();
    const okState = await getInboxSyncState();
    expect(okState.lastError).toBeNull();
    expect(typeof okState.lastSyncAt).toBe('number');
  });

  it('Item 8b: agent applyPlan 認領 >200 筆收件匣項目部分失敗時，只保留尚未認領的 pendingInboxIds', async () => {
    const { applyPlan, loadAgentData } = await import('@/services/agent');
    const ctx = await parseContext('2026-11-18');
    const entries = await Promise.all(
      Array.from({ length: 205 }, async (_, i) => {
        const item = raw(1000 + i, { source: 'applepay', amount: '10', merchant: `Shop${i}` });
        return { item, drafts: await draftsFromItem(item, ctx, twdAccId) };
      }),
    );
    const data = await loadAgentData();
    mock.failAckOnCall = 2; // 200 筆成功，5 筆失敗
    const log = await applyPlan(
      [{
        op: { kind: 'inbox', action: 'book', entries },
        preview: { title: '批次入帳', detail: '', impact: '', blocked: false },
        snapshot: data.snapshot,
      }] as never,
      '批次入帳 205 筆',
      'wave2-agent-205',
    );
    expect(mock.ackBatches.map((b) => b.length)).toEqual([200, 5]);
    expect(log.pendingInboxIds).toHaveLength(5);
    expect(log.warnings?.[0]).toContain('5 筆通知尚未清除');
  });
});
