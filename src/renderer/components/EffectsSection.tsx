/** Blur and mask for a clip (preview and export use the same definitions: shared/effects.ts). */
import { type ClipMask, MAX_BLUR } from '../../shared/effects';
import type { ClipItem, MediaRef } from '../../shared/model';
import * as ops from '../../shared/ops';
import { beginGesture, commit, endGesture, gestureActive, updateGesture } from '../state/store';
import { NumberField, Section, Segmented } from './controls';

export function EffectsSection({ clip, media }: { clip: ClipItem; media: MediaRef }) {
  const id = clip.id;
  const fx = clip.effects ?? {};
  const m = fx.mask;
  const live = (patch: Parameters<typeof ops.setEffects>[2]) => {
    if (gestureActive()) updateGesture((p) => ops.setEffects(p, id, patch));
    else commit((p) => ops.setEffects(p, id, patch));
  };
  const setMask = (patch: Partial<ClipMask>) => commit((p) => ops.setEffects(p, id, { mask: { ...(m ?? DEFAULT_MASK), ...patch } }));
  // A circle on this picture: the same size in pixels across and down.
  const { displayWidth: sw, displayHeight: sh } = media.info;
  const d = 0.9 * Math.min(sw, sh);
  const presets: { label: string; mask: ClipMask }[] = [
    { label: 'Circle', mask: { shape: 'ellipse', x: 0.5, y: 0.5, w: d / sw, h: d / sh, feather: 0.02 } },
    { label: 'Soft oval', mask: { shape: 'ellipse', x: 0.5, y: 0.5, w: 0.9, h: 0.9, feather: 0.3 } },
    { label: 'Vignette', mask: { shape: 'ellipse', x: 0.5, y: 0.5, w: 1.5, h: 1.5, feather: 0.5 } },
    { label: 'Letterbox', mask: { shape: 'rect', x: 0.5, y: 0.5, w: 1.2, h: 0.75, feather: 0 } },
  ];
  const pct = (v: number) => Math.round(v * 1000) / 10;
  return (
    <Section title="Effects">
      <div className="color-row">
        <span className="field-label">Blur</span>
        <input
          type="range"
          className="slider"
          min={0}
          max={100}
          step={1}
          aria-label="Blur"
          value={Math.round(((fx.blur ?? 0) / MAX_BLUR) * 100)}
          onPointerDown={beginGesture}
          onPointerUp={() => endGesture()}
          onDoubleClick={() => commit((p) => ops.setEffects(p, id, { blur: undefined }))}
          onChange={(e) => live({ blur: (Number(e.target.value) / 100) * MAX_BLUR })}
        />
        <span className="mono small color-value">{Math.round(((fx.blur ?? 0) / MAX_BLUR) * 100)}</span>
      </div>
      <Segmented<'none' | 'ellipse' | 'rect'>
        label="Mask"
        value={m?.shape ?? 'none'}
        onChange={(v) => commit((p) => ops.setEffects(p, id, { mask: v === 'none' ? undefined : { ...(m ?? DEFAULT_MASK), shape: v } }))}
        options={[
          { value: 'none', label: 'None' },
          { value: 'ellipse', label: 'Ellipse', hint: 'Only the inside of an ellipse is shown' },
          { value: 'rect', label: 'Rectangle', hint: 'Only the inside of a rectangle is shown' },
        ]}
      />
      <div className="row gap wrap">
        {presets.map((pr) => (
          <button key={pr.label} className="btn tiny" onClick={() => commit((p) => ops.setEffects(p, id, { mask: pr.mask }))}>{pr.label}</button>
        ))}
      </div>
      {m && (
        <>
          <div className="row gap">
            <NumberField label="Centre X" value={pct(m.x)} suffix="%" step={1} decimals={1} onCommit={(v) => setMask({ x: v / 100 })} />
            <NumberField label="Centre Y" value={pct(m.y)} suffix="%" step={1} decimals={1} onCommit={(v) => setMask({ y: v / 100 })} />
          </div>
          <div className="row gap">
            <NumberField label="Width" value={pct(m.w)} suffix="%" min={1} max={200} step={1} decimals={1} onCommit={(v) => setMask({ w: v / 100 })} />
            <NumberField label="Height" value={pct(m.h)} suffix="%" min={1} max={200} step={1} decimals={1} onCommit={(v) => setMask({ h: v / 100 })} />
          </div>
          <div className="color-row">
            <span className="field-label">Soft edge</span>
            <input
              type="range"
              className="slider"
              min={0}
              max={50}
              step={1}
              aria-label="Mask soft edge"
              value={Math.round(m.feather * 100)}
              onPointerDown={beginGesture}
              onPointerUp={() => endGesture()}
              onChange={(e) => live({ mask: { ...m, feather: Number(e.target.value) / 100 } })}
            />
            <span className="mono small color-value">{Math.round(m.feather * 100)}%</span>
          </div>
          {m.shape === 'ellipse' && (
            <label className="check">
              <input type="checkbox" checked={!!m.invert} onChange={(e) => setMask({ invert: e.target.checked })} />
              Invert (hide the inside)
            </label>
          )}
          <p className="muted small">Positions and sizes are fractions of the picture, so the mask moves, scales and rotates with it. Outside the mask the clip is see-through (the background or the tracks below show).</p>
        </>
      )}
    </Section>
  );
}

const DEFAULT_MASK: ClipMask = { shape: 'ellipse', x: 0.5, y: 0.5, w: 0.8, h: 0.8, feather: 0.05 };
