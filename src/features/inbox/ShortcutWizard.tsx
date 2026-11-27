/**
 * 3 步驟捷徑引導設定抽屜（Sheet）：
 * 步驟 1：一鍵加入捷徑（原生 App 略過連結碼複製貼上；Web/PWA 自動複製並提示貼上）
 * 步驟 2：開啟 iOS 自動化（明確引導至「捷徑 → 自動化」分頁、設為「立即執行」、提醒勾選「訊息」與銀行、勿加 Gmail/Outlook）
 * 步驟 3：即時連線驗收（透過傳送測試或檢查 listTokens() use_count 增加確認實際送達，不使用假 visibilitychange 自動通過）
 */
import { Capacitor } from '@capacitor/core';
import { useEffect, useState } from 'react';
import { SHORTCUTS, type InboxToken } from '@/services/inbox';
import { Sheet } from '@/ui/Sheet';

export type ShortcutDef = (typeof SHORTCUTS)[number];

export interface ShortcutWizardProps {
  open: boolean;
  onClose: () => void;
  shortcut: ShortcutDef | null;
  preparing: boolean;
  hasLink: boolean;
  tokens: InboxToken[] | null;
  onAdd: (s: ShortcutDef) => Promise<void>;
  onSendTest: (channelKey: ShortcutDef['key']) => Promise<boolean>;
  onRefreshTokens: () => Promise<InboxToken[]>;
}

const PENDING_KEY = 'clure.inbox.wizard.pending';

export function countTokenUses(tokens: InboxToken[] | null): number {
  if (!tokens?.length) return 0;
  return tokens.reduce((sum, t) => sum + (t.use_count ?? (t.last_used_at ? 1 : 0)), 0);
}

export function ShortcutWizard({
  open,
  onClose,
  shortcut,
  preparing,
  hasLink,
  tokens,
  onAdd,
  onSendTest,
  onRefreshTokens,
}: ShortcutWizardProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [pendingKey, setPendingKey] = useState<string | null>(() => {
    try { return sessionStorage.getItem(PENDING_KEY); } catch { return null; }
  });
  const [joined, setJoined] = useState(false);
  const [testing, setTesting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [baselineCount, setBaselineCount] = useState<number>(0);
  const [verified, setVerified] = useState(false);

  const isNative = Capacitor.isNativePlatform();
  const currentUseCount = countTokenUses(tokens);

  // 每次開啟新渠道時重置引導狀態與驗收基準線
  useEffect(() => {
    if (!open || !shortcut) return;
    setStep(1);
    setJoined(false);
    setTesting(false);
    setChecking(false);
    setVerified(false);
    setBaselineCount(countTokenUses(tokens));
  }, [open, shortcut?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // 若 listTokens() 回傳的 use_count 比基準高，代表實際連線送達成功
  useEffect(() => {
    if (open && step === 3 && currentUseCount > baselineCount) {
      setVerified(true);
    }
  }, [open, step, currentUseCount, baselineCount]);

  // 從「捷徑」App 返回前景時只顯示待確認提示，絕不自動打勾
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const k = sessionStorage.getItem(PENDING_KEY);
        if (k) setPendingKey(k);
      } catch { /* 忽略 */ }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  if (!shortcut) return null;

  const isPendingThis = pendingKey === shortcut.key;

  const clearPending = () => {
    setPendingKey(null);
    try { sessionStorage.removeItem(PENDING_KEY); } catch { /* 忽略 */ }
  };

  const handleAdd = async () => {
    try { sessionStorage.setItem(PENDING_KEY, shortcut.key); } catch { /* 忽略 */ }
    setPendingKey(shortcut.key);
    try {
      await onAdd(shortcut);
    } catch {
      clearPending();
    }
  };

  const confirmJoined = () => {
    clearPending();
    setJoined(true);
    setStep(2);
  };

  const handleSendTest = async () => {
    setTesting(true);
    try {
      const ok = await onSendTest(shortcut.key);
      const updated = await onRefreshTokens();
      if (ok && countTokenUses(updated) > baselineCount) {
        setVerified(true);
      } else if (ok && countTokenUses(updated) > 0) {
        setVerified(true);
      }
    } finally {
      setTesting(false);
    }
  };

  const handleRecheck = async () => {
    setChecking(true);
    try {
      const updated = await onRefreshTokens();
      if (countTokenUses(updated) > baselineCount) {
        setVerified(true);
      }
    } finally {
      setChecking(false);
    }
  };

  const stepLabels: { n: 1 | 2 | 3; label: string }[] = [
    { n: 1, label: '1. 加入捷徑' },
    { n: 2, label: '2. 開啟自動化' },
    { n: 3, label: '3. 連線驗收' },
  ];

  return (
    <Sheet open={open} onClose={onClose} title={`設定：${shortcut.title}`}>
      <div className="wiz-stepper" role="tablist" aria-label="設定步驟">
        {stepLabels.map((s) => (
          <button
            key={s.n}
            type="button"
            role="tab"
            aria-selected={step === s.n}
            className={`wiz-step-pill${step === s.n ? ' active' : ''}${step > s.n ? ' done' : ''}`}
            onClick={() => setStep(s.n)}
          >
            {s.label}
          </button>
        ))}
      </div>

      {step === 1 && (
        <div className="card wiz-panel">
          <p className="wiz-panel-title"><b>步驟 1／3：一鍵加入「{shortcut.name}」</b></p>
          <p className="muted" style={{ marginTop: 4 }}>
            {isNative
              ? '已為這台裝置同步專用憑證，點下方按鈕即可直接匯入捷徑，不需手動複製貼上連結碼。'
              : '點下方按鈕會自動複製你的連結碼並切換到「捷徑」App；跳出「設定捷徑」時，長按輸入框 →「貼上」→「加入捷徑」。'}
          </p>
          {!hasLink && !isNative && (
            <p className="muted" style={{ fontSize: '0.8rem' }}>
              第一次加入時會自動建立這台裝置專用的連結碼（僅能寫入收件匣，無法讀取帳本）。
            </p>
          )}
          <button type="button" className="btn" disabled={preparing} onClick={() => void handleAdd()}>
            {preparing ? '準備中…' : `加入「${shortcut.name}」`}
          </button>

          {isPendingThis && (
            <div className="wiz-next" role="status" style={{ marginTop: 12 }}>
              <span>已從「捷徑」App 返回？請確認是否已加入「<b>{shortcut.name}</b>」：</span>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button type="button" className="pill accent-pill" onClick={confirmJoined}>確認已加入</button>
                <button type="button" className="pill" onClick={clearPending}>還沒加入</button>
              </div>
            </div>
          )}

          {!isPendingThis && (
            <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end' }}>
              <button
                type="button"
                className={joined ? 'btn secondary small' : 'muted'}
                style={joined ? undefined : { background: 'none', border: 0, fontSize: '0.82rem', cursor: 'pointer', padding: '4px 0' }}
                onClick={() => setStep(2)}
              >
                {joined ? '下一步：開啟自動化 →' : '已經加入過了，直接下一步 →'}
              </button>
            </div>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="card wiz-panel">
          <p className="wiz-panel-title"><b>步驟 2／3：在「捷徑 → 自動化」分頁啟用</b></p>
          <div className="wiz-guide-box">
            {shortcut.key === 'auto' ? (
              <ol className="wiz-auto-steps">
                <li>打開 iPhone「捷徑」App，切換到底部 <b>「捷徑 → 自動化」</b> 分頁。</li>
                <li>開啟預先建立的「收到通知」自動化，並將執行方式設為 <b>「立即執行」</b>（建議關閉執行時通知）。</li>
                <li>點入觸發的 App 清單，務必勾選 <b>「訊息」</b> 與常用銀行／支付 App（LINE Pay、街口等），<b>請勿加入 Gmail 或 Outlook</b>。</li>
              </ol>
            ) : (
              <ol className="wiz-auto-steps">
                <li>打開 iPhone「捷徑」App，切換到底部 <b>「捷徑 → 自動化」</b> 分頁。</li>
                <li>開啟預先建立的 <b>「交易」</b> 自動化（可全選要追蹤的卡片），將執行方式設為 <b>「立即執行」</b>。</li>
                <li>若清單內沒有自動化，點右上角「＋」→「交易」→「立即執行」→「執行捷徑：<b>{shortcut.name}</b>」。</li>
              </ol>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
            <a className="btn secondary" href="shortcuts://">打開「捷徑」App</a>
            <button type="button" className="btn" onClick={() => setStep(3)}>我已開啟自動化，下一步 →</button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="card wiz-panel">
          <p className="wiz-panel-title"><b>步驟 3／3：即時連線驗收</b></p>
          <p className="muted" style={{ marginTop: 4 }}>
            點擊「傳送測試」驗證這台裝置能正常送出資料到 Aster 收件匣，或實際觸發一次通知後點「重新檢查連線」。
          </p>
          <div className={`wiz-verify-status${verified ? ' ok' : ''}`} role="status">
            {verified
              ? `✅ 連線驗收通過 · 已接收 ${currentUseCount} 筆資料`
              : currentUseCount > 0
                ? `已接收 ${currentUseCount} 筆資料 · 請點「傳送測試」或觸發一次以確認本次設定`
                : '尚未接收到資料（待驗收）'}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
            <button type="button" className="btn" disabled={testing || checking} onClick={() => void handleSendTest()}>
              {testing ? '傳送中…' : '傳送測試'}
            </button>
            <button type="button" className="btn secondary" disabled={testing || checking} onClick={() => void handleRecheck()}>
              {checking ? '檢查中…' : '重新檢查連線'}
            </button>
          </div>
          {verified && (
            <button type="button" className="btn" style={{ marginTop: 10 }} onClick={onClose}>
              完成設定
            </button>
          )}
        </div>
      )}
    </Sheet>
  );
}
