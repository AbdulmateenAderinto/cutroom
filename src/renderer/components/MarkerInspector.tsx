/** Inspector for a timeline marker: name, colour, time; delete. */
import { useEffect, useState } from 'react';
import { MARKER_COLORS, findMarker, updateMarker } from '../../shared/markers';
import type { Project } from '../../shared/model';
import { frameDuration } from '../../shared/time';
import { engine } from '../preview/engine';
import * as A from '../state/actions';
import { commit } from '../state/store';
import { Section, TimecodeField } from './controls';

export function MarkerInspector({ id, project }: { id: string; project: Project }) {
  const m = findMarker(project, id);
  const [draft, setDraft] = useState(m?.label ?? '');
  useEffect(() => setDraft(m?.label ?? ''), [id, m?.label]);
  if (!m) return null;
  const save = () => draft.trim() !== m.label && commit((p) => updateMarker(p, id, { label: draft.trim() || m.label }));
  return (
    <Section title="Marker">
      <label className="field">
        <span className="field-label">Name</span>
        <input
          className="input"
          aria-label="Marker name"
          value={draft}
          maxLength={200}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setDraft(m.label);
            e.stopPropagation();
          }}
        />
      </label>
      <div className="row gap center" role="group" aria-label="Marker colour">
        {MARKER_COLORS.map((c) => (
          <button
            key={c.id}
            className={`marker-swatch${m.color === c.id ? ' on' : ''}`}
            style={{ background: c.hex }}
            title={c.label}
            aria-label={c.label}
            aria-pressed={m.color === c.id}
            onClick={() => commit((p) => updateMarker(p, id, { color: c.id }))}
          />
        ))}
      </div>
      <TimecodeField
        label="Time"
        value={m.time}
        rate={project.frameRate}
        frameStep={frameDuration(project.frameRate)}
        onCommit={(t) => {
          commit((p) => updateMarker(p, id, { time: t }));
          engine.seek(t);
        }}
      />
      <p className="muted small">↑/↓ stop at markers. In the export, markers can become chapters (QuickTime, VLC and Apple TV show them).</p>
      <div className="row gap">
        <button className="btn small" onClick={() => engine.seek(m.time)}>Go to marker</button>
        <button className="btn small danger" onClick={() => A.deleteSelected('close-gap')}>Delete marker</button>
      </div>
    </Section>
  );
}
