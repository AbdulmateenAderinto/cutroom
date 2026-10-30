/**
 * Clip animation: presets (in / out / whole-clip motion) plus keyframes.
 *
 * Animated values are applied on top of the clip's framing (Fit/Fill/Manual):
 *   scale    multiplier of the framed size, around the image centre (1 = as framed)
 *   x, y     extra offset of the image centre, as a fraction of canvas width / height
 *   opacity  0..1
 *   rotation degrees clockwise, around the image centre (added to the framing's rotation)
 *
 * Keyframes are anchored to SOURCE time (a moment in the media file), so they stay with the
 * content when the clip is trimmed or split. In/out presets are anchored to the clip's edges.
 *
 * evalAnimation() is the single source of truth: the preview applies its result as CSS each
 * frame, and the exporter samples it per output frame and sends the values to FFmpeg.
 */
import type { Ticks } from './time';

export type Easing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'hold';
export type AnimProperty = 'scale' | 'x' | 'y' | 'opacity' | 'rotation';
export const ANIM_PROPERTIES: AnimProperty[] = ['scale', 'x', 'y', 'opacity', 'rotation'];

export interface Keyframe {
  at: Ticks; // source time
  value: number;
  easing: Easing; // how the value moves from this keyframe to the next one
}

export type InPreset = 'fade' | 'zoom' | 'pop' | 'slideLeft' | 'slideRight' | 'slideUp' | 'slideDown';
export type OutPreset = InPreset;
export type MotionPreset = 'kenBurnsIn' | 'kenBurnsOut' | 'panLeft' | 'panRight';

export interface ClipAnimation {
  in?: { preset: InPreset; duration: Ticks };
  out?: { preset: OutPreset; duration: Ticks };
  motion?: { preset: MotionPreset; amount: number }; // amount: 0..1 strength (default 0.5)
  keyframes?: Partial<Record<AnimProperty, Keyframe[]>>;
}

export interface AnimState {
  scale: number;
  x: number;
  y: number;
  opacity: number;
  rotation: number;
}

export const IDENTITY: AnimState = { scale: 1, x: 0, y: 0, opacity: 1, rotation: 0 };

export const IN_PRESETS: { id: InPreset; label: string }[] = [
  { id: 'fade', label: 'Fade' },
  { id: 'zoom', label: 'Zoom' },
  { id: 'pop', label: 'Pop' },
  { id: 'slideLeft', label: 'Slide from left' },
  { id: 'slideRight', label: 'Slide from right' },
  { id: 'slideUp', label: 'Slide from bottom' },
  { id: 'slideDown', label: 'Slide from top' },
];
export const OUT_PRESETS: { id: OutPreset; label: string }[] = [
  { id: 'fade', label: 'Fade' },
  { id: 'zoom', label: 'Zoom' },
  { id: 'pop', label: 'Pop' },
  { id: 'slideLeft', label: 'Slide to left' },
  { id: 'slideRight', label: 'Slide to right' },
  { id: 'slideUp', label: 'Slide to top' },
  { id: 'slideDown', label: 'Slide to bottom' },
];
export const MOTION_PRESETS: { id: MotionPreset; label: string }[] = [
  { id: 'kenBurnsIn', label: 'Slow zoom in' },
  { id: 'kenBurnsOut', label: 'Slow zoom out' },
  { id: 'panLeft', label: 'Pan left' },
  { id: 'panRight', label: 'Pan right' },
];

export const EASINGS: { id: Easing; label: string }[] = [
  { id: 'linear', label: 'Linear' },
  { id: 'easeIn', label: 'Ease in' },
  { id: 'easeOut', label: 'Ease out' },
  { id: 'easeInOut', label: 'Ease in-out' },
  { id: 'hold', label: 'Hold (jump)' },
];

export function ease(e: Easing, p: number): number {
  p = Math.min(1, Math.max(0, p));
  switch (e) {
    case 'linear': return p;
    case 'easeIn': return p * p * p;
    case 'easeOut': return 1 - (1 - p) ** 3;
    case 'easeInOut': return p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
    case 'hold': return p >= 1 ? 1 : 0;
  }
}

export function defaultValue(prop: AnimProperty): number {
  return IDENTITY[prop];
}

/** Value of one keyframed property at source time s (constant before the first / after the last key). */
export function keyframeValue(keys: Keyframe[] | undefined, s: Ticks, prop: AnimProperty): number {
  if (!keys || keys.length === 0) return defaultValue(prop);
  if (s <= keys[0].at) return keys[0].value;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (s < b.at) return a.value + (b.value - a.value) * ease(a.easing, (s - a.at) / (b.at - a.at));
  }
  return keys[keys.length - 1].value;
}

/** Offset (in canvas fractions) that moves a slide fully off-canvas from the centre. */
const SLIDE = 1.1;

function presetState(preset: InPreset, p: number /* 0 = hidden end, 1 = fully in */): AnimState {
  const q = 1 - p;
  switch (preset) {
    case 'fade': return { ...IDENTITY, opacity: p };
    case 'zoom': return { ...IDENTITY, scale: 0.6 + 0.4 * p, opacity: p };
    case 'pop': {
      // overshoot: 0.5 → 1.08 → 1
      const s = p < 0.7 ? 0.5 + (0.58 * p) / 0.7 : 1.08 - (0.08 * (p - 0.7)) / 0.3;
      return { ...IDENTITY, scale: s, opacity: Math.min(1, p * 2) };
    }
    case 'slideLeft': return { ...IDENTITY, x: -SLIDE * q };
    case 'slideRight': return { ...IDENTITY, x: SLIDE * q };
    case 'slideUp': return { ...IDENTITY, y: SLIDE * q };
    case 'slideDown': return { ...IDENTITY, y: -SLIDE * q };
  }
}

function motionState(m: NonNullable<ClipAnimation['motion']>, p: number): AnimState {
  const k = 0.3 * Math.min(1, Math.max(0, m.amount));
  switch (m.preset) {
    case 'kenBurnsIn': return { ...IDENTITY, scale: 1 + k * p };
    case 'kenBurnsOut': return { ...IDENTITY, scale: 1 + k * (1 - p) };
    case 'panLeft': return { ...IDENTITY, scale: 1 + k, x: (k / 2) * (1 - 2 * p) };
    case 'panRight': return { ...IDENTITY, scale: 1 + k, x: -(k / 2) * (1 - 2 * p) };
  }
}

function combine(a: AnimState, b: AnimState): AnimState {
  return { scale: a.scale * b.scale, x: a.x + b.x, y: a.y + b.y, opacity: a.opacity * b.opacity, rotation: a.rotation + b.rotation };
}

/**
 * Animated state of a clip.
 * rel: time since the clip's start on the timeline; duration: the clip's timeline duration;
 * sourceIn: the clip's in-point (rel + sourceIn = source time, used for keyframes).
 */
export function evalAnimation(anim: ClipAnimation | undefined, rel: Ticks, duration: Ticks, sourceIn: Ticks, speed = 1): AnimState {
  if (!anim) return IDENTITY;
  const s = sourceIn + (speed === 1 ? rel : Math.round(rel * speed)); // keyframes sit on source time
  const kf = anim.keyframes ?? {};
  let st: AnimState = {
    scale: keyframeValue(kf.scale, s, 'scale'),
    x: keyframeValue(kf.x, s, 'x'),
    y: keyframeValue(kf.y, s, 'y'),
    opacity: keyframeValue(kf.opacity, s, 'opacity'),
    rotation: keyframeValue(kf.rotation, s, 'rotation'),
  };
  if (anim.motion && duration > 0) st = combine(st, motionState(anim.motion, rel / duration));
  if (anim.in && anim.in.duration > 0 && rel < anim.in.duration) {
    st = combine(st, presetState(anim.in.preset, ease('easeOut', rel / anim.in.duration)));
  }
  if (anim.out && anim.out.duration > 0 && rel > duration - anim.out.duration) {
    st = combine(st, presetState(anim.out.preset, ease('easeIn', (duration - rel) / anim.out.duration)));
  }
  st.opacity = Math.min(1, Math.max(0, st.opacity));
  st.scale = Math.max(0, st.scale);
  return st;
}

export function hasAnimation(anim: ClipAnimation | undefined): boolean {
  if (!anim) return false;
  if (anim.in || anim.out || anim.motion) return true;
  return ANIM_PROPERTIES.some((p) => (anim.keyframes?.[p]?.length ?? 0) > 0);
}

export function animatesOpacity(anim: ClipAnimation | undefined): boolean {
  if (!anim) return false;
  const fades = (pr?: InPreset) => pr === 'fade' || pr === 'zoom' || pr === 'pop';
  return fades(anim.in?.preset) || fades(anim.out?.preset) || (anim.keyframes?.opacity?.length ?? 0) > 0;
}

// --- Keyframe editing helpers (pure) ---

/** Insert or replace a keyframe at source time `at` (sorted, one per time). */
export function upsertKeyframe(keys: Keyframe[] | undefined, at: Ticks, value: number, easing?: Easing): Keyframe[] {
  const list = [...(keys ?? [])];
  const i = list.findIndex((k) => k.at === at);
  if (i >= 0) list[i] = { ...list[i], value, easing: easing ?? list[i].easing };
  else list.push({ at, value, easing: easing ?? 'easeInOut' });
  return list.sort((a, b) => a.at - b.at);
}

export function removeKeyframeAt(keys: Keyframe[] | undefined, at: Ticks): Keyframe[] {
  return (keys ?? []).filter((k) => k.at !== at);
}

/** Validates and clamps user/AI supplied values. */
export function clampAnimValue(prop: AnimProperty, v: number): number {
  if (!Number.isFinite(v)) return defaultValue(prop);
  switch (prop) {
    case 'scale': return Math.min(20, Math.max(0, v));
    case 'opacity': return Math.min(1, Math.max(0, v));
    case 'rotation': return Math.min(3600, Math.max(-3600, v));
    default: return Math.min(5, Math.max(-5, v));
  }
}
