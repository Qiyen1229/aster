import { describe, expect, it } from 'vitest';
import { inboxPrefix4, matchesBlacklist, matchesWhitelist } from '@/services/inbox';

describe('收件匣滑動黑白名單前四字相符標準', () => {
  it('inboxPrefix4 自動擷取前 4 個字作為比對標準', () => {
    expect(inboxPrefix4({ card: '中國信託商業銀行', merchant: '全聯', text: '刷卡消費 200 元' })).toBe('中國信託');
    expect(inboxPrefix4({ card: '', merchant: '蝦皮購物商城', text: '付款成功' })).toBe('蝦皮購物');
    expect(inboxPrefix4({ card: 'LINE', merchant: '', text: '國泰世華銀行：刷卡通知 500 元' })).toBe('國泰世華');
    expect(inboxPrefix4({ card: '', merchant: '', text: 'ChatGPT Plus 訂閱扣款' })).toBe('Chat');
  });

  it('前 4 字加入白名單／黑名單後可自動相符後續同來源通知', () => {
    const prefix = inboxPrefix4({ card: '玉山銀行信用卡', merchant: '加油', text: '中油消費 130 元' });
    expect(prefix).toBe('玉山銀行');
    expect(matchesWhitelist({ card: '玉山銀行簽帳卡', merchant: '', text: '刷卡 100' }, [prefix])).toBe(true);
    expect(matchesBlacklist({ card: '玉山銀行信用卡', merchant: '', text: '刷卡 100' }, [prefix])).toBe(true);
  });
});
