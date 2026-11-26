import { useMemo, useState, type CSSProperties } from 'react';
import { Sheet } from './Sheet';
import { DatePickerSheet, TimePickerSheet } from '@/features/add/pickers';

export interface SelectOption<T extends string | number = string> {
  value: T;
  label: string;
  group?: string;
  disabled?: boolean;
}

export function CustomSelect<T extends string | number = string>({
  id,
  value,
  onChange,
  options,
  title,
  placeholder = '請選擇',
  disabled,
  className,
  style,
  'aria-label': ariaLabel,
}: {
  id?: string;
  value: T;
  onChange: (v: T) => void;
  options: SelectOption<T>[];
  title?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  'aria-label'?: string;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => String(o.value) === String(value));

  const grouped = useMemo(() => {
    const out: { group?: string; items: SelectOption<T>[] }[] = [];
    for (const o of options) {
      const last = out[out.length - 1];
      if (last && last.group === o.group) last.items.push(o);
      else out.push({ group: o.group, items: [o] });
    }
    return out;
  }, [options]);

  return (
    <>
      <button
        id={id}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        className={className ? `custom-select-btn ${className}` : 'custom-select-btn'}
        style={style}
        onClick={() => !disabled && setOpen(true)}
      >
        <span className="custom-select-label">{current?.label ?? placeholder}</span>
        <span className="custom-select-caret" aria-hidden="true">▾</span>
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title={title || ariaLabel || '請選擇'}>
        <div className="list">
          {grouped.map((g, gi) => (
            <div key={`${g.group ?? 'default'}-${gi}`}>
              {g.group && <div className="section-title" style={{ marginTop: gi ? 10 : 0 }}>{g.group}</div>}
              {g.items.map((o) => {
                const active = String(o.value) === String(value);
                return (
                  <button
                    key={String(o.value)}
                    type="button"
                    className="row"
                    disabled={o.disabled}
                    aria-pressed={active}
                    onClick={() => {
                      onChange(o.value);
                      setOpen(false);
                    }}
                  >
                    <span className="row-main">{o.label}</span>
                    {active && <span className="accent">✓</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </Sheet>
    </>
  );
}

export function CustomDateInput({
  id,
  value,
  onChange,
  min,
  max,
  type = 'date',
  title,
  className,
  style,
  'aria-label': ariaLabel,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  min?: string;
  max?: string;
  type?: 'date' | 'time';
  title?: string;
  className?: string;
  style?: CSSProperties;
  'aria-label'?: string;
}) {
  const [open, setOpen] = useState(false);
  const pick = (v: string) => {
    let next = v;
    if (min && next < min) next = min;
    if (max && next > max) next = max;
    onChange(next);
  };

  return (
    <>
      <button
        id={id}
        type="button"
        title={title}
        aria-label={ariaLabel}
        className={className ? `custom-select-btn num ${className}` : 'custom-select-btn num'}
        style={style}
        onClick={() => setOpen(true)}
      >
        <span className="custom-select-label">{value || (type === 'time' ? '選擇時間' : '選擇日期')}</span>
        <span className="custom-select-caret" aria-hidden="true">▾</span>
      </button>
      {type === 'time' ? (
        <TimePickerSheet open={open} value={value || '09:00'} onPick={pick} onClose={() => setOpen(false)} />
      ) : (
        <DatePickerSheet open={open} value={value} onPick={pick} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
