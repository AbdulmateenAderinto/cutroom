/**
 * Voice-over recording: records the microphone while the timeline plays from the playhead, then
 * puts the recording on a "Voice-over" audio track where the recording started.
 *
 * Timing: the clip starts at the playhead time when the recorder reports it has started. Audio
 * input latency (typically 10–50 ms) is not compensated; nudge the clip with ⌥←/→ if needed.
 */
import { addAudioClip, addAudioTrack, tracks } from '../../shared/audio';
import { newId } from '../../shared/model';
import { type Ticks, snapToFrame } from '../../shared/time';
import { engine } from '../preview/engine';
import { playhead } from './playhead';
import { commit, store, toast } from './store';
import { loadWaveform } from './actions';

const api = () => window.cutroom;

let rec: { recorder: MediaRecorder; stream: MediaStream; start: Ticks | null; chunks: Blob[]; muted: boolean } | null = null;

export function isRecording(): boolean {
  return !!rec;
}

/** Start recording. `muteTimeline`: play the timeline silently (no headphones: avoids recording it). */
export async function startVoiceOver(muteTimeline = false): Promise<boolean> {
  if (rec) return false;
  if (!(await api().micAccess())) {
    toast('Cutroom may not use the microphone. Allow it in System Settings → Privacy & Security → Microphone.', 'error', 10000);
    return false;
  }
  let stream: MediaStream;
  try {
    // The sound as it comes in: no echo cancellation, noise suppression or automatic level.
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  } catch (e) {
    toast(`No microphone: ${(e as Error).message}`, 'error');
    return false;
  }
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 256_000 } : undefined);
  rec = { recorder, stream, start: null, chunks: [], muted: muteTimeline };
  const r = rec;
  recorder.ondataavailable = (e) => e.data.size && r.chunks.push(e.data);
  recorder.onstart = () => {
    r.start = playhead.get().time;
    if (muteTimeline) store.set({ previewMuted: true });
    engine.play();
    store.set({ recording: { since: performance.now() } });
  };
  recorder.start(250);
  return true;
}

/** Stop and add the recording to the timeline. Returns the new audio clip's id. */
export async function stopVoiceOver(): Promise<string | null> {
  const r = rec;
  if (!r) return null;
  rec = null;
  const done = new Promise<void>((resolve) => (r.recorder.onstop = () => resolve()));
  r.recorder.stop();
  r.stream.getTracks().forEach((t) => t.stop());
  engine.pause();
  store.set({ recording: null, ...(r.muted ? { previewMuted: false } : {}) });
  await done;
  if (r.start === null || !r.chunks.length) return null;
  const bytes = new Uint8Array(await new Blob(r.chunks, { type: r.recorder.mimeType }).arrayBuffer());
  const saved = await api().saveRecording(bytes, store.get().projectPath);
  if (!saved.ok) {
    toast(`Could not save the recording: ${saved.error}`, 'error');
    return null;
  }
  const probe = await api().probeMedia(saved.path);
  if (!probe.ok) {
    toast(`Could not read the recording: ${probe.error}`, 'error');
    return null;
  }
  const name = saved.path.split(/[\\/]/).pop() ?? 'Voice-over.wav';
  const media = { id: newId('media'), name, path: saved.path, info: probe.info, warnings: probe.warnings };
  let p = { ...store.get().project, media: [...store.get().project.media, media] };
  let track = tracks(p).find((t) => t.name === 'Voice-over');
  if (!track) {
    const t = addAudioTrack(p, 'Voice-over');
    p = t.project;
    track = tracks(p).find((x) => x.id === t.trackId)!;
  }
  const added = addAudioClip(p, media.id, snapToFrame(r.start, p.frameRate), track.id);
  if (!added) return null;
  commit(() => added.project, { selection: { kind: 'audio', id: added.clipId } });
  loadWaveform(media.id);
  toast(`Voice-over added to “Voice-over” (${(probe.info.duration / 705_600_000).toFixed(1)} s).`);
  return added.clipId;
}
