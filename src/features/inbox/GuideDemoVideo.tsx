/**
 * 教學精靈動畫播放元件（使用遮蔽個人資訊後的真實 iPhone / Gmail 截圖 + 動態指標點擊）
 * 支援：
 * - shortcut-step1 / shortcut-step2 / shortcut-step3（iPhone 自動記帳捷徑 3 步驟）
 * - email-step2 / email-step3 / email-step4（Email 自動轉寄後 3 步驟；步驟 1 不顯示影片）
 */
import { useEffect, useState } from 'react';

export type GuideDemoScene =
  | 'shortcut-step1'
  | 'shortcut-step2'
  | 'shortcut-step3'
  | 'email-step2'
  | 'email-step3'
  | 'email-step4';

interface FrameDef {
  caption: string;
  /** 真實截圖路徑（位於 public/guides/）；若省略則使用互動驗證模擬畫面 */
  img?: string;
  /** 指標位置（百分比座標，相對於截圖／模擬螢幕） */
  cursor: { x: number; y: number; click?: boolean };
  /** 當前動畫階段 0..3 */
  phase: number;
}

const FRAME_MS = 3500;

const SCENE_FRAMES: Record<GuideDemoScene, FrameDef[]> = {
  'shortcut-step1': [
    {
      img: '/guides/sc-1a.jpg',
      caption: '打開 iCloud 捷徑後，點下方藍色「設定捷徑」',
      cursor: { x: 50, y: 96, click: true },
      phase: 0,
    },
    {
      img: '/guides/sc-1b.jpg',
      caption: '長按「Text」輸入框，選擇「貼上」專屬連結碼',
      cursor: { x: 16, y: 24, click: true },
      phase: 1,
    },
    {
      img: '/guides/sc-1c.jpg',
      caption: '確認連結碼已貼上，點下方「＋ 加入捷徑」完成匯入 ✓',
      cursor: { x: 50, y: 88, click: true },
      phase: 2,
    },
  ],
  'shortcut-step2': [
    {
      img: '/guides/sc-2a.jpg',
      caption: '在「自動化」分頁確認「自動化操作」為綠色開啟',
      cursor: { x: 86, y: 74, click: true },
      phase: 0,
    },
    {
      img: '/guides/sc-2a.jpg',
      caption: '點上方 App 列表確認已勾選銀行／支付通知來源',
      cursor: { x: 42, y: 54, click: true },
      phase: 1,
    },
    {
      img: '/guides/sc-2a.jpg',
      caption: '下方「感應任何卡片時」也可依需求開啟 ✓',
      cursor: { x: 34, y: 96, click: true },
      phase: 2,
    },
  ],
  'shortcut-step3': [
    { caption: '點擊「傳送測試」發送驗證封包', cursor: { x: 32, y: 46, click: true }, phase: 0 },
    { caption: '測試封包正傳送至 Aster 收件匣…', cursor: { x: 50, y: 34 }, phase: 1 },
    { caption: '顯示「連線驗收通過 · 已接收 1 筆」', cursor: { x: 50, y: 34, click: true }, phase: 2 },
    { caption: '點「完成設定」即可開始自動記帳 ✓', cursor: { x: 50, y: 59, click: true }, phase: 3 },
  ],
  'email-step2': [
    {
      img: '/guides/gm-2a.jpg',
      caption: '點 Gmail 右上角齒輪 ⚙ →「查看所有設定」',
      cursor: { x: 86, y: 16, click: true },
      phase: 0,
    },
    {
      img: '/guides/gm-2b.jpg',
      caption: '切到「轉寄和 POP/IMAP」分頁',
      cursor: { x: 45, y: 41, click: true },
      phase: 1,
    },
    {
      img: '/guides/gm-2c.jpg',
      caption: '點「新增轉寄地址」貼上專屬地址，再點「下一步」',
      cursor: { x: 59, y: 80, click: true },
      phase: 2,
    },
    {
      img: '/guides/gm-2d.jpg',
      caption: '完成 Gmail 驗證後，維持「停用轉寄」即可 ✓',
      cursor: { x: 26, y: 28, click: true },
      phase: 3,
    },
  ],
  'email-step3': [
    {
      img: '/guides/gm-3a.jpg',
      caption: '點 Gmail 搜尋框右側「顯示搜尋選項」圖示',
      cursor: { x: 64, y: 16, click: true },
      phase: 0,
    },
    {
      img: '/guides/gm-3b.jpg',
      caption: '在「包含字詞」欄位貼上消費與銀行關鍵字',
      cursor: { x: 42, y: 39, click: true },
      phase: 1,
    },
    {
      img: '/guides/gm-3b.jpg',
      caption: '點右下角「建立篩選器」進入動作設定',
      cursor: { x: 69, y: 84, click: true },
      phase: 2,
    },
    {
      img: '/guides/gm-3c.jpg',
      caption: '勾選「轉寄給」專屬地址並點「建立篩選器」✓',
      cursor: { x: 77, y: 88, click: true },
      phase: 3,
    },
  ],
  'email-step4': [
    {
      img: '/guides/gm-4a.jpg',
      caption: '打開銀行消費通知信，點右上角 ⋮ →「轉寄」',
      cursor: { x: 83, y: 21, click: true },
      phase: 0,
    },
    {
      img: '/guides/gm-4b.jpg',
      caption: '在「收件者」欄位貼上專屬轉寄地址',
      cursor: { x: 28, y: 17, click: true },
      phase: 1,
    },
    {
      img: '/guides/gm-4b.jpg',
      caption: '點左下角藍色「傳送」，回到 Aster 即會顯示「已連線」✓',
      cursor: { x: 12, y: 90, click: true },
      phase: 2,
    },
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
      key={stepKey}
      className={`gdemo-cursor${click ? ' is-click' : ''}`}
      style={{ left: `${x}%`, top: `${y}%` }}
      aria-hidden="true"
    >
      {click && <span className="gdemo-ripple" />}
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
        <path
          d="M5.5 3.2L19 12.2l-6.1 1.4 2.7 5.5-2.2 1.1-2.7-5.5L6.5 19V3.2Z"
          fill="#FFFFFF"
          stroke="#111318"
          strokeWidth="2.1"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

/** 步驟 3 連線驗收無實機截圖，保留 Aster 驗收狀態示意 */
function ShortcutStep3VerifyView({
  phase,
  cursor,
  stepKey,
}: {
  phase: number;
  cursor: FrameDef['cursor'];
  stepKey: string;
}) {
  return (
    <div className="gdemo-iphone">
      <div className="gdemo-iphone-screen">
        <div className="gdemo-ios-status">
          <span className="gdemo-ios-time">9:41</span>
          <span className="gdemo-ios-island">
            <i />
          </span>
          <span className="gdemo-ios-signals">
            <span className="gdemo-ios-bat">88</span>
          </span>
        </div>
        <div className="gdemo-ios-body">
          <div className="gdemo-ios-aster">
            <div className="gdemo-aster-sheet" style={{ marginTop: 14 }}>
              <div className="gdemo-aster-sheet-head">步驟 3 / 3：連線驗收</div>
              <div className={`gdemo-ios-status-box${phase >= 2 ? ' ok' : ''}`}>
                {phase === 0 && '尚未收到測試封包'}
                {phase === 1 && '傳送測試封包中…'}
                {phase >= 2 && '● 連線驗收通過 · 已接收 1 筆 ✓'}
              </div>
              {phase === 1 && (
                <div className="gdemo-packet-bar">
                  <i />
                </div>
              )}
              <div className="gdemo-aster-row-btns">
                <span className={`gdemo-aster-sec${phase === 0 ? ' pressed' : ''}`}>傳送測試</span>
                <span className={`gdemo-aster-cta${phase === 3 ? ' pressed' : ''}`}>完成設定</span>
              </div>
            </div>
          </div>
          <CursorPointer x={cursor.x} y={cursor.y} click={cursor.click} stepKey={stepKey} />
        </div>
        <div className="gdemo-ios-home" />
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
    }, FRAME_MS);
    return () => window.clearInterval(id);
  }, [scene, frames.length]);

  const f = frames[idx] ?? frames[0];
  const isGmailDesktop = scene === 'email-step2' || scene === 'email-step3' || scene === 'email-step4';

  return (
    <div className="gdemo-wrap" aria-label={`教學示範：${f.caption}`}>
      <div className="gdemo-stage">
        <div className="gdemo-topbar">
          <span className="gdemo-device-tag">
            <i />
            {isGmailDesktop ? 'Gmail 網頁版實機操作' : 'iPhone 實機操作'}
          </span>
          <span className="gdemo-badge">
            步驟 {idx + 1}／{frames.length}
          </span>
        </div>

        <div className={`gdemo-viewport${isGmailDesktop ? ' is-desktop' : ' is-ios'}`}>
          {f.img ? (
            <div className={`gdemo-real-frame${isGmailDesktop ? ' is-desktop' : ' is-ios'}`}>
              <img
                src={f.img}
                alt={f.caption}
                className="gdemo-real-img"
                draggable={false}
              />
              <CursorPointer
                x={f.cursor.x}
                y={f.cursor.y}
                click={f.cursor.click}
                stepKey={`${scene}-${idx}`}
              />
            </div>
          ) : (
            <ShortcutStep3VerifyView
              phase={f.phase}
              cursor={f.cursor}
              stepKey={`${scene}-${idx}`}
            />
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
