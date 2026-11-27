/**
 * 教學精靈仿真動畫播放元件（真實 iPhone iOS 實機畫面＋Gmail 網頁版模擬＋指標移動點擊）
 * 支援：
 * - shortcut-step1 / shortcut-step2 / shortcut-step3（iPhone 自動記帳捷徑 3 步驟）
 * - email-step1 / email-step2 / email-step3 / email-step4（Email 自動轉寄 4 步驟）
 */
import { useEffect, useState, type ReactNode } from 'react';

export type GuideDemoScene =
  | 'shortcut-step1'
  | 'shortcut-step2'
  | 'shortcut-step3'
  | 'email-step1'
  | 'email-step2'
  | 'email-step3'
  | 'email-step4';

interface FrameDef {
  caption: string;
  /** 指標位置（百分比座標，相對於實機螢幕／瀏覽器視窗） */
  cursor: { x: number; y: number; click?: boolean };
  /** 當前動畫階段 0..3 */
  phase: number;
}

const SCENE_FRAMES: Record<GuideDemoScene, FrameDef[]> = {
  'shortcut-step1': [
    { caption: '點「取得捷徑」從 iCloud 匯入捷徑', cursor: { x: 50, y: 87, click: true }, phase: 0 },
    { caption: '跳出「設定捷徑」時，長按連結碼欄位', cursor: { x: 50, y: 61, click: true }, phase: 1 },
    { caption: '點選跳出的「貼上」填入專屬連結碼', cursor: { x: 56, y: 48, click: true }, phase: 2 },
    { caption: '點下方「加入捷徑」完成匯入 ✓', cursor: { x: 50, y: 74, click: true }, phase: 3 },
  ],
  'shortcut-step2': [
    { caption: '打開「捷徑」App，切到底部「自動化」分頁', cursor: { x: 50, y: 89, click: true }, phase: 0 },
    { caption: '開啟「收到來自 36 個 App 通知」右側綠色開關', cursor: { x: 84, y: 57, click: true }, phase: 1 },
    { caption: '進入自動化設定，執行方式選「立即執行」', cursor: { x: 50, y: 80, click: true }, phase: 2 },
    { caption: '確認勾選「訊息、錢包、銀行」，勿勾 Gmail ✓', cursor: { x: 50, y: 49, click: true }, phase: 3 },
  ],
  'shortcut-step3': [
    { caption: '點擊「傳送測試」發送驗證封包', cursor: { x: 32, y: 46, click: true }, phase: 0 },
    { caption: '測試封包正傳送至 Aster 收件匣…', cursor: { x: 50, y: 34 }, phase: 1 },
    { caption: '顯示「連線驗收通過 · 已接收 1 筆」', cursor: { x: 50, y: 34, click: true }, phase: 2 },
    { caption: '點「完成設定」即可開始自動記帳 ✓', cursor: { x: 50, y: 59, click: true }, phase: 3 },
  ],
  'email-step1': [
    { caption: '在欄位輸入要接收銀行通知的 Gmail', cursor: { x: 50, y: 31, click: true }, phase: 0 },
    { caption: '點「產生專屬轉寄地址」按鈕', cursor: { x: 50, y: 43, click: true }, phase: 1 },
    { caption: '系統產生專屬地址 in-80feb0…@qiyen.me', cursor: { x: 42, y: 60 }, phase: 2 },
    { caption: '點右側「複製」取得專屬地址 ✓', cursor: { x: 77, y: 60, click: true }, phase: 3 },
  ],
  'email-step2': [
    { caption: '點 Gmail 右上角齒輪 ⚙ →「查看所有設定」', cursor: { x: 80, y: 32, click: true }, phase: 0 },
    { caption: '切到「轉寄和 POP/IMAP」→「新增轉寄地址」', cursor: { x: 42, y: 32, click: true }, phase: 1 },
    { caption: '貼上專屬地址並點「繼續」（維持停用轉寄）', cursor: { x: 82, y: 58, click: true }, phase: 2 },
    { caption: '收到驗證信後點「前往完成 Gmail 驗證」✓', cursor: { x: 42, y: 58, click: true }, phase: 3 },
  ],
  'email-step3': [
    { caption: '點 Gmail 搜尋框右側「顯示搜尋選項」圖示', cursor: { x: 76, y: 7, click: true }, phase: 0 },
    { caption: '在「包含字詞」貼上消費與銀行關鍵字', cursor: { x: 58, y: 34, click: true }, phase: 1 },
    { caption: '點右下角「建立篩選器」進入動作設定', cursor: { x: 84, y: 49, click: true }, phase: 2 },
    { caption: '勾選「轉寄給」專屬地址並「建立篩選器」✓', cursor: { x: 80, y: 40, click: true }, phase: 3 },
  ],
  'email-step4': [
    { caption: '打開一封銀行消費通知信，點下方「轉寄」', cursor: { x: 43, y: 45, click: true }, phase: 0 },
    { caption: '收件人貼上專屬轉寄地址 in-80feb0…@qiyen.me', cursor: { x: 52, y: 45, click: true }, phase: 1 },
    { caption: '點藍色「傳送」送出測試通知信', cursor: { x: 30, y: 58, click: true }, phase: 2 },
    { caption: 'Aster 偵測入信 → 顯示「已連線 · 1 筆」✓', cursor: { x: 56, y: 73, click: true }, phase: 3 },
  ],
};

function CursorPointer({
  x,
  y,
  click,
  stepKey,
}: {
  x: number;
  y: number;
  click?: boolean;
  stepKey: string;
}) {
  return (
    <div
      className={`gdemo-cursor${click ? ' is-click' : ''}`}
      style={{ left: `${x}%`, top: `${y}%` }}
      aria-hidden="true"
    >
      {click && <span key={stepKey} className="gdemo-ripple" />}
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <path
          d="M5.5 3.2L19 12.2l-6.1 1.4 2.7 5.5-2.2 1.1-2.7-5.5L6.5 19V3.2Z"
          fill="#FFFFFF"
          stroke="#111318"
          strokeWidth="1.9"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

function IPhoneMockup({
  cursor,
  stepKey,
  children,
}: {
  cursor: FrameDef['cursor'];
  stepKey: string;
  children: ReactNode;
}) {
  return (
    <div className="gdemo-iphone">
      <div className="gdemo-iphone-screen">
        <div className="gdemo-ios-status">
          <span className="gdemo-ios-time">9:41</span>
          <span className="gdemo-ios-island" aria-hidden="true">
            <i />
          </span>
          <span className="gdemo-ios-signals" aria-hidden="true">
            <svg width="13" height="9" viewBox="0 0 13 9" fill="currentColor">
              <rect x="0" y="6" width="2" height="3" rx="0.6" />
              <rect x="3" y="4.2" width="2" height="4.8" rx="0.6" />
              <rect x="6" y="2.2" width="2" height="6.8" rx="0.6" />
              <rect x="9" y="0" width="2" height="9" rx="0.6" />
            </svg>
            <span className="gdemo-ios-bat">68</span>
          </span>
        </div>

        <div className="gdemo-ios-body">{children}</div>
        <div className="gdemo-ios-home" aria-hidden="true" />
        <CursorPointer x={cursor.x} y={cursor.y} click={cursor.click} stepKey={stepKey} />
      </div>
    </div>
  );
}

function GmailBrowserMockup({
  cursor,
  stepKey,
  children,
}: {
  cursor: FrameDef['cursor'];
  stepKey: string;
  children: ReactNode;
}) {
  return (
    <div className="gdemo-browser-win">
      <div className="gdemo-chrome-bar">
        <span className="gdemo-win-dots" aria-hidden="true">
          <i style={{ background: '#FF5F57' }} />
          <i style={{ background: '#FEBC2E' }} />
          <i style={{ background: '#28C840' }} />
        </span>
        <span className="gdemo-url-pill">mail.google.com/mail/u/0/</span>
      </div>
      <div className="gdemo-gmail-screen">
        {children}
        <CursorPointer x={cursor.x} y={cursor.y} click={cursor.click} stepKey={stepKey} />
      </div>
    </div>
  );
}

function ShortcutStep1Screen({ phase }: { phase: number }) {
  return (
    <div className="gdemo-ios-aster">
      <div className="gdemo-ios-icloud">
        <div className="gdemo-ios-sheet-head">
          <span className="muted">取消</span>
          <b>iCloud 捷徑</b>
          <span className="muted">···</span>
        </div>
        <div className="gdemo-icloud-center">
          <span className="gdemo-sc-icon lg">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <rect x="3" y="3" width="18" height="18" rx="5" fill="url(#scGradLg)" />
              <defs>
                <linearGradient id="scGradLg" x1="3" y1="3" x2="21" y2="21">
                  <stop stopColor="#64D2FF" />
                  <stop offset="1" stopColor="#BF5AF2" />
                </linearGradient>
              </defs>
            </svg>
          </span>
          <div className="gdemo-sc-name">Aster 自動記帳</div>
          <div className="gdemo-sc-sub">1 個步驟 · 自動傳送消費通知</div>
        </div>
        <div className={`gdemo-ios-btn${phase === 0 ? ' pressed' : ''}`}>取得捷徑</div>
      </div>

      {phase >= 1 && (
        <div className="gdemo-ios-sheet">
          <div className="gdemo-ios-grabber" />
          <div className="gdemo-ios-sheet-head">
            <span className="muted">取消</span>
            <b>設定捷徑</b>
            <span className="muted">···</span>
          </div>
          <div className="gdemo-sc-hero">
            <span className="gdemo-sc-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <rect x="4" y="4" width="16" height="16" rx="4" fill="url(#scGrad)" />
                <defs>
                  <linearGradient id="scGrad" x1="4" y1="4" x2="20" y2="20">
                    <stop stopColor="#64D2FF" />
                    <stop offset="1" stopColor="#BF5AF2" />
                  </linearGradient>
                </defs>
              </svg>
            </span>
            <div>
              <div className="gdemo-sc-name">Aster 自動記帳</div>
              <div className="gdemo-sc-sub">1 個步驟 · iCloud 捷徑</div>
            </div>
          </div>

          <div className="gdemo-sc-field-wrap">
            {(phase === 1 || phase === 2) && (
              <div className="gdemo-ios-menu">
                <span>全選</span>
                <i />
                <span className={`hi${phase === 2 ? ' pressed' : ''}`}>貼上</span>
              </div>
            )}
            <div className="gdemo-sc-label">Aster 連結碼</div>
            <div className={`gdemo-sc-input${phase >= 2 ? ' filled' : ''}`}>
              {phase >= 2 ? 'https://aster.qiyen.me/hook/8a3f…' : '輸入文字（長按貼上）'}
            </div>
          </div>

          <div className={`gdemo-ios-btn${phase === 3 ? ' done' : ''}`}>
            {phase === 3 ? '已加入捷徑 ✓' : '加入捷徑'}
          </div>
        </div>
      )}
    </div>
  );
}

function ShortcutStep2Screen({ phase }: { phase: number }) {
  return (
    <div className="gdemo-sc-app">
      {phase <= 1 && (
        <>
          <div className="gdemo-sc-topbar">
            <span className="gdemo-sc-circle">‹</span>
            <span className="gdemo-sc-circle">≡</span>
          </div>
          <div className="gdemo-sc-bigtitle">{phase === 0 ? '捷徑' : '自動化'}</div>
          {phase === 0 ? (
            <div className="gdemo-sc-grid">
              <div className="gdemo-sc-tile">
                <span>⚡</span>
                <b>Aster 自動記帳</b>
              </div>
              <div className="gdemo-sc-tile muted">
                <span>＋</span>
                <b>所有捷徑</b>
              </div>
            </div>
          ) : (
            <div className="gdemo-sc-auto-wrap">
              <div className="gdemo-sc-section">個人</div>
              <div className="gdemo-sc-list">
                <div className="gdemo-sc-row">
                  <span className="gdemo-sc-badges">
                    <i className="b-wallet">💳</i>→<i className="b-kb">⌨</i>
                  </span>
                  <div className="gdemo-sc-row-txt">
                    <b>在我感應「錢包」付款卡時</b>
                    <span>Aster 自動記帳</span>
                  </div>
                  <span className="gdemo-ios-switch on">
                    <i />
                  </span>
                </div>
                <div className="gdemo-sc-row">
                  <span className="gdemo-sc-badges">
                    <i className="b-bell">🔔</i>→<i className="b-aster">A</i>
                  </span>
                  <div className="gdemo-sc-row-txt">
                    <b>當我收到來自 36 個 App 通知時</b>
                    <span>Aster 自動記帳</span>
                  </div>
                  <span className="gdemo-ios-switch auto-on">
                    <i />
                  </span>
                </div>
              </div>
              <div className="gdemo-sc-fab" aria-hidden="true">＋</div>
            </div>
          )}
          <div className="gdemo-sc-tabbar">
            <span className={phase === 0 ? 'on' : ''}>捷徑</span>
            <span className={phase === 1 ? 'on' : ''}>自動化</span>
            <span>資料庫</span>
          </div>
        </>
      )}

      {phase === 2 && (
        <div className="gdemo-sc-editor">
          <div className="gdemo-sc-topbar">
            <span className="gdemo-sc-circle">‹</span>
            <span className="gdemo-sc-ed-title">Aster 自動記帳 ⌄</span>
            <span className="gdemo-sc-circle">⚙</span>
          </div>
          <div className="gdemo-sc-trigger-card">
            <div className="gdemo-sc-trig-head">🔔 當我收到來自</div>
            <div className="gdemo-sc-app-chips">
              <span className="c-wallet">錢包</span>
              <span className="c-msg">訊息</span>
              <span className="c-line">LINE Pay</span>
              <span className="c-bank">國泰</span>
              <span className="c-bank">台新</span>
              <span className="c-jk">街口</span>
            </div>
            <div className="gdemo-sc-trig-foot">的通知時 ›</div>
          </div>
          <div className="gdemo-sc-action-mini">
            <i className="b-aster">A</i>
            <span>把 <b>App</b> 的 <b>內文</b> 加入 Aster</span>
          </div>
          <div className="gdemo-sc-radio-card">
            <div className="gdemo-sc-radio">
              <span>執行前先詢問</span>
              <i />
            </div>
            <div className="gdemo-sc-radio active">
              <span>立即執行</span>
              <b>✓</b>
            </div>
          </div>
        </div>
      )}

      {phase === 3 && (
        <div className="gdemo-sc-editor">
          <div className="gdemo-sc-topbar">
            <span className="gdemo-sc-circle">‹</span>
            <span className="gdemo-sc-ed-title">選擇 App 通知</span>
            <span className="gdemo-sc-done">完成</span>
          </div>
          <div className="gdemo-sc-checklist">
            <div className="gdemo-sc-chk on">
              <span>💬 訊息（簡訊驗證／刷卡）</span>
              <b>✓</b>
            </div>
            <div className="gdemo-sc-chk on">
              <span>💳 錢包（Apple Pay）</span>
              <b>✓</b>
            </div>
            <div className="gdemo-sc-chk on">
              <span>🏦 銀行／LINE Pay／街口</span>
              <b>✓</b>
            </div>
            <div className="gdemo-sc-chk off">
              <span>✉️ Gmail / Outlook（勿勾選）</span>
              <b>✕</b>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ShortcutStep3Screen({ phase }: { phase: number }) {
  return (
    <div className="gdemo-ios-aster">
      <div className="gdemo-ios-nav">
        <span className="gdemo-ios-back">‹</span>
        <span>步驟 3／3：連線驗收</span>
      </div>
      <div className="gdemo-ios-aster-card" style={{ gap: 8, marginTop: 22 }}>
        <div className={`gdemo-ios-status-box${phase >= 2 ? ' ok' : ''}`}>
          {phase === 0 && '尚未接收到資料（待驗收）'}
          {phase === 1 && '傳送測試封包中…'}
          {phase >= 2 && '✅ 連線驗收通過 · 已接收 1 筆'}
        </div>
        {phase === 1 && <div className="gdemo-packet-bar"><i /></div>}
        <div className="gdemo-ios-btn-row">
          <span className={`gdemo-ios-btn sm${phase === 0 ? ' pressed' : ''}`}>傳送測試</span>
          <span className="gdemo-ios-btn sm muted">重新檢查</span>
        </div>
        {phase >= 2 && (
          <div className={`gdemo-ios-btn${phase === 3 ? ' done' : ''}`}>
            {phase === 3 ? '已完成設定 ✓' : '完成設定'}
          </div>
        )}
      </div>
    </div>
  );
}

function EmailStep1Screen({ phase }: { phase: number }) {
  return (
    <div className="gdemo-ios-aster">
      <div className="gdemo-ios-nav">
        <span className="gdemo-ios-back">‹</span>
        <span>Email 自動轉寄（Gmail）</span>
      </div>
      <div className="gdemo-ios-aster-card" style={{ gap: 7 }}>
        <div className="gdemo-sc-label">步驟 1：你的 Gmail</div>
        <div className={`gdemo-sc-input${phase >= 0 ? ' filled' : ''}`}>
          {phase >= 0 ? 'qiyen@gmail.com' : 'name@gmail.com'}
        </div>
        <div className={`gdemo-ios-btn${phase === 1 ? ' pressed' : ''}`}>產生專屬轉寄地址</div>
        {phase >= 2 && (
          <div className="gdemo-ios-copy-card">
            <div className="gdemo-sc-label">你的專屬轉寄地址</div>
            <div className="gdemo-ios-copy-row">
              <code>in-80feb0…@qiyen.me</code>
              <span className={`gdemo-ios-mini${phase === 3 ? ' done' : ''}`}>
                {phase === 3 ? '已複製 ✓' : '複製'}
              </span>
            </div>
          </div>
        )}
        {phase === 3 && <div className="gdemo-ios-toast">已複製轉寄地址</div>}
      </div>
    </div>
  );
}

function GmailHeader({
  highlightGear,
  highlightFilterIcon,
  searchText,
}: {
  highlightGear?: boolean;
  highlightFilterIcon?: boolean;
  searchText?: string;
}) {
  return (
    <div className="gdemo-gm-head">
      <span className="gdemo-gm-brand">
        <span className="gdemo-gm-m">M</span>
        <span>Gmail</span>
      </span>
      <div className="gdemo-gm-search">
        <span>🔍 {searchText || '搜尋郵件'}</span>
        <span className={`gdemo-gm-sliders${highlightFilterIcon ? ' active' : ''}`}>🎛</span>
      </div>
      <span className={`gdemo-gm-gear${highlightGear ? ' active' : ''}`}>⚙</span>
      <span className="gdemo-gm-avatar">Q</span>
    </div>
  );
}

function EmailStep2Screen({ phase }: { phase: number }) {
  return (
    <div className="gdemo-gm-layout">
      <GmailHeader highlightGear={phase === 0} />
      <div className="gdemo-gm-body">
        <div className="gdemo-gm-side">
          <span className="gdemo-gm-compose-btn">✎ 撰寫</span>
          <span className="on">收件匣</span>
          <span>已加星號</span>
          <span>寄件備份</span>
        </div>
        <div className="gdemo-gm-main">
          {phase === 0 ? (
            <div className="gdemo-gm-list">
              <div className="gdemo-gm-mail"><b>國泰世華</b> <span>刷卡消費通知 NT$ 165</span></div>
              <div className="gdemo-gm-mail"><b>LINE Pay</b> <span>交易完成通知</span></div>
              <div className="gdemo-gm-mail"><b>玉山銀行</b> <span>信用卡消費明細</span></div>
              <div className="gdemo-gm-quick-drawer">
                <div className="gdemo-gm-qd-title">快速設定</div>
                <div className="gdemo-gm-qd-btn">查看所有設定</div>
              </div>
            </div>
          ) : (
            <div className="gdemo-gm-settings">
              <div className="gdemo-gm-tabs">
                <span>一般設定</span>
                <span>標籤</span>
                <span className="on">轉寄和 POP/IMAP</span>
              </div>
              <div className="gdemo-gm-set-row">
                <b>轉寄：</b>
                <span className="gdemo-gm-outline-btn">新增轉寄地址</span>
              </div>
              <div className="gdemo-gm-radio-line">● 停用轉寄（維持此選項）</div>
              {phase === 2 && (
                <div className="gdemo-gm-modal">
                  <div className="gdemo-gm-modal-title">新增轉寄地址</div>
                  <div className="gdemo-gm-modal-input">in-80feb0…@qiyen.me</div>
                  <div className="gdemo-gm-modal-actions">
                    <span>取消</span>
                    <b>繼續</b>
                  </div>
                </div>
              )}
              {phase === 3 && (
                <div className="gdemo-gm-verify-card">
                  <span>已收到 Gmail 驗證信！</span>
                  <b>前往完成 Gmail 驗證 ✓</b>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function EmailStep3Screen({ phase }: { phase: number }) {
  return (
    <div className="gdemo-gm-layout">
      <GmailHeader highlightFilterIcon={phase === 0} />
      <div className="gdemo-gm-body">
        <div className="gdemo-gm-side">
          <span className="gdemo-gm-compose-btn">✎ 撰寫</span>
          <span className="on">收件匣</span>
          <span>已加星號</span>
        </div>
        <div className="gdemo-gm-main">
          <div className="gdemo-gm-list">
            <div className="gdemo-gm-mail"><b>國泰世華</b> <span>刷卡消費通知</span></div>
            <div className="gdemo-gm-mail"><b>台新銀行</b> <span>刷卡消費通知</span></div>
          </div>

          {phase >= 1 && phase <= 2 && (
            <div className="gdemo-gm-filter-pop">
              <div className="gdemo-gm-f-row">
                <span>寄件者</span>
                <i />
              </div>
              <div className="gdemo-gm-f-row">
                <span>包含字詞</span>
                <i className="filled">消費 OR 刷卡 OR LINE Pay…</i>
              </div>
              <div className="gdemo-gm-f-foot">
                <span className={phase === 2 ? 'hi' : ''}>建立篩選器</span>
              </div>
            </div>
          )}

          {phase === 3 && (
            <div className="gdemo-gm-filter-pop">
              <div className="gdemo-gm-f-check">
                <span>☑ 轉寄給：</span>
                <b>in-80feb0…@qiyen.me</b>
              </div>
              <div className="gdemo-gm-f-foot">
                <span className="gdemo-gm-blue-btn">建立篩選器 ✓</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function EmailStep4Screen({ phase }: { phase: number }) {
  return (
    <div className="gdemo-gm-layout">
      <GmailHeader />
      <div className="gdemo-gm-body">
        <div className="gdemo-gm-side">
          <span className="gdemo-gm-compose-btn">✎ 撰寫</span>
          <span className="on">收件匣</span>
          <span>已寄郵件</span>
        </div>
        <div className="gdemo-gm-main">
          <div className="gdemo-gm-thread">
            <div className="gdemo-gm-subj">國泰世華 刷卡消費通知 NT$ 165</div>
            <div className="gdemo-gm-snippet">您於 7-ELEVEN 消費 NT$ 165 元</div>
            {phase === 0 && (
              <div className="gdemo-gm-reply-bar">
                <span>↩ 回覆</span>
                <span className="active">↪ 轉寄</span>
              </div>
            )}
            {phase >= 1 && (
              <div className="gdemo-gm-fwd-box">
                <div className="gdemo-gm-fwd-to">
                  <span>收件人</span>
                  <b>in-80feb0…@qiyen.me</b>
                </div>
                <div className="gdemo-gm-fwd-actions">
                  <span className={`gdemo-gm-blue-btn${phase === 2 ? ' pressed' : ''}`}>
                    {phase >= 2 ? '已傳送 ✓' : '傳送'}
                  </span>
                </div>
              </div>
            )}
            {phase === 3 && (
              <div className="gdemo-gm-aster-ok">● Aster 已連線 · 已接收 1 筆 ✓</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function GuideDemoVideo({ scene }: { scene: GuideDemoScene }) {
  const frames = SCENE_FRAMES[scene];
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    setIdx(0);
    const id = window.setInterval(() => {
      setIdx((i) => (i + 1) % frames.length);
    }, 1750);
    return () => window.clearInterval(id);
  }, [scene, frames.length]);

  const f = frames[idx] ?? frames[0];
  const isGmailDesktop = scene === 'email-step2' || scene === 'email-step3' || scene === 'email-step4';

  return (
    <div className="gdemo-wrap" aria-label={`教學示範動畫：${f.caption}`}>
      <div className="gdemo-stage">
        <div className="gdemo-topbar">
          <span className="gdemo-device-tag">
            <i />
            {isGmailDesktop ? 'Gmail 網頁版實機模擬' : 'iPhone 實機畫面模擬'}
          </span>
          <span className="gdemo-badge">
            步驟 {idx + 1}／{frames.length}
          </span>
        </div>

        <div className={`gdemo-viewport${isGmailDesktop ? ' is-desktop' : ' is-ios'}`}>
          {!isGmailDesktop ? (
            <IPhoneMockup cursor={f.cursor} stepKey={`${scene}-${idx}`}>
              {scene === 'shortcut-step1' && <ShortcutStep1Screen phase={f.phase} />}
              {scene === 'shortcut-step2' && <ShortcutStep2Screen phase={f.phase} />}
              {scene === 'shortcut-step3' && <ShortcutStep3Screen phase={f.phase} />}
              {scene === 'email-step1' && <EmailStep1Screen phase={f.phase} />}
            </IPhoneMockup>
          ) : (
            <GmailBrowserMockup cursor={f.cursor} stepKey={`${scene}-${idx}`}>
              {scene === 'email-step2' && <EmailStep2Screen phase={f.phase} />}
              {scene === 'email-step3' && <EmailStep3Screen phase={f.phase} />}
              {scene === 'email-step4' && <EmailStep4Screen phase={f.phase} />}
            </GmailBrowserMockup>
          )}
        </div>

        <div className="gdemo-caption">
          <span>{f.caption}</span>
          <span className="gdemo-step-dots" role="tablist" aria-label="示範步驟">
            {frames.map((frame, i) => (
              <button
                key={i}
                type="button"
                aria-label={`跳至第 ${i + 1} 步：${frame.caption}`}
                className={i === idx ? 'on' : ''}
                onClick={() => setIdx(i)}
              />
            ))}
          </span>
        </div>
      </div>
    </div>
  );
}
