/**
 * Preview audio through Web Audio, so it can do what the export does: volume above 100%, fades
 * and ducking. Gains come from the same functions the exporter uses (clipGainAt, duckGainAt).
 *
 *   video element A/B ──▶ gain (clip volume) ─────────────────────────────┐
 *   music <audio> per clip ──▶ gain (volume × fades) ──▶ track gain (× duck) ──▶ destination
 *
 * Music elements follow the timeline clock: started/stopped as clips begin and end, and re-synced
 * if they drift more than 80 ms.
 */
import { type AudioTrack, findMedia, type Project } from '../../shared/model';
import { audioClipEnd, clipGainAt, duckGainAt, speechIntervals, tracks } from '../../shared/audio';
import { type Ticks, ticksToSeconds } from '../../shared/time';

let ctx: AudioContext | null = null;
const videoGains = new Map<HTMLMediaElement, GainNode>();
const music = new Map<string, { el: HTMLAudioElement; gain: GainNode; mediaId: string }>();
const trackGains = new Map<string, GainNode>();
let speechCache: { project: Project | null; intervals: { start: Ticks; end: Ticks }[] } = { project: null, intervals: [] };

function audio(): AudioContext {
  if (!ctx) ctx = new AudioContext({ latencyHint: 'interactive' });
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** Route a preview <video> element through a gain node (call once per element, before loading). */
export function attachVideoElement(el: HTMLMediaElement) {
  el.crossOrigin = 'anonymous'; // media is served with CORS so Web Audio may read it
  const c = audio();
  const gain = c.createGain();
  c.createMediaElementSource(el).connect(gain).connect(c.destination);
  videoGains.set(el, gain);
}

export function setVideoGain(el: HTMLMediaElement, value: number) {
  const g = videoGains.get(el);
  if (g) g.gain.value = value;
  else el.volume = Math.min(1, value); // not routed (should not happen): best effort
}

function trackGain(track: AudioTrack): GainNode {
  let g = trackGains.get(track.id);
  if (!g) {
    const c = audio();
    g = c.createGain();
    g.connect(c.destination);
    trackGains.set(track.id, g);
  }
  return g;
}

function player(clipId: string, mediaId: string, src: string, track: AudioTrack) {
  let p = music.get(clipId);
  if (!p || p.mediaId !== mediaId) {
    p?.el.pause();
    const el = new Audio();
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    el.src = src;
    const c = audio();
    const gain = c.createGain();
    c.createMediaElementSource(el).connect(gain).connect(trackGain(track));
    p = { el, gain, mediaId };
    music.set(clipId, p);
  }
  return p;
}

/** Bring music in line with timeline time t. Call every animation frame while playing, and on seek/pause. */
export function syncMusic(project: Project, t: Ticks, playing: boolean, missing: Record<string, boolean>) {
  if (speechCache.project !== project) speechCache = { project, intervals: speechIntervals(project) };
  const live = new Set<string>();
  for (const track of tracks(project)) {
    const tg = trackGain(track);
    tg.gain.value = track.muted ? 0 : track.volume * (track.duck ? duckGainAt(speechCache.intervals, t, track.duckDb) : 1);
    for (const c of track.clips) {
      const active = t >= c.start && t < audioClipEnd(c);
      const m = findMedia(project, c.mediaId);
      if (!m || missing[m.id]) continue;
      if (!active && !music.has(c.id)) continue;
      // Create players slightly ahead of time so they are loaded when needed.
      const soon = t >= c.start - 2 * 705_600_000 && t < audioClipEnd(c);
      if (!active && !soon) {
        music.get(c.id)?.el.pause();
        continue;
      }
      const p = player(c.id, c.mediaId, window.cutroom.mediaUrl(m.path), track);
      live.add(c.id);
      p.gain.gain.value = clipGainAt(c, t);
      const want = ticksToSeconds(c.sourceIn + Math.max(0, t - c.start));
      if (!active || !playing) {
        if (!p.el.paused) p.el.pause();
        // Park the element where playback will start, so pressing Play starts promptly.
        if (Math.abs(p.el.currentTime - want) > 0.02 && !p.el.seeking) p.el.currentTime = want;
        continue;
      }
      if (p.el.paused) {
        if (Math.abs(p.el.currentTime - want) > 0.03) p.el.currentTime = want;
        void p.el.play().catch(() => {});
      } else if (!p.el.seeking && p.el.readyState >= 3 && Math.abs(p.el.currentTime - want) > 0.12) {
        // Correct real drift only; re-seeking while still buffering would make it fall further behind.
        p.el.currentTime = want;
      }
    }
  }
  // Clips that were deleted or moved away.
  for (const [id, p] of music) {
    if (!live.has(id)) {
      p.el.pause();
      if (!tracks(project).some((tr) => tr.clips.some((c) => c.id === id))) music.delete(id);
    }
  }
}

export function stopMusic() {
  for (const p of music.values()) p.el.pause();
}

/** For tests: what the preview audio graph is doing right now. */
export function audioDebug() {
  return {
    music: [...music.entries()].map(([id, p]) => ({ id, playing: !p.el.paused, time: p.el.currentTime, gain: p.gain.gain.value })),
    tracks: [...trackGains.entries()].map(([id, g]) => ({ id, gain: g.gain.value })),
    video: [...videoGains.values()].map((g) => g.gain.value),
  };
}
