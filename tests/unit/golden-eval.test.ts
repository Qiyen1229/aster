import { describe, expect, it } from 'vitest';
import { normalizeMerchantAlias, type MerchantAliasOverride } from '@/domain/merchantAlias';
import {
  TEMPLATE_VERSION,
  detectTemplateDrift,
  parseSourceTemplate,
  type SourceId,
  type TemplateParseRecord,
} from '@/domain/sourceTemplates';
import { evaluateContextRules, type ContextRule } from '@/domain/contextRules';

interface GoldenSample {
  id: string;
  split: 'train' | 'eval';
  month: string;
  source: SourceId;
  rawText: string;
  travelProjectId?: string;
  expected: {
    matched: boolean;
    txAmount?: number;
    txCurrency?: string;
    originalAmount?: number;
    originalCurrency?: string;
    billingAmount?: number;
    billingCurrency?: string;
    balance?: number;
    creditLimit?: number;
    points?: number;
    fee?: number;
    refundStatus?: 'success' | 'pending' | 'cancelled' | 'none';
    kind?: 'expense' | 'income' | 'transfer';
    merchantAlias?: string;
    subContext?: string;
    categoryId?: string;
    accountId?: string;
    targetProjectId?: string;
    targetCurrency?: string;
  };
}

const GOLDEN_OVERRIDES: MerchantAliasOverride[] = [
  { rawKey: 'ECPAY*MOMO888123', alias: 'momo購物網' },
  { rawKey: '藍新*博客來數位', alias: '博客來' },
];

// Rules derived from the 'train' window (2026-03 ~ 2026-04), evaluated on held-out 'eval' window (2026-05)
const GOLDEN_RULES: ContextRule[] = [
  // Uber disambiguation: TRIP -> 車資, EATS -> 外食
  {
    id: 'r_uber_eats',
    status: 'active',
    merchantAlias: 'Uber',
    rawKeyword: 'EATS',
    categoryId: 'cat_food',
    priority: 10,
  },
  {
    id: 'r_uber_trip',
    status: 'active',
    merchantAlias: 'Uber',
    rawKeyword: 'TRIP',
    categoryId: 'cat_transport',
    priority: 10,
  },
  // Travel project vs daily mode for 7-ELEVEN
  {
    id: 'r_711_tokyo',
    status: 'active',
    merchantAlias: '7-ELEVEN',
    projectId: 'proj_tokyo',
    categoryId: 'cat_travel_food',
    targetProjectId: 'proj_tokyo',
    targetCurrency: 'JPY',
    accountId: 'acc_esun_unicard',
    priority: 5,
  },
  {
    id: 'r_711_daily_ctbc',
    status: 'active',
    merchantAlias: '7-ELEVEN',
    card: '中信LINE Pay卡',
    projectId: '',
    categoryId: 'cat_daily_food',
    targetCurrency: 'TWD',
    accountId: 'acc_ctbc_linepay',
    priority: 20,
  },
  {
    id: 'r_711_daily_cathay',
    status: 'active',
    merchantAlias: '7-ELEVEN',
    card: 'CUBE卡',
    projectId: '',
    categoryId: 'cat_daily_food',
    targetCurrency: 'TWD',
    accountId: 'acc_cathay_cube',
    priority: 20,
  },
  {
    id: 'r_711_daily_esun',
    status: 'active',
    merchantAlias: '7-ELEVEN',
    card: '玉山Unicard',
    projectId: '',
    categoryId: 'cat_daily_food',
    targetCurrency: 'TWD',
    accountId: 'acc_esun_unicard',
    priority: 20,
  },
  // Starbucks on different cards -> different accounts
  {
    id: 'r_starbucks_ctbc',
    status: 'active',
    merchantAlias: '星巴克',
    card: '中信LINE Pay卡',
    categoryId: 'cat_drink',
    accountId: 'acc_ctbc_linepay',
  },
  {
    id: 'r_starbucks_linepay',
    status: 'active',
    merchantAlias: '星巴克',
    source: 'linepay',
    categoryId: 'cat_drink',
    accountId: 'acc_linepay_wallet',
  },
  // Taishin @GoGo Shopee
  {
    id: 'r_shopee_taishin',
    status: 'active',
    merchantAlias: '蝦皮購物',
    card: '@GoGo卡',
    categoryId: 'cat_shopping',
    accountId: 'acc_taishin_gogo',
  },
  // 統一超商 -> daily food
  {
    id: 'r_px_cathay',
    status: 'active',
    merchantAlias: '全聯福利中心',
    card: 'CUBE卡',
    categoryId: 'cat_grocery',
    accountId: 'acc_cathay_cube',
  },
  // Shadow / Candidate / Paused / Retired rules (must never win auto-book!)
  {
    id: 'r_shadow_uber',
    status: 'shadow',
    merchantAlias: 'Uber',
    rawKeyword: 'EATS',
    categoryId: 'cat_shadow_delivery',
    priority: 1,
  },
  {
    id: 'r_candidate_711',
    status: 'candidate',
    merchantAlias: '7-ELEVEN',
    categoryId: 'cat_candidate_convenience',
    priority: 1,
  },
  {
    id: 'r_paused_starbucks',
    status: 'paused',
    merchantAlias: '星巴克',
    categoryId: 'cat_wrong_paused',
    priority: 1,
  },
  {
    id: 'r_retired_uber',
    status: 'retired',
    merchantAlias: 'Uber',
    categoryId: 'cat_wrong_retired',
    priority: 1,
  },
];

const GOLDEN_SAMPLES: GoldenSample[] = [
  // --- Eval Window (2026-05), split across all 6 sources ---
  {
    id: 'eval_ctbc_starbucks',
    split: 'eval',
    month: '2026-05',
    source: 'ctbc',
    rawText: '中國信託信用卡通知：您的中信LINE Pay卡(末四碼8899)於 2026/05/12 在 星巴克台北101門市 消費 NT$ 165，可用額度 NT$ 85,000。',
    expected: {
      matched: true,
      txAmount: 165,
      txCurrency: 'TWD',
      creditLimit: 85000,
      kind: 'expense',
      refundStatus: 'none',
      merchantAlias: '星巴克',
      categoryId: 'cat_drink',
      accountId: 'acc_ctbc_linepay',
    },
  },
  {
    id: 'eval_applepay_uber_eats',
    split: 'eval',
    month: '2026-05',
    source: 'applepay',
    rawText: 'Apple Pay 交易通知：於 UBER *EATS 消費 NT$ 285（中信LINE Pay卡 末四碼8899），授權日期 2026/05/13。',
    expected: {
      matched: true,
      txAmount: 285,
      txCurrency: 'TWD',
      kind: 'expense',
      refundStatus: 'none',
      merchantAlias: 'Uber',
      subContext: 'EATS',
      categoryId: 'cat_food',
    },
  },
  {
    id: 'eval_applepay_uber_trip',
    split: 'eval',
    month: '2026-05',
    source: 'applepay',
    rawText: 'Apple Pay 交易通知：於 UBER *TRIP 消費 NT$ 340（國泰CUBE卡 末四碼5566），授權日期 2026/05/14。',
    expected: {
      matched: true,
      txAmount: 340,
      txCurrency: 'TWD',
      kind: 'expense',
      refundStatus: 'none',
      merchantAlias: 'Uber',
      subContext: 'TRIP',
      categoryId: 'cat_transport',
    },
  },
  {
    id: 'eval_esun_711_daily',
    split: 'eval',
    month: '2026-05',
    source: 'esun',
    rawText: '玉山銀行信用卡消費通知：您的玉山Unicard(末四碼3344)於 2026/05/15 在 JKOPAY*7-ELEVEN 消費新台幣 89 元，剩餘額度 92,000 元。',
    expected: {
      matched: true,
      txAmount: 89,
      txCurrency: 'TWD',
      creditLimit: 92000,
      kind: 'expense',
      refundStatus: 'none',
      merchantAlias: '7-ELEVEN',
      categoryId: 'cat_daily_food',
      accountId: 'acc_esun_unicard',
      targetCurrency: 'TWD',
    },
  },
  {
    id: 'eval_esun_711_tokyo_travel',
    split: 'eval',
    month: '2026-05',
    source: 'esun',
    rawText: '玉山銀行信用卡消費通知：您的玉山Unicard(末四碼3344)於 2026/05/16 在 7-ELEVEN 消費 JPY 980，剩餘額度 91,000 元。',
    travelProjectId: 'proj_tokyo',
    expected: {
      matched: true,
      txAmount: 980,
      txCurrency: 'JPY',
      originalAmount: 980,
      originalCurrency: 'JPY',
      creditLimit: 91000,
      kind: 'expense',
      refundStatus: 'none',
      merchantAlias: '7-ELEVEN',
      categoryId: 'cat_travel_food',
      accountId: 'acc_esun_unicard',
      targetProjectId: 'proj_tokyo',
      targetCurrency: 'JPY',
    },
  },
  {
    id: 'eval_cathay_711_daily',
    split: 'eval',
    month: '2026-05',
    source: 'cathay',
    rawText: '國泰世華銀行消費通知：您的CUBE卡(尾號5566)於 2026/05/17 消費 NT$ 115，商店名稱：7-ELEVEN，小樹點 3 點，可用額度 NT$ 149,885。',
    expected: {
      matched: true,
      txAmount: 115,
      txCurrency: 'TWD',
      points: 3,
      creditLimit: 149885,
      kind: 'expense',
      refundStatus: 'none',
      merchantAlias: '7-ELEVEN',
      categoryId: 'cat_daily_food',
      accountId: 'acc_cathay_cube',
    },
  },
  {
    id: 'eval_cathay_pxmart',
    split: 'eval',
    month: '2026-05',
    source: 'cathay',
    rawText: '國泰世華銀行消費通知：您的CUBE卡(尾號5566)於 2026/05/18 消費 NT$ 640，商店名稱：全聯福利中心大安店，小樹點 19 點，可用額度 NT$ 149,245。',
    expected: {
      matched: true,
      txAmount: 640,
      txCurrency: 'TWD',
      points: 19,
      creditLimit: 149245,
      kind: 'expense',
      refundStatus: 'none',
      merchantAlias: '全聯福利中心',
      categoryId: 'cat_grocery',
      accountId: 'acc_cathay_cube',
    },
  },
  {
    id: 'eval_taishin_shopee',
    split: 'eval',
    month: '2026-05',
    source: 'taishin',
    rawText: '台新銀行消費通知：台新@GoGo卡末四碼 2211 於 2026/05/19 在 蝦皮購物 刷卡授權 NT$ 1,280，台新Point 38 點，可用額度 NT$ 78,720。',
    expected: {
      matched: true,
      txAmount: 1280,
      txCurrency: 'TWD',
      points: 38,
      creditLimit: 78720,
      kind: 'expense',
      refundStatus: 'none',
      merchantAlias: '蝦皮購物',
      categoryId: 'cat_shopping',
      accountId: 'acc_taishin_gogo',
    },
  },
  {
    id: 'eval_linepay_starbucks',
    split: 'eval',
    month: '2026-05',
    source: 'linepay',
    rawText: 'LINE Pay 付款完成：您於 街口*星巴克 付款 NT$ 155，使用 LINE POINTS 折抵 20 點，交易日期 2026/05/20。',
    expected: {
      matched: true,
      txAmount: 155,
      txCurrency: 'TWD',
      points: 20,
      kind: 'expense',
      refundStatus: 'none',
      merchantAlias: '星巴克',
      categoryId: 'cat_drink',
      accountId: 'acc_linepay_wallet',
    },
  },
  // Dual-currency (no 30x inflation!)
  {
    id: 'eval_ctbc_usd_dual_currency',
    split: 'eval',
    month: '2026-05',
    source: 'ctbc',
    rawText: '中國信託 LINE Pay 卡消費通知：卡號**8899 消費金額 USD 10.00 (折合新台幣約 NT$ 320)，特店：AMAZON，授權日期 2026/05/21，可用額度 NT$ 84,680。',
    expected: {
      matched: true,
      txAmount: 320,
      txCurrency: 'TWD',
      originalAmount: 10,
      originalCurrency: 'USD',
      billingAmount: 320,
      billingCurrency: 'TWD',
      creditLimit: 84680,
      kind: 'expense',
      refundStatus: 'none',
    },
  },
  // Bank transfer with fee & balance (must not confuse txAmount with fee or balance!)
  {
    id: 'eval_ctbc_transfer_fee_balance',
    split: 'eval',
    month: '2026-05',
    source: 'ctbc',
    rawText: '中國信託銀行通知：您的活存帳戶末四碼 4567 於 2026/05/22 跨行轉出 NT$ 5,000，手續費 NT$ 15，帳戶餘額 NT$ 120,000。',
    expected: {
      matched: true,
      txAmount: 5000,
      txCurrency: 'TWD',
      fee: 15,
      balance: 120000,
      kind: 'transfer',
      refundStatus: 'none',
    },
  },
  // Refund states: pending vs success vs cancelled
  {
    id: 'eval_ctbc_refund_pending',
    split: 'eval',
    month: '2026-05',
    source: 'ctbc',
    rawText: '中國信託通知：您申請的 統一時代百貨 退款申請處理中，金額 NT$ 1,200，將於3-5個工作天入帳。',
    expected: {
      matched: true,
      txAmount: 1200,
      txCurrency: 'TWD',
      refundStatus: 'pending',
      kind: undefined, // Must NOT book as income!
    },
  },
  {
    id: 'eval_ctbc_refund_success',
    split: 'eval',
    month: '2026-05',
    source: 'ctbc',
    rawText: '中國信託通知：您的 蝦皮購物 退款成功，已退款 NT$ 580 至卡號末四碼 8899。',
    expected: {
      matched: true,
      txAmount: 580,
      txCurrency: 'TWD',
      refundStatus: 'success',
      kind: 'income',
    },
  },
  {
    id: 'eval_ctbc_refund_cancelled',
    split: 'eval',
    month: '2026-05',
    source: 'ctbc',
    rawText: '中國信託通知：您的 Momo購物 退款取消，金額 NT$ 990。',
    expected: {
      matched: true,
      txAmount: 990,
      txCurrency: 'TWD',
      refundStatus: 'cancelled',
      kind: undefined, // Must NOT book as income!
    },
  },
];

describe('Wave 1B Pure Domain: MerchantAlias', () => {
  it('normalizes payment-gateway prefixes and noisy store codes while preserving rawText', () => {
    expect(normalizeMerchantAlias('ECPAY*UBER')).toMatchObject({
      alias: 'Uber',
      gateway: 'ECPAY',
      rawText: 'ECPAY*UBER',
      fromOverride: false,
    });
    expect(normalizeMerchantAlias('藍新*UBER')).toMatchObject({
      alias: 'Uber',
      gateway: '藍新',
      rawText: '藍新*UBER',
    });
    expect(normalizeMerchantAlias('街口*星巴克')).toMatchObject({
      alias: '星巴克',
      gateway: '街口',
      rawText: '街口*星巴克',
    });
    expect(normalizeMerchantAlias('LINEPAY*星巴克')).toMatchObject({
      alias: '星巴克',
      gateway: 'LINEPAY',
      rawText: 'LINEPAY*星巴克',
    });
    expect(normalizeMerchantAlias('JKOPAY*7-ELEVEN')).toMatchObject({
      alias: '7-ELEVEN',
      gateway: 'JKOPAY',
      rawText: 'JKOPAY*7-ELEVEN',
    });
    expect(normalizeMerchantAlias('統一超商台北市信義門市')).toMatchObject({
      alias: '統一超商',
      rawText: '統一超商台北市信義門市',
    });
    expect(normalizeMerchantAlias('統一超商(信義門市)')).toMatchObject({
      alias: '統一超商',
      rawText: '統一超商(信義門市)',
    });
    expect(normalizeMerchantAlias('全聯福利中心 新竹巨城店')).toMatchObject({
      alias: '全聯福利中心',
      rawText: '全聯福利中心 新竹巨城店',
    });
    expect(normalizeMerchantAlias('ECPAY*UBER *EATS #1234')).toMatchObject({
      alias: 'Uber',
      gateway: 'ECPAY',
      subContext: 'EATS',
    });
  });

  it('extracts subContext for UBER *TRIP vs UBER *EATS', () => {
    const trip = normalizeMerchantAlias('UBER *TRIP');
    expect(trip.alias).toBe('Uber');
    expect(trip.subContext).toBe('TRIP');
    expect(trip.rawText).toBe('UBER *TRIP');

    const eats = normalizeMerchantAlias('UBER *EATS');
    expect(eats.alias).toBe('Uber');
    expect(eats.subContext).toBe('EATS');
    expect(eats.rawText).toBe('UBER *EATS');
  });

  it('applies user-learned alias overrides', () => {
    const res1 = normalizeMerchantAlias('ECPAY*MOMO888123', GOLDEN_OVERRIDES);
    expect(res1.alias).toBe('momo購物網');
    expect(res1.fromOverride).toBe(true);
    expect(res1.rawText).toBe('ECPAY*MOMO888123');

    const res2 = normalizeMerchantAlias('藍新*博客來數位', GOLDEN_OVERRIDES);
    expect(res2.alias).toBe('博客來');
    expect(res2.fromOverride).toBe(true);

    const res3 = normalizeMerchantAlias('統一超商台北市信義門市', [
      { rawKey: '統一超商', alias: '7-ELEVEN' },
    ]);
    expect(res3.alias).toBe('7-ELEVEN');
    expect(res3.fromOverride).toBe(true);
  });
});

describe('Wave 1B Pure Domain: SourceTemplates & Drift Detection', () => {
  it('exposes versioned templates and rejects non-tx OTP notices', () => {
    expect(TEMPLATE_VERSION).toBe('1.0.0');
    const otp = parseSourceTemplate('中國信託網路銀行動態密碼 OTP 驗證碼：482910，請於 3 分鐘內輸入。');
    expect(otp.matched).toBe(false);
  });

  it('extracts txAmount separately from balance, creditLimit, points, fee, and refundStatus', () => {
    const transfer = parseSourceTemplate(
      '中國信託銀行通知：您的活存帳戶末四碼 4567 於 2026/05/22 跨行轉出 NT$ 5,000，手續費 NT$ 15，帳戶餘額 NT$ 120,000。',
    );
    expect(transfer.matched).toBe(true);
    expect(transfer.txAmount).toBe(5000);
    expect(transfer.fee).toBe(15);
    expect(transfer.balance).toBe(120000);
    expect(transfer.kind).toBe('transfer');

    const pending = parseSourceTemplate('中國信託通知：您申請的 統一時代百貨 退款申請，金額 NT$ 1,200。');
    expect(pending.refundStatus).toBe('pending');
    expect(pending.kind).toBeUndefined();

    const success = parseSourceTemplate('中國信託通知：您的 蝦皮購物 退款成功，已退款 NT$ 580。');
    expect(success.refundStatus).toBe('success');
    expect(success.kind).toBe('income');

    const cancelled = parseSourceTemplate('中國信託通知：您的 Momo購物 退款取消，金額 NT$ 990。');
    expect(cancelled.refundStatus).toBe('cancelled');
    expect(cancelled.kind).toBeUndefined();

    // Time HH:MM between date and 在, plus 紅利點數餘額
    const withTimeAndPointsBal = parseSourceTemplate(
      '中國信託LINE Pay卡消費通知：您於 2026/05/12 14:30 在 星巴克 消費 NT$ 165，紅利點數餘額 1,200 點。',
    );
    expect(withTimeAndPointsBal.matched).toBe(true);
    expect(withTimeAndPointsBal.merchant).toBe('星巴克');
    expect(withTimeAndPointsBal.txAmount).toBe(165);
    expect(withTimeAndPointsBal.points).toBe(1200);

    // TWD primary with (原幣 USD 10.00)
    const twdWithOrig = parseSourceTemplate(
      '中國信託消費通知：消費金額 NT$ 320 (原幣 USD 10.00)，特店：AMAZON。',
    );
    expect(twdWithOrig.txAmount).toBe(320);
    expect(twdWithOrig.txCurrency).toBe('TWD');
    expect(twdWithOrig.originalAmount).toBe(10);
    expect(twdWithOrig.originalCurrency).toBe('USD');

    // Incoming transfer deposit should be income, not transfer
    const incomingTransfer = parseSourceTemplate(
      '中國信託銀行通知：您的活存帳戶末四碼 4567 於 2026/05/22 轉帳存入 NT$ 10,000，帳戶餘額 NT$ 130,000。',
    );
    expect(incomingTransfer.matched).toBe(true);
    expect(incomingTransfer.txAmount).toBe(10000);
    expect(incomingTransfer.kind).toBe('income');
  });

  it('detects template drift on >= 3 consecutive failures or > 40% failure rate', () => {
    const healthy: TemplateParseRecord[] = [
      { templateId: 'ctbc', matched: true },
      { templateId: 'ctbc', matched: true },
      { templateId: 'ctbc', matched: false },
      { templateId: 'ctbc', matched: true },
      { templateId: 'ctbc', matched: true },
    ];
    expect(detectTemplateDrift(healthy).drifted).toBe(false);

    const threeConsecutive: TemplateParseRecord[] = [
      { templateId: 'esun', matched: true },
      { templateId: 'esun', matched: true },
      { templateId: 'esun', matched: false },
      { templateId: 'esun', matched: false },
      { templateId: 'esun', matched: false },
    ];
    const drift1 = detectTemplateDrift(threeConsecutive);
    expect(drift1.drifted).toBe(true);
    expect(drift1.consecutiveFailures).toBe(3);
    expect(drift1.reason).toContain('consecutive');

    const highRate: TemplateParseRecord[] = [
      { templateId: 'cathay', matched: false },
      { templateId: 'cathay', matched: true },
      { templateId: 'cathay', matched: false },
      { templateId: 'cathay', matched: true },
      { templateId: 'cathay', matched: false },
      { templateId: 'cathay', matched: true },
      { templateId: 'cathay', matched: false },
    ];
    const drift2 = detectTemplateDrift(highRate);
    expect(drift2.drifted).toBe(true);
    expect(drift2.recentFailureRate).toBeGreaterThan(0.4);

    // Mixed history filtered by templateId
    const mixed: TemplateParseRecord[] = [
      { templateId: 'ctbc', matched: true },
      { templateId: 'esun', matched: false },
      { templateId: 'ctbc', matched: true },
      { templateId: 'esun', matched: false },
      { templateId: 'ctbc', matched: true },
      { templateId: 'esun', matched: false },
    ];
    expect(detectTemplateDrift(mixed, { templateId: 'ctbc' }).drifted).toBe(false);
    expect(detectTemplateDrift(mixed, { templateId: 'esun' }).drifted).toBe(true);
  });
});

describe('Wave 1B Pure Domain: ContextRules', () => {
  it('skips paused/retired rules and keeps shadow/candidate in shadowPredictions only', () => {
    const res = evaluateContextRules(
      {
        source: 'applepay',
        card: '中信LINE Pay卡 (8899)',
        merchantAlias: 'Uber',
        rawText: 'UBER *EATS',
        amount: 285,
        currency: 'TWD',
        kind: 'expense',
      },
      GOLDEN_RULES,
    );

    expect(res.primary?.rule.id).toBe('r_uber_eats');
    expect(res.primary?.rule.categoryId).toBe('cat_food');
    expect(res.confidence).toBe('high');
    expect(res.shadowPredictions.some((s) => s.rule.id === 'r_shadow_uber')).toBe(true);
    expect(res.shadowPredictions.some((s) => s.rule.id === 'r_retired_uber')).toBe(false);
    expect(res.primary?.rule.status).toBe('active');
  });

  it('handles candidate-only matches without winning auto-book', () => {
    const res = evaluateContextRules(
      {
        source: 'unknown',
        merchantAlias: '7-ELEVEN',
        rawText: '7-ELEVEN',
        travelProjectId: 'proj_other',
      },
      GOLDEN_RULES,
    );
    expect(res.primary).toBeUndefined();
    expect(res.confidence).toBe('low');
    expect(res.shadowPredictions.map((p) => p.rule.id)).toContain('r_candidate_711');
  });

  it('supports amountMin/amountMax and downgrades confidence on close runner-up with different target', () => {
    const rules: ContextRule[] = [
      {
        id: 'r_high_amt',
        status: 'active',
        merchantAlias: '星巴克',
        card: 'CUBE卡',
        amountMin: 500,
        categoryId: 'cat_gift',
      },
      {
        id: 'r_normal_amt',
        status: 'active',
        merchantAlias: '星巴克',
        card: 'CUBE卡',
        amountMax: 499,
        categoryId: 'cat_drink',
      },
    ];
    const small = evaluateContextRules(
      { merchantAlias: '星巴克', card: 'CUBE卡', rawText: '星巴克', amount: 150 },
      rules,
    );
    expect(small.primary?.rule.id).toBe('r_normal_amt');
    expect(small.confidence).toBe('high');

    const closeRules: ContextRule[] = [
      {
        id: 'r_a',
        status: 'active',
        merchantAlias: '星巴克',
        card: 'CUBE卡',
        categoryId: 'cat_drink',
      },
      {
        id: 'r_b',
        status: 'active',
        merchantAlias: '星巴克',
        rawKeyword: '星巴克',
        categoryId: 'cat_snack',
      },
    ];
    const close = evaluateContextRules(
      { merchantAlias: '星巴克', card: 'CUBE卡', rawText: '星巴克' },
      closeRules,
    );
    expect(close.primary?.rule.id).toBe('r_a');
    expect(close.secondCandidate?.rule.id).toBe('r_b');
    expect(close.confidence).toBe('medium');
  });
});

describe('Golden Evaluation Suite (Held-out Eval Window, Zero Leakage)', () => {
  it('achieves high unedited auto-book accuracy, zero 30x currency inflation, and zero false-positive refund booking', () => {
    const evalSamples = GOLDEN_SAMPLES.filter((s) => s.split === 'eval');
    let autoBookEligible = 0;
    let autoBookExact = 0;
    let currencyInflationCount = 0;
    let falsePositiveRefundCount = 0;

    for (const sample of evalSamples) {
      const parsed = parseSourceTemplate(sample.rawText, {
        hintSource: sample.source,
        referenceYear: 2026,
      });

      expect(parsed.matched).toBe(sample.expected.matched);
      expect(parsed.templateId).toBe(sample.source);
      expect(parsed.txAmount).toBe(sample.expected.txAmount);
      expect(parsed.txCurrency).toBe(sample.expected.txCurrency);
      expect(parsed.refundStatus).toBe(sample.expected.refundStatus);
      expect(parsed.kind).toBe(sample.expected.kind);

      if (sample.expected.balance !== undefined) expect(parsed.balance).toBe(sample.expected.balance);
      if (sample.expected.creditLimit !== undefined) expect(parsed.creditLimit).toBe(sample.expected.creditLimit);
      if (sample.expected.points !== undefined) expect(parsed.points).toBe(sample.expected.points);
      if (sample.expected.fee !== undefined) expect(parsed.fee).toBe(sample.expected.fee);
      if (sample.expected.originalAmount !== undefined) {
        expect(parsed.originalAmount).toBe(sample.expected.originalAmount);
        expect(parsed.originalCurrency).toBe(sample.expected.originalCurrency);
      }

      // Check 30x currency inflation guard
      if (
        sample.expected.txAmount !== undefined &&
        parsed.txAmount !== undefined &&
        parsed.txAmount > sample.expected.txAmount * 5
      ) {
        currencyInflationCount++;
      }

      // Check false-positive refund booking guard
      if (
        (sample.expected.refundStatus === 'pending' || sample.expected.refundStatus === 'cancelled') &&
        parsed.kind === 'income'
      ) {
        falsePositiveRefundCount++;
      }

      const merchantNorm = normalizeMerchantAlias(parsed.merchant ?? '', GOLDEN_OVERRIDES);
      if (sample.expected.merchantAlias) {
        expect(merchantNorm.alias).toBe(sample.expected.merchantAlias);
      }
      if (sample.expected.subContext) {
        expect(merchantNorm.subContext).toBe(sample.expected.subContext);
      }

      if (sample.expected.categoryId || sample.expected.accountId) {
        autoBookEligible++;
        const ctxEval = evaluateContextRules(
          {
            source: parsed.templateId,
            card: parsed.card,
            merchantAlias: merchantNorm.alias,
            rawText: parsed.merchant ?? sample.rawText,
            amount: parsed.txAmount,
            currency: parsed.txCurrency,
            kind: parsed.kind,
            travelProjectId: sample.travelProjectId,
          },
          GOLDEN_RULES,
        );

        const primaryRule = ctxEval.primary?.rule;
        const catOk = !sample.expected.categoryId || primaryRule?.categoryId === sample.expected.categoryId;
        const accOk = !sample.expected.accountId || primaryRule?.accountId === sample.expected.accountId;
        const projOk = !sample.expected.targetProjectId || primaryRule?.targetProjectId === sample.expected.targetProjectId;
        const curOk = !sample.expected.targetCurrency || primaryRule?.targetCurrency === sample.expected.targetCurrency;

        if (catOk && accOk && projOk && curOk && ctxEval.confidence === 'high') {
          autoBookExact++;
        }
      }
    }

    const autoBookRate = autoBookEligible > 0 ? autoBookExact / autoBookEligible : 0;
    expect(currencyInflationCount).toBe(0);
    expect(falsePositiveRefundCount).toBe(0);
    expect(autoBookEligible).toBeGreaterThanOrEqual(8);
    expect(autoBookRate).toBeGreaterThanOrEqual(0.9);
  });
});
