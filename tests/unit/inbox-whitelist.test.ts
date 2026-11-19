/**
 * v4.1.39 自動記帳白名單：
 * - matchesWhitelist：名稱出現在商家或訊息裡就命中（不分大小寫、全半形正規化）
 * - judgeNotice：白名單優先放行（包含原本會被留審的 LINE 聊天）
 * - processInboxOnStartup：沒開全域自動入帳時，白名單發送者的通知仍直接記帳；其餘照舊留收件匣
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiState = vi.hoisted(() => ({ items: [] as unknown[], acked: [] as number[] }));
vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    api: vi.fn(async (path: string, opts?: { body?: unknown }) => {
      if (path === '/inbox/items') return apiState.items;
      if (path === '/inbox/items/booking') return { message: '已登記' };
      if (path === '/inbox/items/ack') {
        const ids = (opts?.body as { ids: number[] }).ids;
        apiState.acked.push(...ids);
        return { ids };
      }
      throw new Error(`未預期的 API 呼叫：${path}`);
    }),
  };
});

import { db } from '@/db/schema';
import { addAccount } from '@/db/repo/accounts';
import { judgeNotice, learnCard, matchesWhitelist, processInboxOnStartup, type InboxRaw } from '@/services/inbox';
import { useSettings } from '@/stores/settings';
import { DEFAULT_SETTINGS } from '@/db/repo/settings';

const n = (card: string, text: string, merchant = '') => ({ source: 'notify', card, text, merchant }) as Parameters<typeof judgeNotice>[0];

describe('白名單比對', () => {
  it('來源名稱完全相符才命中；不分大小寫、全半形，內文與商家不算來源', () => {
    expect(matchesWhitelist({ card: '中國信託', merchant: '', text: '刷卡消費 250 元' }, ['中國信託'])).toBe(true);
    expect(matchesWhitelist({ merchant: '玉山銀行', text: '消費 120 元' }, ['玉山銀行'])).toBe(false);
    expect(matchesWhitelist({ merchant: '', text: '【LINE Pay】付款成功' }, ['line pay'])).toBe(false);
    expect(matchesWhitelist({ card: 'ＬＩＮＥ Ｐａｙ', merchant: '', text: '付款' }, ['LINE Pay'])).toBe(true);
    expect(matchesWhitelist({ card: '全家', merchant: '全家', text: '消費 85 元' }, ['玉山'])).toBe(false);
  });
  it('空名單、空白項目不算命中', () => {
    expect(matchesWhitelist({ merchant: '玉山', text: '' }, [])).toBe(false);
    expect(matchesWhitelist({ merchant: '玉山', text: '' }, ['  '])).toBe(false);
  });
  it('learnCard 不會覆蓋使用者已手動設定的卡片對應帳戶', () => {
    useSettings.setState({ ...DEFAULT_SETTINGS, inbox: { ...DEFAULT_SETTINGS.inbox, cardMap: { 中國信託: 'acc-1' } } } as never);
    learnCard('中國信託', 'acc-2');
    expect(useSettings.getState().inbox.cardMap['中國信託']).toBe('acc-1');
    learnCard('玉山銀行', 'acc-2');
    expect(useSettings.getState().inbox.cardMap['玉山銀行']).toBe('acc-2');
  });
});

describe('通知把關：白名單優先', () => {
  it('LINE 聊天有金額：沒白名單留審；白名單命中就放行', () => {
    const chat = n('LINE', '小明\n晚餐 500 你先幫我付', '小明');
    expect(judgeNotice(chat, true).trust).toBe('review');
    expect(judgeNotice(chat, true, ['小明']).trust).toBe('ok');
    expect(judgeNotice(chat, true, ['別人']).trust).toBe('review');
  });
  it('白名單命中時，連沒金額的 LINE 聊天也不會被丟掉', () => {
    expect(judgeNotice(n('LINE', '小明\n今天好冷喔', '小明'), false).trust).toBe('drop');
    expect(judgeNotice(n('LINE', '小明\n今天好冷喔', '小明'), false, ['小明']).trust).toBe('ok');
  });
  it('官方通知與非 LINE 來源不受白名單影響', () => {
    expect(judgeNotice(n('LINE', 'LINE Pay\n您已於 全家 消費 NT$85，付款成功'), true).trust).toBe('ok');
    expect(judgeNotice(n('國泰世華', '刷卡 120 元'), true).trust).toBe('ok');
  });
});

describe('啟動自動入帳：白名單發送者不用開全域自動入帳', () => {
  let bank = '';
  const raw = (id: number, card: string, text: string, merchant = ''): InboxRaw =>
    ({ id, source: 'notify', text, amount: '', merchant, card, occurred: '', created_at: new Date().toISOString() });
  const setInbox = (autoBook: boolean, whitelist: string[]) => {
    const s = useSettings.getState();
    s.set('inbox', { ...s.inbox, autoBook, whitelist, defaultAccountId: bank });
  };

  beforeEach(async () => {
    await db.delete(); await db.open();
    apiState.items = []; apiState.acked = [];
    useSettings.setState({ ...DEFAULT_SETTINGS, baseCurrency: 'TWD', monthStartDay: 1 } as never);
    await db.categories.bulkAdd([{ id: 'exp-other', name: '其他', kind: 'expense', parentId: '', icon: '', color: '', sort: 0, archived: 0, createdAt: 1, updatedAt: 1 }] as never);
    bank = (await addAccount({ name: '台新', icon: '', color: '', type: 'bank', currency: 'TWD', initialBalanceMinor: 1_000_000, includeInNetWorth: true, isLiability: false })).id;
    apiState.items = [
      raw(1, '玉山銀行', '【玉山銀行】您於 全家 消費 120 元', '全家'),
      raw(2, '國泰世華', '【國泰世華】於 7-ELEVEN 消費 85 元', '7-ELEVEN'),
      raw(3, 'LINE', '小明\n晚餐 500 你先幫我付', '小明'),
      raw(4, '玉山銀行', '今天好冷喔'),
    ];
  });

  it('沒開自動入帳＋白名單「玉山銀行」：只有它的消費通知直接記帳', async () => {
    setInbox(false, ['玉山銀行']);
    const r = await processInboxOnStartup();
    expect(r).toMatchObject({ booked: 1, pending: 3 });
    const txs = await db.transactions.toArray();
    expect(txs).toHaveLength(1);
    expect(txs[0].amountMinor).toBe(12_000);
    expect((await db.accounts.get(bank))!.balanceMinor).toBe(1_000_000 - 12_000);
    expect(apiState.acked).toEqual([1]);
  });

  it('白名單加上 LINE 好友「小明」：聊天裡的金額也直接記（不再留審）', async () => {
    setInbox(false, ['玉山銀行', '小明']);
    const r = await processInboxOnStartup();
    expect(r).toMatchObject({ booked: 2, pending: 2 });
    expect((await db.transactions.toArray()).map((t) => t.amountMinor).sort((a, b) => a - b)).toEqual([12_000, 50_000]);
  });

  it('沒開自動入帳、也沒白名單：全部留收件匣', async () => {
    setInbox(false, []);
    const r = await processInboxOnStartup();
    expect(r).toMatchObject({ booked: 0, pending: 4 });
    expect(await db.transactions.count()).toBe(0);
  });

  it('開了全域自動入帳：照舊全部記（LINE 聊天仍留審）', async () => {
    setInbox(true, []);
    const r = await processInboxOnStartup();
    expect(r).toMatchObject({ booked: 2, pending: 2 });
  });

  it('白名單命中但看不懂金額：還是留收件匣', async () => {
    setInbox(false, ['玉山銀行']);
    apiState.items = [raw(4, '玉山銀行', '今天好冷喔')];
    const r = await processInboxOnStartup();
    expect(r).toMatchObject({ booked: 0, pending: 1 });
  });

  it('銀行／LINE 通知入帳 30,000（跨行轉入／存入／薪資入帳）保留 income 類型且避開餘額金額', async () => {
    const { draftsFromItem } = await import('@/services/inbox');
    const { parseContext } = await import('@/services/quickentry');
    const ctx = await parseContext();
    const mk = (text: string, card = '中國信託') => ({
      id: 99, source: 'notify' as const, text, amount: '', merchant: '', card, occurred: '', created_at: '2026-11-15T10:00:00',
    });

    const d1 = await draftsFromItem(mk('中國信託：跨行轉入 NT$30,000，跨行轉帳手續費 0 元，餘額 NT$85,000'), ctx, bank);
    expect(d1).toHaveLength(1);
    expect(d1[0].kind).toBe('income');
    expect(d1[0].amount).toBe(30000);

    const d2 = await draftsFromItem(mk('帳戶餘額 NT$85,000，本次存入 NT$30,000', 'LINE'), ctx, bank);
    expect(d2).toHaveLength(1);
    expect(d2[0].kind).toBe('income');
    expect(d2[0].amount).toBe(30000);

    const d3 = await draftsFromItem(mk('國泰世華 薪資入帳 45,000 元'), ctx, bank);
    expect(d3).toHaveLength(1);
    expect(d3[0].kind).toBe('income');
    expect(d3[0].amount).toBe(45000);

    const d4 = await draftsFromItem(mk('全聯消費 350 元，餘額 12,000 元'), ctx, bank);
    expect(d4).toHaveLength(1);
    expect(d4[0].kind).toBe('expense');
    expect(d4[0].amount).toBe(350);

    const ctxWithCathay = {
      ...ctx,
      accounts: [{ id: bank, name: '國泰世華', currency: 'TWD', type: 'bank' as const, aliases: ['國泰'] }],
    };
    const d5 = await draftsFromItem(mk('跨行轉入 國泰 30,000 元'), ctxWithCathay, bank);
    expect(d5).toHaveLength(1);
    expect(d5[0].kind).toBe('income');
    expect(d5[0].amount).toBe(30000);

    const d6 = await draftsFromItem(mk('【玉山銀行】跨行轉入通知，餘額：85,000元，本次金額：30,000元'), ctx, bank);
    expect(d6).toHaveLength(1);
    expect(d6[0].kind).toBe('income');
    expect(d6[0].amount).toBe(30000);
  });

  it('自訂自動改名與分類規則：比對原始通知／商家並覆寫名稱與類別', async () => {
    const { draftsFromItem } = await import('@/services/inbox');
    const { saveRule } = await import('@/services/autocat');
    const { parseContext } = await import('@/services/quickentry');
    await db.categories.add({ id: 'exp-dinner', name: '晚餐', kind: 'expense', parentId: '', icon: '', color: '', sort: 1, archived: 0, createdAt: 1, updatedAt: 1 } as never);
    await saveRule({
      keyword: '遠東百貨板橋分公司',
      match: 'contains',
      kind: 'expense',
      renameNote: '牛肉麵',
      categoryId: 'exp-dinner',
      priority: 10,
      enabled: true,
    });
    const ctx = await parseContext();
    const item = raw(10, 'LINE', '遠東百貨板橋分公司 : 回饋: 中信LINE Pay卡一般消費 180 元', '遠東百貨板橋分公司');
    const drafts = await draftsFromItem(item, ctx, bank);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].note).toBe('牛肉麵');
    expect(drafts[0].categoryId).toBe('exp-dinner');

    // 僅改名（不指定類別）：保留自動推斷的類別，但名稱改成自訂名稱
    await saveRule({
      keyword: '星巴克',
      match: 'contains',
      kind: 'expense',
      renameNote: '每日咖啡',
      categoryId: '',
      priority: 10,
      enabled: true,
    });
    const ctx2 = await parseContext();
    const item2 = raw(11, 'LINE', '星巴克消費 150 元', '星巴克');
    const drafts2 = await draftsFromItem(item2, ctx2, bank);
    expect(drafts2).toHaveLength(1);
    expect(drafts2[0].note).toBe('每日咖啡');
    expect(drafts2[0].categoryId).toBe('exp-other_exp');
  });

  it('Apple Pay 負數退款通知：kind 為 income 且金額保持正數，不倒扣餘額', async () => {
    const { draftsFromItem } = await import('@/services/inbox');
    const { parseContext } = await import('@/services/quickentry');
    const ctx = await parseContext();
    const refundItem: InboxRaw = {
      id: 12, source: 'applepay', text: 'Apple Store 退款', amount: '-120', merchant: 'Apple Store', card: '中信卡', occurred: '', created_at: new Date().toISOString(),
    };
    const drafts = await draftsFromItem(refundItem, ctx, bank);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].kind).toBe('income');
    expect(drafts[0].amount).toBe(120);
  });

  it('黑名單攔截與中英文連鎖店別名去重', async () => {
    const { shopSimilar } = await import('@/domain/dedupe');
    expect(shopSimilar('FamilyMart', '全家便利商店')).toBe(true);
    expect(shopSimilar('STARBUCKS', '星巴克')).toBe(true);
    expect(judgeNotice(n('LINE', '小明\n晚餐 500 你先幫我付', '小明'), true, ['小明'], ['小明']).trust).toBe('drop');
    expect(judgeNotice(n('中國信託', '停車折抵 100 元'), true, [], ['停車折抵']).trust).toBe('drop');
  });

  it('巧之味手工水餃不會被通知內文「管理費優惠」誤判為管理費，且可正確歸類餐飲', async () => {
    const { draftsFromItem } = await import('@/services/inbox');
    const { parseContext } = await import('@/services/quickentry');
    await db.categories.bulkPut([
      { id: 'exp-lunch', name: '午餐', kind: 'expense', parentId: 'exp-food', icon: '', color: '', sort: 1, archived: 0, createdAt: 1, updatedAt: 1 } as never,
      { id: 'exp-housing-mgmt', name: '管理費', kind: 'expense', parentId: 'exp-housing', icon: '', color: '', sort: 2, archived: 0, createdAt: 1, updatedAt: 1 } as never,
    ]);
    const ctx = await parseContext();
    const item = raw(20, 'LINE', 'LINE Pay 付款完成：巧之味手工水餃 NT$140（享免管理費優惠與帳號管理通知）', '巧之味手工水餃');
    const drafts = await draftsFromItem(item, ctx, bank);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].note).toBe('巧之味手工水餃');
    expect(drafts[0].categoryId).toBe('exp-lunch');
    expect(drafts[0].categoryId).not.toBe('exp-housing-mgmt');
  });

  it('商家記憶隔離：過去銀行通知含管理費，不會讓同銀行的新餐飲消費被記憶成管理費', async () => {
    const { draftsFromItem } = await import('@/services/inbox');
    const { parseContext } = await import('@/services/quickentry');
    await db.categories.bulkPut([
      { id: 'exp-lunch', name: '午餐', kind: 'expense', parentId: 'exp-food', icon: '', color: '', sort: 1, archived: 0, createdAt: 1, updatedAt: 1 } as never,
      { id: 'exp-housing-mgmt', name: '管理費', kind: 'expense', parentId: 'exp-housing', icon: '', color: '', sort: 2, archived: 0, createdAt: 1, updatedAt: 1 } as never,
    ]);
    await db.transactions.add({
      id: 'tx-prev-mgmt',
      type: 'expense',
      date: '2026-11-10',
      amountMinor: 250000,
      currency: 'TWD',
      accountId: bank,
      categoryId: 'exp-housing-mgmt',
      merchant: '社區大樓管理費',
      note: 'LINE Pay 通知 社區大樓管理費',
      tagIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as never);
    const ctx = await parseContext();
    const item = raw(21, 'LINE', 'LINE Pay 消費 160 元，於 阿明無名小店 付款（詳見管理費說明）', '阿明無名小店');
    const drafts = await draftsFromItem(item, ctx, bank);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].categoryId).not.toBe('exp-housing-mgmt');
  });

  it('邊界防呆：網路刷卡不誤判網路電信、全家人不誤判超商、其他分類不污染商家記憶', async () => {
    const { draftsFromItem } = await import('@/services/inbox');
    const { parseContext } = await import('@/services/quickentry');
    await db.categories.bulkPut([
      { id: 'exp-telecom', name: '網路電信', kind: 'expense', parentId: 'exp-housing', icon: '', color: '', sort: 1, archived: 0, createdAt: 1, updatedAt: 1 } as never,
      { id: 'exp-daily', name: '日用品', kind: 'expense', parentId: 'exp-life', icon: '', color: '', sort: 2, archived: 0, createdAt: 1, updatedAt: 1 } as never,
      { id: 'exp-lunch', name: '午餐', kind: 'expense', parentId: 'exp-food', icon: '', color: '', sort: 3, archived: 0, createdAt: 1, updatedAt: 1 } as never,
    ]);
    await db.transactions.add({
      id: 'tx-prev-other',
      type: 'expense',
      date: '2026-11-10',
      amountMinor: 14000,
      currency: 'TWD',
      accountId: bank,
      categoryId: 'exp-other_exp',
      merchant: '巧之味手工水餃',
      note: '巧之味手工水餃',
      tagIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as never);
    const ctx = await parseContext();

    // 1. 網路刷卡消費不應匹配網路電信
    const netDrafts = await draftsFromItem(raw(30, 'LINE', '【台新銀行】消費通知：網路刷卡 500 元，於 神秘小店 付款', '神秘小店'), ctx, bank);
    expect(netDrafts[0].categoryId).not.toBe('exp-telecom');

    // 2. 全家人吃飯不應匹配全家超商日用品，全家 85 則應匹配日用品
    const familyDrafts = await draftsFromItem(raw(31, 'LINE', '全家人吃飯 500 元', '全家人吃飯'), ctx, bank);
    expect(familyDrafts[0].categoryId).not.toBe('exp-daily');
    const fmDrafts = await draftsFromItem(raw(32, 'LINE', '於 全家 消費 85 元', '全家'), ctx, bank);
    expect(fmDrafts[0].categoryId).toBe('exp-daily');

    // 3. 過去誤歸「其他」的巧之味手工水餃，不會覆蓋新版水餃→午餐規則
    const dumplingDrafts = await draftsFromItem(raw(33, 'LINE', '巧之味手工水餃 140 元', '巧之味手工水餃'), ctx, bank);
    expect(dumplingDrafts[0].categoryId).toBe('exp-lunch');

    // 4. 通知含「收到您的付款／回饋點數將於次月入帳／退款須知」仍維持支出，不會翻成收入
    const expNotice = await draftsFromItem(
      raw(34, 'LINE', '已收到您的付款 NT$140，於 巧之味手工水餃 消費（點數回饋將於次月入帳，詳見退款須知）', '巧之味手工水餃'),
      ctx,
      bank,
    );
    expect(expNotice[0].kind).toBe('expense');

    // 5. 「台灣高鐵」「新光三越」「國泰醫院」不會被「台灣銀行」「新光銀行」「國泰銀行」簡稱截斷或誤認帳戶
    await db.accounts.add({ id: 'twbank', name: '台灣銀行', type: 'bank', currency: 'TWD', openingMinor: 0, sort: 9, archived: 0, createdAt: 1, updatedAt: 1 } as never);
    const ctxWithTw = await parseContext();
    const hsrDrafts = await draftsFromItem(raw(35, 'LINE', '於 台灣高鐵 消費 1,490 元', '台灣高鐵'), ctxWithTw, bank);
    expect(hsrDrafts[0].accountId).not.toBe('twbank');
    expect(hsrDrafts[0].note).toBe('台灣高鐵');
  });

  it('LINE錢包「中信Line Pay卡」正確對應中國信託，不會因 LINE錢包 撞名現金錢包或卡在 cardMap', async () => {
    const { draftsFromItem, learnCard } = await import('@/services/inbox');
    const { parseContext } = await import('@/services/quickentry');
    await db.accounts.bulkPut([
      { id: 'wallet-cash', name: '錢包', type: 'cash', currency: 'TWD', icon: '👛', color: '', initialBalanceMinor: 50000, balanceMinor: 50000, includeInNetWorth: true, isLiability: false, sort: 0, archived: 0, createdAt: 1, updatedAt: 1 },
      { id: 'ctbc-bank', name: '中國信託', type: 'bank', currency: 'TWD', icon: '🏦', color: '', initialBalanceMinor: 100000, balanceMinor: 100000, includeInNetWorth: true, isLiability: false, sort: 1, archived: 0, createdAt: 1, updatedAt: 1 },
    ]);
    // 模擬過去誤把 LINE錢包 學成 錢包，且預設帳戶設為 中國信託
    useSettings.setState({
      inbox: {
        ...useSettings.getState().inbox,
        defaultAccountId: 'ctbc-bank',
        whitelist: ['LINE錢包'],
        cardMap: { 'LINE錢包': 'wallet-cash' },
      },
    });
    const ctx = await parseContext();

    // 1. 統一超商：回饋：中信Line Pay卡一般（來源卡別 LINE錢包）→ 應精準歸戶到「中國信託」而非「錢包」
    const ctbcItem = raw(40, 'LINE錢包', 'LINE錢包\n統一超商：回饋：中信Line Pay卡一般 120 元', '統一超商');
    const ctbcDrafts = await draftsFromItem(ctbcItem, ctx, 'wallet-cash');
    expect(ctbcDrafts).toHaveLength(1);
    expect(ctbcDrafts[0].accountId).toBe('ctbc-bank');

    // learnCard 不應再把 LINE錢包 寫死到 cardMap
    learnCard('LINE錢包', 'wallet-cash');
    expect(useSettings.getState().inbox.cardMap['LINE錢包']).toBe('wallet-cash'); // 未覆蓋既有值，且無先前紀錄時不會新增
    learnCard('LINE Pay', 'wallet-cash');
    expect(useSettings.getState().inbox.cardMap['LINE Pay']).toBeUndefined();

    // 2. 沒提銀行名稱的 LINE錢包 通知 → 退回預設帳戶 中國信託，不被「LINE錢包」吸走成現金錢包
    const fallbackItem = raw(41, 'LINE錢包', 'LINE錢包\n於 無名小店 消費 80 元', '無名小店');
    const fallbackDrafts = await draftsFromItem(fallbackItem, ctx, 'wallet-cash');
    expect(fallbackDrafts[0].accountId).toBe('ctbc-bank');

    // 3. 語意防呆：中信房屋不誤判中國信託；用錢包付午餐仍正常命中現金錢包
    const houseDrafts = await draftsFromItem(raw(42, '簡訊', '中信房屋仲介服務費 500 元', '中信房屋'), ctx, 'wallet-cash');
    expect(houseDrafts[0].accountId).toBe('ctbc-bank'); // 注意預設帳戶也是 ctbc-bank，改檢查 findAccounts 直接結果
    const { findAccounts } = await import('@/domain/nlp');
    expect(findAccounts('中信房屋 500 元', ctx.accounts)).toEqual([]);
    expect(findAccounts('用錢包付午餐 100 元', ctx.accounts)[0]?.id).toBe('wallet-cash');
  });
});