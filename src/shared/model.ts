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
import { type AnimState, type ClipAnimation, type Keyframe } from './animation';
import type { CaptionSettings } from './captions';
import type { Rational, Ticks } from './time';

export const PROJECT_FORMAT = 'cutroom-project';
/** v2: clip animations. v3: transcripts and captions. v4: audio tracks and audio-only media. v5: titles. v6: overlay video tracks. v7: markers and more clip fields (Phase 1 editing). */
export const PROJECT_VERSION = 7;
export const PROJECT_EXTENSION = 'cutroom';

export type MediaKind = 'video' | 'audio' | 'image';

export interface MediaInfo {
  /** Absent in older projects = 'video'. */
  kind?: MediaKind;
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
  /** YUV matrix of the source (from its tag, else by size: < 720 lines = BT.601, as players and Chromium assume). */
  colorMatrix?: 'bt709' | 'bt601' | 'other';
  colorRange?: 'tv' | 'pc';
  /** The file's own matrix and primaries tags ('' = untagged); sourceColor interprets them per platform. */
  colorTags?: { matrix: string; primaries: string };
  /** Photos with transparency (PNG/WebP): the background colour shows through. */
  hasAlpha?: boolean;
  /**
   * How the preview shows this file (the export always reads the original): 'native' = the
   * original; otherwise a cached preview copy made with FFmpeg ('remux': picture copied, sound
   * converted; 'transcode': H.264 copy; 'audio'; 'image'). Absent = 'native'.
   */
  preview?: 'native' | 'remux' | 'transcode' | 'audio' | 'image';
  // Audio
  hasAudio: boolean;
  audioCodec: string | null;
  audioSampleRate: number | null;
  audioChannels: number | null;
}

/** Speech-to-text result for a media file. Word times are SOURCE time (they follow every edit). */
export interface TranscriptWord {
  start: Ticks;
  end: Ticks;
  text: string;
}
export interface Transcript {
  language: string;
  model: string;
  words: TranscriptWord[];
}

export interface MediaRef {
  id: string;
  name: string;
  path: string; // absolute path at last save
  relativePath?: string; // relative to the project file, used to find media after moving folders
  info: MediaInfo;
  warnings: string[];
  transcript?: Transcript;
  /** Where the file's audio is not silent (SOURCE time); used to lower music under speech. */
  speech?: { start: Ticks; end: Ticks }[];
  /** Made by Cutroom from part of another file (freeze frame, reversed clip). */
  derived?: { kind: 'freeze' | 'reverse'; mediaId: string; sourceIn: Ticks; sourceOut: Ticks };
}

export function mediaKind(m: MediaRef | undefined): MediaKind {
  return m?.info.kind ?? 'video';
}

export type FramingMode = 'fit' | 'fill' | 'manual';

export interface Framing {
  mode: FramingMode;
  /** Manual only: size relative to "fit" (1 = same size as Fit). */
  scale: number;
  /** Manual only: offset of the image centre from the canvas centre, as a fraction of canvas width/height. */
  x: number;
  y: number;
  /** Any mode: degrees clockwise around the image centre (absent = 0). Corners outside the canvas are cut off. */
  rotation?: number;
}

/** Total rotation of a clip at an animation state (framing + animated), in degrees clockwise. */
export function clipAngle(framing: Framing, animated = 0): number {
  return (framing.rotation ?? 0) + animated;
}

export type TransitionKind =
  | 'crossfade' | 'dipBlack' | 'dipWhite'
  | 'wipeLeft' | 'wipeRight' | 'wipeUp' | 'wipeDown'
  | 'slideLeft' | 'slideRight' | 'slideUp' | 'slideDown'
  | 'zoom';

export interface ClipItem {
  kind: 'clip';
  id: string;
  mediaId: string;
  sourceIn: Ticks;
  sourceOut: Ticks; // exclusive; timeline duration = (sourceOut - sourceIn) / speed
  framing: Framing;
  /** Playback speed, 0.25..4 (absent = 1). Sound keeps its pitch. */
  speed?: number;
  /** Colour adjustments (see color.ts); absent = unchanged. */
  color?: import('./color').ColorAdjust;
  /** Transition into the next clip, centred on the cut (see transitions.ts). */
  transition?: { kind: TransitionKind; duration: Ticks };
  volume: number; // 0..2 (1 = original level)
  muted: boolean;
  animation?: ClipAnimation;
}

/**
 * A clip on an overlay video track (V2, V3, …): placed freely in time, drawn over the main track
 * (higher rows on top), e.g. picture-in-picture. It has every property of a main-track clip.
 */
export interface OverlayClip extends Omit<ClipItem, 'kind' | 'transition'> {
  kind: 'overlay';
  row: number; // 0 = V2, just above the main track
  start: Ticks; // timeline time
}

/** A clip on an audio track. Unlike the video track, audio clips are placed freely in time. */
export interface AudioClip {
  id: string;
  mediaId: string;
  start: Ticks; // timeline time
  sourceIn: Ticks;
  sourceOut: Ticks;
  volume: number; // 0..2
  fadeIn: Ticks;
  fadeOut: Ticks;
}

export interface AudioTrack {
  id: string;
  name: string;
  clips: AudioClip[]; // sorted by start, never overlapping
  volume: number; // 0..2
  muted: boolean;
  /** Lower this track while the video track has sound (speech), by duckDb decibels. */
  duck: boolean;
  duckDb: number; // e.g. -14
}

/** Empty space on the timeline (renders as background colour + silence). */
export interface GapItem {
  kind: 'gap';
  id: string;
  duration: Ticks;
}

export type TrackItem = ClipItem | GapItem;

export type CanvasPreset = 'match' | '16:9' | '9:16' | '1:1' | '4:5' | 'custom';

export type TitleFont = 'sans' | 'serif' | 'rounded' | 'mono' | 'condensed';
export type TitleLook = 'plain' | 'shadow' | 'outline' | 'box';
export type TitleAnim = 'none' | 'fade' | 'rise' | 'pop' | 'typewriter';

export interface TitleStyle {
  font: TitleFont;
  weight: number; // 400 | 600 | 700 | 900
  italic: boolean;
  size: number; // text height as % of the canvas height
  color: string; // #rrggbb
  align: 'left' | 'center' | 'right';
  /** Anchor, as fractions of the canvas: x is the left/centre/right edge of the text (per align), y its vertical centre. */
  x: number;
  y: number;
  look: TitleLook;
  boxColor: string; // #rrggbb, for look 'box'
  boxOpacity: number; // 0..1
  uppercase: boolean;
  /** Lines wrap at this fraction of the canvas width. */
  maxWidth: number;
}

/** Text over the picture, placed freely in time on a text row (rows never have overlapping titles). */
export interface TitleClip {
  id: string;
  row: number; // 0 = lowest row; higher rows draw on top
  start: Ticks;
  duration: Ticks;
  text: string; // may contain line breaks
  style: TitleStyle;
  animIn: TitleAnim;
  animOut: TitleAnim;
  animLength: Ticks; // length of each of the in/out animations
  /**
   * Keyframed motion, on top of the style and in/out animations. Times are relative to the
   * title's start (keys stay put when the title is moved). x/y: offset as a fraction of canvas
   * width/height; scale: multiplier; opacity: 0..1; rotation: degrees clockwise.
   */
  keyframes?: Partial<Record<TitleKeyProp, Keyframe[]>>;
}

export type TitleKeyProp = 'x' | 'y' | 'scale' | 'opacity' | 'rotation';
export const TITLE_KEY_PROPS: TitleKeyProp[] = ['x', 'y', 'scale', 'opacity', 'rotation'];

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
  /** Burned-in captions built from media transcripts (absent = off). */
  captions?: CaptionSettings;
  /** Music / voice-over tracks, mixed under the video track's audio. */
  audioTracks?: AudioTrack[];
  /** Overlay video tracks (picture-in-picture, stacked clips), drawn over the main track. */
  overlays?: OverlayClip[];
  /** Titles and text overlays, drawn above the picture (and below captions). */
  titles?: TitleClip[];
  /** Named points on the timeline (M); exported as chapters if asked. */
  markers?: Marker[];
}

export type MarkerColor = 'yellow' | 'red' | 'green' | 'blue' | 'purple';
export interface Marker {
  id: string;
  time: Ticks; // timeline time, on the frame grid
  label: string;
  color: MarkerColor;
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

export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;

export function clipSpeed(c: ClipItem): number {
  return c.speed ?? 1;
}

/** Timeline length of `sourceLength` ticks of a clip's media. */
export function scaledDuration(sourceLength: Ticks, speed: number): Ticks {
  return speed === 1 ? sourceLength : Math.round(sourceLength / speed);
}

export function itemDuration(item: TrackItem): Ticks {
  return item.kind === 'clip' ? scaledDuration(item.sourceOut - item.sourceIn, clipSpeed(item)) : item.duration;
}

/** Source (media) time shown at timeline time t, for a clip starting at `start` on the timeline. */
export function sourceAt(c: ClipItem, start: Ticks, t: Ticks): Ticks {
  const s = clipSpeed(c);
  return c.sourceIn + (s === 1 ? t - start : Math.round((t - start) * s));
}

/** Timeline time at which source time `src` of a clip starting at `start` is shown. */
export function timelineAt(c: ClipItem, start: Ticks, src: Ticks): Ticks {
  const s = clipSpeed(c);
  return start + (s === 1 ? src - c.sourceIn : Math.round((src - c.sourceIn) / s));
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

/** Apply an animation state to a framed rectangle (scale around its centre, then offset). */
export function animateRect(r: Rect, st: AnimState, canvasW: number, canvasH: number): Rect {
  const cx = r.x + r.w / 2 + st.x * canvasW;
  const cy = r.y + r.h / 2 + st.y * canvasH;
  const w = r.w * st.scale;
  const h = r.h * st.scale;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** The manual framing that reproduces what the clip currently looks like. Used when switching to Manual. */
export function toManualFraming(srcW: number, srcH: number, canvasW: number, canvasH: number, framing: Framing): Framing {
  if (framing.mode === 'manual') return framing;
  const fit = fitScale(srcW, srcH, canvasW, canvasH);
  const scale = framing.mode === 'fit' ? 1 : fillScale(srcW, srcH, canvasW, canvasH) / fit;
  return { mode: 'manual', scale, x: 0, y: 0, ...(framing.rotation ? { rotation: framing.rotation } : {}) };
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

/** Where the preview runs: Chromium on macOS colour-manages video that Chromium elsewhere does not. */
export type PreviewPlatform = 'mac' | 'other';

export interface SourceColor {
  matrix: 'bt709' | 'bt601' | 'other';
  /** Colour primaries the preview converts from ('bt709' = no conversion). */
  primaries: 'bt709' | 'smpte170m' | 'bt470bg' | 'other';
}

const BT601_MATRICES = ['smpte170m', 'bt470bg', 'bt601', 'fcc'];

/**
 * How the preview interprets a source's colours, so the export can do the same (measured; see
 * ARCHITECTURE.md "Colour"). A tag wins; untagged video counts as SD (BT.601 matrix, SMPTE-C
 * primaries) below 720 lines, or on macOS (VideoToolbox) at most 704×576. Only macOS converts
 * SD primaries to the display: elsewhere SMPTE-C/EBU video is shown as if it were BT.709.
 */
export function sourceColor(info: MediaInfo, platform: PreviewPlatform): SourceColor {
  const tags = info.colorTags;
  const sd = platform === 'mac' ? info.width <= 704 && info.height <= 576 : info.height < 720 && info.width < 1280;
  // Older projects have only the matrix (tagged or guessed by the < 720 lines rule).
  const matrix: SourceColor['matrix'] = !tags
    ? info.colorMatrix ?? (info.height < 720 && info.width < 1280 ? 'bt601' : 'bt709')
    : tags.matrix === 'bt709' ? 'bt709'
      : BT601_MATRICES.includes(tags.matrix) ? 'bt601'
        : tags.matrix ? 'other'
          : sd ? 'bt601' : 'bt709';
  if (platform !== 'mac') return { matrix, primaries: 'bt709' };
  const p = tags?.primaries ?? '';
  // Untagged primaries follow the matrix (a BT.601 matrix implies SMPTE-C, as VideoToolbox assumes).
  const primaries: SourceColor['primaries'] =
    p === 'bt709' ? 'bt709'
      : p === 'smpte170m' || p === 'smpte240m' ? 'smpte170m'
        : p === 'bt470bg' ? 'bt470bg'
          : p ? 'other'
            : matrix === 'bt601' ? 'smpte170m' : 'bt709';
  return { matrix, primaries };
}

export function isHexColor(s: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(s);
}
