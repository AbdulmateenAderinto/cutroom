/**
 * Titles and text overlays: style presets, pure editing operations, and the animation state at a
 * given time (used by the preview and, through the same drawing code, by the export).
 *
 * Titles are placed freely in time on text rows. Titles on one row never overlap; higher rows draw
 * on top. Like audio clips they keep their timeline position when the video track is edited.
 */
import { type Keyframe, keyframeValue, removeKeyframeAt, upsertKeyframe } from './animation';
import { TITLE_KEY_PROPS, type Project, type TitleAnim, type TitleClip, type TitleKeyProp, type TitleStyle, isHexColor, newId } from './model';
import { type Ticks, TICKS_PER_SECOND, frameDuration, snapToFrame } from './time';

const S = TICKS_PER_SECOND;
export const TITLE_DEFAULT_DURATION = 3 * S;
export const TITLE_DEFAULT_ANIM = Math.round(0.4 * S);
export const MAX_TITLE_ROWS = 8;

export const FONT_STACKS: Record<TitleStyle['font'], string> = {
  sans: '"Inter", "SF Pro Display", -apple-system, "Helvetica Neue", Arial, sans-serif',
  serif: '"New York", Georgia, "Times New Roman", serif',
  rounded: '"SF Pro Rounded", ui-rounded, "Arial Rounded MT Bold", "Nunito", sans-serif',
  mono: '"SF Mono", ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", monospace',
  condensed: '"Avenir Next Condensed", "Helvetica Neue Condensed", "Roboto Condensed", "Arial Narrow", sans-serif',
};

export const FONTS: { id: TitleStyle['font']; label: string }[] = [
  { id: 'sans', label: 'Sans' },
  { id: 'serif', label: 'Serif' },
  { id: 'rounded', label: 'Rounded' },
  { id: 'condensed', label: 'Condensed' },
  { id: 'mono', label: 'Mono' },
];

export const TITLE_ANIMS: { id: TitleAnim; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'fade', label: 'Fade' },
  { id: 'rise', label: 'Rise' },
  { id: 'pop', label: 'Pop' },
  { id: 'typewriter', label: 'Typewriter' },
];

const BASE: TitleStyle = {
  font: 'sans', weight: 800, italic: false, size: 9, color: '#ffffff', align: 'center', x: 0.5, y: 0.5,
  look: 'shadow', boxColor: '#000000', boxOpacity: 0.6, uppercase: false, maxWidth: 0.9,
};

export type TitlePreset = 'title' | 'subtitle' | 'lowerThird' | 'quote' | 'label';
export const TITLE_PRESETS: { id: TitlePreset; label: string; text: string; style: TitleStyle; animIn: TitleAnim; animOut: TitleAnim }[] = [
  { id: 'title', label: 'Title', text: 'Your title', style: { ...BASE }, animIn: 'rise', animOut: 'fade' },
  { id: 'subtitle', label: 'Subtitle', text: 'A subtitle', style: { ...BASE, weight: 600, size: 5, y: 0.62, look: 'shadow' }, animIn: 'fade', animOut: 'fade' },
  {
    id: 'lowerThird', label: 'Lower third', text: 'Name Surname\nRole or place',
    style: { ...BASE, weight: 700, size: 4.2, align: 'left', x: 0.06, y: 0.82, look: 'box', boxOpacity: 0.7, maxWidth: 0.6 },
    animIn: 'rise', animOut: 'fade',
  },
  { id: 'quote', label: 'Quote', text: '“A short quote.”', style: { ...BASE, font: 'serif', weight: 400, italic: true, size: 6.5, look: 'shadow', maxWidth: 0.75 }, animIn: 'fade', animOut: 'fade' },
  {
    id: 'label', label: 'Label', text: 'LIVE',
    style: { ...BASE, font: 'mono', weight: 700, size: 3.6, align: 'left', x: 0.05, y: 0.09, look: 'box', color: '#111111', boxColor: '#ffd23f', boxOpacity: 1 },
    animIn: 'pop', animOut: 'fade',
  },
];

export function titles(p: Project): TitleClip[] {
  return p.titles ?? [];
}
export const titleEnd = (t: TitleClip): Ticks => t.start + t.duration;
export function findTitle(p: Project, id: string): TitleClip | undefined {
  return titles(p).find((t) => t.id === id);
}
export function titleRows(p: Project): number {
  return titles(p).reduce((n, t) => Math.max(n, t.row + 1), 0);
}

const sorted = (ts: TitleClip[]) => [...ts].sort((a, b) => a.row - b.row || a.start - b.start);
const withTitles = (p: Project, ts: TitleClip[]): Project => ({ ...p, titles: sorted(ts) });

function overlaps(ts: TitleClip[], row: number, start: Ticks, duration: Ticks, ignore?: string): boolean {
  return ts.some((t) => t.id !== ignore && t.row === row && start < titleEnd(t) && t.start < start + duration);
}

/** First free position at or after `start` on `row` (titles on a row never overlap). */
function freeStart(ts: TitleClip[], row: number, start: Ticks, duration: Ticks, ignore?: string): Ticks {
  let s = Math.max(0, start);
  for (const t of sorted(ts.filter((x) => x.row === row && x.id !== ignore))) {
    if (s + duration <= t.start) break;
    if (s < titleEnd(t)) s = titleEnd(t);
  }
  return s;
}

/** The lowest row where a title of `duration` fits at `start`. */
function freeRow(ts: TitleClip[], start: Ticks, duration: Ticks): number {
  for (let r = 0; r < MAX_TITLE_ROWS; r++) if (!overlaps(ts, r, start, duration)) return r;
  return MAX_TITLE_ROWS - 1;
}

function legal(t: TitleClip, p: Project): TitleClip {
  const st = t.style;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
  const pf = frameDuration(p.frameRate);
  const duration = Math.max(pf, snapToFrame(t.duration, p.frameRate));
  return {
    ...t,
    start: Math.max(0, snapToFrame(t.start, p.frameRate)),
    duration,
    row: clamp(Math.round(t.row), 0, MAX_TITLE_ROWS - 1),
    animLength: clamp(t.animLength, 0, Math.floor(duration / 2)),
    style: {
      ...st,
      size: clamp(st.size, 1, 40),
      weight: [400, 600, 700, 800, 900].includes(st.weight) ? st.weight : 700,
      x: clamp(st.x, -0.5, 1.5),
      y: clamp(st.y, -0.5, 1.5),
      boxOpacity: clamp(st.boxOpacity, 0, 1),
      maxWidth: clamp(st.maxWidth, 0.1, 1),
      color: isHexColor(st.color) ? st.color : '#ffffff',
      boxColor: isHexColor(st.boxColor) ? st.boxColor : '#000000',
    },
  };
}

export function addTitle(
  p: Project,
  at: Ticks,
  opts: { preset?: TitlePreset; text?: string; duration?: Ticks; row?: number; style?: Partial<TitleStyle> } = {},
): { project: Project; id: string } {
  const preset = TITLE_PRESETS.find((x) => x.id === (opts.preset ?? 'title')) ?? TITLE_PRESETS[0];
  const ts = titles(p);
  const duration = Math.max(frameDuration(p.frameRate), snapToFrame(opts.duration ?? TITLE_DEFAULT_DURATION, p.frameRate));
  let start = Math.max(0, snapToFrame(at, p.frameRate));
  const row = opts.row ?? freeRow(ts, start, duration);
  if (overlaps(ts, row, start, duration)) start = freeStart(ts, row, start, duration);
  const t = legal(
    {
      id: newId('title'), row, start, duration, text: opts.text ?? preset.text,
      style: { ...preset.style, ...opts.style }, animIn: preset.animIn, animOut: preset.animOut, animLength: TITLE_DEFAULT_ANIM,
    },
    p,
  );
  return { project: withTitles(p, [...ts, t]), id: t.id };
}

export function updateTitle(p: Project, id: string, fn: (t: TitleClip) => TitleClip): Project {
  const old = findTitle(p, id);
  if (!old) return p;
  const next = legal(fn(old), p);
  // Keep rows free of overlaps: if the change would collide, keep the old timing.
  const ts = titles(p);
  const timing = overlaps(ts, next.row, next.start, next.duration, id) ? { row: old.row, start: old.start, duration: old.duration } : {};
  return withTitles(p, ts.map((t) => (t.id === id ? { ...next, ...timing } : t)));
}

export function setTitleStyle(p: Project, id: string, patch: Partial<TitleStyle>): Project {
  return updateTitle(p, id, (t) => ({ ...t, style: { ...t.style, ...patch } }));
}

/** Move to a new start (and row); lands in the nearest free space on that row. */
export function moveTitle(p: Project, id: string, start: Ticks, row?: number): Project {
  const t = findTitle(p, id);
  if (!t) return p;
  const r = Math.min(MAX_TITLE_ROWS - 1, Math.max(0, row ?? t.row));
  const s = freeStart(titles(p), r, snapToFrame(Math.max(0, start), p.frameRate), t.duration, id);
  return withTitles(p, titles(p).map((x) => (x.id === id ? { ...x, start: s, row: r } : x)));
}

/** Drag an edge by a timeline delta; never past a neighbour on the same row, never shorter than a frame. */
export function trimTitle(p: Project, id: string, edge: 'start' | 'end', delta: Ticks): Project {
  const t = findTitle(p, id);
  if (!t) return p;
  const pf = frameDuration(p.frameRate);
  const others = titles(p).filter((x) => x.row === t.row && x.id !== id);
  const prevEnd = Math.max(0, ...others.filter((x) => x.start < t.start).map(titleEnd));
  const nextStart = Math.min(Number.MAX_SAFE_INTEGER, ...others.filter((x) => x.start > t.start).map((x) => x.start));
  let d = snapToFrame(delta, p.frameRate);
  if (edge === 'start') {
    d = Math.min(Math.max(d, prevEnd - t.start), t.duration - pf);
    // Keyframes are relative to the start: shift them so they stay at the same timeline times.
    return updateTitle(p, id, (x) => shiftKeys({ ...x, start: x.start + d, duration: x.duration - d }, -d));
  }
  d = Math.max(Math.min(d, nextStart - titleEnd(t)), pf - t.duration);
  return updateTitle(p, id, (x) => ({ ...x, duration: x.duration + d }));
}

export function deleteTitle(p: Project, id: string): Project {
  return withTitles(p, titles(p).filter((t) => t.id !== id));
}

/** Copy right after the original (or on a free row if that space is taken). */
export function duplicateTitle(p: Project, id: string): { project: Project; id: string } | null {
  const t = findTitle(p, id);
  if (!t) return null;
  const ts = titles(p);
  let row = t.row;
  let start = titleEnd(t);
  if (overlaps(ts, row, start, t.duration)) start = freeStart(ts, row, start, t.duration);
  const copy = { ...t, id: newId('title'), row, start };
  return { project: withTitles(p, [...ts, copy]), id: copy.id };
}

export function splitTitle(p: Project, id: string, at: Ticks): { project: Project; rightId: string } | null {
  const t = findTitle(p, id);
  if (!t) return null;
  const cut = snapToFrame(at, p.frameRate);
  const pf = frameDuration(p.frameRate);
  if (cut < t.start + pf || cut > titleEnd(t) - pf) return null;
  const left = legal({ ...t, duration: cut - t.start, animOut: 'none' }, p);
  const right = legal(shiftKeys({ ...t, id: newId('title'), start: cut, duration: titleEnd(t) - cut, animIn: 'none' }, -(cut - t.start)), p);
  return { project: withTitles(p, titles(p).flatMap((x) => (x.id === id ? [left, right] : [x]))), rightId: right.id };
}

// ---------------------------------------------------------------------------------------------
// Animation

export interface TitleState {
  opacity: number;
  dx: number; // horizontal offset, fraction of canvas width
  dy: number; // vertical offset, fraction of canvas height
  scale: number;
  rotation: number; // degrees clockwise around the text block's centre
  reveal: number; // 0..1 fraction of characters shown (typewriter)
}
const VISIBLE: TitleState = { opacity: 1, dx: 0, dy: 0, scale: 1, rotation: 0, reveal: 1 };

const easeOut = (p: number) => 1 - Math.pow(1 - p, 3);
const easeOutBack = (p: number) => {
  const c = 1.70158;
  return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2);
};

function animState(kind: TitleAnim, p: number): TitleState {
  // p: 0 = hidden end of the animation, 1 = fully visible
  switch (kind) {
    case 'fade':
      return { ...VISIBLE, opacity: p };
    case 'rise':
      return { ...VISIBLE, opacity: Math.min(1, p * 1.5), dy: (1 - easeOut(p)) * 0.05 };
    case 'pop':
      return { ...VISIBLE, opacity: Math.min(1, p * 3), scale: 0.5 + 0.5 * easeOutBack(p) };
    case 'typewriter':
      return { ...VISIBLE, reveal: p };
    default:
      return VISIBLE;
  }
}

/** The title's look at timeline time t, or null when it is not on screen. */
export function titleStateAt(t: TitleClip, time: Ticks): TitleState | null {
  if (time < t.start || time >= titleEnd(t)) return null;
  const rel = time - t.start;
  const len = Math.min(t.animLength, Math.floor(t.duration / 2));
  let st = VISIBLE;
  if (len > 0 && t.animIn !== 'none' && rel < len) st = animState(t.animIn, rel / len);
  // The out animation ends on the title's last frame being nearly hidden (not on the frame after).
  else if (len > 0 && t.animOut !== 'none' && rel >= t.duration - len) st = animState(t.animOut, (t.duration - rel) / len);
  if (!t.keyframes) return st;
  const k = (prop: TitleKeyProp, def: number) => (t.keyframes?.[prop]?.length ? keyframeValue(t.keyframes[prop], rel, prop === 'x' || prop === 'y' ? 'x' : prop) : def);
  return {
    ...st,
    dx: st.dx + k('x', 0),
    dy: st.dy + k('y', 0),
    scale: st.scale * Math.max(0, k('scale', 1)),
    opacity: st.opacity * Math.min(1, Math.max(0, k('opacity', 1))),
    rotation: st.rotation + k('rotation', 0),
  };
}

/** Keyframes moved by `delta` (relative time), e.g. when the start edge moves. */
function shiftKeys(t: TitleClip, delta: Ticks): TitleClip {
  if (!t.keyframes || delta === 0) return t;
  const keyframes: TitleClip['keyframes'] = {};
  for (const prop of TITLE_KEY_PROPS) {
    const keys = t.keyframes[prop];
    if (keys?.length) keyframes[prop] = keys.map((x) => ({ ...x, at: x.at + delta }));
  }
  return { ...t, keyframes };
}

/** Add or change a keyframe at `rel` (time since the title's start, on the frame grid). */
export function setTitleKeyframe(p: Project, id: string, prop: TitleKeyProp, rel: Ticks, value: number, easing?: Keyframe['easing']): Project {
  const at = Math.max(0, snapToFrame(rel, p.frameRate));
  const v = !Number.isFinite(value) ? 0
    : prop === 'opacity' ? Math.min(1, Math.max(0, value))
    : prop === 'scale' ? Math.min(20, Math.max(0, value))
    : prop === 'rotation' ? Math.min(3600, Math.max(-3600, value))
    : Math.min(2, Math.max(-2, value));
  return updateTitle(p, id, (t) => ({ ...t, keyframes: { ...t.keyframes, [prop]: upsertKeyframe(t.keyframes?.[prop], at, v, easing) } }));
}

export function removeTitleKeyframe(p: Project, id: string, prop: TitleKeyProp, rel: Ticks): Project {
  return updateTitle(p, id, (t) => {
    const keys = removeKeyframeAt(t.keyframes?.[prop], rel);
    const keyframes = { ...t.keyframes, [prop]: keys };
    if (!keys.length) delete keyframes[prop];
    const { keyframes: _old, ...rest } = t;
    return Object.keys(keyframes).length ? { ...rest, keyframes } : rest;
  });
}

/** Titles visible at `time`, in drawing order (lowest row first). */
export function titlesAt(p: Project, time: Ticks): { title: TitleClip; state: TitleState }[] {
  const out: { title: TitleClip; state: TitleState }[] = [];
  for (const t of titles(p)) {
    const state = titleStateAt(t, time);
    if (state) out.push({ title: t, state });
  }
  return out.sort((a, b) => a.title.row - b.title.row);
}

/** Times inside the title's in/out animations (for rendering every animated frame in export). */
export function isAnimating(t: TitleClip, time: Ticks): boolean {
  const len = Math.min(t.animLength, Math.floor(t.duration / 2));
  const rel = time - t.start;
  // Between the first and last keyframe of a property whose value changes.
  for (const prop of TITLE_KEY_PROPS) {
    const keys = t.keyframes?.[prop];
    if (keys && keys.length > 1 && rel > keys[0].at && rel <= keys[keys.length - 1].at && keys.some((x) => x.value !== keys[0].value)) return true;
  }
  if (len <= 0) return false;
  return (t.animIn !== 'none' && rel >= 0 && rel < len) || (t.animOut !== 'none' && rel >= t.duration - len && rel < t.duration);
}
