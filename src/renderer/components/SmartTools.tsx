/**
 * Clip inspector: Smart tools — find pauses / scene changes, review them on the timeline, apply.
 * Analysis runs locally with FFmpeg. Nothing changes until you press Apply (one undo step).
 */
import { useState } from 'react';
import { type ClipItem, type Project, findMedia } from '../../shared/model';
import * as ops from '../../shared/ops';
import { formatDuration, secondsToTicks, ticksToSeconds } from '../../shared/time';
import { fillerRanges } from '../../shared/captions';
import { transcribeMedia } from '../state/actions';
import { commit, store, toast, useStore } from '../state/store';
import { ClipCaptions } from './CaptionsSection';
import { Disclosure, NumberField, Section } from './controls';

export function SmartTools({ clip, project, children }: { clip: ClipItem; project: Project; children?: React.ReactNode }) {
  const review = useStore((s) => (s.review?.clipId === clip.id ? s.review : null));
  const missing = useStore((s) => !!s.missing[clip.mediaId]);
  const media = findMedia(project, clip.mediaId)!;
  const [busy, setBusy] = useState<string | null>(null);
  const [noiseDb, setNoiseDb] = useState(-35);
  const [minPause, setMinPause] = useState(0.6);
  const [padding, setPadding] = useState(0.12);
  const [sceneThreshold, setSceneThreshold] = useState(0.3);

  const inClip = (s: number, e: number) => e > clip.sourceIn && s < clip.sourceOut;
  const progress = useStore((s) => s.transcribing[clip.mediaId]);
  const transcript = media.transcript;

  const findFillers = () => {
    const ranges = fillerRanges(transcript?.words ?? []).filter((r) => inClip(r.start, r.end));
    store.set({ review: { clipId: clip.id, kind: 'fillers', ranges, times: [] } });
    if (!ranges.length) toast('No filler words (um, uh, er…) in this clip.');
  };

  const findSilence = async () => {
    setBusy('silence');
    try {
      const r = await window.cutroom.detectSilence(media.path, ticksToSeconds(media.info.duration), { noiseDb, minDuration: minPause });
      const ranges = r.map((x) => ({ start: secondsToTicks(x.start), end: secondsToTicks(x.end) })).filter((x) => inClip(x.start, x.end));
      store.set({ review: { clipId: clip.id, kind: 'silence', ranges, times: [] } });
      if (!ranges.length) toast('No pauses found in this clip with these settings.');
    } catch (e) {
      toast(`Silence detection failed: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const findScenes = async () => {
    setBusy('scenes');
    try {
      const r = await window.cutroom.detectScenes(media.path, sceneThreshold);
      const times = r.map(secondsToTicks).filter((t) => t > clip.sourceIn && t < clip.sourceOut);
      store.set({ review: { clipId: clip.id, kind: 'scenes', ranges: [], times } });
      if (!times.length) toast('No scene changes found inside this clip.');
    } catch (e) {
      toast(`Scene detection failed: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const apply = () => {
    if (!review) return;
    if (review.kind === 'scenes') {
      const r = ops.splitAtSourceTimes(project, clip.id, review.times);
      commit(() => r.project, { review: null });
      toast(`Split into ${r.parts} clips at scene changes.`);
    } else {
      const pad = review.kind === 'silence' ? secondsToTicks(padding) : 0;
      const r = ops.removeSourceRanges(project, clip.id, review.ranges, { padding: pad });
      commit(() => r.project, { review: null, selection: null });
      toast(`Removed ${formatDuration(r.removed)} — now ${r.parts} clip${r.parts === 1 ? '' : 's'}. Undo with ⌘Z.`);
    }
  };

  const total = review ? review.ranges.reduce((s, r) => s + Math.min(r.end, clip.sourceOut) - Math.max(r.start, clip.sourceIn), 0) : 0;

  return (
    <Section title="Smart tools">
      <p className="muted small">Runs on this computer. Results are shown on the timeline for review; nothing changes until you apply.</p>
      <div className="row gap wrap">
        <button className="btn small" disabled={!!busy || missing || !media.info.hasAudio} onClick={findSilence} title={media.info.hasAudio ? 'Detect pauses in this clip' : 'This clip has no audio'}>
          {busy === 'silence' ? 'Listening…' : 'Find pauses'}
        </button>
        <button className="btn small" disabled={!!busy || missing} onClick={findScenes} title="Detect shot changes in this clip">
          {busy === 'scenes' ? 'Looking…' : 'Find scene changes'}
        </button>
        {children}
      </div>
      <div className="speech-row">
        {progress !== undefined ? (
          <span className="row gap center small">
            <span className="mini-progress"><span style={{ width: `${progress * 100}%` }} /></span>
            Transcribing… {Math.round(progress * 100)}%
            <button className="btn tiny" onClick={() => window.cutroom.cancelTranscribe(media.path)}>Cancel</button>
          </span>
        ) : transcript ? (
          <>
            <span className="small ok-text" title={`Model: ${transcript.model}, language: ${transcript.language}`}>✓ Transcript ({transcript.words.length} words)</span>
            <button className="btn small" disabled={!!busy} onClick={findFillers}>Find filler words</button>
            {!project.captions?.enabled && (
              <button className="btn small" onClick={() => commit((p) => ops.setCaptions(p, (c) => ({ ...c, enabled: true })))}>Add captions</button>
            )}
          </>
        ) : (
          <>
            <button className="btn small" disabled={missing || !media.info.hasAudio} onClick={() => transcribeMedia(media.id)} title="Speech-to-text on this computer (whisper.cpp)">
              Transcribe
            </button>
            <button className="btn tiny ghost" onClick={() => store.set({ dialog: 'speech' })}>Set up…</button>
          </>
        )}
      </div>
      {transcript && <ClipCaptions clip={clip} project={project} />}
      <Disclosure title="Detection settings">
        <div className="row gap">
          <NumberField label="Silence below" value={noiseDb} suffix="dB" min={-70} max={-10} step={1} onCommit={setNoiseDb} hint="Higher (e.g. -30) treats more as silence" />
          <NumberField label="Shortest pause" value={minPause} suffix="s" min={0.1} max={5} step={0.1} decimals={1} onCommit={setMinPause} />
        </div>
        <div className="row gap">
          <NumberField label="Keep at edges" value={padding} suffix="s" min={0} max={1} step={0.02} decimals={2} onCommit={setPadding} hint="Kept on both sides of each removed pause so words aren't clipped" />
          <NumberField label="Scene sensitivity" value={sceneThreshold} min={0.05} max={0.9} step={0.05} decimals={2} onCommit={setSceneThreshold} hint="Lower finds more cuts" />
        </div>
      </Disclosure>
      {review && (
        <div className="review">
          {review.kind === 'scenes' ? (
            <div><strong>{review.times.length}</strong> scene change{review.times.length === 1 ? '' : 's'} found (yellow lines on the clip).</div>
          ) : (
            <div>
              <strong>{review.ranges.length}</strong> {review.kind === 'silence' ? 'pause' : 'filler word'}{review.ranges.length === 1 ? '' : 's'} found,{' '}
              {formatDuration(total)} in total (red on the clip).
            </div>
          )}
          <div className="row gap" style={{ marginTop: 6 }}>
            <button
              className="btn small primary"
              disabled={review.kind === 'scenes' ? !review.times.length : !review.ranges.length}
              onClick={apply}
            >
              {review.kind === 'scenes' ? 'Split at scene changes' : review.kind === 'silence' ? 'Remove pauses' : 'Remove filler words'}
            </button>
            <button className="btn small" onClick={() => store.set({ review: null })}>Dismiss</button>
          </div>
        </div>
      )}
    </Section>
  );
}
