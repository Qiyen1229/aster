/**
 * Gmail Email 自動轉寄 4 步驟設定抽屜（Cloudflare Email Routing Webhook）：
 * 步驟 1：輸入你的 Gmail → 產生專屬轉寄地址（in-<token>@qiyen.me）
 * 步驟 2：驗證轉寄地址 → 每 3 秒輪詢等待 Gmail 驗證信，收到後顯示驗證連結與 9 位數確認碼
 * 步驟 3：設定 Gmail 篩選器 → 一鍵複製台灣常見銀行／行動支付關鍵字條件
 * 步驟 4：測試通知與完成 → 偵測入信次數／最後接收時間更新即顯示「已連線」
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getEmailForwardBinding,
  markEmailForwardVerified,
  removeEmailForward,
  setupEmailForward,
  type EmailForwardBinding,
} from '@/services/inbox';
import { ask, useUI } from '@/stores/ui';
import { Sheet } from '@/ui/Sheet';

export const GMAIL_FILTER_TEMPLATE =
  '消費 OR 刷卡 OR 扣款 OR 付款 OR 入帳 OR 轉帳 OR 交易通知 OR LINE Pay OR 街口 OR 悠遊付 OR 國泰世華 OR 中國信託 OR 玉山 OR 台新 OR 富邦 OR 永豐';

export interface EmailForwardSheetProps {
  open: boolean;
  onClose: () => void;
  binding?: EmailForwardBinding | null;
  onUpdated?: (binding: EmailForwardBinding | null) => void;
}

const snack = (text: string) => useUI.getState().showSnack({ text });

async function copyText(value: string, label: string) {
  try {
    await navigator.clipboard.writeText(value);
    snack(`已複製${label}`);
  } catch {
    snack('無法複製，請長按文字自行選取');
  }
}

function formatLocalTime(raw: string): string {
  const normalized = /[Zz]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw}Z`;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? raw : d.toLocaleString('zh-TW');
}

function initialStepFor(b: EmailForwardBinding | null): 1 | 2 | 3 | 4 {
  if (!b) return 1;
  if (b.received_count > 0 || b.last_received_at) return 4;
  if (b.status === 'verified') return 3;
  return 2;
}

export function EmailForwardSheet({ open, onClose, binding: externalBinding, onUpdated }: EmailForwardSheetProps) {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [binding, setBinding] = useState<EmailForwardBinding | null>(externalBinding ?? null);
  const [sourceEmail, setSourceEmail] = useState(externalBinding?.source_email ?? '');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const wasOpenRef = useRef(false);

  const syncBinding = useCallback((next: EmailForwardBinding | null) => {
    setBinding(next);
    if (next) setSourceEmail(next.source_email);
    onUpdated?.(next);
  }, [onUpdated]);

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    setError('');
    if (externalBinding !== undefined) {
      setBinding(externalBinding);
      setSourceEmail(externalBinding?.source_email ?? '');
      setStep(initialStepFor(externalBinding));
      return;
    }
    let alive = true;
    void getEmailForwardBinding().then((res) => {
      if (!alive) return;
      syncBinding(res);
      setStep(initialStepFor(res));
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [open, externalBinding, syncBinding]);

  const pollNow = useCallback(async () => {
    setChecking(true);
    try {
      const latest = await getEmailForwardBinding();
      syncBinding(latest);
    } catch {
      /* 輪詢失敗不打擾使用者 */
    } finally {
      setChecking(false);
    }
  }, [syncBinding]);

  // 步驟 2（等待 Gmail 驗證信）與步驟 4（等待首封測試通知）每 3 秒自動輪詢
  const shouldPollStep2 = open && step === 2 && !!binding && !binding.verify_received_at && !binding.verify_url && !binding.verify_code;
  const shouldPollStep4 = open && step === 4 && !!binding && binding.received_count === 0 && !binding.last_received_at;

  useEffect(() => {
    if (!shouldPollStep2 && !shouldPollStep4) return;
    const timer = setInterval(() => {
      void pollNow();
    }, 3000);
    return () => clearInterval(timer);
  }, [shouldPollStep2, shouldPollStep4, pollNow]);

  const handleSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = sourceEmail.trim();
    if (!trimmed) {
      setError('請輸入你的 Gmail 信箱');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const next = await setupEmailForward(trimmed);
      syncBinding(next);
      setStep(2);
    } catch (err) {
      setError((err as Error).message || '建立轉寄位址失敗');
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmVerified = async () => {
    if (!binding) return;
    setBusy(true);
    setError('');
    try {
      const next = binding.status === 'verified' ? binding : await markEmailForwardVerified();
      syncBinding(next);
      setStep(3);
    } catch (err) {
      setError((err as Error).message || '更新驗證狀態失敗');
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async () => {
    if (!binding) return;
    if (!await ask('移除這個 Email？專屬轉寄地址會立即失效，之後不會再接收轉寄通知。')) return;
    setBusy(true);
    setError('');
    try {
      await removeEmailForward();
      syncBinding(null);
      setSourceEmail('');
      setStep(1);
      snack('已移除 Email 自動轉寄設定');
    } catch (err) {
      setError((err as Error).message || '移除失敗');
    } finally {
      setBusy(false);
    }
  };

  const hasVerification = Boolean(binding?.verify_received_at || binding?.verify_url || binding?.verify_code);
  const isConnected = Boolean(binding && (binding.received_count > 0 || binding.last_received_at));

  return (
    <Sheet open={open} onClose={onClose} title="Email 自動轉寄（Gmail）">
      <div className="wiz-stepper" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }} role="tablist" aria-label="設定步驟">
        {([
          [1, '1. 輸入 Gmail'],
          [2, '2. 驗證地址'],
          [3, '3. 篩選器'],
          [4, '4. 測試完成'],
        ] as const).map(([n, label]) => {
          const disabled = n > 1 && !binding;
          const done = (n === 1 && !!binding)
            || (n === 2 && binding?.status === 'verified')
            || (n === 3 && isConnected)
            || (n === 4 && isConnected);
          return (
            <button
              key={n}
              type="button"
              role="tab"
              aria-selected={step === n}
              disabled={disabled}
              className={`wiz-step-pill${step === n ? ' active' : ''}${done ? ' done' : ''}`}
              onClick={() => setStep(n)}
            >
              {label}
            </button>
          );
        })}
      </div>

      {error && (
        <div className="wiz-verify-status" style={{ color: 'var(--danger)', marginBottom: 10 }} role="alert">
          {error}
        </div>
      )}

      {step === 1 && (
        <section className="wiz-panel" style={{ padding: '4px 0' }}>
          <h3 className="wiz-panel-title" style={{ marginBottom: 6 }}>步驟 1：輸入你的 Gmail</h3>
          <p className="muted" style={{ margin: '0 0 12px', fontSize: '0.86rem', lineHeight: 1.55 }}>
            輸入要轉寄銀行／支付通知的 Gmail，Aster 會為你產生一組專屬轉寄地址。
          </p>
          <form onSubmit={handleSetup}>
            <label className="field" style={{ marginBottom: 12, borderRadius: 14 }}>
              <span className="label">你的 Gmail</span>
              <input
                type="email"
                placeholder="name@gmail.com"
                value={sourceEmail}
                onChange={(e) => setSourceEmail(e.target.value)}
                required
              />
            </label>
            <button type="submit" className="btn primary" disabled={busy}>
              {busy ? '產生中…' : binding ? '更新並產生新的轉寄地址' : '產生專屬轉寄地址'}
            </button>
          </form>

          {binding && (
            <div className="card" style={{ marginTop: 14, padding: 14 }}>
              <div className="muted" style={{ fontSize: '0.78rem', marginBottom: 8 }}>你的專屬轉寄地址</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 12, background: 'var(--surface-2)' }}>
                <code style={{ flex: 1, minWidth: 0, fontSize: '0.8rem', overflowWrap: 'anywhere', lineHeight: 1.35 }}>
                  {binding.forward_address}
                </code>
                <button type="button" className="btn tinted small" onClick={() => void copyText(binding.forward_address, '轉寄地址')}>
                  複製
                </button>
              </div>
              <button
                type="button"
                className="btn tinted"
                style={{ marginTop: 12 }}
                onClick={() => setStep(2)}
              >
                下一步：驗證轉寄地址
              </button>
            </div>
          )}
        </section>
      )}

      {step === 2 && binding && (
        <section className="wiz-panel" style={{ padding: '4px 0' }}>
          <h3 className="wiz-panel-title" style={{ marginBottom: 10 }}>步驟 2：驗證轉寄地址</h3>
          <div className="card" style={{ padding: 14 }}>
            <ol style={{ margin: 0, paddingLeft: 18, fontSize: '0.85rem', lineHeight: 1.65 }}>
              <li>用電腦版瀏覽器打開 <b>Gmail → 設定 → 查看所有設定 → 轉寄和 POP/IMAP</b>。</li>
              <li>點選「<b>新增轉寄地址</b>」，貼上以下專屬地址：</li>
            </ol>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, padding: '8px 10px', borderRadius: 12, background: 'var(--surface-2)' }}>
              <code style={{ flex: 1, minWidth: 0, fontSize: '0.8rem', overflowWrap: 'anywhere', lineHeight: 1.35 }}>
                {binding.forward_address}
              </code>
              <button type="button" className="btn tinted small" onClick={() => void copyText(binding.forward_address, '轉寄地址')}>
                複製
              </button>
            </div>
            <p className="muted" style={{ margin: '10px 0 0', fontSize: '0.8rem', lineHeight: 1.5 }}>
              提醒：新增後請維持「<b>停用轉寄</b>」，不要開啟全部信件轉寄，下一步會用篩選器只轉寄消費通知。
            </p>
          </div>

          {hasVerification ? (
            <div className="wiz-verify-status ok" style={{ marginTop: 12, padding: 14, borderRadius: 16 }}>
              <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>已收到 Gmail 轉寄驗證信！請完成確認：</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                {binding.verify_url && (
                  <button
                    type="button"
                    className="btn primary small"
                    onClick={() => window.open(binding.verify_url!, '_blank', 'noopener,noreferrer')}
                  >
                    前往完成 Gmail 驗證
                  </button>
                )}
                {binding.verify_code && (
                  <button
                    type="button"
                    className="btn tinted small"
                    onClick={() => void copyText(binding.verify_code!, ' 9 位數確認碼')}
                  >
                    複製 9 位數確認碼（{binding.verify_code}）
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div
              className="card"
              style={{ marginTop: 12, padding: '12px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '0.86rem', fontWeight: 600 }}>等待 Gmail 驗證信中…</div>
                <div className="muted" style={{ fontSize: '0.76rem', marginTop: 2 }}>每 3 秒自動檢查</div>
              </div>
              <button
                type="button"
                className="btn tinted small"
                disabled={checking}
                onClick={() => void pollNow()}
              >
                {checking ? '檢查中…' : '立即檢查'}
              </button>
            </div>
          )}

          <div className="btn-row" style={{ marginTop: 14 }}>
            <button
              type="button"
              className="btn secondary"
              style={{ flex: '0 0 auto', width: 'auto', minWidth: 88, padding: '0 16px' }}
              onClick={() => setStep(1)}
            >
              上一步
            </button>
            <button
              type="button"
              className="btn primary"
              style={{ flex: 1, width: 'auto', minWidth: 0, fontSize: '0.95rem', whiteSpace: 'nowrap' }}
              disabled={busy}
              onClick={() => void handleConfirmVerified()}
            >
              {binding.status === 'verified' ? '下一步：設定篩選器' : '我已完成驗證，下一步'}
            </button>
          </div>
        </section>
      )}

      {step === 3 && binding && (
        <section className="wiz-panel" style={{ padding: '4px 0' }}>
          <h3 className="wiz-panel-title" style={{ marginBottom: 6 }}>步驟 3：設定 Gmail 篩選器</h3>
          <p className="muted" style={{ margin: '0 0 10px', fontSize: '0.85rem', lineHeight: 1.5 }}>
            建議只轉寄銀行／行動支付的消費與入帳通知，避免一般信件或廣告也送進收件匣。
          </p>
          <div className="card" style={{ padding: 14 }}>
            <ol style={{ margin: 0, paddingLeft: 18, fontSize: '0.85rem', lineHeight: 1.65 }}>
              <li>在 Gmail 搜尋框右側點選「<b>顯示搜尋選項</b>」。</li>
              <li>在「<b>包含字詞</b>」貼上以下台灣常見銀行與支付關鍵字：</li>
            </ol>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, padding: '8px 10px', borderRadius: 12, background: 'var(--surface-2)' }}>
              <code style={{ flex: 1, minWidth: 0, fontSize: '0.78rem', overflowWrap: 'anywhere', lineHeight: 1.4 }}>{GMAIL_FILTER_TEMPLATE}</code>
              <button type="button" className="btn tinted small" onClick={() => void copyText(GMAIL_FILTER_TEMPLATE, '篩選器關鍵字')}>
                複製
              </button>
            </div>
            <ol start={3} style={{ margin: '10px 0 0', paddingLeft: 18, fontSize: '0.85rem', lineHeight: 1.65 }}>
              <li>點選「<b>建立篩選器</b>」→ 勾選「<b>轉寄給</b>」→ 選擇 <code style={{ overflowWrap: 'anywhere' }}>{binding.forward_address}</code>。</li>
            </ol>
          </div>

          <div className="btn-row" style={{ marginTop: 14 }}>
            <button
              type="button"
              className="btn secondary"
              style={{ flex: '0 0 auto', width: 'auto', minWidth: 88, padding: '0 16px' }}
              onClick={() => setStep(2)}
            >
              上一步
            </button>
            <button
              type="button"
              className="btn primary"
              style={{ flex: 1, width: 'auto', minWidth: 0, fontSize: '0.95rem', whiteSpace: 'nowrap' }}
              onClick={() => setStep(4)}
            >
              下一步：測試通知與完成
            </button>
          </div>
        </section>
      )}

      {step === 4 && binding && (
        <section className="wiz-panel" style={{ padding: '4px 0' }}>
          <h3 className="wiz-panel-title" style={{ marginBottom: 6 }}>步驟 4：測試通知與完成</h3>
          <p className="muted" style={{ margin: '0 0 12px', fontSize: '0.85rem', lineHeight: 1.5 }}>
            可從 Gmail 手動轉寄一封銀行消費通知信到 <code style={{ overflowWrap: 'anywhere' }}>{binding.forward_address}</code> 測試，或等待下一筆通知自動寄達。
          </p>

          {isConnected ? (
            <div className="wiz-verify-status ok" style={{ padding: 14, borderRadius: 16 }}>
              <div style={{ fontWeight: 600 }}>已連線 · 已接收 {binding.received_count} 筆</div>
              {binding.last_received_at && (
                <div className="muted" style={{ fontSize: '0.78rem', marginTop: 4 }}>
                  最近接收：{formatLocalTime(binding.last_received_at)}
                </div>
              )}
            </div>
          ) : (
            <div
              className="card"
              style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '0.86rem', fontWeight: 600 }}>等待接收測試通知信中…</div>
                <div className="muted" style={{ fontSize: '0.76rem', marginTop: 2 }}>每 3 秒自動檢查</div>
              </div>
              <button
                type="button"
                className="btn tinted small"
                disabled={checking}
                onClick={() => void pollNow()}
              >
                {checking ? '檢查中…' : '立即檢查'}
              </button>
            </div>
          )}

          <div className="btn-row" style={{ marginTop: 14 }}>
            <button
              type="button"
              className="btn secondary"
              style={{ flex: '0 0 auto', width: 'auto', minWidth: 88, padding: '0 16px' }}
              onClick={() => setStep(3)}
            >
              上一步
            </button>
            <button
              type="button"
              className="btn primary"
              style={{ flex: 1, width: 'auto', minWidth: 0, fontSize: '0.95rem', whiteSpace: 'nowrap' }}
              onClick={onClose}
            >
              完成
            </button>
          </div>
        </section>
      )}

      {binding && (
        <div style={{ marginTop: 14, textAlign: 'center' }}>
          <button
            type="button"
            className="btn danger small"
            disabled={busy}
            onClick={() => void handleRemove()}
          >
            移除這個 Email
          </button>
        </div>
      )}
    </Sheet>
  );
}
