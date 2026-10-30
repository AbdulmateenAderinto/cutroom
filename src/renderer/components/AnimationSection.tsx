/**
 * Clip inspector: Animation section — presets (in / out / motion) and keyframes at the playhead.
 */
import {
  ANIM_PROPERTIES,
  type AnimProperty,
  EASINGS,
  type Easing,
  IN_PRESETS,
  type InPreset,
  MOTION_PRESETS,
  type MotionPreset,
  OUT_PRESETS,
  keyframeValue,
} from '../../shared/animation';
import { type ClipItem, type Project, findMedia, sourceAt, timelineAt } from '../../shared/model';
import { clipLayout } from '../../shared/overlays';
import * as ops from '../../shared/ops';
import { TICKS_PER_SECOND, formatTimecode, snapToFrame } from '../../shared/time';
import { engine } from '../preview/engine';
import { usePlayhead } from '../state/playhead';
import { commit } from '../state/store';
import { NumberField, Section } from './controls';

const LABELS: Record<AnimProperty, { label: string; unit: string; hint: string }> = {
  scale: { label: 'Zoom', unit: '%', hint: 'Size relative to the framed size (100% = as framed)' },
  x: { label: 'Move X', unit: 'px', hint: 'Horizontal offset in canvas pixels, added to the framing' },
  y: { label: 'Move Y', unit: 'px', hint: 'Vertical offset in canvas pixels, added to the framing' },
  opacity: { label: 'Opacity', unit: '%', hint: '0% = invisible, 100% = fully visible' },
  rotation: { label: 'Rotate', unit: '°', hint: 'Degrees clockwise, added to the framing rotation (360 = one full turn)' },
};

export function AnimationSection({ clip, project }: { clip: ClipItem; project: Project }) {
  const time = usePlayhead((p) => p.time);
  const lay = clipLayout(project, clip.id)!;
  const media = findMedia(project, clip.mediaId)!;
  const { width: cw, height: ch } = project.canvas;
  const anim = clip.animation ?? {};
  const id = clip.id;
  const dur = lay.end - lay.start;
  const inside = time >= lay.start && time < lay.end;
  const at = snapToFrame(sourceAt(clip, lay.start, time), media.info.frameRate, 'round');
  const keysAll = ANIM_PROPERTIES.flatMap((p) => anim.keyframes?.[p] ?? []).map((k) => k.at);
  const uniq = [...new Set(keysAll)].sort((a, b) => a - b);
  const toUnits = (p: AnimProperty, v: number) => (p === 'x' ? v * cw : p === 'y' ? v * ch : p === 'rotation' ? v : v * 100);
  const fromUnits = (p: AnimProperty, v: number) => (p === 'x' ? v / cw : p === 'y' ? v / ch : p === 'rotation' ? v : v / 100);
  const seekSource = (s: number) => engine.seek(timelineAt(clip, lay.start, s));
  const sec = (t: number) => Math.round((t / TICKS_PER_SECOND) * 10) / 10;

  return (
    <Section title="Animation">
      <div className="anim-grid">
        <span className="field-label">In</span>
        <select
          className="input"
          aria-label="In animation"
          value={anim.in?.preset ?? ''}
          onChange={(e) => commit((p) => ops.setAnimation(p, id, (a) => ({ ...a, in: e.target.value ? { preset: e.target.value as InPreset, duration: a.in?.duration ?? TICKS_PER_SECOND / 2 } : undefined })))}
        >
          <option value="">None</option>
          {IN_PRESETS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        <NumberField label="" value={sec(anim.in?.duration ?? TICKS_PER_SECOND / 2)} suffix="s" min={0.1} max={10} step={0.1} decimals={1} width={52}
          hint="In-animation length in seconds"
          onCommit={(v) => anim.in && commit((p) => ops.setAnimation(p, id, (a) => ({ ...a, in: { ...a.in!, duration: Math.round(v * TICKS_PER_SECOND) } })))} />

        <span className="field-label">Out</span>
        <select
          className="input"
          aria-label="Out animation"
          value={anim.out?.preset ?? ''}
          onChange={(e) => commit((p) => ops.setAnimation(p, id, (a) => ({ ...a, out: e.target.value ? { preset: e.target.value as InPreset, duration: a.out?.duration ?? TICKS_PER_SECOND / 2 } : undefined })))}
        >
          <option value="">None</option>
          {OUT_PRESETS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        <NumberField label="" value={sec(anim.out?.duration ?? TICKS_PER_SECOND / 2)} suffix="s" min={0.1} max={10} step={0.1} decimals={1} width={52}
          hint="Out-animation length in seconds"
          onCommit={(v) => anim.out && commit((p) => ops.setAnimation(p, id, (a) => ({ ...a, out: { ...a.out!, duration: Math.round(v * TICKS_PER_SECOND) } })))} />

        <span className="field-label">Motion</span>
        <select
          className="input"
          aria-label="Motion over the whole clip"
          value={anim.motion?.preset ?? ''}
          onChange={(e) => commit((p) => ops.setAnimation(p, id, (a) => ({ ...a, motion: e.target.value ? { preset: e.target.value as MotionPreset, amount: a.motion?.amount ?? 0.5 } : undefined })))}
        >
          <option value="">None</option>
          {MOTION_PRESETS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        <NumberField label="" value={Math.round((anim.motion?.amount ?? 0.5) * 100)} suffix="%" min={0} max={100} step={5} width={52}
          hint="Motion strength"
          onCommit={(v) => anim.motion && commit((p) => ops.setAnimation(p, id, (a) => ({ ...a, motion: { ...a.motion!, amount: v / 100 } })))} />
      </div>

      <div className="kf-head">
        <span className="field-label">Keyframes</span>
        <span className="row gap">
          <button className="btn tiny" disabled={!uniq.some((k) => k < at)} title="Previous keyframe" onClick={() => seekSource([...uniq].reverse().find((k) => k < at)!)}>◀ ◆</button>
          <button className="btn tiny" disabled={!uniq.some((k) => k > at)} title="Next keyframe" onClick={() => seekSource(uniq.find((k) => k > at)!)}>◆ ▶</button>
        </span>
      </div>
      {!inside ? (
        <p className="muted small">
          Move the playhead over this clip to add keyframes.{' '}
          <button className="btn tiny" onClick={() => engine.seek(lay.start)}>Go to clip</button>
        </p>
      ) : (
        <>
          <p className="muted small">At {formatTimecode(time, project.frameRate)}. Changing a value adds a keyframe (◆) here; values in between are interpolated.</p>
          {ANIM_PROPERTIES.map((prop) => {
            const keys = anim.keyframes?.[prop] ?? [];
            const here = keys.find((k) => k.at === at);
            const meta = LABELS[prop];
            // Keyframed value only (presets are applied on top and are not baked into keyframes).
            const shown = Math.round(toUnits(prop, keyframeValue(keys, sourceAt(clip, lay.start, time), prop)) * 10) / 10;
            return (
              <div key={prop} className="kf-row">
                <button
                  className={`kf-diamond${here ? ' on' : ''}`}
                  title={here ? `Remove the ${meta.label} keyframe here` : `Add a ${meta.label} keyframe here with the current value`}
                  aria-label={`${here ? 'Remove' : 'Add'} ${meta.label} keyframe`}
                  onClick={() =>
                    commit((p) =>
                      here ? ops.removeKeyframe(p, id, prop, at) : ops.setKeyframe(p, id, prop, at, fromUnits(prop, shown)),
                    )
                  }
                >
                  ◆
                </button>
                <NumberField
                  label={meta.label}
                  value={shown}
                  suffix={meta.unit}
                  step={prop === 'x' || prop === 'y' ? 10 : 5}
                  decimals={prop === 'x' || prop === 'y' ? 0 : 1}
                  hint={meta.hint}
                  onCommit={(v) => commit((p) => ops.setKeyframe(p, id, prop, at, fromUnits(prop, v)))}
                />
                {here && (
                  <select
                    className="input kf-ease"
                    aria-label={`${meta.label} easing to the next keyframe`}
                    title="How the value moves from this keyframe to the next"
                    value={here.easing}
                    onChange={(e) => commit((p) => ops.setKeyframe(p, id, prop, at, here.value, e.target.value as Easing))}
                  >
                    {EASINGS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                )}
                {keys.length > 0 && <span className="muted small" title="Keyframes on this property">{keys.length}◆</span>}
              </div>
            );
          })}
          {uniq.length > 0 && (
            <button className="btn tiny" onClick={() => commit((p) => ops.setAnimation(p, id, (a) => ({ ...a, keyframes: undefined })))}>
              Clear all keyframes
            </button>
          )}
        </>
      )}
    </Section>
  );
}

