/**
 * 教學精靈仿真動畫播放元件（模擬 iOS 捷徑／Gmail 網頁版真實畫面＋明顯但不誇張的指標移動點擊動畫）
 * 支援：
 * - shortcut-step1 / shortcut-step2 / shortcut-step3（iPhone 自動記帳捷徑 3 步驟）
 * - email-step1 / email-step2 / email-step3 / email-step4（Email 自動轉寄 4 步驟）
 */
import { useEffect, useState } from 'react';

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
  /** 指標位置（百分比座標，相對於仿真螢幕容器） */
  cursor: { x: number; y: number; click?: boolean };
  /** 當前動畫階段 0..2 */
  phase: number;
}

const SCENE_FRAMES: Record<GuideDemoScene, FrameDef[]> = {
  'shortcut-step1': [
    { caption: '點「加入捷徑」跳轉 iCloud 頁面', cursor: { x: 74, y: 74, click: true }, phase: 0 },
    { caption: '長按連結框貼上連結碼', cursor: { x: 52, y: 49, click: true }, phase: 1 },
    { caption: '點「加入捷徑」完成匯入 ✓', cursor: { x: 50, y: 80, click: true }, phase: 2 },
  ],
  'shortcut-step2': [
    { caption: '切換至「捷徑 → 自動化」分頁', cursor: { x: 50, y: 88, click: true }, phase: 0 },
    { caption: '打開「收到通知」與「交易」開關', cursor: { x: 82, y: 36, click: true }, phase: 1 },
    { caption: '執行方式選「立即執行」✓', cursor: { x: 52, y: 66, click: true }, phase: 2 },
  ],
  'shortcut-step3': [
    { caption: '點擊「傳送測試」發送驗證封包', cursor: { x: 34, y: 78, click: true }, phase: 0 },
    { caption: '封包已送達 Aster 伺服器…', cursor: { x: 54, y: 48 }, phase: 1 },
    { caption: '顯示「已接收 1 筆」即完成連線 ✓', cursor: { x: 52, y: 48, click: true }, phase: 2 },
  ],
  'email-step1': [
    { caption: '輸入你的 Gmail 信箱', cursor: { x: 64, y: 40, click: true }, phase: 0 },
    { caption: '點擊「產生專屬轉寄地址」', cursor: { x: 50, y: 65, click: true }, phase: 1 },
    { caption: '點「複製」取得專屬地址 ✓', cursor: { x: 82, y: 82, click: true }, phase: 2 },
  ],
  'email-step2': [
    { caption: '點 Gmail 右上角齒輪 → 查看所有設定', cursor: { x: 85, y: 20, click: true }, phase: 0 },
    { caption: '切到「轉寄和 POP/IMAP」新增地址（維持停用）', cursor: { x: 64, y: 44, click: true }, phase: 1 },
    { caption: '收到驗證信後點「前往完成 Gmail 驗證」✓', cursor: { x: 46, y: 78, click: true }, phase: 2 },
  ],
  'email-step3': [
    { caption: '點 Gmail 搜尋框右側「顯示搜尋選項」', cursor: { x: 79, y: 21, click: true }, phase: 0 },
    { caption: '在「包含字詞」貼上消費關鍵字', cursor: { x: 56, y: 48, click: true }, phase: 1 },
    { caption: '建立篩選器 → 勾選「轉寄給」專屬地址 ✓', cursor: { x: 54, y: 78, click: true }, phase: 2 },
  ],
  'email-step4': [
    { caption: '打開銀行消費通知信，點「轉寄」', cursor: { x: 74, y: 66, click: true }, phase: 0 },
    { caption: '收件人貼上專屬地址並點「傳送」', cursor: { x: 24, y: 80, click: true }, phase: 1 },
    { caption: 'Aster 偵測入信 → 顯示「已連線」✓', cursor: { x: 52, y: 50, click: true }, phase: 2 },
  ],
};

function CursorPointer({ x, y, click }: { x: number; y: number; click?: boolean }) {
  return (
    <div
      className={`gdemo-cursor${click ? ' is-click' : ''}`}
      style={{ left: `${x}%`, top: `${y}%` }}
      aria-hidden="true"
    >
      {click && <span className="gdemo-ripple" />}
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <path
          d="M5.5 3.2L19 12.2l-6.1 1.4 2.7 5.5-2.2 1.1-2.7-5.5L6.5 19V3.2Z"
          fill="#FFFFFF"
          stroke="#111318"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
      </svg>
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
    }, 1800);
    return () => window.clearInterval(id);
  }, [scene, frames.length]);

  const f = frames[idx] ?? frames[0];

  return (
    <div className="gdemo-wrap" aria-label={`教學示範動畫：${f.caption}`}>
      <div className="gdemo-stage">
        <div className="gdemo-topbar">
          <span className="gdemo-dots">
            <i />
            <i />
            <i />
          </span>
          <span className="gdemo-badge">示範預覽</span>
        </div>

        <div className="gdemo-body">
          {scene === 'shortcut-step1' && (
            <div className="gdemo-phone">
              <div className="gdemo-ui-title">Aster 自動記帳</div>
              <div className={`gdemo-input${f.phase >= 1 ? ' filled' : ''}`}>
                {f.phase >= 1 ? 'https://aster.qiyen.me/api/hook/…' : '長按貼上 Aster 連結碼'}
              </div>
              <div className={`gdemo-cta${f.phase === 2 ? ' done' : ''}`}>
                {f.phase === 2 ? '已加入捷徑 ✓' : '加入捷徑'}
              </div>
            </div>
          )}

          {scene === 'shortcut-step2' && (
            <div className="gdemo-phone">
              <div className="gdemo-row">
                <span>收到通知（銀行／LINE Pay／訊息）</span>
                <span className={`gdemo-switch${f.phase >= 1 ? ' on' : ''}`}><i /></span>
              </div>
              <div className="gdemo-row">
                <span>交易（Apple Pay 錢包感應）</span>
                <span className={`gdemo-switch${f.phase >= 1 ? ' on' : ''}`}><i /></span>
              </div>
              <div className={`gdemo-pill-row${f.phase === 2 ? ' active' : ''}`}>
                <span>執行方式：</span>
                <b>立即執行</b>
              </div>
              <div className="gdemo-tabbar">
                <span>捷徑</span>
                <span className={f.phase === 0 ? 'on' : ''}>自動化</span>
                <span>資料庫</span>
              </div>
            </div>
          )}

          {scene === 'shortcut-step3' && (
            <div className="gdemo-phone">
              <div className={`gdemo-status${f.phase === 2 ? ' ok' : ''}`}>
                {f.phase === 0 && '待驗收 · 尚未收到資料'}
                {f.phase === 1 && '傳送測試封包中…'}
                {f.phase === 2 && '✅ 連線驗收通過 · 已接收 1 筆'}
              </div>
              <div className="gdemo-btn-pair">
                <span className={`gdemo-cta sm${f.phase === 0 ? ' active' : ''}`}>傳送測試</span>
                <span className="gdemo-cta sm muted">重新檢查</span>
              </div>
            </div>
          )}

          {scene === 'email-step1' && (
            <div className="gdemo-phone">
              <div className={`gdemo-input${f.phase >= 0 ? ' filled' : ''}`}>
                name@gmail.com
              </div>
              <div className="gdemo-cta sm">產生專屬轉寄地址</div>
              <div className={`gdemo-copy-box${f.phase >= 1 ? ' show' : ''}`}>
                <span>in-80feb0…@qiyen.me</span>
                <span className="gdemo-mini-btn">{f.phase === 2 ? '已複製 ✓' : '複製'}</span>
              </div>
            </div>
          )}

          {scene === 'email-step2' && (
            <div className="gdemo-browser">
              <div className="gdemo-ghead">
                <span className="gdemo-glogo">Gmail</span>
                <span className="gdemo-gsearch">設定 › 轉寄和 POP/IMAP</span>
                <span className={`gdemo-gear${f.phase === 0 ? ' active' : ''}`}>⚙</span>
              </div>
              <div className="gdemo-gcontent">
                <div className={`gdemo-gline${f.phase === 1 ? ' active' : ''}`}>
                  {f.phase >= 1 ? '已貼上 in-80feb0…@qiyen.me（維持停用轉寄）' : '點選「新增轉寄地址」'}
                </div>
                <div className={`gdemo-cta sm${f.phase === 2 ? ' done' : ''}`}>
                  {f.phase === 2 ? '前往完成 Gmail 驗證 ✓' : '等待驗證信中…'}
                </div>
              </div>
            </div>
          )}

          {scene === 'email-step3' && (
            <div className="gdemo-browser">
              <div className="gdemo-ghead">
                <span className="gdemo-glogo">Gmail</span>
                <span className={`gdemo-gsearch${f.phase >= 1 ? ' filled' : ''}`}>
                  {f.phase >= 1 ? '消費 OR 刷卡 OR LINE Pay…' : '搜尋郵件'}
                </span>
                <span className={`gdemo-gear${f.phase === 0 ? ' active' : ''}`}>▾</span>
              </div>
              <div className="gdemo-gcontent">
                <div className={`gdemo-gline${f.phase === 2 ? ' active' : ''}`}>
                  {f.phase === 2 ? '☑ 轉寄給 in-80feb0…@qiyen.me' : '包含字詞：消費 OR 刷卡 OR 付款…'}
                </div>
                <div className={`gdemo-cta sm${f.phase === 2 ? ' done' : ''}`}>
                  {f.phase === 2 ? '建立篩選器 ✓' : '下一步'}
                </div>
              </div>
            </div>
          )}

          {scene === 'email-step4' && (
            <div className="gdemo-browser">
              <div className="gdemo-gcontent" style={{ gap: 6 }}>
                <div className="gdemo-gline">主旨：刷卡消費通知 NT$ 165</div>
                <div className="gdemo-gcompose">
                  {f.phase >= 1 ? '收件人：in-80feb0…@qiyen.me' : '點選信件右下角「轉寄」'}
                </div>
                <div className="gdemo-btn-pair" style={{ justifyContent: 'space-between' }}>
                  <span className={`gdemo-cta sm${f.phase === 1 ? ' active' : ''}`}>傳送</span>
                  <span className={`gdemo-status-chip${f.phase === 2 ? ' ok' : ''}`}>
                    {f.phase === 2 ? '已連線 · 1 筆 ✓' : '轉寄'}
                  </span>
                </div>
              </div>
            </div>
          )}

          <CursorPointer x={f.cursor.x} y={f.cursor.y} click={f.cursor.click} />
        </div>

        <div className="gdemo-caption">
          <span>{f.caption}</span>
          <span className="gdemo-step-dots" aria-hidden="true">
            {frames.map((_, i) => (
              <i key={i} className={i === idx ? 'on' : ''} />
            ))}
          </span>
        </div>
      </div>
    </div>
  );
}
