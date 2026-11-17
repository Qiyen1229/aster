/**
 * 專案與預算（Tab 2）：整合為 3 大主題分頁（預算｜週期與借貸｜專案與資產）。
 * 各主題內提供專屬二級分段控制，清晰獨立呈現各區塊（包含耐用品、借貸、專案、目標等），
 * 並完整保留所有舊網址與通知連結相容（?tab=installment / debt / project / wish / durable）。
 */
import { lazy, Suspense, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { SkeletonRows } from '@/ui/controls';
import { Icon } from '@/ui/Icon';
import { useScreenDetail } from '@/stores/screenContext';

const BudgetSection = lazy(() => import('./budgets'));
const ProjectSection = lazy(() => import('./projects'));
const RecurringSection = lazy(() => import('./recurring'));
const InstallmentSection = lazy(() => import('./installments'));
const DebtSection = lazy(() => import('./debts'));
const GoalSection = lazy(() => import('./goals'));
const WishlistSection = lazy(() => import('./wishlist'));
const DurableSection = lazy(() => import('./durables'));

const TABS = [
  { key: 'budget', label: '預算' },
  { key: 'recurring', label: '週期與分期' },
  { key: 'debt', label: '應收應付' },
  { key: 'project', label: '專案' },
  { key: 'goal', label: '目標' },
  { key: 'durable', label: '耐用品' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

export default function PlanPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab') ?? 'budget';

  const tab: TabKey = useMemo(() => {
    if (raw === 'debt') return 'debt';
    if (raw === 'recurring' || raw === 'installment') return 'recurring';
    if (raw === 'durable') return 'durable';
    if (raw === 'goal' || raw === 'wish') return 'goal';
    if (raw === 'project' || raw === 'assets') return 'project';
    return 'budget';
  }, [raw]);

  const setTab = (k: TabKey) => {
    params.set('tab', k);
    setParams(params, { replace: true });
  };

  const currentLabel = TABS.find((t) => t.key === tab)?.label ?? '預算';
  useScreenDetail(tab === 'budget' ? null : `專案與預算 → ${currentLabel}`);

  return (
    <main className="page plan-page">
      <h1 className="large-title" style={{ marginTop: 12 }}>專案與預算</h1>

      <div className="sub-row" role="tablist" aria-label="規劃分頁" style={{ marginBottom: 12, overflowX: 'auto', flexWrap: 'nowrap', paddingBottom: 4 }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`pill${tab === t.key ? ' accent-pill' : ''}`}
            style={{ flex: 'none' }}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <Suspense fallback={<SkeletonRows />}>
        {tab === 'budget' && <BudgetSection />}
        {tab === 'recurring' && <><RecurringSection /><InstallmentSection /></>}
        {tab === 'debt' && <DebtSection />}
        {tab === 'project' && <ProjectSection />}
        {tab === 'goal' && <><GoalSection /><WishlistSection /></>}
        {tab === 'durable' && <DurableSection />}
      </Suspense>
    </main>
  );
}

/** 區塊標題列：標題＋新增按鈕 */
export function SectionHead({ title, onAdd, addLabel = '新增' }: { title: string; onAdd?: () => void; addLabel?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '14px 4px 8px' }}>
      <h2 style={{ margin: 0, fontSize: '1.08rem' }}>{title}</h2>
      {onAdd && <button className="btn small tinted" onClick={onAdd}><Icon name="plus" size={16} />{addLabel}</button>}
    </div>
  );
}
