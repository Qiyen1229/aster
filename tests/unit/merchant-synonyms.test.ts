import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { buildDefaultCategories } from '@/db/seed/categories';
import { SYNONYMS } from '@/domain/merchant-synonyms';
import { matchCategory } from '@/domain/nlp-entities';

describe('全行業 800+ 店家自動記帳詞庫', () => {
  const cats = buildDefaultCategories();

  it('內建店家與關鍵詞總數至少 800 筆以上', () => {
    const uniqueTerms = new Set<string>();
    for (const s of SYNONYMS) {
      for (const w of s.generic) uniqueTerms.add(w.toLowerCase());
      for (const w of s.specific ?? []) uniqueTerms.add(w.toLowerCase());
    }
    expect(uniqueTerms.size).toBeGreaterThanOrEqual(800);
  });

  it('正確對應使用者指定與各行業代表店家', () => {
    expect(matchCategory('蝦皮 390', cats, 'expense')?.category.id).toBe('exp-shopping-online');
    expect(matchCategory('ChatGPT Plus', cats, 'expense')?.category.id).toBe('exp-subscription-cloud');
    expect(matchCategory('Claude Pro', cats, 'expense')?.category.id).toBe('exp-subscription-cloud');
    expect(matchCategory('Gemini Advanced', cats, 'expense')?.category.id).toBe('exp-subscription-cloud');
    expect(matchCategory('購買股票', cats, 'expense')?.category.id).toBe('sys-stock-buy');
    expect(matchCategory('兒童新樂園', cats, 'expense')?.category.id).toBe('exp-entertainment');
    expect(matchCategory('六福村門票', cats, 'expense')?.category.id).toBe('exp-entertainment');
    expect(matchCategory('台電電費', cats, 'expense')?.category.id).toBe('exp-housing-utility');
    expect(matchCategory('所得稅申報', cats, 'expense')?.category.id).toBe('exp-tax-incometax');
    expect(matchCategory('sukiya 牛肉飯', cats, 'expense')?.category.id).toBe('exp-food-lunch');
    expect(matchCategory('World Gym 健身', cats, 'expense')?.category.id).toBe('exp-entertainment-sport');
    expect(matchCategory('大樹藥局', cats, 'expense')?.category.id).toBe('exp-medical-medicine');
    expect(matchCategory('長榮航空機票', cats, 'expense')?.category.id).toBe('exp-transport-flight');
  });

  it('短英文品牌不誤判長單字子字串（詞邊界保護）', () => {
    // 'cos' 不應誤配 'costco'（costco 應配到 食材）；'ok' 不應誤配 'booking'（booking 應配到 機票/旅遊）
    expect(matchCategory('costco 牛奶', cats, 'expense')?.category.id).toBe('exp-food-grocery');
    expect(matchCategory('booking 訂房', cats, 'expense')?.category.id).toBe('exp-transport-flight');
  });
});
