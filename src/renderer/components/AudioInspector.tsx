/**
 * Inspector panels for audio-track clips and audio tracks.
 */
import { useState } from 'react';
import { type AudioTrack, type Project, findMedia } from '../../shared/model';
import { audioClipDuration, findAudioClip, setAudioClip, setAudioClipFx, setAudioTrack, trimAudioClip, updateAudioClip } from '../../shared/audio';
import { AudioFxSection } from './AudioFxSection';
import { TICKS_PER_SECOND as S, formatTimecode, frameDuration, secondsToTicks } from '../../shared/time';
import { engine } from '../preview/engine';
import * as A from '../state/actions';
import { beginGesture, commit, endGesture, gestureActive, store, updateGesture } from '../state/store';
import { NumberField, Section, TimecodeField } from './controls';

function VolumeSlider({ value, label, edit }: { value: number; label: string; edit: (p: Project, v: number) => Project }) {
  return (
    <div className="row gap center">
      <input
        type="range"
        className="slider"
        min={0}
        max={200}
        value={Math.round(value * 100)}
        aria-label={label}
        onPointerDown={beginGesture}
        onPointerUp={() => endGesture()}
        onChange={(e) => {
          const v = Number(e.target.value) / 100;
          if (gestureActive()) updateGesture((p) => edit(p, v));
          else commit((p) => edit(p, v));
        }}
      />
      <span className="mono small" style={{ width: 44, textAlign: 'right' }}>{Math.round(value * 100)}%</span>
    </div>
  );
}

export function TrackSettings({ track }: { track: AudioTrack }) {
  const id = track.id;
  const [analysing, setAnalysing] = useState(false);
  const toggleDuck = async (on: boolean) => {
    if (on) {
      setAnalysing(true);
      const ok = await A.ensureSpeechAnalysis().finally(() => setAnalysing(false));
      if (!ok) return;
    }
    commit((p) => setAudioTrack(p, id, { duck: on }));
  };
  return (
    <Section title={`Track: ${track.name}`}>
      <label className="field">
        <span className="field-label">Name</span>
        <input
          className="input"
          defaultValue={track.name}
          key={track.name}
          onBlur={(e) => {
            const name = e.target.value.trim() || track.name;
            if (name !== track.name) commit((p) => setAudioTrack(p, id, { name }));
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      </label>
      <span className="field-label">Track volume</span>
      <VolumeSlider value={track.volume} label="Track volume" edit={(p, v) => setAudioTrack(p, id, { volume: v })} />
      <label className="check">
        <input type="checkbox" checked={track.muted} onChange={(e) => commit((p) => setAudioTrack(p, id, { muted: e.target.checked }))} />
        Mute track
      </label>
      <label className="check" title="Automatically lowers this track while the video has speech or other sound">
        <input type="checkbox" checked={track.duck || analysing} disabled={analysing} onChange={(e) => toggleDuck(e.target.checked)} aria-label="Lower under speech" />
        Lower under speech (ducking){analysing && <span className="muted small"> · finding speech…</span>}
      </label>
      {track.duck && (
        <NumberField label="Lower by" value={track.duckDb} suffix="dB" min={-40} max={-1} step={1} onCommit={(v) => commit((p) => setAudioTrack(p, id, { duckDb: v }))} hint="-6 dB = half as loud, -14 dB ≈ a fifth" />
      )}
      <p className="muted small">Ducking listens to the video track (analysed on this computer) and dips this track a moment before sound starts.</p>
      <button className="btn small danger" onClick={() => A.deleteSelected('close-gap')}>Delete track</button>
    </Section>
  );
}

export function AudioClipInspector({ clipId, project }: { clipId: string; project: Project }) {
  const hit = findAudioClip(project, clipId);
  if (!hit) return null;
  const { clip, track } = hit;
  const media = findMedia(project, clip.mediaId);
  const pf = frameDuration(project.frameRate);
  const sec = (t: number) => Math.round((t / S) * 100) / 100;
  return (
    <>
      <Section title="Audio clip">
        <div className="clip-title">{media?.name}</div>
        <div className="muted small">
          On “{track.name}” · {formatTimecode(clip.start, project.frameRate)} → {formatTimecode(clip.start + audioClipDuration(clip), project.frameRate)}
        </div>
        <div className="row gap wrap" style={{ marginTop: 6 }}>
          <button className="btn small" onClick={() => engine.seek(clip.start)}>Go to start</button>
          <button className="btn small" onClick={A.splitAtPlayhead} title="S">Split at playhead</button>
          <button className="btn small" onClick={A.duplicateSelected}>Duplicate</button>
          <button className="btn small danger" onClick={() => A.deleteSelected('close-gap')}>Delete</button>
        </div>
      </Section>
      <Section title="Timing">
        <TimecodeField label="Starts at (timeline)" value={clip.start} rate={project.frameRate} frameStep={pf}
          onCommit={(t) => commit((p) => updateAudioClip(p, clipId, (c) => ({ ...c, start: Math.max(0, t) })))} />
        <TimecodeField label="Source in" value={clip.sourceIn} rate={project.frameRate} frameStep={pf}
          onCommit={(t) => commit((p) => trimAudioClip(p, clipId, 'start', t - clip.sourceIn))} hint="Where in the file the clip begins (moves the clip's start with it)" />
        <TimecodeField label="Duration" value={audioClipDuration(clip)} rate={project.frameRate} frameStep={pf}
          onCommit={(t) => commit((p) => trimAudioClip(p, clipId, 'end', t - audioClipDuration(clip)))} />
      </Section>
      <Section title="Level">
        <span className="field-label">Volume (up to 200%)</span>
        <VolumeSlider value={clip.volume} label="Clip volume" edit={(p, v) => setAudioClip(p, clipId, { volume: v })} />
        <div className="row gap">
          <NumberField label="Fade in" value={sec(clip.fadeIn)} suffix="s" min={0} max={30} step={0.1} decimals={2}
            onCommit={(v) => commit((p) => setAudioClip(p, clipId, { fadeIn: secondsToTicks(v) }))} />
          <NumberField label="Fade out" value={sec(clip.fadeOut)} suffix="s" min={0} max={30} step={0.1} decimals={2}
            onCommit={(v) => commit((p) => setAudioClip(p, clipId, { fadeOut: secondsToTicks(v) }))} />
        </div>
        <p className="muted small">Tip: drag the small squares at the clip’s top corners on the timeline.</p>
        <AudioFxSection fx={clip.audioFx} mediaId={clip.mediaId} edit={(p, patch) => setAudioClipFx(p, clipId, patch)} />
      </Section>
      <TrackSettings track={track} />
      <button className="btn tiny ghost" onClick={() => store.set({ selection: null })}>Project settings</button>
    </>
  );
}
