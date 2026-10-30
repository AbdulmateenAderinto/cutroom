/**
 * Turns a Project + ExportSettings into an FFmpeg argument list (an array — never a shell string,
 * so file names with spaces/quotes/etc. are passed through untouched).
 *
 * Graph shape, one segment per timeline item:
 *   clip:  [input] crop→scale (same maths as the preview) → overlay onto a background of exactly
 *          N frames;  audio: trim/align → resample 48k stereo → volume → pad/trim to exactly M samples
 *   gap:   background colour for N frames + M samples of silence
 * then concat all segments, then pad/crop the canvas into the output size if the aspect differs.
 *
 * Segment lengths come from cumulative timeline boundaries rounded once each, so per-segment
 * rounding never accumulates, and audio boundaries are derived from the same video frame
 * boundaries (keeps A/V in sync across any number of cuts).
 */
import { animatesOpacity, evalAnimation, hasAnimation } from './animation';
import { audioClipDuration, audioClipEnd, duckGainAt, speechIntervals, tracks } from './audio';
import {
  type ClipItem,
  type LaidOutItem,
  type MediaInfo,
  type MediaRef,
  type PreviewPlatform,
  type Project,
  type Rect,
  animateRect,
  clipAngle,
  clipSpeed,
  computeClipRect,
  evenDim,
  findMedia,
  isHexColor,
  layoutSequence,
  sourceAt,
  sourceColor,
} from './model';
import { type ResolvedTransition, dipColour, isDip, resolveTransitions, transitionMix, xfadeName, zoomScale } from './transitions';
import { clipColor, ffmpegCurves, ffmpegMixer } from './color';
import { ffmpegAudioFx } from './audioFx';
import { ffmpegMaskAlpha } from './effects';
import { overlayLayout, overlays } from './overlays';
import {
  type Rational,
  type Ticks,
  frameDuration,
  frameToTicks,
  rateToFloat,
  secondsToTicks,
  ticksToFrame,
  ticksToSamples,
  ticksToSeconds,
} from './time';

export type X264Preset = 'veryfast' | 'faster' | 'fast' | 'medium' | 'slow';

export interface ExportSettings {
  outputPath: string;
  width: number;
  height: number;
  frameRate: Rational;
  /** Only matters when the output aspect ratio differs from the canvas: letterbox (fit) or crop (fill). */
  canvasMapping: 'fit' | 'fill';
  videoBitrateMbps: number;
  x264Preset: X264Preset;
  audioBitrateKbps: number;
  /** 'bitrate' (default): average target bitrate. 'crf': constant quality (libx264 only). */
  rateControl?: 'bitrate' | 'crf';
  /** libx264 constant-quality value: lower = better and larger (18 ≈ visually lossless, 23 = default). */
  crf?: number;
  /** 'x264' (default, software) or 'videotoolbox' (Apple hardware encoder, macOS only). */
  encoder?: VideoEncoder;
  /**
   * Video codec (default 'h264'). 'hevc' = H.265, tagged hvc1 so Apple devices play it; 'prores' =
   * Apple ProRes 422 for editing (`.mov` only; quality-based, so bitrate/CRF don't apply).
   * The container (MP4 or QuickTime .mov) follows the output file's extension.
   */
  codec?: VideoCodec;
  proresProfile?: 'standard' | 'hq';
  /** Export only this part of the timeline (timeline ticks, end exclusive). */
  range?: { start: Ticks; end: Ticks } | null;
  /** Write the timeline markers as chapters (MP4/MOV chapter marks). */
  chapters?: boolean;
  /** Normalize the loudness of the whole mix to this integrated level (LUFS), e.g. −14; null = off. */
  loudness?: number | null;
  /**
   * Render the picture in several parts at once (each part is a range export, so its frames are
   * the same as a one-pass export's), then join them without re-encoding the picture. The sound
   * is rendered as PCM per part and encoded once over the joined mix. See segmentRanges.
   */
  parallel?: boolean;
}

export const LOUDNESS_TARGETS: { lufs: number; label: string }[] = [
  { lufs: -14, label: '−14 LUFS (YouTube, Spotify, Instagram)' },
  { lufs: -16, label: '−16 LUFS (Apple Music, podcasts)' },
  { lufs: -23, label: '−23 LUFS (broadcast, EBU R128)' },
];
/** True-peak ceiling used with loudness normalization (dBTP). */
export const TRUE_PEAK = -1.5;

/** What FFmpeg's loudnorm measured in the first pass. */
export interface LoudnessMeasurement {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

export type VideoEncoder = 'x264' | 'videotoolbox';
export type VideoCodec = 'h264' | 'hevc' | 'prores';
export const VIDEO_CODECS: { id: VideoCodec; label: string }[] = [
  { id: 'h264', label: 'H.264 — plays everywhere' },
  { id: 'hevc', label: 'HEVC (H.265) — about half the size, plays on Apple devices' },
  { id: 'prores', label: 'Apple ProRes 422 — for editing (Final Cut Pro), very large' },
];

export const containerOf = (outputPath: string): 'mp4' | 'mov' => (/\.mov$/i.test(outputPath) ? 'mov' : 'mp4');

/** ProRes data rates (Mb/s) at 1920×1080 29.97 fps, from Apple's ProRes white paper; scaled by pixels × fps. */
export function proresMbps(w: number, h: number, fps: Rational, profile: 'standard' | 'hq' = 'standard'): number {
  const base = profile === 'hq' ? 220 : 147;
  return Math.round((base * (w * h * rateToFloat(fps))) / (1920 * 1080 * 29.97));
}
export const CRF_RANGE = { min: 12, max: 35, default: 20 };

export const AUDIO_BITRATES = [128, 160, 192, 256, 320];
export const X264_PRESETS: { id: X264Preset; label: string }[] = [
  { id: 'veryfast', label: 'Very fast (larger artefacts at the same bitrate)' },
  { id: 'faster', label: 'Faster' },
  { id: 'fast', label: 'Fast' },
  { id: 'medium', label: 'Medium (recommended)' },
  { id: 'slow', label: 'Slow (better quality per bit, slower export)' },
];

/** Largest size an animated clip may be scaled to in one frame (protects memory). */
export const MAX_ANIMATED_DIM = 8192;

export interface ExportPlan {
  args: string[];
  durationSeconds: number;
  /** Frames in the output file (the range, if one is set). */
  totalFrames: number;
  /** Frames rendered before the range start is trimmed off (the caption/title image track covers them). */
  timelineFrames: number;
  /** The part of the timeline in the output (timeline ticks, end exclusive). */
  span: { start: Ticks; end: Ticks };
  width: number;
  height: number;
}

/** Output sizes that keep the canvas aspect ratio. */
export function outputSizeOptions(canvasW: number, canvasH: number): { label: string; width: number; height: number }[] {
  const out = [{ label: `Canvas size (${canvasW}×${canvasH})`, width: canvasW, height: canvasH }];
  const short = Math.min(canvasW, canvasH);
  for (const target of [2160, 1440, 1080, 720, 540, 480]) {
    if (target === short) continue;
    const k = target / short;
    const w = evenDim(canvasW * k);
    const h = evenDim(canvasH * k);
    if (w > 7680 || h > 7680) continue;
    out.push({ label: `${target}p (${w}×${h})`, width: w, height: h });
  }
  return out;
}

/** Rough starting point: ~0.1 bits per pixel per frame (H.264, typical footage). */
export function suggestBitrateMbps(w: number, h: number, fps: Rational, codec: VideoCodec = 'h264'): number {
  // HEVC reaches the same quality at roughly 60% of H.264's bitrate.
  if (codec === 'hevc') return Math.max(1, Math.round(suggestBitrateMbps(w, h, fps) * 0.6 * 2) / 2);
  const mbps = (w * h * rateToFloat(fps) * 0.1) / 1e6;
  return Math.max(1, Math.round(mbps * 2) / 2);
}

/** Approximate size: average bitrate × duration. Real files vary with content and container overhead. */
export function estimateFileSizeBytes(durationSeconds: number, videoMbps: number, audioKbps: number): number {
  return ((videoMbps * 1e6 + audioKbps * 1e3) * durationSeconds) / 8;
}

export function aspectDiffers(w1: number, h1: number, w2: number, h2: number): boolean {
  return Math.abs(w1 / h1 - w2 / h2) > 0.005;
}

export function validateExportSettings(project: Project, s: ExportSettings, mediaAvailable: (m: MediaRef) => boolean): string[] {
  const errors: string[] = [];
  const clips = project.sequence.items.filter((i) => i.kind === 'clip');
  if (clips.length === 0) errors.push('The timeline is empty. Add at least one clip before exporting.');
  if (!s.outputPath) errors.push('Choose where to save the exported video.');
  if (!(s.width >= 16 && s.height >= 16 && s.width <= 7680 && s.height <= 7680)) errors.push('Output size must be between 16 and 7680 pixels.');
  if (s.width % 2 || s.height % 2) errors.push('H.264 output needs even width and height.');
  if (!(s.videoBitrateMbps >= 0.1 && s.videoBitrateMbps <= 400)) errors.push('Video bitrate must be between 0.1 and 400 Mb/s.');
  const codec = s.codec ?? 'h264';
  if (!/\.(mp4|mov)$/i.test(s.outputPath) && s.outputPath) errors.push('The output file must end in .mp4 or .mov.');
  if (codec === 'prores' && containerOf(s.outputPath) !== 'mov' && s.outputPath) errors.push('ProRes is saved as a QuickTime .mov file: change the file name ending to .mov.');
  if (codec === 'prores' && s.encoder === 'videotoolbox') errors.push('ProRes is encoded in software here; choose the software encoder.');
  if (s.rateControl === 'crf' && codec !== 'prores') {
    if (s.encoder === 'videotoolbox') errors.push('Constant quality is not available with the hardware encoder. Use a target bitrate, or the software encoder.');
    if (!(Number.isFinite(s.crf) && s.crf! >= CRF_RANGE.min && s.crf! <= CRF_RANGE.max)) errors.push(`Quality (CRF) must be between ${CRF_RANGE.min} and ${CRF_RANGE.max}.`);
  }
  if (s.range) {
    const dur = layoutSequence(project).duration;
    const one = frameDuration(s.frameRate);
    if (!(s.range.start >= 0 && s.range.end <= dur + one && s.range.end - s.range.start >= one)) errors.push('The marked range is empty or outside the timeline. Mark it again (I and O keys) or export the whole timeline.');
  }
  const missing = new Set<string>();
  const used = [...clips.map((c) => (c.kind === 'clip' ? c.mediaId : '')), ...tracks(project).flatMap((t) => t.clips.map((c) => c.mediaId))];
  for (const id of used) {
    if (!id) continue;
    const m = findMedia(project, id);
    if (!m || !mediaAvailable(m)) missing.add(m?.name ?? id);
  }
  if (missing.size) errors.push(`Some media files are offline: ${[...missing].join(', ')}. Relink them first.`);
  return errors;
}

const f6 = (n: number) => n.toFixed(6);
/** Truncate (never round up) so values stay within bounds. */
const trunc3 = (n: number) => (Math.floor(n * 1000) / 1000).toFixed(3);
const hexColor = (c: string) => '0x' + c.replace('#', '');

function intersect(a: Rect, w: number, h: number): Rect | null {
  const x0 = Math.max(0, a.x);
  const y0 = Math.max(0, a.y);
  const x1 = Math.min(w, a.x + a.w);
  const y1 = Math.min(h, a.y + a.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** How the project canvas maps into the output frame: scale k and the canvas size in output pixels. */
export function canvasInOutput(project: Project, s: Pick<ExportSettings, 'width' | 'height' | 'canvasMapping'>) {
  const cw = project.canvas.width;
  const ch = project.canvas.height;
  const k = s.canvasMapping === 'fill' ? Math.max(s.width / cw, s.height / ch) : Math.min(s.width / cw, s.height / ch);
  return { k, bw: Math.max(2, Math.round(cw * k)), bh: Math.max(2, Math.round(ch * k)) };
}

/** Caption images rendered by the app for one export (base64 PNGs of the canvas-in-output size). */
export interface CaptionTrack {
  width: number;
  height: number;
  blank: string;
  segments: { start: number; end: number; png: string }[]; // timeline seconds
}

export interface ExportExtras {
  /**
   * Pitch-preserving time stretch for speed changes: 'rubberband' when the FFmpeg build has it
   * (sound lines up within ~50 ms at 0.25×, ~30 ms at 0.5×, ~15 ms when faster), else 'atempo'
   * (up to ~120 ms early at 0.25×, ~40 ms at 0.5×). Measured with beeps; see STATUS.md.
   */
  timeStretch?: 'rubberband' | 'atempo';
  /** ffconcat file listing caption PNGs (canvas-in-output size) with durations; see exportRunner. */
  captionTrack?: string;
  /** Platform whose preview the export matches (sourceColor); default 'other'. */
  previewPlatform?: PreviewPlatform;
  /** FFmpeg metadata file with chapters (markers.chapterMetadata), written by the runner. */
  chaptersFile?: string;
  /**
   * Loudness normalization (settings.loudness), in two passes: 'measure' builds a plan that only
   * measures the finished mix (output discarded; loudnorm prints JSON), then the real export
   * applies a linear gain with the measured values.
   */
  loudness?: 'measure' | LoudnessMeasurement;
  /**
   * Parallel export part: the picture alone goes to the output file (QuickTime, the export's codec)
   * and the mix to `audioFile` as 32-bit float WAV. No loudness or chapters (added when joining).
   */
  segment?: { audioFile: string };
}

/** The loudnorm filter that applies a measured correction (linear gain), back at the project rate. */
export function loudnormApply(target: number, L: LoudnessMeasurement, sampleRate: number, samples: number): string {
  return (
    `loudnorm=I=${target}:TP=${TRUE_PEAK}:LRA=11:measured_I=${L.input_i}:measured_TP=${L.input_tp}:measured_LRA=${L.input_lra}:measured_thresh=${L.input_thresh}:offset=${L.target_offset}:linear=true,` +
    // loudnorm works at 192 kHz; back to the project rate, same length.
    `aresample=${sampleRate},atrim=end_sample=${samples}`
  );
}
export function loudnormMeasure(target: number): string {
  return `loudnorm=I=${target}:TP=${TRUE_PEAK}:LRA=11:print_format=json`;
}

/**
 * Split output frames [a, b) into `parts` ranges at frame boundaries (timeline ticks). Fewer parts
 * when the export is short: each part is at least `minSeconds` long. One range = no splitting.
 */
export function segmentRanges(span: { start: Ticks; end: Ticks }, rate: Rational, parts: number, minSeconds = 2): { start: Ticks; end: Ticks }[] {
  const a = ticksToFrame(span.start, rate, 'round');
  const b = ticksToFrame(span.end, rate, 'round');
  const minFrames = Math.ceil(minSeconds * rateToFloat(rate));
  const n = Math.max(1, Math.min(parts, Math.floor((b - a) / Math.max(1, minFrames))));
  const out: { start: Ticks; end: Ticks }[] = [];
  for (let i = 0; i < n; i++) {
    const f0 = a + Math.round(((b - a) * i) / n);
    const f1 = a + Math.round(((b - a) * (i + 1)) / n);
    out.push({ start: frameToTicks(f0, rate), end: frameToTicks(f1, rate) });
  }
  return out;
}

/**
 * Join parallel export parts: picture copied (not re-encoded), sound encoded once from the joined
 * PCM (with the loudness correction, if any), chapters added. The lists are ffconcat files.
 */
export function joinSegmentsArgs(
  s: ExportSettings, videoList: string, audioList: string, outputFile: string, sampleRate: number, samples: number,
  extras: { chaptersFile?: string; loudness?: LoudnessMeasurement } = {},
): string[] {
  const codec = s.codec ?? 'h264';
  const tag = codec === 'hevc' ? ['-tag:v', 'hvc1'] : codec === 'h264' ? ['-tag:v', 'avc1'] : [];
  const audio = codec === 'prores' ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'aac', '-b:a', `${s.audioBitrateKbps}k`];
  const loud = extras.loudness && s.loudness !== undefined && s.loudness !== null ? ['-af', loudnormApply(s.loudness, extras.loudness, sampleRate, samples)] : [];
  return [
    '-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats',
    '-f', 'concat', '-safe', '0', '-i', videoList,
    '-f', 'concat', '-safe', '0', '-i', audioList,
    ...(extras.chaptersFile ? ['-f', 'ffmetadata', '-i', extras.chaptersFile] : []),
    '-map', '0:v:0', '-map', '1:a:0', '-map_metadata', '-1', '-map_chapters', extras.chaptersFile ? '2' : '-1',
    '-c:v', 'copy', ...tag,
    ...loud, ...audio, '-ar', String(sampleRate), '-ac', '2',
    '-movflags', '+faststart',
    '-f', containerOf(s.outputPath), outputFile,
  ];
}

/**
 * The first filters for a video source, so the rest of the chain sees the colours the preview
 * shows (see sourceColor): `tagSource + toBt709`, then convert from `matrix`/`range` to BT.709.
 * Shared with the preview copies (main/media/proxy.ts), so they show the same colours.
 */
export function sourceColorSteps(info: MediaInfo, platform: PreviewPlatform) {
  const src = sourceColor(info, platform);
  // SD primaries (macOS only): converted to BT.709 first, in linear light with the sRGB curve as
  // Chromium does (pure SMPTE-C green shows as 63,251,0), so the rest of the chain sees BT.709.
  // The range is converted beforehand: the colorspace filter takes no full-range (yuvj) input.
  const gamut = src.primaries === 'smpte170m' || src.primaries === 'bt470bg';
  // Video frames are first tagged with the matrix/range assumed here: FFmpeg 8+ converts untagged
  // frames (as BT.601) to match the output's BT.709 tag, which shifted untagged HD colours.
  const tagSource = `setparams=${src.matrix === 'other' ? '' : `colorspace=${src.matrix === 'bt601' ? 'smpte170m' : 'bt709'}:`}range=${info.colorRange === 'pc' ? 'pc' : 'tv'},`;
  const toBt709 = gamut
    ? `scale=in_range=${info.colorRange === 'pc' ? 'pc' : 'tv'}:out_range=tv,format=yuv420p,` +
      `colorspace=ispace=${src.matrix === 'bt601' ? 'smpte170m' : 'bt709'}:irange=tv:iprimaries=${src.primaries}:itrc=srgb:` +
      'space=bt709:range=tv:primaries=bt709:trc=srgb:fast=0,' +
      'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv,'
    : '';
  const matrix: 'bt709' | 'bt601' | 'other' = gamut ? 'bt709' : src.matrix;
  const range: 'tv' | 'pc' = gamut ? 'tv' : info.colorRange ?? 'tv';
  return { tagSource, toBt709, matrix, range };
}

/** A media file whose picture goes through an input transform (tone mapping and/or a LUT). */
export function hasInputTransform(m: MediaRef): boolean {
  return m.info.kind === 'video' && (!!(m.input?.toneMap && m.info.isHDR) || !!m.input?.lut || !!m.input?.key);
}

/** A chroma-keyed file: its picture has transparency (preview copy: VP9 with alpha in WebM). */
export function isKeyed(m: MediaRef): boolean {
  return m.info.kind === 'video' && !!m.input?.key && isHexColor(m.input.key.color);
}

/** Identifies the input transform, for cache keys of preview copies. */
export function inputRecipe(m: MediaRef): string {
  if (!hasInputTransform(m)) return '';
  const k = m.input?.key;
  return [
    m.input?.toneMap && m.info.isHDR ? 'tm1' : '',
    m.input?.lut ? `lut:${m.input.lut.file}` : '',
    k && isKeyed(m) ? `key:${k.color}:${k.similarity}:${k.blend}` : '',
  ].filter(Boolean).join('|');
}

/**
 * The input transform as FFmpeg filters, ending in BT.709 gamma RGB (rgb24, full range) — the
 * same chain makes the preview copy (main/media/proxy.ts), so preview and export agree:
 *  - tone mapping (HDR10/PQ or HLG): to linear light with HDR reference white (203 nits, ITU-R
 *    BT.2408) as SDR white, BT.2020 → BT.709 primaries, the Mobius curve (keeps colours up to
 *    reference white nearly unchanged, rolls off highlights), back to the BT.709 transfer;
 *  - LUT: FFmpeg lut3d (tetrahedral) on that RGB. FFmpeg reads the LUT by its bare file name,
 *    so it must run in the LUT folder (cwd): the name is a hex hash, so nothing needs escaping.
 */
export function inputTransformChain(m: MediaRef, platform: PreviewPlatform): string {
  if (!hasInputTransform(m)) return '';
  const info = m.info;
  let chain: string;
  if (m.input?.toneMap && info.isHDR) {
    const tin = info.colorTransfer === 'arib-std-b67' ? 'arib-std-b67' : 'smpte2084';
    const rin = info.colorRange === 'pc' ? 'full' : 'limited';
    chain = `zscale=tin=${tin}:min=bt2020nc:pin=bt2020:rin=${rin}:t=linear:npl=203,format=gbrpf32le,zscale=p=bt709,` +
      'tonemap=tonemap=mobius:desat=0,zscale=t=bt709:m=bt709:r=full,format=rgb24,';
  } else {
    const c = sourceColorSteps(info, platform);
    chain = `${c.tagSource}${c.toBt709}scale=in_color_matrix=${c.matrix === 'bt601' ? 'bt601' : 'bt709'}:in_range=${c.range},format=rgb24,`;
  }
  if (m.input?.lut) {
    if (!/^[0-9a-f]{40}\.cube$/.test(m.input.lut.file)) throw new Error(`Unexpected LUT file name for ${m.name}.`);
    chain += `lut3d=file=${m.input.lut.file}:interp=tetrahedral,format=rgb24,`;
  }
  if (isKeyed(m)) {
    // Ends in RGBA: keyed pixels are transparent.
    const k = m.input!.key!;
    const n = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number(v) || 0)).toFixed(3);
    chain += `format=rgba,colorkey=color=0x${k.color.slice(1)}:similarity=${n(k.similarity, 0.01, 1)}:blend=${n(k.blend, 0, 1)},`;
  }
  return chain;
}

/**
 * Pitch-preserving tempo change for a speed. rubberband handles any ratio in one stage; atempo
 * handles 0.5–2× per stage (chained for 0.25× and 4×).
 */
function tempoFilter(speed: number, kind: 'rubberband' | 'atempo'): string {
  if (speed === 1) return '';
  if (kind === 'rubberband') return `apad=pad_dur=0.5,rubberband=tempo=${speed},`;
  const stages: number[] = [];
  let r = speed;
  while (r > 2) {
    stages.push(2);
    r /= 2;
  }
  while (r < 0.5) {
    stages.push(0.5);
    r /= 0.5;
  }
  stages.push(r);
  // apad first: at the end of a file there is nothing more to read, and without trailing input
  // atempo drops its last window (measured: 10 ms of silence at 0.5×, 35 ms at 0.25×).
  return 'apad=pad_dur=0.25,' + stages.map((x) => `atempo=${Math.round(x * 1e6) / 1e6},`).join('');
}

/** A clip that is rotated at some point (framing rotation or rotation keyframes). */
function rotates(c: ClipItem): boolean {
  return (c.framing.rotation ?? 0) % 360 !== 0 || (c.animation?.keyframes?.rotation ?? []).some((k) => k.value % 360 !== 0);
}

export function buildExportPlan(project: Project, s: ExportSettings, outputFile: string, mediaPath: (m: MediaRef) => string, extras: ExportExtras = {}): ExportPlan {
  const rate = s.frameRate;
  const sr = project.audio.sampleRate;
  const { items } = layoutSequence(project);
  const cw = project.canvas.width;
  const ch = project.canvas.height;

  // How the project canvas maps into the output frame (identity when sizes match).
  const { k, bw, bh } = canvasInOutput(project, s);
  const rateStr = `${rate.num}/${rate.den}`;
  const bg = hexColor(project.background);

  // Solid background. Converted from RGB with the BT.709 matrix the output is tagged with; FFmpeg's
  // default (BT.601) would shift colours, e.g. pure red would play back slightly orange.
  const background = (w: number, h: number, frames: number) =>
    `color=c=${bg}:s=${w}x${h}:r=${rateStr},trim=end_frame=${frames},format=rgb24,` +
    `scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setsar=1`;

  // Fully transparent canvas, for overlay-track clips.
  const clear = (w: number, h: number, frames: number) =>
    `color=c=black@0:s=${w}x${h}:r=${rateStr},trim=end_frame=${frames},format=yuva420p,setsar=1`;

  const inputs: string[] = [];
  const filters: string[] = [];
  const concatPads: string[] = [];
  let totalFrames = 0;
  let inputIndex = 0;

  // Range export: frames [rangeA, rangeB) of the timeline. The timeline is built only up to rangeB
  // (the clip straddling it renders fewer frames; its animation still uses its full length), clips
  // wholly before rangeA are plain background (never decoded), and the start is trimmed off. So
  // every frame inside the range is identical to a full export. (Cutting the end with a trim
  // instead can stall FFmpeg 6 when it falls inside an animated clip's split/blend graph.)
  const rangeA = s.range ? Math.max(0, ticksToFrame(s.range.start, rate, 'round')) : 0;
  const rangeB = s.range ? ticksToFrame(s.range.end, rate, 'round') : Number.MAX_SAFE_INTEGER;

  let segN = 0;
  const samplesOf = (f0: number, f1: number) => ticksToSamples(frameToTicks(f1, rate), sr) - ticksToSamples(frameToTicks(f0, rate), sr);

  /** Background colour and silence for output frames [f0, f1). Returns [video, audio] pads. */
  const renderGap = (f0: number, f1: number): [string, string] => {
    const n = segN++;
    filters.push(`${background(bw, bh, f1 - f0)},format=yuv420p[v${n}]`);
    filters.push(`anullsrc=r=${sr}:cl=stereo,atrim=end_sample=${samplesOf(f0, f1)}[a${n}]`);
    return [`[v${n}]`, `[a${n}]`];
  };

  /**
   * Clip `l` composed on the canvas for output frames [f0, f1). The frames may reach past the
   * clip's own edges (a crossfade shows footage before its start / after its end); source times
   * always come from sourceAt(), so they match the preview.
   *
   * `layer`: composed on a transparent canvas instead (an overlay-track clip, laid over the main
   * track afterwards); fades then change the alpha instead of mixing with the background colour.
   */
  const renderClip = (l: LaidOutItem, f0: number, f1: number, layer = false, extraScale?: (t: Ticks) => number): [string, string] => {
    const n = segN++;
    const frames = f1 - f0;
    const samples = samplesOf(f0, f1);
    const v = `v${n}`;
    const a = `a${n}`;
    const outFmt = layer ? 'yuva420p' : 'yuv420p';
    filters.push(`${layer ? clear(bw, bh, frames) : background(bw, bh, frames)}[bg${n}]`);
    const silence = `anullsrc=r=${sr}:cl=stereo,atrim=end_sample=${samples}[${a}]`;
    const item = l.item as ClipItem;
    const srcStart = sourceAt(item, l.start, frameToTicks(f0, rate));
    const media = findMedia(project, item.mediaId)!;
    const info = media.info;
    // Convert the source's colour matrix/range to the BT.709 limited-range output, the same
    // interpretation the preview (Chromium) uses, so colours match.
    const isImage = info.kind === 'image';
    // Tone mapping / a LUT turn the source into RGB first; from there it is treated like a photo.
    const xform = inputTransformChain(media, extras.previewPlatform ?? 'other');
    const { tagSource, toBt709, matrix, range } = isImage || xform
      ? { tagSource: '', toBt709: '', matrix: 'bt709' as const, range: 'tv' as const }
      : sourceColorSteps(info, extras.previewPlatform ?? 'other');
    // Photos are first decoded to RGB (JPEG's full-range BT.601 is undone by that step), so the
    // resizing scale converts RGB → BT.709 limited range, as for backgrounds and captions.
    // Colour adjustments work on RGB (as the preview's SVG filter does): the source is converted to
    // RGB with its own matrix/range (Chromium's interpretation), mixed, and converted to BT.709.
    const adjust = clipColor(item);
    // Effects work on the decoded picture (before any resizing), on RGBA: blur (6 IIR steps: within
    // 1–2% of a true Gaussian; 1 step is visibly too narrow), then the mask's alpha.
    const blurSigma = item.effects?.blur ? item.effects.blur * (info.rotation % 180 !== 0 ? info.height : info.width) : 0;
    const mask = item.effects?.mask;
    const effects =
      (blurSigma > 0 ? `format=gbrap,gblur=sigma=${(Math.round(blurSigma * 1000) / 1000).toString()}:steps=6,format=rgba,` : '') +
      (mask ? `format=gbrap,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${ffmpegMaskAlpha(mask)}',format=rgba,` : '');
    const rgbPath = isImage || !!adjust || !!xform || !!effects;
    const colour = rgbPath
      ? ':out_color_matrix=bt709:out_range=tv'
      : `${matrix === 'bt601' ? ':in_color_matrix=bt601:out_color_matrix=bt709' : ''}${range === 'pc' ? ':in_range=pc:out_range=tv' : ''}`;
    // Transparent PNG/WebP keep their alpha so the background colour shows through.
    const fgFormat = layer || (isImage && info.hasAlpha) || mask || isKeyed(media) ? 'yuva420p' : 'yuv420p';
    const speed = clipSpeed(item);
    // Speed: timestamps are divided by the speed (frames shown sooner/later); sound is time-stretched
    // with its pitch kept (tempoFilter), like the preview (HTMLMediaElement.preservesPitch).
    // Constant-frame-rate video: timestamps are snapped to the file's own frame grid. Matroska/WebM
    // store milliseconds (a frame at 66.67 ms is stored as 67 ms), which would otherwise make the
    // export show the previous frame where the preview (which seeks a quarter frame in) shows the
    // right one. Exact timestamps (MP4) are unchanged by this; variable frame rate is left alone.
    const fr = info.frameRate;
    const t0 = !isImage && !info.isVFR ? `round((PTS-STARTPTS)*TB*${fr.num}/${fr.den})*${fr.den}/(${fr.num}*TB)` : 'PTS-STARTPTS';
    const pts = speed === 1 ? `setpts=${t0}` : `setpts=(${t0})/${speed}`;
    // The time stretch needs input past the clip's end to produce its last output window, so read
    // a little more where the file has it (the exact sample trim below removes the excess).
    const readFor0 = speed * ticksToSeconds(frameToTicks(frames, rate)) + 2 * speed * ticksToSeconds(frameDuration(rate)) + (speed === 1 ? 0 : 0.25);
    let lead = 0;
    if (isImage) {
      // A still image, repeated at the output frame rate for as long as the clip lasts.
      inputs.push('-loop', '1', '-framerate', rateStr, '-t', f6(readFor0), '-i', mediaPath(media));
    } else {
      // Start decoding half a source frame early so the frame at sourceIn is kept even if its
      // timestamp is a hair below sourceIn; the audio is then trimmed back by exactly that amount.
      const half = Math.floor(frameDuration(info.frameRate) / 2);
      const ss = Math.max(0, srcStart - half);
      lead = ticksToSeconds(srcStart - ss);
      inputs.push('-ss', f6(ticksToSeconds(ss)), '-t', f6(readFor0 + lead), '-i', mediaPath(media));
    }
    const i = inputIndex++;
    const decode =
      xform +
      tagSource +
      toBt709 +
      (isImage || xform ? 'format=rgba,' : adjust || effects ? `scale=in_color_matrix=${matrix === 'bt601' ? 'bt601' : 'bt709'}:in_range=${range === 'pc' ? 'pc' : 'tv'},format=rgba,` : '') +
      (adjust ? `colorchannelmixer=${ffmpegMixer(adjust)},` : '') +
      (adjust && ffmpegCurves(adjust) ? `${ffmpegCurves(adjust)},` : '') +
      effects;

    // Video framing — identical maths to the preview, scaled into output pixels.
    const r0 = computeClipRect(info.displayWidth, info.displayHeight, cw, ch, item.framing);
    const R = { x: r0.x * k, y: r0.y * k, w: r0.w * k, h: r0.h * k };
    const V = intersect(R, bw, bh);
    if (hasAnimation(item.animation) || rotates(item) || extraScale) {
      // Animated (or rotated) clip: evaluate the animation at every output frame (same function as
      // the preview) and drive FFmpeg with per-frame commands for size, position, angle and opacity.
      const dur = l.end - l.start;
      const quarter = 0.25 / (rate.num / rate.den);
      const states = Array.from({ length: frames }, (_, j) => {
        const rel = Math.max(0, frameToTicks(f0 + j, rate) - l.start);
        const st0 = evalAnimation(item.animation, Math.min(rel, dur), dur, item.sourceIn, clipSpeed(item));
        const st = extraScale ? { ...st0, scale: st0.scale * extraScale(frameToTicks(f0 + j, rate)) } : st0;
        return { r: animateRect(r0, st, cw, ch), st, angle: clipAngle(item.framing, st.rotation) };
      });
      const rotating = states.some((s) => s.angle % 360 !== 0);
      // Rotation: the picture is scaled once to its largest size, rotated into a transparent square
      // that fits any angle (side D = its diagonal), and that square is then resized per frame —
      // uniform scaling and rotation commute, so this equals rotating the resized picture.
      const bw0 = Math.min(MAX_ANIMATED_DIM, Math.max(2, Math.round(Math.max(...states.map((s) => s.r.w)) * k)));
      const bh0 = Math.min(MAX_ANIMATED_DIM, Math.max(2, Math.round(Math.max(...states.map((s) => s.r.h)) * k)));
      const D = 2 * Math.ceil(Math.hypot(bw0, bh0) / 2) + 2;
      const sizeCmds: string[] = [];
      const posCmds: string[] = [];
      const opCmds: string[] = [];
      const rotCmds: string[] = [];
      let prev = { w: -1, h: -1, x: NaN, y: NaN, o: -1, a: NaN };
      let first = prev;
      states.forEach(({ r, st, angle }, j) => {
        let w = Math.min(MAX_ANIMATED_DIM, Math.max(2, Math.round(r.w * k)));
        let h = Math.min(MAX_ANIMATED_DIM, Math.max(2, Math.round(r.h * k)));
        let x = Math.round(r.x * k);
        let y = Math.round(r.y * k);
        if (rotating) {
          // The rotated square, centred where the picture's centre is.
          const side = Math.min(MAX_ANIMATED_DIM, Math.max(2, 2 * Math.round((D * (r.w * k)) / bw0 / 2)));
          x = Math.round((r.x + r.w / 2) * k - side / 2);
          y = Math.round((r.y + r.h / 2) * k - side / 2);
          w = side;
          h = side;
        }
        const cur = { w, h, x, y, o: Math.round(st.opacity * 1000) / 1000, a: Math.round(((angle * Math.PI) / 180) * 1e6) / 1e6 };
        if (j === 0) first = cur;
        // Commands fire a quarter frame early so they are in place before frame j is processed.
        const at = Math.max(0, j / (rate.num / rate.den) - quarter).toFixed(6);
        if (j > 0 && (cur.w !== prev.w || cur.h !== prev.h)) sizeCmds.push(`${at} scale@s${n} w ${cur.w}, scale@s${n} h ${cur.h}`);
        if (j > 0 && (cur.x !== prev.x || cur.y !== prev.y)) posCmds.push(`${at} overlay@o${n} x ${cur.x}, overlay@o${n} y ${cur.y}`);
        if (j > 0 && cur.o !== prev.o) opCmds.push(`${at} ${(layer ? ['c3'] : ['c0', 'c1', 'c2']).map((c) => `blend@b${n} ${c}_opacity ${cur.o}`).join(', ')}`);
        if (j > 0 && cur.a !== prev.a) rotCmds.push(`${at} rotate@r${n} a ${cur.a}`);
        prev = cur;
      });
      const sendcmd = (cmds: string[]) => (cmds.length ? `sendcmd=c='${cmds.join(';')}',` : '');
      const fade = animatesOpacity(item.animation);
      const rot = rotating
        ? `scale=w=${bw0}:h=${bh0}:flags=bicubic${rgbPath ? '' : colour},setsar=1,format=yuva420p,` +
          `${sendcmd(rotCmds)}rotate@r${n}=a=${first.a}:ow=${D}:oh=${D}:c=black@0:bilinear=1,`
        : '';
      filters.push(
        // Pixel format is converted BEFORE the resizing scale: a format filter after it would
        // stop size changes from reaching the overlay (verified with FFmpeg 6.1).
        `[${i}:v:0]${pts},${decode}${rgbPath ? `scale=${colour.slice(1)},` : ''}format=${rotating ? 'yuva420p' : fgFormat},${rot}` +
          `${sendcmd(sizeCmds)}scale@s${n}=w=${first.w}:h=${first.h}:flags=bicubic${rgbPath || rotating ? '' : colour},setsar=1[fg${n}]`,
      );
      if (fade) filters.push(`[bg${n}]split[bga${n}][bgb${n}]`);
      const base = fade ? `bga${n}` : `bg${n}`;
      filters.push(`[${base}]${sendcmd(posCmds).replace(/,$/, '') || 'null'}[bgp${n}]`);
      const lay = fade ? `lay${n}` : v;
      filters.push(
        `[bgp${n}][fg${n}]overlay@o${n}=x=${first.x}:y=${first.y}:eof_action=repeat:format=auto,trim=end_frame=${frames},format=${outFmt}[${lay}]`,
      );
      if (fade) {
        filters.push(`[bgb${n}]${sendcmd(opCmds).replace(/,$/, '') || 'null'}[bgo${n}]`);
        const o = first.o;
        // On the main track the picture is mixed with the background colour; on an overlay track
        // only the alpha changes (colour from the clip, alpha × opacity).
        const ops = layer ? `c0_opacity=1:c1_opacity=1:c2_opacity=1:c3_opacity=${o}` : `c0_opacity=${o}:c1_opacity=${o}:c2_opacity=${o}`;
        filters.push(`[${lay}][bgo${n}]blend@b${n}=all_mode=normal:${ops},format=${outFmt}[${v}]`);
      }
    } else if (V) {
      const ox = Math.round(V.x);
      const oy = Math.round(V.y);
      const ow = Math.max(1, Math.round(V.x + V.w) - ox);
      const oh = Math.max(1, Math.round(V.y + V.h) - oy);
      // After FFmpeg's auto-rotation, frames are display-oriented; crop works in frame pixels.
      const rotated = info.rotation % 180 !== 0;
      const fw = rotated ? info.height : info.width;
      const fh = rotated ? info.width : info.height;
      const chain = [pts, ...(decode ? [decode.slice(0, -1)] : [])];
      const fullyVisible = R.x >= 0 && R.y >= 0 && R.x + R.w <= bw + 0.5 && R.y + R.h <= bh + 0.5;
      if (!fullyVisible) {
        // Source region that maps onto the visible part, clamped to the frame (rounding of the
        // output rectangle can otherwise push it a fraction of a pixel outside, which FFmpeg rejects).
        let cx = Math.max(0, ((ox - R.x) / R.w) * fw);
        let cy = Math.max(0, ((oy - R.y) / R.h) * fh);
        cx = Math.min(cx, fw - 1);
        cy = Math.min(cy, fh - 1);
        const cwid = Math.max(1, Math.min((ow / R.w) * fw, fw - cx));
        const chei = Math.max(1, Math.min((oh / R.h) * fh, fh - cy));
        chain.push(`crop=w=${trunc3(cwid)}:h=${trunc3(chei)}:x=${trunc3(cx)}:y=${trunc3(cy)}:exact=1`);
      }
      chain.push(`scale=w=${ow}:h=${oh}:flags=bicubic${colour}`, `format=${fgFormat}`, 'setsar=1');
      filters.push(`[${i}:v:0]${chain.join(',')}[fg${n}]`);
      // overlay keeps going while the clip input lasts, so cut back to exactly N frames.
      filters.push(`[bg${n}][fg${n}]overlay=x=${ox}:y=${oy}:eof_action=repeat:format=auto,trim=end_frame=${frames},format=${outFmt}[${v}]`);
    } else {
      filters.push(`[bg${n}]format=${outFmt}[${v}]`); // framed entirely off-canvas
    }

    if (info.hasAudio && !item.muted && item.volume > 0) {
      filters.push(
        `[${i}:a:0]atrim=start=${f6(lead)},asetpts=PTS-${f6(lead)}/TB,${tempoFilter(speed, extras.timeStretch ?? 'atempo')}` +
          `aresample=${sr}:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
          `volume=${item.volume.toFixed(4)},${ffmpegAudioFx(item.audioFx, sr)}apad,atrim=end_sample=${samples}[${a}]`,
      );
    } else filters.push(silence);
    return [`[${v}]`, `[${a}]`];
  };

  // Timeline → segments. A crossfade is its own segment covering the window around the cut (both
  // clips rendered and mixed); the clips' own segments stop/start at the window. Dips fade the
  // clips' own ends to/from the colour.
  const fr = (t: Ticks) => ticksToFrame(t, rate, 'round');
  const transitions = resolveTransitions(project, items);
  type Seg =
    | { kind: 'gap' | 'clip'; l: LaidOutItem; f0: number; f1: number; dipIn?: { frames: number; colour: string }; dipOut?: { frames: number; colour: string } }
    | { kind: 'xfade'; tr: ResolvedTransition; a: LaidOutItem; b: LaidOutItem; f0: number; f1: number };
  const segs: Seg[] = [];
  items.forEach((l) => {
    let f0 = fr(l.start);
    let f1 = fr(l.end);
    const before = transitions.find((t) => t.b === l);
    const after = transitions.find((t) => t.a === l);
    const seg: Seg = { kind: l.item.kind, l, f0, f1 };
    if (before && !isDip(before.kind)) seg.f0 = f0 = fr(before.end);
    else if (before) seg.dipIn = { frames: fr(before.end) - f0, colour: dipColour(before.kind) };
    if (after && !isDip(after.kind)) seg.f1 = f1 = fr(after.start);
    else if (after) seg.dipOut = { frames: f1 - fr(after.start), colour: dipColour(after.kind) };
    segs.push(seg);
    if (after && !isDip(after.kind)) segs.push({ kind: 'xfade', tr: after, a: after.a, b: after.b, f0: fr(after.start), f1: fr(after.end) });
  });

  for (const seg of segs) {
    const f0 = seg.f0;
    const f1 = Math.min(seg.f1, rangeB);
    const frames = f1 - f0;
    if (frames <= 0) continue; // shorter than one output frame, or after the range
    totalFrames += frames;
    const samples = samplesOf(f0, f1);
    if (seg.kind === 'gap' || f1 <= rangeA) {
      const [v, a] = renderGap(f0, f1);
      concatPads.push(`${v}${a}`);
      continue;
    }
    if (seg.kind === 'xfade') {
      // Both clips over the whole window, mixed linearly: frame j shows a j/n of the incoming clip.
      const n = seg.f1 - seg.f0;
      const dur = f6(ticksToSeconds(frameToTicks(n, rate)));
      // Zoom: each clip is also scaled per frame (transitionLook); the pictures are then crossfaded.
      const zoom = (which: 'a' | 'b') =>
        seg.tr.kind === 'zoom' ? (t: Ticks) => zoomScale(which, transitionMix(seg.tr, t).b) : undefined;
      const [va, aa] = renderClip(seg.a, f0, f1, false, zoom('a'));
      const [vb, ab] = renderClip(seg.b, f0, f1, false, zoom('b'));
      const k = segN++;
      filters.push(`${va}${vb}xfade=transition=${xfadeName(seg.tr.kind)}:duration=${dur}:offset=0,trim=end_frame=${frames},format=yuv420p[xv${k}]`);
      filters.push(`${aa}afade=t=out:st=0:d=${dur}:curve=tri[xao${k}]`);
      filters.push(`${ab}afade=t=in:st=0:d=${dur}:curve=tri[xai${k}]`);
      filters.push(`[xao${k}][xai${k}]amix=inputs=2:normalize=0:duration=first,atrim=end_sample=${samples}[xa${k}]`);
      concatPads.push(`[xv${k}][xa${k}]`);
      continue;
    }
    let [v, a] = renderClip(seg.l, f0, f1);
    if (seg.dipIn || seg.dipOut) {
      const k = segN++;
      const vf: string[] = [];
      const af: string[] = [];
      const secs = (fr2: number) => f6(ticksToSeconds(frameToTicks(fr2, rate)));
      if (seg.dipIn) {
        vf.push(`fade=t=in:start_frame=0:nb_frames=${seg.dipIn.frames}:color=${hexColor(seg.dipIn.colour)}`);
        af.push(`afade=t=in:st=0:d=${secs(seg.dipIn.frames)}:curve=tri`);
      }
      if (seg.dipOut) {
        const start = seg.f1 - seg.dipOut.frames - f0;
        vf.push(`fade=t=out:start_frame=${start}:nb_frames=${seg.dipOut.frames}:color=${hexColor(seg.dipOut.colour)}`);
        af.push(`afade=t=out:st=${secs(start)}:d=${secs(seg.dipOut.frames)}:curve=tri`);
      }
      filters.push(`${v}${vf.join(',')},format=yuv420p[dv${k}]`);
      filters.push(`${a}${af.join(',')}[da${k}]`);
      [v, a] = [`[dv${k}]`, `[da${k}]`];
    }
    concatPads.push(`${v}${a}`);
  }

  filters.push(`${concatPads.join('')}concat=n=${concatPads.length}:v=1:a=1[vcat0][acat]`);

  // ---- Overlay tracks (picture-in-picture): each clip rendered on a transparent canvas for its own
  // frames, shifted to its start and laid over the main track (lowest row first, so higher rows end
  // up on top). Like audio tracks, nothing plays past the main track's end.
  const overlayAudio: string[] = [];
  let vMain = '[vcat0]';
  [...overlays(project)].sort((x, y) => x.row - y.row || x.start - y.start).forEach((o, oi) => {
    const lo = overlayLayout(o);
    const f0 = Math.max(fr(lo.start), rangeA);
    const f1 = Math.min(fr(lo.end), totalFrames);
    if (f1 <= f0) return;
    const [ov, oa] = renderClip(lo, f0, f1, true);
    // Start frame as an exact fraction, rounded: setpts truncates, so 5.333333/TB would land on
    // frame 159 instead of 160 (the overlay one frame early).
    filters.push(`${ov}setpts=PTS-STARTPTS+round(${f0}*${rate.den}/(${rate.num}*TB))[ovs${oi}]`);
    filters.push(`${vMain}[ovs${oi}]overlay=x=0:y=0:eof_action=pass:format=auto,format=yuv420p[vov${oi}]`);
    vMain = `[vov${oi}]`;
    if (o.muted || o.volume === 0 || !findMedia(project, o.mediaId)?.info.hasAudio) return;
    filters.push(`${oa}adelay=delays=${ticksToSamples(frameToTicks(f0, rate), sr)}S:all=1[ova${oi}]`);
    overlayAudio.push(`[ova${oi}]`);
  });
  if (vMain !== '[vcat0]') filters.push(`${vMain}null[vcat1]`);
  const vBase = vMain === '[vcat0]' ? '[vcat0]' : '[vcat1]';
  if (extras.captionTrack) {
    // Caption images (drawn by the app, so they match the preview) as one timed PNG stream.
    // RGB → YUV with BT.709, like the backgrounds, so coloured text keeps its colour.
    inputs.push('-f', 'concat', '-safe', '0', '-i', extras.captionTrack);
    filters.push(`[${inputIndex}:v:0]format=rgba,scale=out_color_matrix=bt709:out_range=tv,format=yuva420p[cap]`);
    filters.push(`${vBase}[cap]overlay=x=0:y=0:format=auto:eof_action=pass,format=yuv420p[vcat]`);
    inputIndex++;
  } else {
    filters.push(`${vBase}null[vcat]`);
  }
  if (bw === s.width && bh === s.height) {
    filters.push('[vcat]setsar=1,format=yuv420p[vfull]');
  } else if (s.canvasMapping === 'fill') {
    const crop = `crop=${s.width}:${s.height}:${Math.floor((bw - s.width) / 2)}:${Math.floor((bh - s.height) / 2)}`;
    filters.push(`[vcat]${crop},setsar=1,format=yuv420p[vfull]`);
  } else {
    // Letterbox: place the canvas on a background of the output size (same colour handling as above).
    filters.push(`${background(s.width, s.height, totalFrames)}[obg]`);
    const x = Math.floor((s.width - bw) / 2);
    const y = Math.floor((s.height - bh) / 2);
    filters.push(`[obg][vcat]overlay=x=${x}:y=${y}:format=auto,setsar=1,format=yuv420p[vfull]`);
  }

  const outA = Math.min(rangeA, Math.max(0, totalFrames - 1));
  const outB = totalFrames; // already ends at the range end
  const ranged = outA > 0;
  filters.push(ranged ? `[vfull]trim=start_frame=${outA},setpts=PTS-STARTPTS[vout]` : '[vfull]null[vout]');

  // ---- Audio tracks (music, voice-over), mixed under the video track's audio ----
  const totalSamples = ticksToSamples(frameToTicks(totalFrames, rate), sr);
  const rangeStartT = frameToTicks(outA, rate);
  const rangeEndT = frameToTicks(outB, rate);
  const projectEnd = frameToTicks(totalFrames, rate);
  const speech = speechIntervals(project);
  const trackPads: string[] = [];
  tracks(project).forEach((track, ti) => {
    if (track.muted || track.volume === 0) return;
    const clipPads: string[] = [];
    track.clips.forEach((c, ci) => {
      const m = findMedia(project, c.mediaId);
      if (!m || !m.info.hasAudio || c.volume === 0) return;
      const startSample = ticksToSamples(c.start, sr);
      if (startSample >= totalSamples) return; // starts after the video ends
      if (audioClipEnd(c) <= rangeStartT || c.start >= rangeEndT) return; // not heard in the range
      const durSamples = Math.min(ticksToSamples(audioClipEnd(c), sr), totalSamples) - startSample;
      const durSec = durSamples / sr;
      inputs.push('-ss', f6(ticksToSeconds(c.sourceIn)), '-t', f6(durSec + 0.1), '-i', mediaPath(m));
      const i = inputIndex++;
      const chain = [`aresample=${sr}:async=1:first_pts=0`, 'aformat=sample_fmts=fltp:channel_layouts=stereo', `volume=${c.volume.toFixed(4)}`];
      const fx = ffmpegAudioFx(c.audioFx, sr);
      if (fx) chain.push(fx.slice(0, -1));
      // Linear fades, matching clipGainAt() used by the preview. Fade-out is placed against the
      // clip's own end even if the video ends first.
      if (c.fadeIn > 0) chain.push(`afade=t=in:st=0:d=${f6(ticksToSeconds(c.fadeIn))}`);
      if (c.fadeOut > 0) chain.push(`afade=t=out:st=${f6(ticksToSeconds(audioClipDuration(c) - c.fadeOut))}:d=${f6(ticksToSeconds(c.fadeOut))}`);
      chain.push('apad', `atrim=end_sample=${durSamples}`, `adelay=delays=${startSample}S:all=1`);
      filters.push(`[${i}:a:0]${chain.join(',')}[ac${ti}_${ci}]`);
      clipPads.push(`[ac${ti}_${ci}]`);
    });
    if (!clipPads.length) return;
    const bus = [clipPads.length > 1 ? `${clipPads.join('')}amix=inputs=${clipPads.length}:normalize=0:duration=longest` : `${clipPads[0]}anull`];
    bus.push(`volume=${track.volume.toFixed(4)}`);
    if (track.duck && speech.length) {
      // Ducking envelope sampled every 20 ms (same function as the preview), applied as commands.
      const step = 0.02;
      const cmds: string[] = [];
      let prev = 1;
      for (let t = 0; t < ticksToSeconds(projectEnd); t += step) {
        const g = Math.round(duckGainAt(speech, secondsToTicks(t), track.duckDb) * 10000) / 10000;
        if (Math.abs(g - prev) > 0.0005) cmds.push(`${t.toFixed(3)} volume@duck${ti} volume ${g}`);
        prev = g;
      }
      const g0 = Math.round(duckGainAt(speech, 0, track.duckDb) * 10000) / 10000;
      if (cmds.length) bus.push(`asendcmd=c='${cmds.join(';')}'`);
      bus.push(`volume@duck${ti}=${g0}`);
    }
    bus.push('apad', `atrim=end_sample=${totalSamples}`);
    filters.push(`${bus.join(',')}[trk${ti}]`);
    trackPads.push(`[trk${ti}]`);
  });
  let audioOut = '[acat]';
  trackPads.push(...overlayAudio);
  if (trackPads.length) {
    // Sum (not average) the tracks, then a transparent limiter so loud overlaps cannot clip.
    filters.push(`[acat]${trackPads.join('')}amix=inputs=${trackPads.length + 1}:normalize=0:duration=first,alimiter=limit=0.98:level=0:latency=1[amix]`);
    audioOut = '[amix]';
  }

  if (ranged) {
    const sA = ticksToSamples(rangeStartT, sr);
    const sB = ticksToSamples(rangeEndT, sr);
    filters.push(`${audioOut}atrim=start_sample=${sA}:end_sample=${sB},asetpts=PTS-STARTPTS[arange]`);
    audioOut = '[arange]';
  }

  // Loudness normalization of the finished mix (EBU R128 loudnorm, two passes, linear gain).
  if (s.loudness !== undefined && s.loudness !== null && extras.loudness && !extras.segment) {
    const L = extras.loudness;
    filters.push(
      L === 'measure'
        ? `${audioOut}${loudnormMeasure(s.loudness)}[aloud]`
        : `${audioOut}${loudnormApply(s.loudness, L, sr, ticksToSamples(rangeEndT - rangeStartT, sr))}[aloud]`,
    );
    audioOut = '[aloud]';
  }

  const kbps = Math.round(s.videoBitrateMbps * 1000);
  const codec = s.codec ?? 'h264';
  const crf = String(s.crf ?? CRF_RANGE.default);
  // Average-bitrate mode with a VBV cap: the encoder aims for this average; it is not constant and
  // the final size is approximate.
  const vbv = ['-b:v', `${kbps}k`, '-maxrate', `${kbps * 2}k`, '-bufsize', `${kbps * 2}k`];
  let video: string[];
  if (codec === 'prores') {
    // ProRes 422 (or HQ), 10-bit 4:2:2; 'apl0' is written into the ProRes frame headers.
    video = ['-c:v', 'prores_ks', '-profile:v', s.proresProfile === 'hq' ? '3' : '2', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le'];
  } else if (codec === 'hevc') {
    // hvc1 (not FFmpeg's default hev1) is what QuickTime, Photos and iOS require to play HEVC.
    video = s.encoder === 'videotoolbox'
      ? ['-c:v', 'hevc_videotoolbox', '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-b:v', `${kbps}k`, '-tag:v', 'hvc1']
      : [
          '-c:v', 'libx265', '-preset', s.x264Preset, '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1',
          ...(s.rateControl === 'crf'
            ? ['-crf', crf, '-x265-params', 'log-level=error']
            : ['-b:v', `${kbps}k`, '-x265-params', `log-level=error:vbv-maxrate=${kbps * 2}:vbv-bufsize=${kbps * 2}`]),
        ];
  } else {
    video = s.encoder === 'videotoolbox'
      ? // Apple's hardware encoder: average bitrate only (its constant-quality mode is not used).
        ['-c:v', 'h264_videotoolbox', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-b:v', `${kbps}k`, '-tag:v', 'avc1']
      : ['-c:v', 'libx264', '-preset', s.x264Preset, '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-tag:v', 'avc1', ...(s.rateControl === 'crf' ? ['-crf', crf] : vbv)];
  }
  // ProRes goes with uncompressed PCM sound (as cameras and Final Cut use); otherwise AAC.
  const audio = codec === 'prores' ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'aac', '-b:a', `${s.audioBitrateKbps}k`];
  // Chapters come only from the markers (never copied from a source file).
  const chapterInput = extras.chaptersFile && !extras.segment ? inputIndex++ : -1;
  if (extras.chaptersFile && !extras.segment) inputs.push('-f', 'ffmetadata', '-i', extras.chaptersFile);
  if (extras.segment) {
    // Parallel export part: picture → outputFile (QuickTime), mix → 32-bit float WAV.
    return {
      args: [
        '-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats',
        ...inputs, '-filter_complex', filters.join(';\n'),
        '-map', '[vout]', '-map_metadata', '-1',
        ...video,
        '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
        '-r', `${rate.num}/${rate.den}`, '-an', '-f', 'mov', outputFile,
        '-map', audioOut, '-c:a', 'pcm_f32le', '-ar', String(sr), '-ac', '2', '-f', 'wav', extras.segment.audioFile,
      ],
      totalFrames: outB - outA,
      timelineFrames: totalFrames,
      durationSeconds: ticksToSeconds(frameToTicks(outB - outA, rate)),
      span: { start: rangeStartT, end: rangeEndT },
      width: s.width,
      height: s.height,
    };
  }
  if (extras.loudness === 'measure') {
    // Measuring pass: render everything, encode nothing, keep loudnorm's report (info level).
    return {
      args: [
        '-hide_banner', '-nostdin', '-y', '-loglevel', 'info', '-progress', 'pipe:1', '-nostats',
        ...inputs, '-filter_complex', filters.join(';\n'), '-map', '[vout]', '-map', audioOut,
        '-c:v', 'wrapped_avframe', '-c:a', 'pcm_f32le', '-f', 'null', '-',
      ],
      totalFrames: outB - outA,
      timelineFrames: totalFrames,
      durationSeconds: ticksToSeconds(frameToTicks(outB - outA, rate)),
      span: { start: rangeStartT, end: rangeEndT },
      width: s.width,
      height: s.height,
    };
  }
  const args = [
    '-hide_banner', '-nostdin', '-y',
    '-loglevel', 'error',
    '-progress', 'pipe:1', '-nostats',
    ...inputs,
    '-filter_complex', filters.join(';\n'),
    '-map', '[vout]', '-map', audioOut,
    '-map_chapters', String(chapterInput),
    ...video,
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    '-r', `${rate.num}/${rate.den}`,
    ...audio, '-ar', String(sr), '-ac', '2',
    '-movflags', '+faststart',
    '-f', containerOf(s.outputPath), outputFile,
  ];
  return {
    args,
    totalFrames: outB - outA,
    timelineFrames: totalFrames,
    durationSeconds: ticksToSeconds(frameToTicks(outB - outA, rate)),
    span: { start: rangeStartT, end: rangeEndT },
    width: s.width,
    height: s.height,
  };
}
