/**
 * 首次使用引導（5 步）：歡迎與主幣別 → 功能介紹（最強大、最新穎的 6 個功能，見 showcase.ts）→ 外觀 → 第一個帳戶 → 範例資料。
 * 之後的新功能另外由設定裡的「新」標記與更新通知帶出（release.json）；每次發佈都要檢查有沒有資格進入功能介紹（見 showcase.ts 開頭）。
 */
import { ICON_192 } from '@/ui/assets';
import { useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { addAccount, ACCOUNT_TYPES } from '@/db/repo/accounts';
import { clearSampleData, hasSampleData, loadSampleData } from '@/db/seed/sample';
import { saveSetting } from '@/db/repo/settings';
import type { AccountType } from '@/db/types';
import { CURRENCIES, toMinor } from '@/domain/money';
import { evaluate } from '@/domain/calc-expr';
import { useSettings } from '@/stores/settings';
import { Icon } from '@/ui/Icon';
import { Segmented } from '@/ui/controls';
import { ShowcaseCarousel } from './ShowcaseCarousel';
import { ACCENTS, PALETTES } from '../settings/SettingsPage';

export default function Onboarding() {
  const s = useSettings();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const isReplay = s.onboarded || params.get('replay') === '1';
  const wasOnboarded = useRef(isReplay);
  const [step, setStep] = useState(0);
  const [accName, setAccName] = useState('錢包');
  const [accType, setAccType] = useState<AccountType>('cash');
  const [balance, setBalance] = useState('');
  const [busy, setBusy] = useState(false);
  const finishing = useRef(false);
  const step4EnteredAt = useRef(0);
  const STEPS = 5;

  const finish = async (withSample: boolean) => {
    if (finishing.current) return;
    if (withSample && performance.now() - step4EnteredAt.current < 350) return;
    finishing.current = true;
    setBusy(true);
    try {
      if (accName.trim()) {
        const info = ACCOUNT_TYPES.find((t) => t.type === accType)!;
        const v = toMinor(evaluate(balance || '0') ?? 0, s.baseCurrency);
        await addAccount({
          name: accName.trim(), type: accType, currency: s.baseCurrency, icon: info.icon, color: '#30D158',
          initialBalanceMinor: info.liability ? -Math.abs(v) : v, includeInNetWorth: true, isLiability: info.liability,
        });
      }
      if (withSample) {
        if (!(await hasSampleData())) await loadSampleData();
      } else {
        if (await hasSampleData()) await clearSampleData();
      }
      s.set('onboarded', true);
      await saveSetting('onboarded', true);
      if (!wasOnboarded.current) {
        s.set('gestureTourDone', false);
        await saveSetting('gestureTourDone', false);
      }
      navigate('/', { replace: true });
    } finally {
      finishing.current = false;
      setBusy(false);
    }
  };

  const next = () => setStep((x) => {
    const nxt = Math.min(STEPS - 1, x + 1);
    if (nxt === STEPS - 1) step4EnteredAt.current = performance.now();
    return nxt;
  });

  return (
    <main className="onb">
      <div className="onb-head">
        <div className="steps" aria-label={`第 ${step + 1} 步，共 ${STEPS} 步`}>
          {Array.from({ length: STEPS }, (_, i) => <i key={i} className={i === step ? 'on' : ''} />)}
        </div>
        {isReplay && (
          <button
            type="button"
            className="icon-btn onb-close"
            aria-label="關閉導覽"
            disabled={busy}
            onClick={() => navigate('/', { replace: true })}
          >
            <Icon name="close" size={20} />
          </button>
        )}
      </div>

      {step === 0 && (
        <>
          <img src={ICON_192} alt="" width={72} height={72} style={{ borderRadius: 16, marginTop: 8 }} />
          <h1>歡迎使用 Aster 記帳</h1>
          <p style={{ marginBottom: 8 }}>🔒 資料存在你自己的伺服器，登入的每台裝置都會同步。先選主要幣別（報表與淨資產會換算成它，之後可在設定更改）。</p>
          <div className="list" style={{ maxHeight: '44dvh', overflowY: 'auto' }}>
            {Object.values(CURRENCIES).map((c) => (
              <button key={c.code} className="row" onClick={() => s.set('baseCurrency', c.code)} aria-pressed={s.baseCurrency === c.code}>
                <span className="num" style={{ width: 48, fontWeight: 600 }}>{c.code}</span>
                <span className="row-main">{c.name}</span>
                {s.baseCurrency === c.code && <span className="accent">✓</span>}
              </button>
            ))}
          </div>
          <div className="grow" />
          <button className="btn" onClick={next}>開始設定</button>
        </>
      )}

      {step === 1 && (
        <>
          <h1>功能介紹</h1>
          <p style={{ marginBottom: 12 }}>Aster 必備技能，左右滑動看看。</p>
          <ShowcaseCarousel />
          <div className="grow" />
          <button className="btn" onClick={next}>下一步</button>
        </>
      )}

      {step === 2 && (
        <>
          <h1>挑一個喜歡的樣子</h1>
          <p>深色、淺色或跟隨系統，再選一個風格主題。</p>
          <Segmented value={s.theme} onChange={(v) => s.set('theme', v)}
            options={[{ value: 'system', label: '跟隨系統' }, { value: 'light', label: '淺色' }, { value: 'dark', label: '深色' }]} />
          <div className="palette-options" role="group" aria-label="全域風格主題" style={{ marginTop: 16 }}>
            {PALETTES.map((p) => (
              <button key={p.key} type="button" className="palette-option"
                aria-pressed={(s.themePalette ?? 'obsidian') === p.key}
                onClick={() => s.set('themePalette', p.key)}>
                <span className="palette-preview" aria-hidden="true" style={{ background: p.preview[0] }}>
                  <span className="palette-preview-card" style={{ background: p.preview[1] }}>
                    <span style={{ background: p.preview[2] }} />
                    <span style={{ background: p.preview[2] }} />
                  </span>
                </span>
                <span className="palette-name">{p.name}</span>
                <span className="palette-desc">{p.desc}</span>
              </button>
            ))}
          </div>
          {(s.themePalette ?? 'obsidian') === 'default' && (
            <div className="swatches" style={{ marginTop: 12, justifyContent: 'center' }}>
              {ACCENTS.map((a) => (
                <button key={a.key} className="swatch" style={{ ['--c' as string]: a.color, width: 44, height: 44 }} aria-pressed={s.accent === a.key}
                  aria-label={a.name} onClick={() => s.set('accent', a.key)} />
              ))}
            </div>
          )}
          <p style={{ marginTop: 16 }}>收支顏色</p>
          <Segmented value={s.upColor} onChange={(v) => s.set('upColor', v)}
            options={[{ value: 'green', label: '支出紅・收入綠' }, { value: 'red', label: '支出綠・收入紅' }]} />
          <div className="grow" />
          <button className="btn" onClick={next}>下一步</button>
        </>
      )}

      {step === 3 && (
        <>
          <h1>建立第一個帳戶</h1>
          <p>記帳時要選擇從哪個帳戶付款，先建一個最常用的吧。</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
            {ACCOUNT_TYPES.filter((t) => ['cash', 'bank', 'epay', 'credit'].includes(t.type)).map((t) => (
              <button key={t.type} className="pill" aria-pressed={accType === t.type}
                onClick={() => { setAccType(t.type); setAccName(t.type === 'cash' ? '錢包' : t.label); }}>{t.icon} {t.label}</button>
            ))}
          </div>
          <div className="list">
            <div className="field"><label htmlFor="o-name">名稱</label><input id="o-name" value={accName} onChange={(e) => setAccName(e.target.value)} /></div>
            <div className="field">
              <label htmlFor="o-bal">{accType === 'credit' ? '目前欠款' : '目前餘額'}</label>
              <input id="o-bal" inputMode="decimal" value={balance} placeholder="0" onChange={(e) => setBalance(e.target.value.replace(/[^0-9.]/g, ''))} />
            </div>
          </div>
          <div className="grow" />
          <button key="step-3-next" className="btn" onClick={next} disabled={!accName.trim()}>下一步</button>
          <button key="step-3-skip" className="btn secondary" style={{ marginTop: 8 }} onClick={() => { setAccName(''); next(); }}>略過</button>
        </>
      )}

      {step === 4 && (
        <>
          <h1>要先看看範例嗎？</h1>
          <p>載入 90 天示範帳目，體驗月曆、列表與報表。可在「設定 → 資料」一鍵清除，不影響你自己的帳。</p>
          <div className="grow" />
          <button key="step-4-blank" className="btn" disabled={busy} onClick={() => void finish(false)}>{busy ? '準備中…' : '從空白開始'}</button>
          <button key="step-4-sample" className="btn secondary" style={{ marginTop: 8 }} disabled={busy} onClick={() => void finish(true)}>{busy ? '準備中…' : '載入範例資料'}</button>
        </>
      )}

      {step > 0 && !busy && (
        <button className="muted" style={{ marginTop: 12, minHeight: 44 }} onClick={() => setStep((x) => x - 1)}>上一步</button>
      )}
    </main>
  );
}
