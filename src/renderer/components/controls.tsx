/**
 * Small reusable form controls. Values are committed on Enter or when the field loses focus;
 * Escape reverts. Arrow keys nudge numeric fields (Shift = ×10).
 */
import { type ReactNode, useEffect, useState } from 'react';
import { type Rational, type Ticks, formatTimecode, parseTimecode } from '../../shared/time';

export function TimecodeField(props: {
  label: string;
  value: Ticks;
  rate: Rational;
  onCommit: (t: Ticks) => void;
  frameStep?: Ticks;
  hint?: string;
  disabled?: boolean;
}) {
  const text = formatTimecode(props.value, props.rate);
  const [draft, setDraft] = useState(text);
  const [error, setError] = useState(false);
  useEffect(() => setDraft(text), [text]);
  const commit = () => {
    const t = parseTimecode(draft, props.rate);
    if (t === null) {
      setError(true);
      return;
    }
    setError(false);
    if (t !== props.value) props.onCommit(t);
    else setDraft(text);
  };
  return (
    <label className="field" title={props.hint ?? 'Type HH:MM:SS:FF (frames), seconds like 4.5, or frames like 90f. Press Enter to apply.'}>
      <span className="field-label">{props.label}</span>
      <span className="field-row">
        {props.frameStep !== undefined && (
          <button type="button" className="btn tiny" disabled={props.disabled} title="One frame earlier" onClick={() => props.onCommit(props.value - props.frameStep!)}>
            −1f
          </button>
        )}
        <input
          className={`input mono${error ? ' invalid' : ''}`}
          value={draft}
          disabled={props.disabled}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              setDraft(text);
              setError(false);
            }
          }}
        />
        {props.frameStep !== undefined && (
          <button type="button" className="btn tiny" disabled={props.disabled} title="One frame later" onClick={() => props.onCommit(props.value + props.frameStep!)}>
            +1f
          </button>
        )}
      </span>
      {error && <span className="field-error">Use HH:MM:SS:FF, seconds (4.5) or frames (90f)</span>}
    </label>
  );
}

export function NumberField(props: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  decimals?: number;
  hint?: string;
  width?: number;
}) {
  const fmt = (v: number) => (props.decimals !== undefined ? v.toFixed(props.decimals) : String(v));
  const [draft, setDraft] = useState(fmt(props.value));
  useEffect(() => setDraft(fmt(props.value)), [props.value]);
  const clamp = (v: number) => Math.min(props.max ?? Infinity, Math.max(props.min ?? -Infinity, v));
  const commit = (raw = draft) => {
    const v = Number(raw);
    if (!Number.isFinite(v)) return setDraft(fmt(props.value));
    const c = clamp(v);
    if (c !== props.value) props.onCommit(c);
    setDraft(fmt(c));
  };
  return (
    <label className="field" title={props.hint}>
      <span className="field-label">{props.label}</span>
      <span className="field-row">
        <input
          className="input mono"
          style={props.width ? { width: props.width } : undefined}
          inputMode="decimal"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setDraft(fmt(props.value));
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              const step = (props.step ?? 1) * (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
              const v = clamp(Number(draft) + step);
              if (Number.isFinite(v)) {
                setDraft(fmt(v));
                props.onCommit(v);
              }
            }
          }}
        />
        {props.suffix && <span className="suffix">{props.suffix}</span>}
      </span>
    </label>
  );
}

export function Segmented<T extends string>(props: {
  value: T;
  options: { value: T; label: string; hint?: string }[];
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <div className="field">
      {props.label && <span className="field-label">{props.label}</span>}
      <div className="segmented" role="radiogroup" aria-label={props.label}>
        {props.options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === props.value}
            className={o.value === props.value ? 'on' : ''}
            title={o.hint}
            onClick={() => props.onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Collapsible section for advanced settings, closed by default. */
export function Disclosure(props: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="disclosure" open={props.defaultOpen}>
      <summary>{props.title}</summary>
      <div className="disclosure-body">{props.children}</div>
    </details>
  );
}

export function Section(props: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="section">
      <header className="section-head">
        <h3>{props.title}</h3>
        {props.actions}
      </header>
      {props.children}
    </section>
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
