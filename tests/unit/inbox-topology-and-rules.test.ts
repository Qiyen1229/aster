import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/schema';
import { buildDefaultCategories } from '@/db/seed/categories';
import { addAccount } from '@/db/repo/accounts';
import { extractPreferredNoticeAmount, previewAutoBook } from '@/services/inbox';
import { learnImplicitMapping } from '@/services/autocat';

describe('自動記帳進階規則與隱式學習（3–8）', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    await db.categories.bulkAdd(buildDefaultCategories());
  });

  it('規則優先抽取實付金額與雙幣別台幣實付，無法確定時才標記 ambiguous', () => {
    expect(extractPreferredNoticeAmount('消費 200 元，點數折抵 50 元，實付 150 元')).toEqual({
      amount: 150,
      currency: 'TWD',
      ambiguous: false,
    });
    expect(extractPreferredNoticeAmount('刷卡 USD 10.00（約台幣 320 元）')).toEqual({
      amount: 320,
      currency: 'TWD',
      ambiguous: false,
    });
    expect(extractPreferredNoticeAmount('消費 200 元，點數折抵 50 點')).toEqual({
      ambiguous: true,
    });
  });

  it('轉出文案含「入帳」字眼不反判為收入，且支援帳號末四碼轉出至自己帳戶、自動加值與扣繳卡費', async () => {
    const ctbc = await addAccount({
      name: '中國信託', type: 'bank', currency: 'TWD', initialBalanceMinor: 50000_00,
      icon: 'landmark', color: '#0ea5e9', includeInNetWorth: true, isLiability: false, last4: '7068',
    });
    const richart = await addAccount({
      name: '台新 Richart', type: 'bank', currency: 'TWD', initialBalanceMinor: 10000_00,
      icon: 'landmark', color: '#ef4444', includeInNetWorth: true, isLiability: false, last4: '12345',
    });
    const easycard = await addAccount({
      name: '悠遊卡', type: 'stored', currency: 'TWD', initialBalanceMinor: 500_00,
      icon: 'wallet', color: '#22c55e', includeInNetWorth: true, isLiability: false,
    });
    const card = await addAccount({
      name: '國泰 CUBE 卡', type: 'credit', currency: 'TWD', initialBalanceMinor: 0,
      icon: 'credit-card', color: '#10b981', includeInNetWorth: true, isLiability: true,
      credit: { limitMinor: 100000_00, statementDay: 20, dueDay: 5, autoPayAccountId: ctbc.id },
    });

    // 4. 轉出含「入帳」字眼：轉給陌生帳號應為支出而非收入
    const outToOther = await previewAutoBook('中國信託：您的轉帳 NT$1,000 已入帳至對方帳戶 *99999', '中國信託');
    expect(outToOther.drafts[0]?.kind).toBe('expense');

    // 3. 轉出至自己另一帳戶末碼 *12345 → 自動成立 transfer
    const selfTransfer = await previewAutoBook('中國信託轉出 NT$3,000 至帳號 *12345', '中國信託');
    expect(selfTransfer.drafts[0]?.kind).toBe('transfer');
    expect(selfTransfer.drafts[0]?.toAccountId).toBe(richart.id);

    // 6a. 悠遊卡自動加值 → transfer 到悠遊卡
    const topup = await previewAutoBook('悠遊卡自動加值 NT$500 成功', '中國信託');
    expect(topup.drafts[0]?.kind).toBe('transfer');
    expect(topup.drafts[0]?.toAccountId).toBe(easycard.id);

    // 6b. 扣繳信用卡費 → transfer 到信用卡
    const autopay = await previewAutoBook('已自中國信託扣繳國泰 CUBE 卡信用卡費 NT$12,000', '中國信託');
    expect(autopay.drafts[0]?.kind).toBe('transfer');
    expect(autopay.drafts[0]?.toAccountId).toBe(card.id);
  });

  it('隱式學習：收件匣編輯改名與指定分類後自動沉澱規則', async () => {
    const ok = await learnImplicitMapping({
      rawKeyword: 'ECPAY*UBER',
      note: 'Uber',
      categoryId: 'exp-transport',
      kind: 'expense',
    });
    expect(ok).toBe(true);
    const rules = await db.rules.toArray();
    expect(rules.some((r) => r.keyword === 'ECPAY*UBER' && r.renameNote === 'Uber' && r.categoryId === 'exp-transport')).toBe(true);
  });
});
