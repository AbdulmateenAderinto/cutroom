/**
 * Audio tracks (music, voice-over): pure operations and the ducking envelope.
 *
 * Audio clips are placed freely in time (timeline `start`), never overlap on one track, and end
 * where the project (video track) ends. The ducking envelope — how much a track is lowered while
 * the video track has sound — is computed here once and used by both preview and export.
 */
import { type AudioClip, type AudioTrack, type Project, findMedia, layoutSequence, mediaKind, newId } from './model';
import { type Ticks, TICKS_PER_SECOND, frameDuration, snapToFrame } from './time';

export const MAX_VOLUME = 2;
const S = TICKS_PER_SECOND;

export function tracks(p: Project): AudioTrack[] {
  return p.audioTracks ?? [];
}

export function audioClipDuration(c: AudioClip): Ticks {
  return c.sourceOut - c.sourceIn;
}

export function audioClipEnd(c: AudioClip): Ticks {
  return c.start + audioClipDuration(c);
}

export function findAudioClip(p: Project, id: string): { track: AudioTrack; clip: AudioClip } | null {
  for (const track of tracks(p)) {
    const clip = track.clips.find((c) => c.id === id);
    if (clip) return { track, clip };
  }
  return null;
}

function withTracks(p: Project, ts: AudioTrack[]): Project {
  return { ...p, audioTracks: ts };
}

function mapTrack(p: Project, trackId: string, fn: (t: AudioTrack) => AudioTrack): Project {
  return withTracks(p, tracks(p).map((t) => (t.id === trackId ? fn(t) : t)));
}

const sortClips = (clips: AudioClip[]) => [...clips].sort((a, b) => a.start - b.start);

export function addAudioTrack(p: Project, name?: string): { project: Project; trackId: string } {
  const id = newId('atrk');
  const track: AudioTrack = { id, name: name ?? `Audio ${tracks(p).length + 1}`, clips: [], volume: 1, muted: false, duck: false, duckDb: -14 };
  return { project: withTracks(p, [...tracks(p), track]), trackId: id };
}

export function removeAudioTrack(p: Project, trackId: string): Project {
  return withTracks(p, tracks(p).filter((t) => t.id !== trackId));
}

export function setAudioTrack(p: Project, trackId: string, patch: Partial<Pick<AudioTrack, 'name' | 'volume' | 'muted' | 'duck' | 'duckDb'>>): Project {
  return mapTrack(p, trackId, (t) => ({
    ...t,
    ...patch,
    volume: Math.min(MAX_VOLUME, Math.max(0, patch.volume ?? t.volume)),
    duckDb: Math.min(-1, Math.max(-40, patch.duckDb ?? t.duckDb)),
  }));
}

/** First free position at or after `start` on the track where `duration` fits (clips never overlap). */
export function freeSlot(track: AudioTrack, start: Ticks, duration: Ticks, ignoreId?: string): Ticks {
  let s = Math.max(0, start);
  const others = sortClips(track.clips.filter((c) => c.id !== ignoreId));
  for (const c of others) {
    if (s + duration <= c.start) break;
    if (s < audioClipEnd(c)) s = audioClipEnd(c);
  }
  return s;
}

/** Add a whole audio (or video's audio) file to a track at `start` (snapped to frames, moved to free space). */
export function addAudioClip(p: Project, mediaId: string, start: Ticks, trackId?: string): { project: Project; clipId: string; trackId: string } | null {
  const media = findMedia(p, mediaId);
  if (!media || !media.info.hasAudio) return null;
  let project = p;
  let tid = trackId ?? tracks(p)[0]?.id;
  if (!tid || !tracks(p).some((t) => t.id === tid)) {
    const r = addAudioTrack(project, mediaKind(media) === 'audio' ? 'Music' : undefined);
    project = r.project;
    tid = r.trackId;
  }
  const track = tracks(project).find((t) => t.id === tid)!;
  const pf = frameDuration(p.frameRate);
  const duration = snapToFrame(media.info.duration, p.frameRate, 'floor');
  if (duration < pf) return null;
  const at = freeSlot(track, snapToFrame(start, p.frameRate), duration);
  const clip: AudioClip = { id: newId('aclip'), mediaId, start: at, sourceIn: 0, sourceOut: duration, volume: 1, fadeIn: 0, fadeOut: 0 };
  return { project: mapTrack(project, tid, (t) => ({ ...t, clips: sortClips([...t.clips, clip]) })), clipId: clip.id, trackId: tid };
}

export function updateAudioClip(p: Project, clipId: string, fn: (c: AudioClip, t: AudioTrack) => AudioClip): Project {
  const hit = findAudioClip(p, clipId);
  if (!hit) return p;
  return mapTrack(p, hit.track.id, (t) => ({ ...t, clips: sortClips(t.clips.map((c) => (c.id === clipId ? fn(c, t) : c))) }));
}

/** Clamp fades so they fit the clip (fade-in + fade-out ≤ duration). */
function legalFades(c: AudioClip): AudioClip {
  const d = audioClipDuration(c);
  const fadeIn = Math.max(0, Math.min(c.fadeIn, d));
  const fadeOut = Math.max(0, Math.min(c.fadeOut, d - fadeIn));
  return { ...c, fadeIn, fadeOut };
}

export function setAudioClip(p: Project, clipId: string, patch: Partial<Pick<AudioClip, 'volume' | 'fadeIn' | 'fadeOut'>>): Project {
  return updateAudioClip(p, clipId, (c) =>
    legalFades({ ...c, ...patch, volume: Math.min(MAX_VOLUME, Math.max(0, patch.volume ?? c.volume)) }),
  );
}

/** Move a clip to a new start (and optionally another track); it lands in the nearest free space. */
export function moveAudioClip(p: Project, clipId: string, start: Ticks, toTrackId?: string): Project {
  const hit = findAudioClip(p, clipId);
  if (!hit) return p;
  const dest = toTrackId ? tracks(p).find((t) => t.id === toTrackId) : hit.track;
  if (!dest) return p;
  const s = freeSlot(dest, snapToFrame(Math.max(0, start), p.frameRate), audioClipDuration(hit.clip), clipId);
  const moved = { ...hit.clip, start: s };
  let next = mapTrack(p, hit.track.id, (t) => ({ ...t, clips: t.clips.filter((c) => c.id !== clipId) }));
  next = mapTrack(next, dest.id, (t) => ({ ...t, clips: sortClips([...t.clips, moved]) }));
  return next;
}

/**
 * Trim an edge by a timeline delta. Start edge: moves `start` and `sourceIn` together (the audio
 * stays in place, like trimming a video clip without ripple). Neighbours are never overlapped.
 */
export function trimAudioClip(p: Project, clipId: string, edge: 'start' | 'end', delta: Ticks): Project {
  const hit = findAudioClip(p, clipId);
  if (!hit) return p;
  const media = findMedia(p, hit.clip.mediaId);
  if (!media) return p;
  const pf = frameDuration(p.frameRate);
  const c = hit.clip;
  const others = hit.track.clips.filter((x) => x.id !== clipId);
  const prevEnd = Math.max(0, ...others.filter((x) => x.start < c.start).map(audioClipEnd));
  const nextStart = Math.min(Number.MAX_SAFE_INTEGER, ...others.filter((x) => x.start > c.start).map((x) => x.start));
  if (edge === 'start') {
    let d = snapToFrame(delta, p.frameRate);
    d = Math.max(d, -c.sourceIn, prevEnd - c.start); // not before the file start or the previous clip
    d = Math.min(d, audioClipDuration(c) - pf);
    return updateAudioClip(p, clipId, (x) => legalFades({ ...x, start: x.start + d, sourceIn: x.sourceIn + d }));
  }
  let d = snapToFrame(delta, p.frameRate);
  d = Math.min(d, media.info.duration - c.sourceOut, nextStart - audioClipEnd(c));
  d = Math.max(d, pf - audioClipDuration(c));
  return updateAudioClip(p, clipId, (x) => legalFades({ ...x, sourceOut: x.sourceOut + d }));
}

export function splitAudioClip(p: Project, clipId: string, t: Ticks): { project: Project; rightId: string } | null {
  const hit = findAudioClip(p, clipId);
  if (!hit) return null;
  const c = hit.clip;
  t = snapToFrame(t, p.frameRate);
  const pf = frameDuration(p.frameRate);
  if (t < c.start + pf || t > audioClipEnd(c) - pf) return null;
  const cut = c.sourceIn + (t - c.start);
  const left: AudioClip = { ...c, sourceOut: cut, fadeOut: 0 };
  const right: AudioClip = { ...c, id: newId('aclip'), start: t, sourceIn: cut, fadeIn: 0 };
  return {
    project: mapTrack(p, hit.track.id, (tr) => ({ ...tr, clips: sortClips(tr.clips.flatMap((x) => (x.id === clipId ? [legalFades(left), legalFades(right)] : [x]))) })),
    rightId: right.id,
  };
}

export function deleteAudioClip(p: Project, clipId: string): Project {
  const hit = findAudioClip(p, clipId);
  if (!hit) return p;
  return mapTrack(p, hit.track.id, (t) => ({ ...t, clips: t.clips.filter((c) => c.id !== clipId) }));
}

/** Clip gain at timeline time t (volume × fades), 0 outside the clip. */
export function clipGainAt(c: AudioClip, t: Ticks): number {
  if (t < c.start || t >= audioClipEnd(c)) return 0;
  const rel = t - c.start;
  const d = audioClipDuration(c);
  let g = c.volume;
  if (c.fadeIn > 0 && rel < c.fadeIn) g *= rel / c.fadeIn;
  if (c.fadeOut > 0 && rel > d - c.fadeOut) g *= (d - rel) / c.fadeOut;
  return g;
}

// ---------------------------------------------------------------------------------------------
// Ducking

/** Ramps: the music starts dipping just before speech and comes back up after it. */
export const DUCK_ATTACK = Math.round(0.25 * S);
export const DUCK_RELEASE = Math.round(0.5 * S);
const DUCK_BRIDGE = Math.round(0.6 * S); // pauses shorter than this stay ducked

/** Timeline intervals where the video track has sound (from each media file's `speech` ranges). */
export function speechIntervals(p: Project): { start: Ticks; end: Ticks }[] {
  const out: { start: Ticks; end: Ticks }[] = [];
  for (const l of layoutSequence(p).items) {
    if (l.item.kind !== 'clip' || l.item.muted || l.item.volume === 0) continue;
    const clip = l.item;
    for (const r of findMedia(p, clip.mediaId)?.speech ?? []) {
      const a = Math.max(r.start, clip.sourceIn);
      const b = Math.min(r.end, clip.sourceOut);
      if (b > a) out.push({ start: l.start + a - clip.sourceIn, end: l.start + b - clip.sourceIn });
    }
  }
  out.sort((x, y) => x.start - y.start);
  const merged: { start: Ticks; end: Ticks }[] = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r.start - last.end <= DUCK_BRIDGE) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

/** Ducking multiplier (1 = no change) at time t for the given speech intervals and depth in dB. */
export function duckGainAt(intervals: { start: Ticks; end: Ticks }[], t: Ticks, duckDb: number): number {
  const low = Math.pow(10, duckDb / 20);
  let amount = 0; // 0 = full level, 1 = fully ducked
  for (const r of intervals) {
    if (t < r.start - DUCK_ATTACK) break;
    let a: number;
    if (t < r.start) a = 1 - (r.start - t) / DUCK_ATTACK;
    else if (t <= r.end) a = 1;
    else if (t < r.end + DUCK_RELEASE) a = 1 - (t - r.end) / DUCK_RELEASE;
    else a = 0;
    amount = Math.max(amount, a);
  }
  return 1 - amount * (1 - low);
}

/** Whether ducking needs speech analysis that has not been done yet (media on the timeline without `speech`). */
export function mediaNeedingSpeechAnalysis(p: Project): string[] {
  const ids = new Set<string>();
  for (const it of p.sequence.items) {
    if (it.kind !== 'clip') continue;
    const m = findMedia(p, it.mediaId);
    if (m && m.info.hasAudio && !m.speech) ids.add(m.id);
  }
  return [...ids];
}

/** Invert silence ranges into sound ranges over [0, duration]. */
export function soundFromSilence(silence: { start: Ticks; end: Ticks }[], duration: Ticks): { start: Ticks; end: Ticks }[] {
  const out: { start: Ticks; end: Ticks }[] = [];
  let cursor = 0;
  for (const s of [...silence].sort((a, b) => a.start - b.start)) {
    if (s.start > cursor) out.push({ start: cursor, end: s.start });
    cursor = Math.max(cursor, s.end);
  }
  if (cursor < duration) out.push({ start: cursor, end: duration });
  return out;
}

export function setSpeech(p: Project, mediaId: string, speech: { start: Ticks; end: Ticks }[]): Project {
  return { ...p, media: p.media.map((m) => (m.id === mediaId ? { ...m, speech } : m)) };
}
