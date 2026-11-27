import { useEffect, useState } from 'react';
import type { CategoryKind, ConfidenceLevel } from '@/db/types';
import { createScopedRule } from '@/services/autocat';
import type { InboxEntry } from '@/services/inbox';
import { useUI } from '@/stores/ui';
import { Sheet } from '@/ui/Sheet';

export const CONFIDENCE_LABEL: Record<ConfidenceLevel, string> = {
  high: '高',
  medium: '中',
  low: '低',
};

export function formatDecisionReason(reason: string): string {
  if (reason === 'only_shadow_or_candidate_matched') return '觀察期規則命中（待確認）';
  if (reason === 'no_rule_matched') return '無規則命中（依商家記憶或預設）';
  if (reason === 'tie_with_different_target') return '多條規則同分衝突';
  if (reason === 'close_runner_up_different_target') return '有接近的備選規則';
  if (reason.startsWith('source:')) return `來源：${reason.slice(7)}`;
  if (reason.startsWith('card:')) return `卡片：${reason.slice(5)}`;
  if (reason.startsWith('merchantAlias:')) return `商家：${reason.slice(14)}`;
  if (reason.startsWith('rawKeyword:')) return `關鍵字：${reason.slice(11)}`;
  if (reason.startsWith('amountRange:')) return `金額區間：${reason.slice(12)}`;
  if (reason.startsWith('currency:')) return `幣別：${reason.slice(9)}`;
  if (reason.startsWith('kind:')) return `類型：${reason.slice(5) === 'income' ? '收入' : '支出'}`;
  if (reason === 'projectId:daily') return '模式：日常記帳';
  if (reason.startsWith('projectId:')) return `專案：${reason.slice(10)}`;
  return reason;
}

const CONF_COLORS: Record<ConfidenceLevel, { bg: string; fg: string }> = {
  high: { bg: 'color-mix(in srgb, var(--pos, #16a34a) 14%, transparent)', fg: 'var(--pos, #15803d)' },
  medium: { bg: 'color-mix(in srgb, var(--warning, #d97706) 15%, transparent)', fg: 'var(--warning, #b45309)' },
  low: { bg: 'var(--surface-2)', fg: 'var(--text-2)' },
};

export function InboxDecisionMeta({
  entry,
  onApplySecondCandidate,
  compact = false,
}: {
  entry: InboxEntry;
  onApplySecondCandidate?: (cand: NonNullable<InboxEntry['secondCandidate']>) => void;
  compact?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const reasons = entry.decisionReasons ?? [];
  const hasMeta = Boolean(entry.confidence || reasons.length || entry.secondCandidate || entry.shadowMatch || entry.driftWarning);
  if (!hasMeta) return null;

  const confStyle = entry.confidence ? CONF_COLORS[entry.confidence] : undefined;

  return (
    <div
      className="inbox-decision-meta"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        marginTop: compact ? 3 : 5,
        width: '100%',
        fontSize: '0.76rem',
        color: 'var(--text-2)',
      }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
        {entry.confidence && confStyle && (
          <span
            data-testid="confidence-badge"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '1px 7px',
              borderRadius: 999,
              fontSize: '0.72rem',
              fontWeight: 600,
              background: confStyle.bg,
              color: confStyle.fg,
            }}
          >
            信心 {CONFIDENCE_LABEL[entry.confidence]}
          </span>
        )}
        {reasons.length > 0 && (
          <span data-testid="decision-reason">
            {formatDecisionReason(reasons[0])}
            {reasons.length > 1 && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                style={{
                  marginLeft: 4,
                  background: 'none',
                  border: 0,
                  padding: 0,
                  color: 'var(--accent-text)',
                  fontSize: '0.72rem',
                  cursor: 'pointer',
                }}
              >
                {expanded ? '收合' : `+${reasons.length - 1} 項`}
              </button>
            )}
          </span>
        )}
      </div>

      {expanded && reasons.length > 1 && (
        <ul style={{ margin: '2px 0 0', paddingLeft: 16, fontSize: '0.73rem', lineHeight: 1.45 }}>
          {reasons.slice(1).map((r, idx) => (
            <li key={`${r}-${idx}`}>{formatDecisionReason(r)}</li>
          ))}
        </ul>
      )}

      {entry.secondCandidate && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {onApplySecondCandidate ? (
            <button
              type="button"
              className="pill"
              style={{ height: 24, fontSize: '0.72rem', padding: '0 8px' }}
              onClick={() => onApplySecondCandidate(entry.secondCandidate!)}
              title="切換為第二順位候選規則"
            >
              改用備選：{entry.secondCandidate.label}
            </button>
          ) : (
            <span>備選：{entry.secondCandidate.label}</span>
          )}
        </div>
      )}

      {entry.shadowMatch && (
        <div data-testid="shadow-match" style={{ color: 'var(--accent-text)' }}>
          🔭 觀察期預測：{entry.shadowMatch.label}
        </div>
      )}

      {entry.driftWarning && (
        <div data-testid="drift-warning" style={{ color: 'var(--warning, #b45309)' }}>
          ⚠️ 格式漂移：{entry.driftWarning}
        </div>
      )}
    </div>
  );
}

export function SplitSkipControl({
  disabled,
  onSkip,
}: {
  disabled?: boolean;
  onSkip: (reason: 'non_tx' | 'duplicate' | 'ignore') => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);

  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        className="pill"
        disabled={disabled}
        aria-label="略過"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        略過 ▾
      </button>
      {open && (
        <>
          <div
            aria-hidden="true"
            onClick={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 55 }}
          />
          <div
            role="menu"
            aria-label="選擇略過原因"
            style={{
              position: 'absolute',
              right: 0,
              top: 'calc(100% + 6px)',
              zIndex: 60,
              minWidth: 164,
              padding: 6,
              borderRadius: 14,
              background: 'var(--surface)',
              border: '0.5px solid var(--glass-border)',
              boxShadow: 'var(--shadow-lg)',
              display: 'grid',
              gap: 2,
            }}
          >
            {(
              [
                ['non_tx', '非交易', '驗證碼、廣告通知'],
                ['duplicate', '重複', '帳本已有相同項目'],
                ['ignore', '這次不記', '暫時略過不入帳'],
              ] as const
            ).map(([reason, label, sub]) => (
              <button
                key={reason}
                type="button"
                role="menuitem"
                disabled={disabled}
                onClick={() => {
                  setOpen(false);
                  void onSkip(reason);
                }}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: 1,
                  width: '100%',
                  padding: '8px 10px',
                  borderRadius: 10,
                  textAlign: 'left',
                  background: 'transparent',
                  color: 'var(--text)',
                }}
              >
                <span style={{ fontSize: '0.84rem', fontWeight: 600 }}>{label}</span>
                <span className="muted" style={{ fontSize: '0.72rem' }}>{sub}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}

export type RuleScopeMode = 'merchant' | 'card_merchant' | 'source' | 'amount_range';

export function ScopeRuleSheet({
  entry,
  onClose,
  onCreated,
}: {
  entry: InboxEntry | null;
  onClose: () => void;
  onCreated?: () => void;
}) {
  const draft = entry?.drafts[0];
  const defaultKeyword = (entry?.item.merchant || draft?.note || entry?.item.text.slice(0, 30) || '').trim();
  const defaultCard = (entry?.item.card || '').trim();
  const defaultAmount = draft?.amount ?? 0;

  const [scope, setScope] = useState<RuleScopeMode>('merchant');
  const [keyword, setKeyword] = useState(defaultKeyword);
  const [card, setCard] = useState(defaultCard);
  const [minAmount, setMinAmount] = useState('');
  const [maxAmount, setMaxAmount] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!entry) return;
    const d = entry.drafts[0];
    setScope('merchant');
    setKeyword((entry.item.merchant || d?.note || entry.item.text.slice(0, 30) || '').trim());
    setCard((entry.item.card || '').trim());
    const amt = d?.amount ?? 0;
    if (amt > 0) {
      setMinAmount(String(Math.max(0, Math.floor(amt * 0.8))));
      setMaxAmount(String(Math.ceil(amt * 1.2)));
    } else {
      setMinAmount('');
      setMaxAmount('');
    }
  }, [entry]);

  const handleSave = async () => {
    if (!entry) return;
    const kw = keyword.trim();
    if (!kw) {
      useUI.getState().showSnack({ text: '請輸入商家或關鍵字' });
      return;
    }
    const kind: CategoryKind = draft?.kind === 'income' ? 'income' : 'expense';
    const categoryId = draft?.categoryId || '';
    const accountId = draft?.accountId;

    const minVal = scope === 'amount_range' && minAmount.trim() !== '' ? Number(minAmount) : undefined;
    const maxVal = scope === 'amount_range' && maxAmount.trim() !== '' ? Number(maxAmount) : undefined;
    if (scope === 'card_merchant' && !card.trim()) {
      useUI.getState().showSnack({ text: '請輸入卡片名稱或末四碼' });
      return;
    }

    setBusy(true);
    try {
      await createScopedRule({
        keyword: kw,
        merchantAlias: scope === 'merchant' || scope === 'card_merchant' ? kw : undefined,
        card: scope === 'card_merchant' ? card.trim() : undefined,
        source: scope === 'source' ? entry.item.source : undefined,
        minAmount: minVal !== undefined && Number.isFinite(minVal) ? minVal : undefined,
        maxAmount: maxVal !== undefined && Number.isFinite(maxVal) ? maxVal : undefined,
        kind,
        categoryId,
        accountId,
        renameNote: draft?.note && draft.note !== kw ? draft.note : undefined,
        status: 'shadow',
      });
      useUI.getState().showSnack({ text: '已建立規則（進入觀察期，確認 2 次後自動啟用）' });
      onCreated?.();
      onClose();
    } catch (err) {
      useUI.getState().showSnack({ text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const scopeOptions: Array<{ id: RuleScopeMode; title: string; desc: string }> = [
    { id: 'merchant', title: '只此商家', desc: `套用到所有符合「${keyword || '...'}」的消費` },
    { id: 'card_merchant', title: '此卡＋此商家', desc: `僅限卡片「${card || '未指定'}」且符合商家時套用` },
    { id: 'source', title: '此來源', desc: `僅限來源「${entry?.item.source ?? 'notify'}」且符合關鍵字時套用` },
    { id: 'amount_range', title: '此金額區間', desc: '僅限金額落在指定區間內時套用' },
  ];

  return (
    <Sheet
      open={!!entry}
      onClose={onClose}
      title="以後這類都這樣"
      right={
        <button type="button" className="accent" disabled={busy} onClick={() => void handleSave()}>
          建立
        </button>
      }
    >
      {entry && (
        <>
          <p className="muted" style={{ fontSize: '0.82rem', margin: '0 4px 10px' }}>
            新建規則會先進入「觀察期（shadow）」，不影響自動入帳，確認兩次無誤後自動啟用。
          </p>
          <div className="list">
            {scopeOptions.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className="row"
                aria-pressed={scope === opt.id}
                onClick={() => setScope(opt.id)}
                style={{
                  textAlign: 'left',
                  background: scope === opt.id ? 'var(--accent-soft)' : undefined,
                }}
              >
                <div className="row-main">
                  <div className="row-title">{opt.title}</div>
                  <div className="row-sub">{opt.desc}</div>
                </div>
                {scope === opt.id && <span style={{ color: 'var(--accent-text)', fontWeight: 700 }}>✓</span>}
              </button>
            ))}
          </div>

          <div className="section-title">條件細節</div>
          <div className="list">
            <div className="field">
              <span className="label">商家 / 關鍵字</span>
              <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="商家名稱或關鍵字" />
            </div>
            {scope === 'card_merchant' && (
              <div className="field">
                <span className="label">卡片 / 末四碼</span>
                <input value={card} onChange={(e) => setCard(e.target.value)} placeholder="例如：玉山卡 或 8899" />
              </div>
            )}
            {scope === 'amount_range' && (
              <div className="field">
                <span className="label">金額區間</span>
                <input
                  inputMode="decimal"
                  placeholder="最低"
                  style={{ width: 84, minWidth: 0, flex: '0 1 84px', textAlign: 'right' }}
                  value={minAmount}
                  onChange={(e) => setMinAmount(e.target.value)}
                />
                <span className="muted">～</span>
                <input
                  inputMode="decimal"
                  placeholder="最高"
                  style={{ width: 84, minWidth: 0, flex: '0 1 84px', textAlign: 'right' }}
                  value={maxAmount}
                  onChange={(e) => setMaxAmount(e.target.value)}
                />
                {defaultAmount > 0 && <span className="muted" style={{ fontSize: '0.75rem' }}>原金額 {defaultAmount}</span>}
              </div>
            )}
          </div>
        </>
      )}
    </Sheet>
  );
}
