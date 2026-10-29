/**
 * Captions: project-wide style (Project settings) and per-clip text editing (Clip panel).
 */
import { useState } from 'react';
import { type CaptionLook, DEFAULT_CAPTIONS, buildCues, replaceWords } from '../../shared/captions';
import { type ClipItem, type Project, findMedia, isHexColor, layoutSequence } from '../../shared/model';
import * as ops from '../../shared/ops';
import { formatTimecode } from '../../shared/time';
import { engine } from '../preview/engine';
import { transcribeMedia } from '../state/actions';
import { commit, store } from '../state/store';
import { NumberField, Section, Segmented } from './controls';

export function CaptionsSection({ project }: { project: Project }) {
  const c = project.captions ?? { ...DEFAULT_CAPTIONS, enabled: false };
  const set = (patch: Partial<typeof c>) => commit((p) => ops.setCaptions(p, (cur) => ({ ...cur, ...patch })));
  const onTimeline = project.media.filter((m) => project.sequence.items.some((i) => i.kind === 'clip' && i.mediaId === m.id));
  const untranscribed = onTimeline.filter((m) => !m.transcript);
  return (
    <Section title="Captions">
      <label className="check">
        <input type="checkbox" checked={c.enabled} onChange={(e) => set({ enabled: e.target.checked })} aria-label="Show captions" />
        Show captions (burned into the export)
      </label>
      {untranscribed.length > 0 && (
        <div className="banner warn small" style={{ margin: '6px 0' }}>
          {untranscribed.length} file{untranscribed.length > 1 ? 's' : ''} on the timeline {untranscribed.length > 1 ? 'have' : 'has'} no transcript.
          <button className="btn tiny" onClick={() => untranscribed.forEach((m) => transcribeMedia(m.id))}>Transcribe {untranscribed.length > 1 ? 'all' : 'it'}</button>
        </div>
      )}
      {c.enabled && (
        <>
          <Segmented<CaptionLook>
            label="Look"
            value={c.look}
            onChange={(look) => set({ look })}
            options={[
              { value: 'outline', label: 'Outline' },
              { value: 'box', label: 'Box' },
              { value: 'plain', label: 'Plain' },
            ]}
          />
          <div className="row gap">
            <NumberField label="Size" value={c.fontSize} suffix="%" min={1.5} max={15} step={0.2} decimals={1} onCommit={(fontSize) => set({ fontSize })} hint="Text height as % of the canvas height" />
            <NumberField label="Position" value={Math.round(c.position * 100)} suffix="%" min={3} max={97} step={1} onCommit={(v) => set({ position: v / 100 })} hint="0% = top, 100% = bottom" />
          </div>
          <div className="row gap center">
            <label className="field">
              <span className="field-label">Text</span>
              <input type="color" value={c.color} onChange={(e) => isHexColor(e.target.value) && set({ color: e.target.value })} />
            </label>
            <label className="check" title="Colour the word being spoken">
              <input type="checkbox" checked={!!c.highlight} onChange={(e) => set({ highlight: e.target.checked ? '#ffd23f' : null })} />
              Highlight words
            </label>
            {c.highlight && <input type="color" value={c.highlight} aria-label="Highlight colour" onChange={(e) => isHexColor(e.target.value) && set({ highlight: e.target.value })} />}
          </div>
          <label className="check">
            <input type="checkbox" checked={c.uppercase} onChange={(e) => set({ uppercase: e.target.checked })} />
            ALL CAPS
          </label>
          <p className="muted small">{buildCues(project).length} caption lines. Edit their text from a clip’s panel.</p>
        </>
      )}
    </Section>
  );
}

/** Caption lines of one clip, with editable text (edits the media's transcript). */
export function ClipCaptions({ clip, project }: { clip: ClipItem; project: Project }) {
  const media = findMedia(project, clip.mediaId)!;
  const lay = layoutSequence(project).items.find((l) => l.item.id === clip.id)!;
  const cues = buildCues(project).filter((q) => q.start >= lay.start && q.start < lay.end);
  const [editing, setEditing] = useState<number | null>(null);
  if (!media.transcript) return null;
  return (
    <details className="disclosure">
      <summary>Caption text in this clip ({cues.length})</summary>
      <div className="disclosure-body cue-list">
        {cues.length === 0 && <p className="muted small">No speech in this part of the clip.</p>}
        {cues.map((q, i) => {
          const text = q.words.map((w) => w.text).join(' ');
          const srcStart = clip.sourceIn + (q.words[0].start - lay.start);
          const srcEnd = clip.sourceIn + (q.words[q.words.length - 1].end - lay.start);
          return (
            <div key={`${q.start}-${i}`} className="cue-row">
              <button className="btn tiny ghost mono" title="Go to this line" onClick={() => engine.seek(q.start)}>
                {formatTimecode(q.start, project.frameRate).slice(3)}
              </button>
              <input
                className="input"
                defaultValue={text}
                key={text}
                aria-label={`Caption ${i + 1}`}
                onFocus={() => setEditing(i)}
                onBlur={(e) => {
                  setEditing(null);
                  const v = e.target.value.trim();
                  if (v === text) return;
                  commit((p) => {
                    const m = findMedia(p, clip.mediaId)!;
                    return ops.setTranscript(p, m.id, { ...m.transcript!, words: replaceWords(m.transcript!.words, srcStart, srcEnd, v) });
                  });
                }}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                style={editing === i ? { borderColor: 'var(--accent)' } : undefined}
              />
            </div>
          );
        })}
        <button className="btn tiny" onClick={() => store.set({ selection: null })}>Caption style…</button>
      </div>
    </details>
  );
}
