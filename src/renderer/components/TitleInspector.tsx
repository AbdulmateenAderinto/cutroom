/**
 * Inspector panel for a title: text, style presets, font and look, position, timing and animation.
 */
import { useEffect, useState } from 'react';
import { EASINGS, type Easing, keyframeValue } from '../../shared/animation';
import { TITLE_KEY_PROPS, type Project, type TitleAnim, type TitleKeyProp, type TitleStyle, isHexColor } from '../../shared/model';
import { FONTS, TITLE_ANIMS, TITLE_PRESETS, findTitle, removeTitleKeyframe, setTitleKeyframe, setTitleStyle, updateTitle } from '../../shared/titles';
import { TICKS_PER_SECOND as S, formatTimecode, frameDuration, secondsToTicks, snapToFrame } from '../../shared/time';
import { usePlayhead } from '../state/playhead';
import { engine } from '../preview/engine';
import * as A from '../state/actions';
import { commit } from '../state/store';
import { NumberField, Section, Segmented, TimecodeField } from './controls';

export function TitleInspector({ id, project }: { id: string; project: Project }) {
  const t = findTitle(project, id);
  const [draft, setDraft] = useState(t?.text ?? '');
  useEffect(() => setDraft(t?.text ?? ''), [id, t?.text]);
  if (!t) return null;
  const st = t.style;
  const style = (patch: Partial<TitleStyle>) => commit((p) => setTitleStyle(p, id, patch));
  const pf = frameDuration(project.frameRate);
  const pct = (v: number) => Math.round(v * 1000) / 10;
  const saveText = () => draft !== t.text && commit((p) => updateTitle(p, id, (x) => ({ ...x, text: draft })));

  return (
    <>
      <Section title="Text">
        <textarea
          className="input title-text"
          aria-label="Title text"
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={saveText}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) (e.target as HTMLTextAreaElement).blur();
            if (e.key === 'Escape') setDraft(t.text);
          }}
        />
        <p className="muted small">Enter makes a new line; ⌘↩ or clicking away applies. Drag the text in the preview to move it.</p>
        <div className="row gap wrap">
          <button className="btn small" onClick={() => engine.seek(t.start)}>Go to start</button>
          <button className="btn small" onClick={A.splitAtPlayhead} title="S">Split at playhead</button>
          <button className="btn small" onClick={A.duplicateSelected}>Duplicate</button>
          <button className="btn small danger" onClick={() => A.deleteSelected('close-gap')}>Delete</button>
        </div>
      </Section>
      <Section title="Style">
        <span className="field-label">Start from a style (keeps your text)</span>
        <div className="row gap wrap">
          {TITLE_PRESETS.map((pr) => (
            <button
              key={pr.id}
              className="btn tiny"
              onClick={() => commit((p) => updateTitle(p, id, (x) => ({ ...x, style: { ...pr.style }, animIn: pr.animIn, animOut: pr.animOut })))}
            >
              {pr.label}
            </button>
          ))}
        </div>
        <label className="field">
          <span className="field-label">Font</span>
          <select className="input" aria-label="Font" value={st.font} onChange={(e) => style({ font: e.target.value as TitleStyle['font'] })}>
            {FONTS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </label>
        <div className="row gap">
          <NumberField label="Size" value={st.size} suffix="% of height" min={1} max={40} step={0.5} decimals={1} onCommit={(v) => style({ size: v })} />
          <label className="field">
            <span className="field-label">Weight</span>
            <select className="input" aria-label="Weight" value={st.weight} onChange={(e) => style({ weight: Number(e.target.value) })}>
              <option value={400}>Regular</option>
              <option value={600}>Semibold</option>
              <option value={700}>Bold</option>
              <option value={800}>Extra bold</option>
              <option value={900}>Black</option>
            </select>
          </label>
        </div>
        <div className="row gap center">
          <label className="field">
            <span className="field-label">Colour</span>
            <input type="color" aria-label="Text colour" value={st.color} onChange={(e) => isHexColor(e.target.value) && style({ color: e.target.value })} />
          </label>
          <label className="check"><input type="checkbox" checked={st.italic} onChange={(e) => style({ italic: e.target.checked })} />Italic</label>
          <label className="check"><input type="checkbox" checked={st.uppercase} onChange={(e) => style({ uppercase: e.target.checked })} />ALL CAPS</label>
        </div>
        <Segmented
          label="Look"
          value={st.look}
          options={[
            { value: 'plain', label: 'Plain' },
            { value: 'shadow', label: 'Shadow' },
            { value: 'outline', label: 'Outline' },
            { value: 'box', label: 'Box' },
          ]}
          onChange={(v) => style({ look: v })}
        />
        {st.look === 'box' && (
          <div className="row gap center">
            <label className="field">
              <span className="field-label">Box</span>
              <input type="color" aria-label="Box colour" value={st.boxColor} onChange={(e) => isHexColor(e.target.value) && style({ boxColor: e.target.value })} />
            </label>
            <NumberField label="Box opacity" value={Math.round(st.boxOpacity * 100)} suffix="%" min={0} max={100} step={5} onCommit={(v) => style({ boxOpacity: v / 100 })} />
          </div>
        )}
      </Section>
      <Section title="Position">
        <Segmented
          label="Align"
          value={st.align}
          options={[
            { value: 'left', label: 'Left' },
            { value: 'center', label: 'Centre' },
            { value: 'right', label: 'Right' },
          ]}
          onChange={(v) => style({ align: v, x: v === 'left' ? 0.06 : v === 'right' ? 0.94 : 0.5 })}
        />
        <div className="row gap wrap">
          <button className="btn tiny" onClick={() => style({ y: 0.12 })}>Top</button>
          <button className="btn tiny" onClick={() => style({ y: 0.5 })}>Middle</button>
          <button className="btn tiny" onClick={() => style({ y: 0.82 })}>Lower third</button>
          <button className="btn tiny" onClick={() => style({ y: 0.9 })}>Bottom</button>
        </div>
        <div className="row gap">
          <NumberField label="X" value={pct(st.x)} suffix="%" min={-50} max={150} step={1} decimals={1} onCommit={(v) => style({ x: v / 100 })} hint="Anchor across the canvas: the left edge, centre or right edge of the text depending on Align" />
          <NumberField label="Y" value={pct(st.y)} suffix="%" min={-50} max={150} step={1} decimals={1} onCommit={(v) => style({ y: v / 100 })} hint="Vertical centre of the text, from the top" />
          <NumberField label="Wrap at" value={Math.round(st.maxWidth * 100)} suffix="%" min={10} max={100} step={5} onCommit={(v) => style({ maxWidth: v / 100 })} hint="Long lines wrap at this width" />
        </div>
      </Section>
      <Section title="Timing">
        <div className="muted small">
          Row {t.row + 1} · {formatTimecode(t.start, project.frameRate)} → {formatTimecode(t.start + t.duration, project.frameRate)}
        </div>
        <TimecodeField label="Starts at" value={t.start} rate={project.frameRate} frameStep={pf}
          onCommit={(v) => commit((p) => updateTitle(p, id, (x) => ({ ...x, start: Math.max(0, v) })))} />
        <TimecodeField label="Duration" value={t.duration} rate={project.frameRate} frameStep={pf}
          onCommit={(v) => commit((p) => updateTitle(p, id, (x) => ({ ...x, duration: v })))} />
      </Section>
      <Section title="Animation">
        <div className="row gap">
          <label className="field">
            <span className="field-label">In</span>
            <select className="input" aria-label="Title animation in" value={t.animIn} onChange={(e) => commit((p) => updateTitle(p, id, (x) => ({ ...x, animIn: e.target.value as TitleAnim })))}>
              {TITLE_ANIMS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Out</span>
            <select className="input" aria-label="Title animation out" value={t.animOut} onChange={(e) => commit((p) => updateTitle(p, id, (x) => ({ ...x, animOut: e.target.value as TitleAnim })))}>
              {TITLE_ANIMS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          </label>
          <NumberField label="Length" value={Math.round((t.animLength / S) * 100) / 100} suffix="s" min={0} max={10} step={0.1} decimals={2}
            onCommit={(v) => commit((p) => updateTitle(p, id, (x) => ({ ...x, animLength: secondsToTicks(v) })))} />
        </div>
      </Section>
      <TitleKeyframes id={id} project={project} />
    </>
  );
}

const KEY_LABELS: Record<TitleKeyProp, { label: string; unit: string; toUnits: (v: number, w: number, h: number) => number; fromUnits: (v: number, w: number, h: number) => number }> = {
  x: { label: 'Move X', unit: 'px', toUnits: (v, w) => v * w, fromUnits: (v, w) => v / w },
  y: { label: 'Move Y', unit: 'px', toUnits: (v, _w, h) => v * h, fromUnits: (v, _w, h) => v / h },
  scale: { label: 'Zoom', unit: '%', toUnits: (v) => v * 100, fromUnits: (v) => v / 100 },
  opacity: { label: 'Opacity', unit: '%', toUnits: (v) => v * 100, fromUnits: (v) => v / 100 },
  rotation: { label: 'Rotate', unit: '°', toUnits: (v) => v, fromUnits: (v) => v },
};

/** Keyframed motion for a title (move, zoom, opacity, rotate), at the playhead. */
function TitleKeyframes({ id, project }: { id: string; project: Project }) {
  const time = usePlayhead((p) => p.time);
  const t = findTitle(project, id);
  if (!t) return null;
  const { width: w, height: h } = project.canvas;
  const rel = snapToFrame(time - t.start, project.frameRate, 'round');
  const inside = time >= t.start && time < t.start + t.duration;
  const all = [...new Set(TITLE_KEY_PROPS.flatMap((p) => t.keyframes?.[p] ?? []).map((k) => k.at))].sort((a, b) => a - b);
  return (
    <Section title="Motion (keyframes)">
      <div className="row gap center">
        <button className="btn tiny" disabled={!all.some((k) => k < rel)} title="Previous keyframe" onClick={() => engine.seek(t.start + [...all].reverse().find((k) => k < rel)!)}>◀ ◆</button>
        <button className="btn tiny" disabled={!all.some((k) => k > rel)} title="Next keyframe" onClick={() => engine.seek(t.start + all.find((k) => k > rel)!)}>◆ ▶</button>
      </div>
      {!inside ? (
        <p className="muted small">
          Move the playhead over this title to add keyframes. <button className="btn tiny" onClick={() => engine.seek(t.start)}>Go to title</button>
        </p>
      ) : (
        <>
          <p className="muted small">At {formatTimecode(time, project.frameRate)}. Changing a value adds a keyframe (◆) here; values in between are interpolated. Added to the style and the in/out animation.</p>
          {TITLE_KEY_PROPS.map((prop) => {
            const keys = t.keyframes?.[prop] ?? [];
            const here = keys.find((k) => k.at === rel);
            const meta = KEY_LABELS[prop];
            const def = prop === 'scale' || prop === 'opacity' ? 1 : 0;
            const shown = Math.round(meta.toUnits(keys.length ? keyframeValue(keys, rel, prop === 'y' ? 'x' : prop) : def, w, h) * 10) / 10;
            return (
              <div key={prop} className="kf-row">
                <button
                  className={`kf-diamond${here ? ' on' : ''}`}
                  aria-label={`${here ? 'Remove' : 'Add'} title ${meta.label} keyframe`}
                  title={here ? `Remove the ${meta.label} keyframe here` : `Add a ${meta.label} keyframe here with the current value`}
                  onClick={() => commit((p) => (here ? removeTitleKeyframe(p, id, prop, rel) : setTitleKeyframe(p, id, prop, rel, meta.fromUnits(shown, w, h))))}
                >
                  ◆
                </button>
                <NumberField
                  label={meta.label}
                  value={shown}
                  suffix={meta.unit}
                  step={prop === 'x' || prop === 'y' ? 10 : 5}
                  decimals={prop === 'x' || prop === 'y' ? 0 : 1}
                  onCommit={(v) => commit((p) => setTitleKeyframe(p, id, prop, rel, meta.fromUnits(v, w, h)))}
                />
                {here && (
                  <select
                    className="input kf-ease"
                    aria-label={`Title ${meta.label} easing to the next keyframe`}
                    value={here.easing}
                    onChange={(e) => commit((p) => setTitleKeyframe(p, id, prop, rel, here.value, e.target.value as Easing))}
                  >
                    {EASINGS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                )}
                {keys.length > 0 && <span className="muted small">{keys.length}◆</span>}
              </div>
            );
          })}
          {all.length > 0 && (
            <button className="btn tiny" onClick={() => commit((p) => updateTitle(p, id, (x) => { const { keyframes: _k, ...rest } = x; return rest; }))}>
              Clear all keyframes
            </button>
          )}
        </>
      )}
    </Section>
  );
}
