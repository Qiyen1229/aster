/**
 * 智慧提醒：異常與訂閱偵測、預算預警、規則判斷不了時請 AI 查市價。
 * 偵測本機端以規則運算，不計入 AI 額度；完全符合 Aster 原生 iOS 設計規範。
 */
import { useNavigate } from 'react-router-dom';
import { AUTH_ENABLED } from '@/stores/auth';
import { useSettings } from '@/stores/settings';
import { Switch } from '@/ui/controls';
import { Icon } from '@/ui/Icon';
import { InsightsResults } from '@/features/insights/InsightsPage';
import type { AiStatus } from '@/services/ai';

export function SmartAlerts({ aiStatus }: { aiStatus?: AiStatus | null }) {
  const navigate = useNavigate();
  const insights = useSettings((s) => s.insights);
  const ai = useSettings((s) => s.ai);
  const set = useSettings((s) => s.set);

  const dataOn = !!ai?.allowData;

  return (
    <div style={{ minWidth: 0 }}>
      {/* 1. 頂部狀態卡片 */}
      <div className="list" style={{ marginTop: 4 }}>
        <div className="row with-icon">
          <span className="set-tile" style={{ ['--c' as string]: '#30D158' }} aria-hidden="true">
            <Icon name="shieldCheck" size={18} />
          </span>
          <div className="row-main">
            <div className="row-title">本機離線智慧守護</div>
            <div className="row-sub" style={{ whiteSpace: 'normal' }}>
              純端運算不耗額度，自動偵測未登記訂閱、異常漲價與預算超支。
            </div>
          </div>
        </div>
      </div>

      {/* 2. 即時防護開關 */}
      <div className="section-title">即時偵測防護</div>
      <div className="list">
        <div className="row with-icon">
          <span className="set-tile" style={{ ['--c' as string]: '#BF5AF2' }} aria-hidden="true">
            <Icon name="repeat" size={18} />
          </span>
          <div className="row-main">
            <div className="row-title">消費異常與訂閱偵測</div>
          </div>
          <Switch
            checked={insights.anomaly}
            label="消費異常與訂閱偵測"
            onChange={(v) => set('insights', { ...insights, anomaly: v })}
          />
        </div>
        <div className="row with-icon">
          <span className="set-tile" style={{ ['--c' as string]: '#FF9F0A' }} aria-hidden="true">
            <Icon name="target" size={18} />
          </span>
          <div className="row-main">
            <div className="row-title">預算進度超支預警</div>
          </div>
          <Switch
            checked={insights.budgetWarn}
            label="預算進度超支預警"
            onChange={(v) => set('insights', { ...insights, budgetWarn: v })}
          />
        </div>
        {AUTH_ENABLED && insights.anomaly && (
          <div className="row with-icon">
            <span className="set-tile" style={{ ['--c' as string]: '#0A84FF' }} aria-hidden="true">
              <Icon name="sparkles" size={18} />
            </span>
            <div className="row-main">
              <div className="row-title">疑難支出請 Cilo 比對市價</div>
            </div>
            <Switch
              checked={insights.aiPrice && !!ai?.enabled}
              label="請 Cilo 查市價"
              onChange={(v) => {
                if (ai?.enabled) set('insights', { ...insights, aiPrice: v });
                else navigate('/settings/ai');
              }}
            />
          </div>
        )}
      </div>

      {/* 3. Cilo 智慧延伸 */}
      {AUTH_ENABLED && (
        <>
          <div className="section-title">Cilo 智慧分析</div>
          <div className="list">
            {!ai?.enabled ? (
              <button type="button" className="row with-icon" onClick={() => navigate('/settings/ai')}>
                <span className="set-tile" style={{ ['--c' as string]: '#5856D6' }} aria-hidden="true">
                  <Icon name="ai" size={18} />
                </span>
                <div className="row-main">
                  <div className="row-title">Cilo 對話與進階財務分析</div>
                  <div className="row-sub">目前未啟用 · 點擊前往設定開啟</div>
                </div>
                <Icon name="chevronR" className="row-chev" />
              </button>
            ) : !dataOn ? (
              <button type="button" className="row with-icon" onClick={() => navigate('/settings/ai')}>
                <span className="set-tile" style={{ ['--c' as string]: '#FF9F0A' }} aria-hidden="true">
                  <Icon name="shieldCheck" size={18} />
                </span>
                <div className="row-main">
                  <div className="row-title">財務數據存取授權</div>
                  <div className="row-sub">問 Cilo 與財務分析需要允許存取去識別化統計 · 點擊前往授權</div>
                </div>
                <Icon name="chevronR" className="row-chev" />
              </button>
            ) : (
              <button type="button" className="row with-icon" onClick={() => navigate('/settings/ai')}>
                <span className="set-tile" style={{ ['--c' as string]: '#30D158' }} aria-hidden="true">
                  <Icon name="sparkles" size={18} />
                </span>
                <div className="row-main">
                  <div className="row-title">Cilo 分析服務運作中</div>
                  <div className="row-sub">
                    {aiStatus
                      ? `今日剩 ${aiStatus.quota.daily.remaining ?? '不限'} 次 · 本週剩 ${aiStatus.quota.weekly.remaining ?? '不限'} 次`
                      : '點擊管理 Cilo 與查看額度點數'}
                  </div>
                </div>
                <Icon name="chevronR" className="row-chev" />
              </button>
            )}
          </div>
        </>
      )}

      {/* 4. 偵測結果 */}
      <InsightsResults />
    </div>
  );
}
