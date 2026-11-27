import { useCallback, useEffect, useState } from 'react';
import { db } from '@/db/schema';
import type { CategoryRule, RuleStatus } from '@/db/types';
import { categoryLabel, useCategories } from '@/app/hooks';
import { detectTemplateDrift, SOURCE_TEMPLATES, type DriftDetectionResult, type TemplateParseRecord } from '@/domain/sourceTemplates';
import { saveRule } from '@/services/autocat';
import { computeHealthMetrics, type HealthMetrics } from '@/services/decisionLog';
import { useUI } from '@/stores/ui';
import type { RuleDraft } from './RuleEditorSheet';

export const RULE_STATUS_LABEL: Record<RuleStatus, string> = {
  active: '啟用中',
  shadow: '觀察期',
  paused: '已暫停',
  candidate: '候選',
  retired: '已停用',
};

const pct = (n: number) => `${Math.round(n * 100)}%`;

interface UnknownMerchantItem {
  label: string;
  count: number;
}

export function RulesHealthTab({ onEditRule }: { onEditRule: (draft: RuleDraft) => void }) {
  const { map: catMap } = useCategories();
  const [metrics, setMetrics] = useState<HealthMetrics | null>(null);
  const [ruleMap, setRuleMap] = useState<Map<string, CategoryRule>>(new Map());
  const [unknownMerchants, setUnknownMerchants] = useState<UnknownMerchantItem[]>([]);
  const [drifts, setDrifts] = useState<Array<{ name: string; result: DriftDetectionResult }>>([]);
  const [loading, setLoading] = useState(true);

  const loadHealth = useCallback(async () => {
    setLoading(true);
    try {
      const now = Date.now();
      const since = now - 30 * 86_400_000;
      const [m, rules, recentDecisions, tplMeta] = await Promise.all([
        computeHealthMetrics(30, now),
        db.rules.toArray(),
        db.auto_decisions.where('ts').between(since, now, true, true).toArray(),
        db.meta.get('inbox.templateHistory').catch(() => undefined),
      ]);

      setMetrics(m);
      setRuleMap(new Map(rules.map((r) => [r.id, r])));

      const unknownAgg = new Map<string, number>();
      for (const d of recentDecisions) {
        if (d.outcome !== 'review' && d.outcome !== 'auto_booked') continue;
        if (d.matchedRuleId && d.confidenceLevel !== 'low') continue;
        const label = (d.chosen?.merchant || d.snippet || '').trim();
        if (!label) continue;
        unknownAgg.set(label, (unknownAgg.get(label) ?? 0) + 1);
      }
      setUnknownMerchants(
        [...unknownAgg.entries()]
          .map(([label, count]) => ({ label, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 8),
      );

      const history: TemplateParseRecord[] = Array.isArray(tplMeta?.value) ? tplMeta.value : [];
      const driftRows: Array<{ name: string; result: DriftDetectionResult }> = [];
      for (const tpl of SOURCE_TEMPLATES) {
        const res = detectTemplateDrift(history, { templateId: tpl.id });
        if (res.drifted) driftRows.push({ name: tpl.name, result: res });
      }
      setDrifts(driftRows);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadHealth();
  }, [loadHealth]);

  const pauseRule = async (ruleId: string) => {
    const r = ruleMap.get(ruleId) ?? (await db.rules.get(ruleId));
    if (!r) return;
    await saveRule({
      ...r,
      status: 'paused',
      enabled: false,
      statusReason: '從規則健康手動暫停',
    });
    useUI.getState().showSnack({ text: `已暫停規則「${r.keyword || r.merchantAlias || r.id}」` });
    await loadHealth();
  };

  if (loading && !metrics) {
    return <div className="card">載入健康指標中…</div>;
  }
  if (!metrics) return null;

  return (
    <div data-testid="rules-health-tab">
      <div className="card" data-testid="north-star-card" style={{ marginBottom: 12 }}>
        <div className="muted" style={{ fontSize: '0.8rem' }}>北極星指標（近 30 天）</div>
        <div style={{ fontSize: '1.65rem', fontWeight: 800, margin: '4px 0' }}>
          {pct(metrics.uneditedAutoBookRate)}
          <span style={{ fontSize: '0.9rem', fontWeight: 500, marginLeft: 8, color: 'var(--text-2)' }}>
            未修正自動入帳率
          </span>
        </div>
        <div className="muted" style={{ fontSize: '0.8rem' }}>
          自動入帳 {metrics.autoBookedCount} 筆 · 待確認 {metrics.reviewCount} 筆 · 總決策 {metrics.totalDecisions} 筆
        </div>
      </div>

      <div className="section-title">總覽與各欄位修正率</div>
      <div className="list">
        <div className="row">
          <div className="row-main">
            <div className="row-title">自動覆蓋率 / 待確認率 / 重複誤判率</div>
            <div className="row-sub">
              覆蓋 {pct(metrics.autoCoverageRate)} · 待確認 {pct(metrics.reviewRate)} · 重複誤判 {pct(metrics.duplicateFalsePositiveRate)}
            </div>
          </div>
        </div>
        <div className="row">
          <div className="row-main">
            <div className="row-title">各欄位修正率</div>
            <div className="row-sub" style={{ whiteSpace: 'normal' }}>
              分類 {pct(metrics.fieldEditRates.category)} · 帳戶 {pct(metrics.fieldEditRates.account)} · 金額 {pct(metrics.fieldEditRates.amount)} · 幣別 {pct(metrics.fieldEditRates.currency)} · 日期 {pct(metrics.fieldEditRates.date)}
            </div>
          </div>
        </div>
      </div>

      <div className="section-title">最常被改的規則</div>
      {metrics.mostEditedRules.length === 0 ? (
        <div className="card muted" style={{ fontSize: '0.84rem' }}>近 30 天沒有被頻繁修正的規則。</div>
      ) : (
        <div className="list">
          {metrics.mostEditedRules.map((item) => {
            const fullRule = ruleMap.get(item.ruleId);
            const st: RuleStatus = fullRule?.enabled === false ? 'paused' : (item.status ?? fullRule?.status ?? 'active');
            return (
              <div key={item.ruleId} className="row">
                <div className="row-main">
                  <div className="row-title">
                    「{item.keyword || fullRule?.merchantAlias || item.ruleId}」
                    <span className="pill" style={{ marginLeft: 6, height: 22, fontSize: '0.72rem' }}>
                      {RULE_STATUS_LABEL[st]}
                    </span>
                  </div>
                  <div className="row-sub">
                    修正 {item.editCount} 次 · 撤銷 {item.rejectCount} 次
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {st !== 'paused' && (
                    <button type="button" className="pill" onClick={() => void pauseRule(item.ruleId)}>
                      暫停
                    </button>
                  )}
                  {fullRule && (
                    <button type="button" className="pill" onClick={() => onEditRule({ ...fullRule })}>
                      編輯
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="section-title">候選衝突（{metrics.candidateConflicts.length}）</div>
      {metrics.candidateConflicts.length === 0 ? (
        <div className="card muted" style={{ fontSize: '0.84rem' }}>近期沒有規則衝突。</div>
      ) : (
        <div className="list">
          {metrics.candidateConflicts.slice(0, 8).map((c) => (
            <div key={c.decisionId} className="row">
              <div className="row-main">
                <div className="row-title">{c.snippet || '（無摘要）'}</div>
                <div className="row-sub" style={{ whiteSpace: 'normal' }}>
                  {c.candidateCount} 條規則衝突 · 建議分類：{c.categoryIds.map((id) => categoryLabel(catMap, id)).join(' / ') || '無'}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="section-title">未知商家（{unknownMerchants.length}）</div>
      {unknownMerchants.length === 0 ? (
        <div className="card muted" style={{ fontSize: '0.84rem' }}>近 30 天沒有低信心未知商家。</div>
      ) : (
        <div className="list">
          {unknownMerchants.map((u) => (
            <div key={u.label} className="row">
              <div className="row-main">
                <div className="row-title">{u.label}</div>
                <div className="row-sub">近 30 天低信心 / 未命中 {u.count} 次</div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="section-title">格式漂移警示</div>
      {drifts.length === 0 ? (
        <div className="card muted" style={{ fontSize: '0.84rem' }}>目前各銀行／支付通知格式正常，無漂移警示。</div>
      ) : (
        <div className="list">
          {drifts.map((d) => (
            <div key={d.name} className="row">
              <div className="row-main">
                <div className="row-title">⚠️ {d.name}</div>
                <div className="row-sub" style={{ whiteSpace: 'normal' }}>
                  {d.result.reason || `失敗率 ${pct(d.result.recentFailureRate)}`}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
