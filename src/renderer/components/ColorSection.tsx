/**
 * Colour adjustments for a clip: exposure, contrast, saturation, temperature, hue, lightness, and
 * curves. Dragging a slider or a curve point updates the preview live and counts as one undo step.
 */
import { useRef, useState } from 'react';
import { COLOR_LIMITS, CURVE_CHANNELS, type ColorAdjust, type ColorCurves, type CurvePoint, NEUTRAL, type Slider, curveTables, isNeutral, legalCurve } from '../../shared/color';
import type { ClipItem } from '../../shared/model';
import * as ops from '../../shared/ops';
import { beginGesture, commit, endGesture, gestureActive, updateGesture } from '../state/store';
import { Section } from './controls';

const ROWS: { key: Slider; label: string; show: (v: number) => string; step: number }[] = [
  { key: 'exposure', label: 'Exposure', show: (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)} stops`, step: 0.05 },
  { key: 'contrast', label: 'Contrast', show: (v) => `${v >= 1 ? '+' : ''}${Math.round((v - 1) * 100)}%`, step: 0.01 },
  { key: 'saturation', label: 'Saturation', show: (v) => `${Math.round(v * 100)}%`, step: 0.01 },
  { key: 'temperature', label: 'Temperature', show: (v) => (v === 0 ? 'neutral' : `${v > 0 ? 'warmer' : 'cooler'} ${Math.round(Math.abs(v) * 100)}`), step: 0.01 },
  { key: 'hue', label: 'Hue', show: (v) => `${v > 0 ? '+' : ''}${Math.round(v)}°`, step: 1 },
  { key: 'lightness', label: 'Lightness', show: (v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`, step: 0.01 },
];

const CURVE_PRESETS: { label: string; curves: ColorCurves }[] = [
  { label: 'S-curve', curves: { master: [[0.25, 0.18], [0.75, 0.82]] } },
  { label: 'Lift shadows', curves: { master: [[0, 0.06], [0.3, 0.36]] } },
  { label: 'Faded', curves: { master: [[0, 0.1], [1, 0.92]] } },
  { label: 'Teal & orange', curves: { r: [[0.3, 0.26], [0.7, 0.76]], b: [[0.3, 0.36], [0.7, 0.64]] } },
];

export function ColorSection({ clip }: { clip: ClipItem }) {
  const c = { ...NEUTRAL, ...clip.color };
  const set = (patch: Partial<ColorAdjust>) => {
    if (gestureActive()) updateGesture((p) => ops.setColor(p, clip.id, patch));
    else commit((p) => ops.setColor(p, clip.id, patch));
  };
  return (
    <Section
      title="Colour"
      actions={!isNeutral(clip.color) ? <button className="btn tiny ghost" onClick={() => commit((p) => ops.setColor(p, clip.id, { ...NEUTRAL, curves: undefined }))}>Reset</button> : undefined}
    >
      {ROWS.map((r) => (
        <div key={r.key} className="color-row">
          <span className="field-label">{r.label}</span>
          <input
            type="range"
            className="slider"
            min={COLOR_LIMITS[r.key][0]}
            max={COLOR_LIMITS[r.key][1]}
            step={r.step}
            value={c[r.key]}
            aria-label={r.label}
            onPointerDown={beginGesture}
            onPointerUp={() => endGesture()}
            onDoubleClick={() => commit((p) => ops.setColor(p, clip.id, { [r.key]: NEUTRAL[r.key] }))}
            onChange={(e) => set({ [r.key]: Number(e.target.value) })}
          />
          <span className="mono small color-value">{r.show(c[r.key])}</span>
        </div>
      ))}
      <CurvesEditor clip={clip} />
      <p className="muted small">Double-click a slider to reset it. The preview and the export use the same colour maths.</p>
    </Section>
  );
}

const SIZE = 200;
const CH_COLOURS: Record<keyof ColorCurves, string> = { master: '#e8e8e8', r: '#ff5f57', g: '#3ccf6e', b: '#4f9dff' };
const CH_LABELS: Record<keyof ColorCurves, string> = { master: 'All', r: 'Red', g: 'Green', b: 'Blue' };

/**
 * Curves: click to add a point, drag to move it, double-click (or drag off the box) to remove it.
 * The line shows the curve the export uses (curveTables).
 */
function CurvesEditor({ clip }: { clip: ClipItem }) {
  const [ch, setCh] = useState<keyof ColorCurves>('master');
  const svg = useRef<SVGSVGElement>(null);
  const curves = clip.color?.curves ?? {};
  const pts: CurvePoint[] = curves[ch] ?? [];
  const setCurve = (next: CurvePoint[], live: boolean) => {
    const patch = { curves: { ...curves, [ch]: legalCurve(next) ?? undefined } };
    if (live) updateGesture((p) => ops.setColor(p, clip.id, patch));
    else commit((p) => ops.setColor(p, clip.id, patch));
  };
  const toPt = (e: { clientX: number; clientY: number }): CurvePoint => {
    const b = svg.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)), Math.min(1, Math.max(0, 1 - (e.clientY - b.top) / b.height))];
  };
  const drag = (e: React.PointerEvent, index: number | null) => {
    e.preventDefault();
    e.stopPropagation();
    let list = [...pts];
    let i = index;
    if (i === null) {
      list = [...list, toPt(e)].sort((a, b) => a[0] - b[0]);
      i = list.findIndex((p) => p[0] === toPt(e)[0]);
    }
    beginGesture();
    setCurve(list, true);
    const target = e.currentTarget as SVGElement;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const b = svg.current!.getBoundingClientRect();
      const out = ev.clientX < b.left - 20 || ev.clientX > b.right + 20 || ev.clientY < b.top - 20 || ev.clientY > b.bottom + 20;
      const next = list.map((p, k) => (k === i ? toPt(ev) : p));
      setCurve(out ? list.filter((_, k) => k !== i) : next, true);
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      endGesture();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };
  const tables = curveTables({ ...NEUTRAL, curves: { [ch]: pts } });
  const line = (tables ? (ch === 'master' ? tables.r : tables[ch]) : null) ?? Array.from({ length: 256 }, (_, i) => i / 255);
  const d = line.map((y, i) => `${i === 0 ? 'M' : 'L'}${((i / 255) * SIZE).toFixed(1)},${((1 - y) * SIZE).toFixed(1)}`).join(' ');
  return (
    <div className="curves">
      <div className="row gap center">
        <span className="field-label">Curves</span>
        <div className="segmented" role="radiogroup" aria-label="Curve channel">
          {CURVE_CHANNELS.map((k) => (
            <button key={k} role="radio" aria-checked={ch === k} className={ch === k ? 'on' : ''} onClick={() => setCh(k)}>
              {CH_LABELS[k]}{curves[k]?.length ? ' •' : ''}
            </button>
          ))}
        </div>
      </div>
      <svg
        ref={svg}
        className="curves-box"
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="img"
        aria-label={`${CH_LABELS[ch]} curve`}
        onPointerDown={(e) => drag(e, null)}
      >
        {[1, 2, 3].map((k) => (
          <g key={k} className="curves-grid">
            <line x1={(k * SIZE) / 4} y1={0} x2={(k * SIZE) / 4} y2={SIZE} />
            <line x1={0} y1={(k * SIZE) / 4} x2={SIZE} y2={(k * SIZE) / 4} />
          </g>
        ))}
        <line className="curves-diag" x1={0} y1={SIZE} x2={SIZE} y2={0} />
        <path d={d} fill="none" stroke={CH_COLOURS[ch]} strokeWidth={2} />
        {pts.map(([x, y], i) => (
          <circle
            key={i}
            cx={x * SIZE}
            cy={(1 - y) * SIZE}
            r={6}
            className="curves-pt"
            onPointerDown={(e) => drag(e, i)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setCurve(pts.filter((_, k) => k !== i), false);
            }}
          />
        ))}
      </svg>
      <div className="row gap wrap">
        {CURVE_PRESETS.map((pr) => (
          <button key={pr.label} className="btn tiny" onClick={() => commit((p) => ops.setColor(p, clip.id, { curves: pr.curves }))}>{pr.label}</button>
        ))}
        {Object.keys(curves).length > 0 && (
          <button className="btn tiny ghost" onClick={() => commit((p) => ops.setColor(p, clip.id, { curves: undefined }))}>Straighten all</button>
        )}
      </div>
      <p className="muted small">Click to add a point, drag to move it; double-click or drag it out of the box to remove it.</p>
    </div>
  );
}
