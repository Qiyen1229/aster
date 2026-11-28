/**
 * 分帳（AA 制）：選擇一起分攤的人；平均拆分（含自己）或自訂每人金額。
 * - 我先付：儲存後帳戶扣全額、收支統計只算我的份額、其他人各產生一筆「對方欠我」。
 * - 別人先付：這筆不動我的帳戶，只產生一筆「我欠先付的人」我的份額；還款時才記為支出。
 */
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import { evaluate } from '@/domain/calc-expr';
import { splitEqually } from '@/domain/debt';
import { formatMoney, fromMinor, toMinor } from '@/domain/money';
import { Sheet } from '@/ui/Sheet';
import { Segmented } from '@/ui/controls';

export interface SplitPerson {
  name: string;
  amount: string;
  debtId?: string;
  locked?: boolean;
}

export interface SplitState {
  mode: 'equal' | 'custom';
  people: SplitPerson[];
  /** 有值（含空字串）＝別人先付，值是先付的人的名字；undefined ＝我先付 */
  payer?: string;
}

/** 計算單人分攤輸入字串（支援四則運算式），空字串回傳 0，格式錯誤回傳 null */
export function evalShareMinor(raw: string, currency: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return 0;
  const val = evaluate(trimmed);
  if (!val || val.lt(0)) return null;
  return toMinor(val, currency);
}

/** 對所有未鎖定的自訂分攤金額套用服務費倍率（預設 +10%，四捨五入到幣別最小單位） */
export function applyServiceCharge(people: SplitPerson[], currency: string, rate = 1.1): SplitPerson[] {
  return people.map((p) => {
    if (p.locked || !p.amount.trim()) return p;
    const val = evaluate(p.amount.trim());
    if (!val || val.lte(0)) return p;
    const minor = toMinor(val.mul(rate), currency);
    return { ...p, amount: fromMinor(minor, currency).toString() };
  });
}

export function computeSplit(totalMinor: number, s: SplitState, currency: string): { myShare: number; shares: { name: string; minor: number; debtId?: string; locked?: boolean }[]; error?: string } {
  if (!s.people.length) return { myShare: totalMinor, shares: [] };
  if (s.payer !== undefined && !s.people.some((p) => p.name === s.payer)) {
    return { myShare: 0, shares: [], error: '請選擇是誰先付的錢' };
  }
  if (s.mode === 'equal') {
    const hasLocked = s.people.some((p) => p.locked);
    if (!hasLocked) {
      const parts = splitEqually(totalMinor, s.people.length + 1);
      return { myShare: parts[0], shares: s.people.map((p, i) => ({ name: p.name, minor: parts[i + 1], debtId: p.debtId, locked: p.locked })) };
    }
    const lockedSum = s.people.reduce((sum, p) => sum + (p.locked ? (evalShareMinor(p.amount, currency) ?? 0) : 0), 0);
    if (lockedSum > totalMinor) return { myShare: 0, shares: [], error: '總金額不可小於已結清的分攤金額' };
    const unlockedCount = s.people.filter((p) => !p.locked).length;
    const parts = splitEqually(totalMinor - lockedSum, unlockedCount + 1);
    let uIdx = 1;
    const shares = s.people.map((p) => {
      if (p.locked) return { name: p.name, minor: evalShareMinor(p.amount, currency) ?? 0, debtId: p.debtId, locked: true };
      return { name: p.name, minor: parts[uIdx++], debtId: p.debtId, locked: false };
    });
    return { myShare: parts[0], shares };
  }
  const shares: { name: string; minor: number; debtId?: string; locked?: boolean }[] = [];
  for (const p of s.people) {
    const minor = evalShareMinor(p.amount, currency);
    if (minor === null) return { myShare: 0, shares: [], error: `「${p.name}」的金額運算式有誤` };
    shares.push({ name: p.name, minor, debtId: p.debtId, locked: p.locked });
  }
  const others = shares.reduce((a, x) => a + x.minor, 0);
  if (others > totalMinor) return { myShare: 0, shares, error: '分攤金額超過總額' };
  return { myShare: totalMinor - others, shares };
}

export function SplitSheet({ open, onClose, value, onChange, totalMinor, currency, editing = false }: {
  open: boolean; onClose: () => void; value: SplitState; onChange: (s: SplitState) => void; totalMinor: number; currency: string; editing?: boolean;
}) {
  const people = useLiveQuery(() => db.people.toArray(), []) ?? [];
  const [name, setName] = useState('');
  const add = (n: string) => {
    const v = n.trim();
    if (!v || value.people.some((p) => p.name === v)) return;
    onChange({ ...value, people: [...value.people, { name: v, amount: '' }], payer: value.payer === '' ? v : value.payer });
    setName('');
  };
  const r = computeSplit(totalMinor, value, currency);
  const hasUnlockedCustom = value.mode === 'custom' && value.people.some((p) => !p.locked);
  return (
    <Sheet open={open} onClose={onClose} title="分帳" right={<button className="accent" style={{ minHeight: 44, fontWeight: 600 }} onClick={onClose}>完成</button>}>
      {!editing && (
        <Segmented value={value.payer === undefined ? 'me' : 'other'} ariaLabel="誰先付"
          onChange={(v) => onChange({ ...value, payer: v === 'me' ? undefined : (value.people[0]?.name ?? '') })}
          options={[{ value: 'me', label: '我先付' }, { value: 'other', label: '別人先付' }]} />
      )}
      <p className="muted" style={{ fontSize: '0.85rem' }}>
        {value.payer === undefined
          ? <>由我先付 {formatMoney(totalMinor, currency)}，其他人之後還我。收支統計只會計入我的份額。</>
          : <>{value.payer ? `由 ${value.payer}` : '由別人'}先付 {formatMoney(totalMinor, currency)}，我之後還他我的份額。這筆不會動到我的帳戶，還款時才記為支出。</>}
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <Segmented value={value.mode} onChange={(m) => onChange({ ...value, mode: m })} options={[{ value: 'equal', label: '平均分（含我）' }, { value: 'custom', label: '自訂金額' }]} ariaLabel="分帳方式" />
        </div>
        {hasUnlockedCustom && (
          <button type="button" className="btn small secondary" style={{ whiteSpace: 'nowrap' }}
            onClick={() => onChange({ ...value, people: applyServiceCharge(value.people, currency) })}>
            +10%
          </button>
        )}
      </div>
      <form onSubmit={(e) => { e.preventDefault(); add(name); }} style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
        <input className="input" placeholder="加入一起分的人" value={name} onChange={(e) => setName(e.target.value)} maxLength={20} />
        <button className="btn small" type="submit" disabled={!name.trim()}>加入</button>
      </form>
      {people.length > 0 && (
        <div className="sub-row">
          {people.filter((p) => !value.people.some((x) => x.name === p.name)).map((p) => <button key={p.id} className="pill" onClick={() => add(p.name)}>＋ {p.name}</button>)}
        </div>
      )}
      <div className="list">
        <div className="row"><span className="row-main">我</span><b className="num">{formatMoney(r.myShare, currency)}</b></div>
        {value.people.map((p, i) => (
          <div key={p.name} className="row">
            <span className="row-main">
              {value.payer !== undefined ? (
                <button className="pill" style={{ marginRight: 8 }} aria-pressed={value.payer === p.name}
                  onClick={() => onChange({ ...value, payer: p.name })}>{value.payer === p.name ? '✓ 先付' : '先付'}</button>
              ) : null}
              {p.name}
            </span>
            {value.mode === 'custom' ? (
              <input className="input num" style={{ width: 120, textAlign: 'right' }} inputMode="text" value={p.amount} placeholder="0 或 320+80"
                disabled={p.locked}
                aria-label={`${p.name} 分攤金額`}
                onChange={(e) => {
                  const cleaned = e.target.value.replace(/[^0-9.+\-−*×/÷()]/g, '');
                  onChange({ ...value, people: value.people.map((x, j) => (j === i ? { ...x, amount: cleaned } : x)) });
                }}
                onBlur={() => {
                  if (p.locked || !p.amount.trim()) return;
                  const minor = evalShareMinor(p.amount, currency);
                  if (minor !== null) {
                    const formatted = minor === 0 ? '' : fromMinor(minor, currency).toString();
                    if (formatted !== p.amount) {
                      onChange({ ...value, people: value.people.map((x, j) => (j === i ? { ...x, amount: formatted } : x)) });
                    }
                  }
                }} />
            ) : <span className="num">{formatMoney(r.shares[i]?.minor ?? 0, currency)}</span>}
            {p.locked ? (
              <span className="muted" style={{ fontSize: '0.75rem', padding: '0 6px' }} title="已結清的分帳項目不可修改或刪除">🔒 已結清</span>
            ) : (
              <button className="icon-btn plain" aria-label={`移除 ${p.name}`}
                onClick={() => onChange({ ...value, people: value.people.filter((_, j) => j !== i), payer: value.payer === p.name ? '' : value.payer })}>✕</button>
            )}
          </div>
        ))}
      </div>
      {r.error && <p style={{ color: 'var(--danger)' }}>{r.error}</p>}
      {value.people.length > 0 && value.mode === 'equal' && (
        <p className="muted" style={{ fontSize: '0.8rem' }}>{value.people.length + 1} 人平分，每人約 {fromMinor(r.myShare, currency).toString()}</p>
      )}
    </Sheet>
  );
}
