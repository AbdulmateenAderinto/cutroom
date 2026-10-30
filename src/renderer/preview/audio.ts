/**
 * Preview audio through Web Audio, so it can do what the export does: volume above 100%, fades
 * and ducking. Gains come from the same functions the exporter uses (clipGainAt, duckGainAt).
 *
 *   video element A/B ──▶ EQ ──▶ gain (clip volume) ──────────────────────────┐
 *   music <audio> per clip ──▶ EQ ──▶ gain (volume × fades) ──▶ track gain (× duck) ──▶ destination
 *
 * EQ: three BiquadFilterNodes with the bands of shared/audioFx.ts (the export uses the same
 * coefficients). Noise reduction is export-only (see audioFx.ts).
 *
 * Music elements follow the timeline clock: started/stopped as clips begin and end, and re-synced
 * if they drift more than 80 ms.
 */
import { type AudioTrack, findMedia, type Project } from '../../shared/model';
import { audioClipEnd, clipGainAt, duckGainAt, speechIntervals, tracks } from '../../shared/audio';
import { type Ticks, ticksToSeconds } from '../../shared/time';
import { type AudioFx, EQ_BANDS } from '../../shared/audioFx';
import { previewUrl } from './mediaUrl';

let ctx: AudioContext | null = null;
const videoGains = new Map<HTMLMediaElement, GainNode>();
const eqs = new Map<HTMLMediaElement, BiquadFilterNode[]>();
const music = new Map<string, { el: HTMLAudioElement; gain: GainNode; mediaId: string }>();

/** source → low shelf → mid peak → high shelf → `to` */
function eqChain(c: AudioContext, el: HTMLMediaElement, to: AudioNode) {
  const nodes = EQ_BANDS.map((b) => {
    const n = c.createBiquadFilter();
    n.type = b.type;
    n.frequency.value = b.freq;
    if (b.type === 'peaking') n.Q.value = b.q;
    n.gain.value = 0;
    return n;
  });
  const src = c.createMediaElementSource(el);
  src.connect(nodes[0]);
  nodes[0].connect(nodes[1]);
  nodes[1].connect(nodes[2]);
  nodes[2].connect(to);
  eqs.set(el, nodes);
}

/** Set an element's EQ from a clip's sound settings. */
export function setEq(el: HTMLMediaElement, fx: AudioFx | undefined) {
  const nodes = eqs.get(el);
  if (!nodes) return;
  EQ_BANDS.forEach((b, i) => {
    const g = fx?.[b.key] ?? 0;
    if (nodes[i].gain.value !== g) nodes[i].gain.value = g;
  });
}
const trackGains = new Map<string, GainNode>();
let speechCache: { project: Project | null; intervals: { start: Ticks; end: Ticks }[] } = { project: null, intervals: [] };

let master: GainNode | null = null;

function audio(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: 'interactive' });
    master = ctx.createGain();
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** Route a preview <video> element through a gain node (call once per element, before loading). */
export function attachVideoElement(el: HTMLMediaElement) {
  el.crossOrigin = 'anonymous'; // media is served with CORS so Web Audio may read it
  const c = audio();
  const gain = c.createGain();
  gain.connect(master!);
  eqChain(c, el, gain);
  videoGains.set(el, gain);
}

/** Undo attachVideoElement for an element that is being thrown away (overlay clips). */
export function detachVideoElement(el: HTMLMediaElement) {
  videoGains.get(el)?.disconnect();
  videoGains.delete(el);
  eqs.delete(el);
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
    g.connect(master!);
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
    gain.connect(trackGain(track));
    eqChain(c, el, gain);
    p = { el, gain, mediaId };
    music.set(clipId, p);
  }
  return p;
}

/** Bring music in line with timeline time t. Call every animation frame while playing, and on seek/pause. */
export function syncMusic(project: Project, t: Ticks, playing: boolean, missing: Record<string, boolean>, rate = 1) {
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
      const url = previewUrl(m);
      if (!url) continue; // preview copy of this sound not ready yet
      const p = player(c.id, c.mediaId, url, track);
      live.add(c.id);
      p.gain.gain.value = clipGainAt(c, t);
      setEq(p.el, c.audioFx);
      const want = ticksToSeconds(c.sourceIn + Math.max(0, t - c.start));
      if (!active || !playing) {
        if (!p.el.paused) p.el.pause();
        // Park the element where playback will start, so pressing Play starts promptly.
        if (Math.abs(p.el.currentTime - want) > 0.02 && !p.el.seeking) p.el.currentTime = want;
        continue;
      }
      if (p.el.playbackRate !== rate) p.el.playbackRate = rate; // J/K/L shuttle
      if (p.el.paused) {
        if (Math.abs(p.el.currentTime - want) > 0.03) p.el.currentTime = want;
        void p.el.play().catch(() => {});
      } else if (!p.el.seeking && p.el.readyState >= 3 && Math.abs(p.el.currentTime - want) > 0.12 * rate) {
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

/** For tests: the EQ's response (dB) at these frequencies on an element, from the Web Audio nodes. */
export function eqResponse(el: HTMLMediaElement, freqs: number[]): number[] | null {
  const nodes = eqs.get(el);
  if (!nodes) return null;
  const f = new Float32Array(freqs);
  const db = freqs.map(() => 0);
  for (const n of nodes) {
    const mag = new Float32Array(freqs.length);
    n.getFrequencyResponse(f, mag, new Float32Array(freqs.length));
    mag.forEach((m, i) => (db[i] += 20 * Math.log10(m)));
  }
  return db;
}

/** For tests: what the preview audio graph is doing right now. */
export function audioDebug() {
  return {
    eq: [...eqs.values()].map((ns) => ns.map((n) => n.gain.value)),
    music: [...music.entries()].map(([id, p]) => ({ id, playing: !p.el.paused, time: p.el.currentTime, gain: p.gain.gain.value })),
    tracks: [...trackGains.entries()].map(([id, g]) => ({ id, gain: g.gain.value })),
    video: [...videoGains.values()].map((g) => g.gain.value),
  };
}

/** Silence (or not) everything the preview plays. */
export function setPreviewMuted(muted: boolean) {
  audio();
  if (master) master.gain.value = muted ? 0 : 1;
}
