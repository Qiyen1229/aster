/**
 * 首次進首頁的互動式手勢教學（完成 Onboarding 後觸發一次，或從「設定 → 重看手勢教學」重開）：
 * - 手機版：聚光燈對準底部靈動島「＋」鈕，3 步實際操作後過關（上滑開 Cilo → 長按語音 → 輕點記帳與滑動分頁）
 * - 桌機寬屏：顯示快捷鍵與側邊欄操作提示卡片
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { haptic } from '@/services/haptics';
import { useSettings } from '@/stores/settings';
import { Icon } from '@/ui/Icon';

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

const STEPS = [
  {
    badge: '第 1 / 3 步・上滑手勢',
    title: '對著「＋」往上滑，喚出 Cilo 助手',
    desc: '在任何頁面按住中間「＋」鈕往上滑動，都能隨時呼叫 Cilo 查帳、改帳或問收支。現在試著把下方按鈕往上滑看看！',
    nextLabel: '我會了，下一步',
  },
  {
    badge: '第 2 / 3 步・長按手勢',
    title: '長按「＋」直接語音記帳',
    desc: '在首頁或帳目頁按住「＋」0.35 秒即可開始說話記帳，放開立刻辨識入帳。現在按住下方按鈕感受一下！',
    nextLabel: '換最後一步',
  },
  {
    badge: '第 3 / 3 步・輕點與滑動切換',
    title: '輕點「＋」記一筆，底部可左右拖曳換頁',
    desc: '平時輕點「＋」馬上開啟記一筆；手指按住底部導覽列左右拖曳，也能絲滑切換「帳戶、專案、報表、設定」。點一下下方按鈕就開始吧！',
    nextLabel: '開始記帳',
  },
] as const;

function measureFab(): Box {
  const el = document.querySelector<HTMLElement>('.dynamic-fab');
  if (el) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    }
  }
  const w = typeof window !== 'undefined' ? window.innerWidth : 390;
  const h = typeof window !== 'undefined' ? window.innerHeight : 844;
  return { left: w / 2 - 28, top: h - 82, width: 56, height: 56 };
}

export function GestureTour({ desktop }: { desktop: boolean }) {
  const setSetting = useSettings((s) => s.set);
  const [step, setStep] = useState(0);
  const [fabBox, setFabBox] = useState<Box>(measureFab);
  const [pressing, setPressing] = useState(false);
  const [doneMsg, setDoneMsg] = useState('');
  const startY = useRef(0);
  const startX = useRef(0);
  const pressingRef = useRef(false);
  const locked = useRef(false);
  const holdTimer = useRef(0);
  const stepTimer = useRef(0);

  const finish = useCallback(() => {
    window.clearTimeout(holdTimer.current);
    window.clearTimeout(stepTimer.current);
    pressingRef.current = false;
    setSetting('gestureTourDone', true);
  }, [setSetting]);

  useEffect(() => {
    const update = () => setFabBox(measureFab());
    update();
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('resize', update);
      window.clearTimeout(holdTimer.current);
      window.clearTimeout(stepTimer.current);
    };
  }, []);

  const advance = useCallback((msg: string) => {
    if (locked.current) return;
    locked.current = true;
    window.clearTimeout(holdTimer.current);
    pressingRef.current = false;
    setPressing(false);
    setDoneMsg(msg);
    stepTimer.current = window.setTimeout(() => {
      locked.current = false;
      setDoneMsg('');
      setStep((s) => {
        if (s >= STEPS.length - 1) {
          setSetting('gestureTourDone', true);
          return s;
        }
        return s + 1;
      });
    }, 450);
  }, [setSetting]);

  const onDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button > 0 || locked.current) return;
    startY.current = e.clientY;
    startX.current = e.clientX;
    pressingRef.current = true;
    setPressing(true);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (step === 1) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = window.setTimeout(() => {
        haptic('medium');
        advance('✓ 手感對了！');
      }, 350);
    }
  };

  const onMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!pressingRef.current || locked.current) return;
    const up = startY.current - e.clientY;
    const dx = Math.abs(e.clientX - startX.current);
    if (step === 0 && up > 28) {
      haptic('medium');
      advance('✓ 做到了！');
    } else if (step === 1 && (up > 24 || dx > 24)) {
      window.clearTimeout(holdTimer.current);
    }
  };

  const onUp = () => {
    window.clearTimeout(holdTimer.current);
    const wasPressing = pressingRef.current;
    pressingRef.current = false;
    setPressing(false);
    if (wasPressing && step === 2 && !locked.current) {
      haptic('light');
      finish();
    }
  };

  if (desktop) {
    return (
      <div className="tour-backdrop desktop" role="dialog" aria-modal="true" aria-label="寬屏快捷導覽">
        <div className="tour-card">
          <div className="tour-head">
            <span className="tour-badge">操作導覽</span>
            <button type="button" className="tour-skip" onClick={finish}>略過</button>
          </div>
          <h2>歡迎來到 Aster 寬屏模式</h2>
          <p className="muted">左側邊欄常駐主要導覽與快捷入口，搭配鍵盤操作更有效率：</p>
          <ul className="tour-kbd-list">
            <li><kbd className="kbd">N</kbd><span>隨時新增一筆記帳</span></li>
            <li><kbd className="kbd">/</kbd><span>快速搜尋全部帳目</span></li>
            <li><kbd className="kbd">1</kbd> – <kbd className="kbd">5</kbd><span>切換首頁、帳戶、專案、報表、設定</span></li>
            <li><span style={{ display: 'inline-grid', placeItems: 'center', width: 22, height: 22, borderRadius: 6, background: '#17181c', border: '1px solid var(--sep)', flexShrink: 0 }}><Icon name="ai" size={14} /></span><span>左側邊欄底部一鍵喚出語音記帳與 Cilo 助手</span></li>
          </ul>
          <div className="tour-actions">
            <button type="button" className="btn" onClick={finish}>開始使用</button>
          </div>
        </div>
      </div>
    );
  }

  const cur = STEPS[step];
  const cardBottom = typeof window !== 'undefined'
    ? Math.max(112, window.innerHeight - fabBox.top + 26)
    : 120;

  return (
    <div className="tour-backdrop" role="dialog" aria-modal="true" aria-label="互動式手勢教學">
      <div className="tour-card" style={{ bottom: `${cardBottom}px` }}>
        <div className="tour-head">
          <span className="tour-badge">{cur.badge}</span>
          <button type="button" className="tour-skip" onClick={finish}>略過</button>
        </div>
        <h2>{cur.title}</h2>
        <p className="muted">{cur.desc}</p>
        {doneMsg && <div className="tour-done-badge" role="status">{doneMsg}</div>}
        <div className="tour-foot">
          <div className="tour-dots" aria-hidden="true">
            {STEPS.map((_, i) => <i key={i} className={i === step ? 'on' : i < step ? 'done' : ''} />)}
          </div>
          <button
            type="button"
            className="btn small tinted"
            onClick={() => (step >= STEPS.length - 1 ? finish() : setStep((s) => s + 1))}
          >
            {cur.nextLabel}
          </button>
        </div>
      </div>

      {step === 0 && !doneMsg && (
        <div
          className="tour-swipe-hint"
          aria-hidden="true"
          style={{ left: `${fabBox.left + fabBox.width / 2}px`, top: `${fabBox.top - 10}px` }}
        >
          <Icon name="up" size={20} />
          <span>往上滑</span>
        </div>
      )}

      <button
        type="button"
        className={`tour-target${pressing ? ' pressing' : ''}${step === 1 ? ' mode-hold' : ''}`}
        aria-label={cur.title}
        style={{
          left: `${fabBox.left}px`,
          top: `${fabBox.top}px`,
          width: `${fabBox.width}px`,
          height: `${fabBox.height}px`,
        }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onContextMenu={(e) => e.preventDefault()}
      >
        <span className="tour-ring" aria-hidden="true" />
        <Icon name="plus" size={28} stroke={2.4} />
      </button>
    </div>
  );
}
