import {
  type ClipItem,
  type FramingMode,
  type GapItem,
  type MediaRef,
  type Project,
  fillScale,
  findMedia,
  fitScale,
  isHexColor,
  layoutSequence,
  toManualFraming,
} from '../../shared/model';
import * as ops from '../../shared/ops';
import { COMMON_FRAME_RATES, formatDuration, formatTimecode, frameDuration, rateLabel, sameRate } from '../../shared/time';
import * as A from '../state/actions';
import { beginGesture, commit, endGesture, gestureActive, store, updateGesture, useStore } from '../state/store';
import { findAudioClip } from '../../shared/audio';
import { AnimationSection } from './AnimationSection';
import { AudioClipInspector, TrackSettings } from './AudioInspector';
import { CaptionsSection } from './CaptionsSection';
import { SmartTools } from './SmartTools';
import { CanvasControl } from './TopBar';
import { Disclosure, NumberField, Section, Segmented, TimecodeField, formatBytes } from './controls';

/** A range input whose whole drag is one undo step. */
function ProjectSlider(props: { value: number; min: number; max: number; label: string; disabled?: boolean; edit: (p: Project, v: number) => Project }) {
  return (
    <input
      type="range"
      className="slider"
      min={props.min}
      max={props.max}
      value={props.value}
      disabled={props.disabled}
      aria-label={props.label}
      onPointerDown={beginGesture}
      onPointerUp={() => endGesture()}
      onChange={(e) => {
        const v = Number(e.target.value);
        if (gestureActive()) updateGesture((p) => props.edit(p, v));
        else commit((p) => props.edit(p, v));
      }}
    />
  );
}

function MediaDetails({ m }: { m: MediaRef }) {
  const i = m.info;
  const visual = i.kind !== 'audio';
  const rows: [string, string][] = [
    ['File', m.path],
    ['Container', i.container.split(',')[0]],
    ...(i.kind === 'image'
      ? ([
          ['Photo', `${i.videoCodec.toUpperCase()} · ${i.displayWidth}×${i.displayHeight}${i.rotation ? ` · rotated ${i.rotation}° (EXIF)` : ''}${i.hasAlpha ? ' · transparent' : ''}`],
          ['Clip length', 'Any — 4 s when added; drag its end to change'],
        ] as [string, string][])
      : visual
      ? ([
          ['Video', `${i.videoCodec.toUpperCase()} · ${i.width}×${i.height}${i.rotation ? ` · rotated ${i.rotation}°` : ''} · ${i.pixFmt}`],
          ['Shown as', `${i.displayWidth}×${i.displayHeight}`],
          ['Frame rate', `${rateLabel(i.frameRate)} fps${i.isVFR ? ` (variable, avg ${rateLabel(i.avgFrameRate)})` : ''}`],
        ] as [string, string][])
      : []),
    ...(i.kind === 'image' ? [] : ([['Duration', formatDuration(i.duration)]] as [string, string][])),
    ['Audio', i.hasAudio ? `${i.audioCodec?.toUpperCase()} · ${i.audioSampleRate} Hz · ${i.audioChannels} ch` : 'none'],
    ['Size', formatBytes(i.fileSize)],
  ];
  if (i.colorTransfer) rows.push(['Transfer', i.colorTransfer]);
  return (
    <dl className="details">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
      {m.warnings.map((w) => (
        <div key={w} className="warn-text">⚠ {w}</div>
      ))}
    </dl>
  );
}

function ClipInspector({ clip, project }: { clip: ClipItem; project: Project }) {
  const media = findMedia(project, clip.mediaId)!;
  const missing = useStore((s) => !!s.missing[clip.mediaId]);
  const rate = project.frameRate;
  const pf = frameDuration(rate);
  const lay = layoutSequence(project).items.find((l) => l.item.id === clip.id)!;
  const { width: cw, height: ch } = project.canvas;
  const { displayWidth: sw, displayHeight: sh } = media.info;
  const id = clip.id;

  const setMode = (mode: FramingMode) => {
    if (mode === clip.framing.mode) return;
    const f = mode === 'manual' ? toManualFraming(sw, sh, cw, ch, clip.framing) : { ...clip.framing, mode };
    commit((p) => ops.setFraming(p, id, f));
  };
  const manual = clip.framing.mode === 'manual' ? clip.framing : null;
  const fill = fillScale(sw, sh, cw, ch) / fitScale(sw, sh, cw, ch);

  return (
    <>
      <Section title="Clip">
        <div className="clip-title">{media.name}</div>
        {missing && (
          <div className="banner warn small">
            Source file is offline. <button className="btn tiny" onClick={() => A.relink(media.id)}>Relink…</button>
          </div>
        )}
        <div className="muted small">
          Timeline {formatTimecode(lay.start, rate)} → {formatTimecode(lay.end, rate)}
        </div>
      </Section>

      <Section title="Trim">
        <p className="muted small">Source time = position inside the original file. Drag clip edges on the timeline, or type exact values.</p>
        <TimecodeField
          label="Source in"
          value={clip.sourceIn}
          rate={media.info.frameRate}
          frameStep={frameDuration(media.info.frameRate)}
          onCommit={(t) => commit((p) => ops.setClipRange(p, id, t, clip.sourceOut, 'out'))}
          hint="First frame used from the source file (keeps the out point)."
        />
        <TimecodeField
          label="Source out"
          value={clip.sourceOut}
          rate={rate}
          frameStep={pf}
          onCommit={(t) => commit((p) => ops.setClipRange(p, id, clip.sourceIn, t, 'in'))}
          hint="Where the clip ends in the source file (exclusive)."
        />
        <TimecodeField
          label="Duration"
          value={clip.sourceOut - clip.sourceIn}
          rate={rate}
          frameStep={pf}
          onCommit={(t) => commit((p) => ops.setClipRange(p, id, clip.sourceIn, clip.sourceIn + t, 'in'))}
          hint="Length on the timeline. Later clips move to follow (ripple)."
        />
        <div className="muted small">Source file length: {formatTimecode(media.info.duration, media.info.frameRate)}</div>
      </Section>

      <Section title="Framing">
        <Segmented<FramingMode>
          value={clip.framing.mode}
          onChange={setMode}
          options={[
            { value: 'fit', label: 'Fit', hint: 'Show the whole image; empty space is filled with the background colour' },
            { value: 'fill', label: 'Fill', hint: 'Cover the whole canvas; edges of the image are cropped' },
            { value: 'manual', label: 'Manual', hint: 'Set position and scale yourself' },
          ]}
        />
        <p className="muted small">
          {clip.framing.mode === 'fit' && 'Whole image visible. Padding uses the project background colour.'}
          {clip.framing.mode === 'fill' && 'Canvas fully covered; overflow is cropped. Proportions are kept.'}
          {clip.framing.mode === 'manual' && 'Drag the image in the preview, or type values. 100% = Fit size.'}
        </p>
        {manual && (
          <>
            <div className="row gap">
              <NumberField
                label="Scale"
                value={Math.round(manual.scale * 1000) / 10}
                suffix="%"
                min={5}
                max={2000}
                step={1}
                decimals={1}
                onCommit={(v) => commit((p) => ops.setFraming(p, id, { ...manual, scale: v / 100 }))}
              />
            </div>
            <ProjectSlider
              label="Scale"
              min={5}
              max={400}
              value={Math.min(400, Math.round(manual.scale * 100))}
              edit={(p, v) => ops.setFraming(p, id, { ...manual, scale: v / 100 })}
            />
            <div className="row gap">
              <NumberField
                label="X offset"
                value={Math.round(manual.x * cw)}
                suffix="px"
                step={1}
                hint="Horizontal offset of the image centre from the canvas centre, in canvas pixels"
                onCommit={(v) => commit((p) => ops.setFraming(p, id, { ...manual, x: v / cw }))}
              />
              <NumberField
                label="Y offset"
                value={Math.round(manual.y * ch)}
                suffix="px"
                step={1}
                hint="Vertical offset of the image centre from the canvas centre, in canvas pixels"
                onCommit={(v) => commit((p) => ops.setFraming(p, id, { ...manual, y: v / ch }))}
              />
            </div>
            <div className="row gap wrap">
              <button className="btn small" onClick={() => commit((p) => ops.setFraming(p, id, { ...manual, x: 0, y: 0 }))}>Centre</button>
              <button className="btn small" onClick={() => commit((p) => ops.setFraming(p, id, { ...manual, scale: 1 }))}>Fit size</button>
              <button className="btn small" onClick={() => commit((p) => ops.setFraming(p, id, { ...manual, scale: fill }))}>Fill size</button>
            </div>
          </>
        )}
      </Section>

      <AnimationSection clip={clip} project={project} />

      <SmartTools clip={clip} project={project} />

      <Section title="Audio">
        {media.info.hasAudio ? (
          <>
            <label className="check">
              <input type="checkbox" checked={clip.muted} onChange={(e) => commit((p) => ops.setClipAudio(p, id, { muted: e.target.checked }))} />
              Mute this clip
            </label>
            <div className="row gap center">
              <ProjectSlider
                label="Volume"
                min={0}
                max={200}
                value={Math.round(clip.volume * 100)}
                disabled={clip.muted}
                edit={(p, v) => ops.setClipAudio(p, id, { volume: v / 100 })}
              />
              <span className="mono small">{Math.round(clip.volume * 100)}%</span>
            </div>
            <p className="muted small">Up to 200% (boost).</p>
          </>
        ) : (
          <p className="muted small">This clip’s source file has no audio. Silence is exported for its duration.</p>
        )}
      </Section>

      <Section title="Actions">
        <div className="row gap wrap">
          <button className="btn small" onClick={A.splitAtPlayhead} title="S">Split at playhead</button>
          <button className="btn small" onClick={A.duplicateSelected} title="⌘D">Duplicate</button>
          <button className="btn small danger" onClick={() => A.deleteSelected('close-gap')} title="Delete">Delete (close gap)</button>
          <button className="btn small" onClick={() => A.deleteSelected('leave-gap')} title="Shift+Delete">Delete, leave gap</button>
        </div>
      </Section>

      <Disclosure title="Source details">
        <MediaDetails m={media} />
      </Disclosure>
    </>
  );
}

function GapInspector({ gap, project }: { gap: GapItem; project: Project }) {
  const pf = frameDuration(project.frameRate);
  return (
    <Section title="Gap">
      <p className="muted small">Empty space: exported as the background colour with silence.</p>
      <TimecodeField
        label="Duration"
        value={gap.duration}
        rate={project.frameRate}
        frameStep={pf}
        onCommit={(t) => commit((p) => ops.setGapDuration(p, gap.id, t))}
      />
      <button className="btn small danger" onClick={() => A.deleteSelected('close-gap')}>Remove gap</button>
    </Section>
  );
}

function MediaInspector({ m }: { m: MediaRef }) {
  const missing = useStore((s) => !!s.missing[m.id]);
  return (
    <>
      <Section title="Media file">
        <div className="clip-title">{m.name}</div>
        <div className="row gap wrap">
          {!missing && <button className="btn small primary" onClick={() => A.addMediaToTimeline(m.id)}>+ Add to timeline</button>}
          <button className="btn small" onClick={() => A.relink(m.id)}>{missing ? 'Relink…' : 'Replace file…'}</button>
          <button className="btn small danger" onClick={() => A.removeMedia(m.id)}>Remove from project</button>
        </div>
      </Section>
      <Section title="Details">
        <MediaDetails m={m} />
      </Section>
    </>
  );
}

function ProjectSettings({ project }: { project: Project }) {
  const rateKnown = COMMON_FRAME_RATES.find((r) => sameRate(r.rate, project.frameRate));
  return (
    <>
      <Section title="Project">
        <label className="field">
          <span className="field-label">Name</span>
          <input
            className="input"
            defaultValue={project.name}
            key={project.id + project.name}
            onBlur={(e) => {
              const name = e.target.value.trim() || 'Untitled';
              if (name !== project.name) commit((p) => ({ ...p, name }));
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        </label>
      </Section>
      <Section title="Canvas">
        <p className="muted small">The shape and pixel size of your video. Each clip’s framing (Fit/Fill/Manual) is kept when this changes.</p>
        <CanvasControl />
        <label className="field">
          <span className="field-label">Background (padding & gaps)</span>
          <span className="field-row">
            <input
              type="color"
              value={project.background}
              onChange={(e) => isHexColor(e.target.value) && commit((p) => ({ ...p, background: e.target.value }))}
            />
            <span className="mono small">{project.background}</span>
          </span>
        </label>
      </Section>
      <CaptionsSection project={project} />
      <Section title="Timing">
        <label className="field" title="All cuts snap to this frame grid. Export can use a different rate.">
          <span className="field-label">Frame rate</span>
          <select
            className="input"
            value={rateKnown?.label ?? 'other'}
            onChange={(e) => {
              const r = COMMON_FRAME_RATES.find((x) => x.label === e.target.value);
              if (r) commit((p) => ops.setFrameRate(p, r.rate));
            }}
          >
            {!rateKnown && <option value="other">{rateLabel(project.frameRate)} fps</option>}
            {COMMON_FRAME_RATES.map((r) => (
              <option key={r.label} value={r.label}>
                {r.label} fps
              </option>
            ))}
          </select>
        </label>
        <p className="muted small">Changing it re-snaps clip lengths to the new frame grid (each moves by under half a frame).</p>
      </Section>
      <Section title="Audio">
        <p className="muted small">48 kHz stereo (fixed in this version). Mono sources play on both channels.</p>
      </Section>
      <p className="muted small hint">Select a clip on the timeline to edit its trim, framing and volume.</p>
    </>
  );
}

export function Inspector() {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const item = selection?.kind === 'item' ? project.sequence.items.find((i) => i.id === selection.id) : undefined;
  const media = selection?.kind === 'media' ? findMedia(project, selection.id) : undefined;
  const audioClip = selection?.kind === 'audio' ? findAudioClip(project, selection.id) : null;
  const audioTrack = selection?.kind === 'audioTrack' ? project.audioTracks?.find((t) => t.id === selection.id) : undefined;
  const title = item?.kind === 'clip' ? 'Clip properties' : item?.kind === 'gap' ? 'Gap' : media ? 'Media'
    : audioClip ? 'Audio clip' : audioTrack ? 'Audio track' : 'Project settings';
  const anything = item || media || audioClip || audioTrack;
  return (
    <aside className="panel inspector">
      <header className="panel-head">
        <h2>{title}</h2>
        {anything && (
          <button className="btn tiny ghost" onClick={() => store.set({ selection: null })} title="Deselect (Esc) to see project settings">
            Project settings
          </button>
        )}
      </header>
      <div className="panel-body">
        {item?.kind === 'clip' && <ClipInspector clip={item} project={project} />}
        {item?.kind === 'gap' && <GapInspector gap={item} project={project} />}
        {media && <MediaInspector m={media} />}
        {audioClip && <AudioClipInspector clipId={audioClip.clip.id} project={project} />}
        {audioTrack && <TrackSettings track={audioTrack} />}
        {!anything && <ProjectSettings project={project} />}
      </div>
    </aside>
  );
}
