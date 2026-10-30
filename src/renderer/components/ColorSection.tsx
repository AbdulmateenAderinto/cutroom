/**
 * Colour adjustments for a clip: exposure, contrast, saturation, temperature.
 * Dragging a slider updates the preview live and counts as one undo step.
 */
import { COLOR_LIMITS, type ColorAdjust, NEUTRAL, isNeutral } from '../../shared/color';
import type { ClipItem } from '../../shared/model';
import * as ops from '../../shared/ops';
import { beginGesture, commit, endGesture, gestureActive, updateGesture } from '../state/store';
import { Section } from './controls';

const ROWS: { key: keyof ColorAdjust; label: string; show: (v: number) => string; step: number }[] = [
  { key: 'exposure', label: 'Exposure', show: (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)} stops`, step: 0.05 },
  { key: 'contrast', label: 'Contrast', show: (v) => `${v >= 1 ? '+' : ''}${Math.round((v - 1) * 100)}%`, step: 0.01 },
  { key: 'saturation', label: 'Saturation', show: (v) => `${Math.round(v * 100)}%`, step: 0.01 },
  { key: 'temperature', label: 'Temperature', show: (v) => (v === 0 ? 'neutral' : `${v > 0 ? 'warmer' : 'cooler'} ${Math.round(Math.abs(v) * 100)}`), step: 0.01 },
];

export function ColorSection({ clip }: { clip: ClipItem }) {
  const c = clip.color ?? NEUTRAL;
  const set = (patch: Partial<ColorAdjust>) => {
    if (gestureActive()) updateGesture((p) => ops.setColor(p, clip.id, patch));
    else commit((p) => ops.setColor(p, clip.id, patch));
  };
  return (
    <Section
      title="Colour"
      actions={!isNeutral(clip.color) ? <button className="btn tiny ghost" onClick={() => commit((p) => ops.setColor(p, clip.id, NEUTRAL))}>Reset</button> : undefined}
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
      <p className="muted small">Double-click a slider to reset it. The preview and the export use the same colour maths.</p>
    </Section>
  );
}
