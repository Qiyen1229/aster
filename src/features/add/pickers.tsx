/**
 * 記帳面板用的選擇器（皆為巢狀 Bottom Sheet）：帳戶、幣別、標籤、專案。
 */
import { useEffect, useRef, useState } from 'react';
import { db, uid } from '@/db/schema';
import type { Account, Project, Tag } from '@/db/types';
import { CURRENCIES } from '@/domain/money';
import { addDays, fromDateKey, monthGrid, pad2, todayKey } from '@/domain/period';
import { haptic } from '@/services/haptics';
import { useSettings } from '@/stores/settings';
import { Sheet } from '@/ui/Sheet';
import { Amount } from '@/ui/controls';
import { CatIcon, Icon } from '@/ui/Icon';
import { CATEGORY_COLORS } from '@/db/seed/categories';
import { accountTypeInfo } from '@/db/repo/accounts';
import { lifeLabel } from '@/domain/durable';

export function AccountPicker({ open, onClose, accounts, value, onPick, title = '選擇帳戶', exclude }: {
  open: boolean; onClose: () => void; accounts: Account[]; value?: string; onPick: (id: string) => void; title?: string; exclude?: string;
}) {
  const list = accounts.filter((a) => a.id !== exclude);
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      {list.length === 0 ? (
        <p className="muted" style={{ textAlign: 'center' }}>尚無其他帳戶，請先到「帳戶」頁新增。</p>
      ) : (
        <div className="list">
          {list.map((a) => (
            <button key={a.id} className="row with-icon" onClick={() => { onPick(a.id); onClose(); }} aria-pressed={a.id === value}>
              <span className="cat-icon sm" style={{ ['--c' as string]: a.color }} aria-hidden="true"><CatIcon icon={a.icon} size={16} /></span>
              <div className="row-main">
                <div className="row-title">{a.name}</div>
                <div className="row-sub">{accountTypeInfo(a.type).label} · {a.currency}</div>
              </div>
              <Amount minor={a.balanceMinor} currency={a.currency} tone="none" className="row-value" />
              {a.id === value && <Icon name="check" className="accent" />}
            </button>
          ))}
        </div>
      )}
    </Sheet>
  );
}

export function CurrencyPicker({ open, onClose, value, onPick }: { open: boolean; onClose: () => void; value: string; onPick: (c: string) => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="選擇幣別">
      <div className="list">
        {Object.values(CURRENCIES).map((c) => (
          <button key={c.code} className="row" onClick={() => { onPick(c.code); onClose(); }}>
            <span className="num" style={{ width: 44, fontWeight: 600 }}>{c.code}</span>
            <span className="row-main">{c.name}</span>
            <span className="muted">{c.symbol}</span>
            {c.code === value && <Icon name="check" className="accent" />}
          </button>
        ))}
      </div>
    </Sheet>
  );
}

export function TagPicker({ open, onClose, tags, value, onChange }: {
  open: boolean; onClose: () => void; tags: Tag[]; value: string[]; onChange: (ids: string[]) => void;
}) {
  const [name, setName] = useState('');
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  const create = async () => {
    const n = name.trim();
    if (!n) return;
    const exist = tags.find((t) => t.name === n);
    if (exist) { if (!value.includes(exist.id)) onChange([...value, exist.id]); setName(''); return; }
    const now = Date.now();
    const tag: Tag = { id: uid(), name: n, color: CATEGORY_COLORS[tags.length % CATEGORY_COLORS.length], sort: tags.length, createdAt: now, updatedAt: now };
    await db.tags.add(tag);
    onChange([...value, tag.id]);
    setName('');
  };
  return (
    <Sheet open={open} onClose={onClose} title="標籤" right={<button className="accent" style={{ minHeight: 44, fontWeight: 600 }} onClick={onClose}>完成</button>}>
      <form onSubmit={(e) => { e.preventDefault(); void create(); }} style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input className="input" placeholder="新增標籤，例如：出差、約會" value={name} onChange={(e) => setName(e.target.value)} maxLength={20} />
        <button className="btn small" type="submit" disabled={!name.trim()}>新增</button>
      </form>
      {tags.length === 0 ? (
        <p className="muted" style={{ textAlign: 'center' }}>還沒有標籤。一筆帳可以有多個標籤，方便日後篩選。</p>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {tags.map((t) => (
            <button key={t.id} className="pill" aria-pressed={value.includes(t.id)} onClick={() => toggle(t.id)}>
              <span style={{ width: 8, height: 8, borderRadius: 4, background: t.color }} />{t.name}
            </button>
          ))}
        </div>
      )}
    </Sheet>
  );
}

export function ProjectPicker({ open, onClose, projects, value, onPick }: {
  open: boolean; onClose: () => void; projects: Project[]; value?: string; onPick: (id: string) => void;
}) {
  const active = projects.filter((p) => p.status === 'active');
  return (
    <Sheet open={open} onClose={onClose} title="專案">
      <div className="list">
        <button className="row" onClick={() => { onPick(''); onClose(); }}>
          <span className="row-main">不屬於任何專案</span>
          {!value && <Icon name="check" className="accent" />}
        </button>
        {active.map((p) => (
          <button key={p.id} className="row" onClick={() => { onPick(p.id); onClose(); }}>
            <span aria-hidden="true"><CatIcon icon={p.icon} size={16} /></span>
            <span className="row-main">{p.name}</span>
            {p.id === value && <Icon name="check" className="accent" />}
          </button>
        ))}
      </div>
      {active.length === 0 && <p className="muted" style={{ textAlign: 'center' }}>專案管理將於階段 2 推出。</p>}
    </Sheet>
  );
}

export function DurablePicker({
  open,
  onClose,
  value,
  custom,
  onPick,
  onCustom,
}: {
  open: boolean;
  onClose: () => void;
  value: number;
  custom: number;
  onPick: (years: number) => void;
  onCustom: () => void;
}) {
  const presets = [1, 2, 3, 5, 7, 10];
  return (
    <Sheet open={open} onClose={onClose} title="標記為耐用品">
      <p className="muted" style={{ fontSize: '0.84rem', margin: '0 4px 12px' }}>
        設定預計使用期限，自動計算每日持有成本（手機、筆電、機車、家電等）。
      </p>
      <div className="list">
        <button
          type="button"
          className="row"
          onClick={() => { onPick(0); onClose(); }}
          aria-pressed={value === 0}
        >
          <span className="row-main">不追蹤（一般支出）</span>
          {value === 0 && <Icon name="check" className="accent" />}
        </button>

        {presets.map((y) => (
          <button
            key={y}
            type="button"
            className="row"
            onClick={() => { onPick(y); onClose(); }}
            aria-pressed={value === y && value !== custom}
          >
            <span className="row-main">預計使用 {y} 年</span>
            {value === y && value !== custom && <Icon name="check" className="accent" />}
          </button>
        ))}

        {custom > 0 && (
          <button
            type="button"
            className="row"
            onClick={() => { onPick(custom); onClose(); }}
            aria-pressed={value === custom}
          >
            <span className="row-main">自訂：{lifeLabel(custom)}</span>
            {value === custom && <Icon name="check" className="accent" />}
          </button>
        )}

        <button
          type="button"
          className="row accent"
          onClick={() => { onClose(); onCustom(); }}
        >
          <Icon name="edit" size={16} />
          <span className="row-main">{custom > 0 ? '修改自訂期限…' : '自訂使用期限…'}</span>
        </button>
      </div>
    </Sheet>
  );
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 60 }, (_, i) => i);
const QUICK_MINUTES = [0, 15, 30, 45];

function parseYM(key: string) {
  const d = fromDateKey(key || todayKey());
  return { y: d.getFullYear(), m0: d.getMonth() };
}

function parseHM(value: string): [number, number] {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(value.trim());
  if (m) {
    const h = Math.min(23, Math.max(0, Number(m[1])));
    const min = Math.min(59, Math.max(0, Number(m[2])));
    return [h, min];
  }
  const now = new Date();
  return [now.getHours(), now.getMinutes()];
}

export function DatePickerSheet({ open, value, onPick, onClose }: {
  open: boolean;
  value: string;
  onPick: (date: string) => void;
  onClose: () => void;
}) {
  const weekStart = useSettings((s) => s.weekStart);
  const [ym, setYm] = useState(() => parseYM(value));

  useEffect(() => {
    if (open) setYm(parseYM(value));
  }, [open, value]);

  const today = todayKey();
  const quickDays = [
    { label: '前天', key: addDays(today, -2) },
    { label: '昨天', key: addDays(today, -1) },
    { label: '今天', key: today },
  ];

  const shiftMonth = (delta: number) => {
    haptic('light');
    setYm((prev) => {
      const next = new Date(prev.y, prev.m0 + delta, 1);
      return { y: next.getFullYear(), m0: next.getMonth() };
    });
  };

  const weekdayLabels = Array.from({ length: 7 }, (_, i) => WEEKDAYS[(weekStart + i) % 7]);
  const cells = monthGrid(ym.y, ym.m0, weekStart);

  return (
    <Sheet open={open} onClose={onClose} title="選擇日期">
      <div className="dp-body">
        <div className="dp-quick">
          {quickDays.map((q) => (
            <button
              key={q.label}
              type="button"
              className={`dp-chip${value === q.key ? ' active' : ''}`}
              onClick={() => { haptic('light'); onPick(q.key); onClose(); }}
            >
              {q.label}
            </button>
          ))}
        </div>

        <div className="dp-head">
          <button type="button" className="icon-btn" aria-label="上個月" onClick={() => shiftMonth(-1)}>
            <Icon name="chevLeft" size={18} />
          </button>
          <strong className="num">{ym.y} 年 {ym.m0 + 1} 月</strong>
          <button type="button" className="icon-btn" aria-label="下個月" onClick={() => shiftMonth(1)}>
            <Icon name="chevRight" size={18} />
          </button>
        </div>

        <div className="dp-weekdays" aria-hidden="true">
          {weekdayLabels.map((w) => <span key={w}>{w}</span>)}
        </div>

        <div className="dp-grid" role="grid" aria-label="日曆">
          {cells.map((c) => (
            <button
              key={c.key}
              type="button"
              className={`dp-cell num${c.inMonth ? '' : ' out'}${c.key === today ? ' today' : ''}${c.key === value ? ' selected' : ''}`}
              aria-label={c.key}
              aria-pressed={c.key === value}
              onClick={() => { haptic('light'); onPick(c.key); onClose(); }}
            >
              {c.day}
            </button>
          ))}
        </div>
      </div>
    </Sheet>
  );
}

export function TimePickerSheet({ open, value, onPick, onClose }: {
  open: boolean;
  value: string;
  onPick: (time: string) => void;
  onClose: () => void;
}) {
  const [[hour, minute], setHM] = useState<[number, number]>(() => parseHM(value));
  const hourRef = useRef<HTMLDivElement>(null);
  const minRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setHM(parseHM(value));
    const id = window.requestAnimationFrame(() => {
      hourRef.current?.querySelector('.tp-opt.selected')?.scrollIntoView?.({ block: 'center' });
      minRef.current?.querySelector('.tp-opt.selected')?.scrollIntoView?.({ block: 'center' });
    });
    return () => window.cancelAnimationFrame(id);
  }, [open, value]);

  const applyNow = () => {
    haptic('light');
    const now = new Date();
    onPick(`${pad2(now.getHours())}:${pad2(now.getMinutes())}`);
    onClose();
  };

  const confirm = () => {
    haptic('light');
    onPick(`${pad2(hour)}:${pad2(minute)}`);
    onClose();
  };

  return (
    <Sheet open={open} onClose={onClose} title="選擇時間">
      <div className="tp-body">
        <div className="tp-preview num" aria-live="polite">
          {pad2(hour)}:{pad2(minute)}
        </div>

        <div className="tp-quick">
          {QUICK_MINUTES.map((qm) => (
            <button
              key={qm}
              type="button"
              className={`dp-chip num${minute === qm ? ' active' : ''}`}
              onClick={() => { haptic('light'); setHM(([h]) => [h, qm]); }}
            >
              :{pad2(qm)}
            </button>
          ))}
        </div>

        <div className="tp-cols">
          <div className="tp-col-wrap">
            <div className="tp-col-label">時</div>
            <div className="tp-col" ref={hourRef} role="listbox" aria-label="小時">
              {HOURS.map((h) => (
                <button
                  key={h}
                  type="button"
                  role="option"
                  aria-selected={hour === h}
                  className={`tp-opt num${hour === h ? ' selected' : ''}`}
                  onClick={() => { haptic('light'); setHM(([, m]) => [h, m]); }}
                >
                  {pad2(h)}
                </button>
              ))}
            </div>
          </div>

          <div className="tp-col-wrap">
            <div className="tp-col-label">分</div>
            <div className="tp-col" ref={minRef} role="listbox" aria-label="分鐘">
              {MINUTES.map((m) => (
                <button
                  key={m}
                  type="button"
                  role="option"
                  aria-selected={minute === m}
                  className={`tp-opt num${minute === m ? ' selected' : ''}`}
                  onClick={() => { haptic('light'); setHM(([h]) => [h, m]); }}
                >
                  {pad2(m)}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="tp-actions">
          <button type="button" className="btn ghost" onClick={applyNow}>現在</button>
          <button type="button" className="btn primary" onClick={confirm}>確定</button>
        </div>
      </div>
    </Sheet>
  );
}

