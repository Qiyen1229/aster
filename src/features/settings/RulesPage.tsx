/**
 * 自動分類規則：備註／商家文字 → 分類（可加標籤）。另列出「建議建立的規則」（過去常記在同一分類的文字）。
 * 沒有規則時，記帳也會依過去同樣文字最常用的分類自動帶入（商家記憶）。
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import { categoryLabel, useAccounts, useCategories } from '@/app/hooks';
import { ruleCandidates, saveRule } from '@/services/autocat';
import { ruleMatches } from '@/domain/rules';
import { useUI } from '@/stores/ui';
import { EmptyState } from '@/ui/controls';
import { Icon } from '@/ui/Icon';
import { blankRule, RULE_MATCH_LABEL, RuleEditorSheet, ruleTargetSummary, type RuleDraft } from './RuleEditorSheet';

export default function RulesPage() {
  const navigate = useNavigate();
  const { map: catMap } = useCategories();
  const { map: accMap } = useAccounts();
  const rules = useLiveQuery(() => db.rules.orderBy('priority').toArray(), []) ?? [];
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [test, setTest] = useState('');
  const [cands, setCands] = useState<Awaited<ReturnType<typeof ruleCandidates>>>([]);
  useEffect(() => { void ruleCandidates().then(setCands).catch(() => undefined); }, [rules.length]);

  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <h1>自動分類規則</h1>
        <button className="icon-btn" aria-label="新增規則" onClick={() => setDraft(blankRule())}><Icon name="plus" /></button>
      </header>
      <p className="muted" style={{ margin: '0 8px 12px', fontSize: '0.85rem' }}>
        自動記帳、備註、帳單與電子發票符合規則時，可自動改寫名稱並帶入分類或指定帳戶。沒有規則時，參考你過去同樣文字最常用的分類與帳戶。
      </p>

      {rules.length === 0 ? (
        <EmptyState emoji="🪄" title="還沒有規則" text="例如：「全聯」→ 日用品、「遠東百貨板橋分公司」→ 牛肉麵 · 晚餐。" action={<button className="btn small" onClick={() => setDraft(blankRule())}>新增規則</button>} />
      ) : (
        <div className="list">
          {rules.map((r) => (
            <button key={r.id} className="row" onClick={() => setDraft({ ...r })} style={r.enabled ? undefined : { opacity: 0.5 }}>
              <div className="row-main">
                <div className="row-title">「{r.keyword}」→ {ruleTargetSummary(r, catMap)}</div>
                <div className="row-sub">{RULE_MATCH_LABEL[r.match]} · {r.kind === 'any' ? '支出與收入' : r.kind === 'expense' ? '支出' : '收入'} · 優先 {r.priority}{r.hits ? ` · 已套用 ${r.hits} 次` : ''}{r.tagIds?.length ? ` · ${r.tagIds.length} 個標籤` : ''}{r.accountId && accMap.get(r.accountId) ? ` · 帳戶：${accMap.get(r.accountId)!.name}` : ''}</div>
              </div>
              <Icon name="chevronR" className="row-chev" />
            </button>
          ))}
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

      <div className="section-title">測試</div>
      <div className="list">
        <div className="field"><span className="label">輸入文字</span><input value={test} onChange={(e) => setTest(e.target.value)} placeholder="例如：全聯福利中心 信義店" /></div>
        {test.trim() && (
          <div className="row"><span className="row-main row-sub">
            {(() => { const hit = rules.find((r) => ruleMatches(r, test)); return hit ? `符合「${hit.keyword}」→ ${ruleTargetSummary(hit, catMap)}` : '沒有符合的規則（會改用商家記憶）'; })()}
          </span></div>
        )}
      </div>

      <RuleEditorSheet draft={draft} onChange={setDraft} onClose={() => setDraft(null)} />
    </main>
  );
}
