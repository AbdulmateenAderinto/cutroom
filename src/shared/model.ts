/**
 * The project model: plain, serializable data. The UI, the preview and the exporter all read
 * this same structure, so an edit means the same thing everywhere.
 *
 * Non-destructive: clips only reference media by id and store instructions (in/out points,
 * framing, volume). Source files are never modified.
 *
 * Time values are integer Ticks (see time.ts). Two time spaces are kept distinct:
 *   - source time:   a position inside a media file (ClipItem.sourceIn / sourceOut)
 *   - timeline time: a position in the edited sequence (derived by layoutSequence)
 */
import type { Rational, Ticks } from './time';

export const PROJECT_FORMAT = 'cutroom-project';
export const PROJECT_VERSION = 1;
export const PROJECT_EXTENSION = 'cutroom';

export interface MediaInfo {
  container: string; // ffprobe format_name, e.g. "mov,mp4,m4a,3gp,3g2,mj2"
  fileSize: number;
  duration: Ticks; // usable duration (video stream duration when present)
  // Video
  videoCodec: string;
  width: number; // coded pixel size
  height: number;
  displayWidth: number; // after rotation and pixel aspect ratio — use these for framing
  displayHeight: number;
  rotation: number; // degrees, 0/90/180/270
  frameRate: Rational; // nominal (r_frame_rate)
  avgFrameRate: Rational;
  isVFR: boolean;
  pixFmt: string;
  colorTransfer: string;
  isHDR: boolean;
  // Audio
  hasAudio: boolean;
  audioCodec: string | null;
  audioSampleRate: number | null;
  audioChannels: number | null;
}

export interface MediaRef {
  id: string;
  name: string;
  path: string; // absolute path at last save
  relativePath?: string; // relative to the project file, used to find media after moving folders
  info: MediaInfo;
  warnings: string[];
}

export type FramingMode = 'fit' | 'fill' | 'manual';

export interface Framing {
  mode: FramingMode;
  /** Manual only: size relative to "fit" (1 = same size as Fit). */
  scale: number;
  /** Manual only: offset of the image centre from the canvas centre, as a fraction of canvas width/height. */
  x: number;
  y: number;
}

export interface ClipItem {
  kind: 'clip';
  id: string;
  mediaId: string;
  sourceIn: Ticks;
  sourceOut: Ticks; // exclusive; timeline duration = sourceOut - sourceIn (speed is always 1 for now)
  framing: Framing;
  volume: number; // 0..1
  muted: boolean;
}

/** Empty space on the timeline (renders as background colour + silence). */
export interface GapItem {
  kind: 'gap';
  id: string;
  duration: Ticks;
}

export type TrackItem = ClipItem | GapItem;

export type CanvasPreset = 'match' | '16:9' | '9:16' | '1:1' | '4:5' | 'custom';

export interface Project {
  format: typeof PROJECT_FORMAT;
  version: number;
  id: string;
  name: string;
  canvas: { width: number; height: number; preset: CanvasPreset };
  frameRate: Rational;
  background: string; // "#rrggbb", used for padding in Fit and for gaps
  audio: { sampleRate: number; channels: number };
  media: MediaRef[];
  /** A single magnetic video track: items play back-to-back in array order. */
  sequence: { items: TrackItem[] };
}

export const DEFAULT_FRAMING: Framing = { mode: 'fit', scale: 1, x: 0, y: 0 };

export function newId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

export function createProject(name = 'Untitled'): Project {
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    id: newId('proj'),
    name,
    canvas: { width: 1920, height: 1080, preset: '16:9' },
    frameRate: { num: 30, den: 1 },
    background: '#000000',
    audio: { sampleRate: 48000, channels: 2 },
    media: [],
    sequence: { items: [] },
  };
}

export function itemDuration(item: TrackItem): Ticks {
  return item.kind === 'clip' ? item.sourceOut - item.sourceIn : item.duration;
}

export interface LaidOutItem {
  item: TrackItem;
  index: number;
  start: Ticks; // timeline time
  end: Ticks;
}

/** Derive timeline placement from clip order. Integer arithmetic, so no drift. */
export function layoutSequence(project: Project): { items: LaidOutItem[]; duration: Ticks } {
  let t = 0;
  const items = project.sequence.items.map((item, index) => {
    const start = t;
    t += itemDuration(item);
    return { item, index, start, end: t };
  });
  return { items, duration: t };
}

/** The item whose [start, end) contains t. At the very end, returns the last item. */
export function itemAt(layout: LaidOutItem[], t: Ticks): LaidOutItem | null {
  for (const l of layout) if (t >= l.start && t < l.end) return l;
  return null;
}

export function findMedia(project: Project, mediaId: string): MediaRef | undefined {
  return project.media.find((m) => m.id === mediaId);
}

// ---------------------------------------------------------------------------------------------
// Framing — shared by preview (CSS positioning) and export (FFmpeg crop/scale/overlay).

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function fitScale(srcW: number, srcH: number, canvasW: number, canvasH: number): number {
  return Math.min(canvasW / srcW, canvasH / srcH);
}

export function fillScale(srcW: number, srcH: number, canvasW: number, canvasH: number): number {
  return Math.max(canvasW / srcW, canvasH / srcH);
}

/**
 * Where the (display-oriented) source image lands on the canvas, in canvas pixels.
 * Width and height are always scaled by the same factor: footage is never stretched.
 */
export function computeClipRect(srcW: number, srcH: number, canvasW: number, canvasH: number, framing: Framing): Rect {
  const fit = fitScale(srcW, srcH, canvasW, canvasH);
  let s: number;
  let cx = canvasW / 2;
  let cy = canvasH / 2;
  if (framing.mode === 'fit') s = fit;
  else if (framing.mode === 'fill') s = fillScale(srcW, srcH, canvasW, canvasH);
  else {
    s = fit * framing.scale;
    cx += framing.x * canvasW;
    cy += framing.y * canvasH;
  }
  const w = srcW * s;
  const h = srcH * s;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** The manual framing that reproduces what the clip currently looks like. Used when switching to Manual. */
export function toManualFraming(srcW: number, srcH: number, canvasW: number, canvasH: number, framing: Framing): Framing {
  if (framing.mode === 'manual') return framing;
  const fit = fitScale(srcW, srcH, canvasW, canvasH);
  const scale = framing.mode === 'fit' ? 1 : fillScale(srcW, srcH, canvasW, canvasH) / fit;
  return { mode: 'manual', scale, x: 0, y: 0 };
}

// ---------------------------------------------------------------------------------------------
// Canvas presets

export const CANVAS_PRESETS: { id: CanvasPreset; label: string; width?: number; height?: number }[] = [
  { id: 'match', label: 'Match source' },
  { id: '16:9', label: '16:9 Landscape', width: 1920, height: 1080 },
  { id: '9:16', label: '9:16 Portrait', width: 1080, height: 1920 },
  { id: '1:1', label: '1:1 Square', width: 1080, height: 1080 },
  { id: '4:5', label: '4:5 Portrait', width: 1080, height: 1350 },
  { id: 'custom', label: 'Custom…' },
];

/** H.264 with 4:2:0 chroma needs even dimensions. */
export function evenDim(n: number): number {
  const r = Math.max(2, Math.round(n));
  return r % 2 === 0 ? r : r + 1;
}

export const MAX_DIMENSION = 7680;

export function isHexColor(s: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(s);
}
