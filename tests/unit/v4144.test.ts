// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/schema';
import { findAccounts } from '@/domain/nlp-entities';
import { saveRule, invalidateAutocat } from '@/services/autocat';
import { draftsFromItem, bookInboxEntries, learnCard, type InboxRaw } from '@/services/inbox';
import { parseContext } from '@/services/quickentry';
import { useSettings } from '@/stores/settings';
import { installViewportTracking } from '@/app/viewport';

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    api: vi.fn(async (_path: string, opts?: { body?: { ids?: number[] } }) => ({
      ids: opts?.body?.ids ?? [],
    })),
  };
});

describe('v4.1.44 修復驗證', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    invalidateAutocat();
    useSettings.setState({
      inbox: {
        autoBook: true,
        defaultAccountId: 'ctbc',
        cardMap: {},
        forecast: true,
        whitelist: ['中國信託', 'LINE Pay'],
      },
    });
  });

  it('findAccounts：Line Money 不會被通用詞 LINE / Pay / online 誤判，但完整名稱與 Richart / CUBE 仍可比對', () => {
    const accounts = [
      { id: 'lm', name: 'Line Money', type: 'bank' },
      { id: 'ctbc', name: '中國信託', type: 'bank' },
      { id: 'taishin', name: '台新 Richart', type: 'bank' },
      { id: 'cube', name: '國泰 CUBE 卡', type: 'credit' },
    ];
    expect(findAccounts('LINE Pay 遠東百貨消費 NT$178', accounts)).toEqual([]);
    expect(findAccounts('LINE 通知 online shopping 178', accounts)).toEqual([]);
    expect(findAccounts('Line Money 轉帳 500', accounts).map((x) => x.id)).toEqual(['lm']);
    expect(findAccounts('Richart 500', accounts).map((x) => x.id)).toEqual(['taishin']);
    expect(findAccounts('CUBE 500', accounts).map((x) => x.id)).toEqual(['cube']);
  });

  it('自動記帳：規則「指定帳戶」優先於通知文字／卡片推測，且不會因 default／LINE 聊天通知污染 cardMap', async () => {
    const now = Date.now();
    await db.accounts.bulkPut([
      { id: 'lm', name: 'Line Money', type: 'bank', currency: 'TWD', icon: 'bank', color: '#00c300', initialBalanceMinor: 0, balanceMinor: 0, isLiability: false, includeInNetWorth: true, sort: 1, archived: 0, createdAt: now, updatedAt: now },
      { id: 'ctbc', name: '中國信託', type: 'bank', currency: 'TWD', icon: 'bank', color: '#007aff', initialBalanceMinor: 0, balanceMinor: 0, isLiability: false, includeInNetWorth: true, sort: 2, archived: 0, createdAt: now, updatedAt: now },
    ]);
    await db.categories.put({
      id: 'exp-dinner', name: '晚餐', kind: 'expense', icon: 'utensils', color: '#ff9500', parentId: '', sort: 1, archived: 0, createdAt: now, updatedAt: now,
    });
    await saveRule({
      keyword: '遠東百貨',
      match: 'contains',
      kind: 'expense',
      renameNote: '牛肉麵',
      categoryId: 'exp-dinner',
      accountId: 'ctbc',
      priority: 0,
      enabled: true,
    });

    // 即使 cardMap 曾誤學過 LINE Pay -> lm，規則指定帳戶 ctbc 仍必須勝出
    useSettings.setState((s) => ({
      inbox: { ...s.inbox, cardMap: { 'LINE Pay': 'lm' } },
    }));

    const ctx = await parseContext('2026-11-16');
    const item: InboxRaw = {
      id: 101,
      source: 'notify',
      text: 'LINE Pay 通知：您於遠東百貨消費 NT$178，使用 Line Money 付款',
      amount: '',
      merchant: '',
      card: 'LINE Pay',
      occurred: '2026-11-16 12:30',
      created_at: '2026-11-16T04:30:00Z',
    };
    const drafts = await draftsFromItem(item, ctx, 'ctbc');
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      note: '牛肉麵',
      categoryId: 'exp-dinner',
      accountId: 'ctbc',
      accountSource: 'rule',
    });

    // 即使舊版曾誤學 cardMap['LINE'] -> lm，LINE 聊天通知也不應採用該對應，且 learnCard 不應寫入 LINE
    useSettings.setState((s) => ({
      inbox: { ...s.inbox, cardMap: { LINE: 'lm' } },
    }));
    const item2: InboxRaw = {
      id: 102,
      source: 'notify',
      text: '您於 7-ELEVEN 消費 NT$55',
      amount: '',
      merchant: '7-ELEVEN',
      card: 'LINE',
      occurred: '2026-11-16 13:00',
      created_at: '2026-11-16T05:00:00Z',
    };
    const drafts2 = await draftsFromItem(item2, ctx, 'ctbc');
    expect(drafts2[0]).toMatchObject({ accountId: 'ctbc', accountSource: 'default' });
    await bookInboxEntries([{ item: item2, drafts: drafts2 }]);
    learnCard('LINE', 'lm');
    expect(useSettings.getState().inbox.cardMap).toEqual({ LINE: 'lm' });
  });

  it('viewport：iOS visualViewport offsetTop 偏移時仍維持 kb-open 並正確計算 --kb 與 --vvt', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 852 });
    const listeners = new Map<string, () => void>();
    const vv = {
      height: 500,
      offsetTop: 250,
      addEventListener: (ev: string, fn: () => void) => listeners.set(ev, fn),
      removeEventListener: (ev: string) => listeners.delete(ev),
    };
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });

    const cleanup = installViewportTracking();
    const root = document.documentElement;
    expect(root.classList.contains('kb-open')).toBe(true);
    expect(root.style.getPropertyValue('--kb')).toBe('102px');
    expect(root.style.getPropertyValue('--vvh')).toBe('500px');
    expect(root.style.getPropertyValue('--vvt')).toBe('250px');

    cleanup();
    input.remove();
  });
});
