/**
 * 自動分類規則：備註／商家文字 → 分類（可加標籤）。
 * 包含三頁籤：規則清單（含生命週期狀態與信心度）、規則模擬器（含近 90 天歷史 Dry-run）、規則健康儀表板。
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import type { CategoryRule, RuleStatus } from '@/db/types';
import { categoryLabel, useAccounts, useCategories } from '@/app/hooks';
import { ruleCandidates, saveRule } from '@/services/autocat';
import { computeRuleConfidence } from '@/services/decisionLog';
import { CONFIDENCE_LABEL } from '@/features/inbox/InboxDecisionUI';
import { useUI } from '@/stores/ui';
import { EmptyState, Segmented } from '@/ui/controls';
import { Icon } from '@/ui/Icon';
import { blankRule, RULE_MATCH_LABEL, RuleEditorSheet, ruleTargetSummary, type RuleDraft } from './RuleEditorSheet';
import { RulesSimulatorTab } from './RulesSimulatorTab';
import { RULE_STATUS_LABEL, RulesHealthTab } from './RulesHealthTab';

type RulesTab = 'list' | 'simulator' | 'health';

function effectiveStatus(r: CategoryRule): RuleStatus {
  if (r.status === 'retired') return 'retired';
  if (r.enabled === false) return 'paused';
  return r.status ?? 'active';
}

export default function RulesPage() {
  const navigate = useNavigate();
  const { map: catMap } = useCategories();
  const { map: accMap } = useAccounts();
  const rules = (useLiveQuery(() => db.rules.orderBy('priority').toArray(), []) ?? []).filter((r) => !r.deletedAt);
  const [tab, setTab] = useState<RulesTab>('list');
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [cands, setCands] = useState<Awaited<ReturnType<typeof ruleCandidates>>>([]);
  useEffect(() => { void ruleCandidates().then(setCands).catch(() => undefined); }, [rules.length]);

  const setRuleStatus = async (r: CategoryRule, nextStatus: RuleStatus) => {
    await saveRule({
      ...r,
      status: nextStatus,
      enabled: nextStatus !== 'paused' && nextStatus !== 'retired',
      statusReason: `使用者手動切換為「${RULE_STATUS_LABEL[nextStatus]}」`,
    });
    useUI.getState().showSnack({ text: `已切換為「${RULE_STATUS_LABEL[nextStatus]}」` });
  };

  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <h1>自動分類規則</h1>
        <button className="icon-btn" aria-label="新增規則" onClick={() => setDraft(blankRule())}><Icon name="plus" /></button>
      </header>

      <div style={{ marginBottom: 12 }}>
        <Segmented
          value={tab}
          ariaLabel="規則頁籤"
          onChange={setTab}
          options={[
            { value: 'list', label: '規則清單' },
            { value: 'simulator', label: '規則模擬器' },
            { value: 'health', label: '規則健康' },
          ]}
        />
      </div>

      {tab === 'list' && (
        <>
          {rules.length === 0 ? (
            <EmptyState emoji="🪄" title="還沒有規則" text="例如：「全聯」→ 日用品、「遠東百貨板橋分公司」→ 牛肉麵 · 晚餐。" action={<button className="btn small" onClick={() => setDraft(blankRule())}>新增規則</button>} />
          ) : (
            <div className="list">
              {rules.map((r) => {
                const st = effectiveStatus(r);
                const conf = computeRuleConfidence(r);
                return (
                  <div
                    key={r.id}
                    className="row"
                    role="button"
                    tabIndex={0}
                    onClick={() => setDraft({ ...r })}
                    onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setDraft({ ...r }); } }}
                    style={{
                      cursor: 'pointer',
                      flexWrap: 'wrap',
                      rowGap: 6,
                      opacity: st === 'paused' || st === 'retired' ? 0.65 : 1,
                    }}
                  >
                    <div className="row-main">
                      <div className="row-title" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                        <span>「{r.keyword || r.merchantAlias || '情境規則'}」→ {ruleTargetSummary(r, catMap)}</span>
                        <span
                          className="pill"
                          data-testid={`rule-status-${r.id}`}
                          style={{
                            height: 22,
                            fontSize: '0.72rem',
                            padding: '0 8px',
                            background: st === 'active' ? 'var(--accent-soft)' : 'var(--surface-2)',
                            color: st === 'active' ? 'var(--accent-text)' : 'var(--text-2)',
                          }}
                        >
                          {RULE_STATUS_LABEL[st]}
                        </span>
                      </div>
                      <div className="row-sub" style={{ whiteSpace: 'normal' }}>
                        {RULE_MATCH_LABEL[r.match]} · {r.kind === 'any' ? '支出與收入' : r.kind === 'expense' ? '支出' : '收入'} · 優先 {r.priority} · 信心 {Math.round(conf.score * 100)}% ({CONFIDENCE_LABEL[conf.level]})
                        {r.hits ? ` · 已套用 ${r.hits} 次` : ''}
                        {r.tagIds?.length ? ` · ${r.tagIds.length} 個標籤` : ''}
                        {r.accountId && accMap.get(r.accountId) ? ` · 帳戶：${accMap.get(r.accountId)!.name}` : ''}
                        {r.card ? ` · 卡：${r.card}` : ''}
                        {r.source ? ` · 來源：${r.source}` : ''}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }} onClick={(ev) => ev.stopPropagation()}>
                      {st === 'shadow' && (
                        <button type="button" className="pill accent-pill" style={{ height: 28, fontSize: '0.75rem' }} onClick={() => void setRuleStatus(r, 'active')}>
                          升為啟用
                        </button>
                      )}
                      {(st === 'paused' || st === 'retired' || st === 'candidate') && (
                        <button type="button" className="pill accent-pill" style={{ height: 28, fontSize: '0.75rem' }} onClick={() => void setRuleStatus(r, 'active')}>
                          {st === 'candidate' ? '直接啟用' : '恢復啟用'}
                        </button>
                      )}
                      {st === 'active' && (
                        <button type="button" className="pill" style={{ height: 28, fontSize: '0.75rem' }} onClick={() => void setRuleStatus(r, 'paused')}>
                          暫停
                        </button>
                      )}
                      {st !== 'retired' && (
                        <button type="button" className="pill" style={{ height: 28, fontSize: '0.75rem' }} onClick={() => void setRuleStatus(r, 'retired')}>
                          停用
                        </button>
                      )}
                      <Icon name="chevronR" className="row-chev" />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {cands.length > 0 && (
            <>
              <div className="section-title">建議建立的規則</div>
              <div className="list">
                {cands.map((c) => (
                  <div key={`${c.kind}|${c.text}`} className="row">
                    <div className="row-main">
                      <div className="row-title">「{c.text}」→ {categoryLabel(catMap, c.categoryId)}</div>
                      <div className="row-sub">過去 {c.count} 筆幾乎都記在這個分類</div>
                    </div>
                    <button className="btn small tinted" onClick={() => void saveRule({ ...blankRule(c.kind, c.categoryId, c.text) }).then(() => useUI.getState().showSnack({ text: '已建立規則' }))}>建立</button>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {tab === 'simulator' && <RulesSimulatorTab />}
      {tab === 'health' && <RulesHealthTab onEditRule={(d) => setDraft(d)} />}

      <RuleEditorSheet draft={draft} onChange={setDraft} onClose={() => setDraft(null)} />
    </main>
  );
}
