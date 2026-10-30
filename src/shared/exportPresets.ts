/**
 * Export presets. Sizes are given by the short edge ("1080p") so a preset keeps the canvas shape:
 * 1080p is 1920×1080 for a 16:9 canvas and 1080×1920 for 9:16. Saved presets are stored per
 * computer by the export dialog.
 */
import { type VideoEncoder, type X264Preset, outputSizeOptions, suggestBitrateMbps } from './exportPlan';
import type { Rational } from './time';

export interface ExportPreset {
  id: string;
  name: string;
  builtin?: boolean;
  /** Short edge of the output in pixels, or 'canvas' for the canvas size. */
  shortEdge: number | 'canvas';
  frameRate: Rational | 'project';
  rateControl: 'bitrate' | 'crf';
  /** Mb/s, or 'suggest' for a bitrate matched to the size and frame rate. */
  mbps?: number | 'suggest';
  crf?: number;
  x264Preset: X264Preset;
  audioKbps: number;
  encoder: VideoEncoder;
}

export const BUILTIN_PRESETS: ExportPreset[] = [
  { id: 'share1080', name: 'Share — 1080p, 30 fps', builtin: true, shortEdge: 1080, frameRate: { num: 30, den: 1 }, rateControl: 'bitrate', mbps: 12, x264Preset: 'medium', audioKbps: 192, encoder: 'x264' },
  { id: 'small720', name: 'Small file — 720p', builtin: true, shortEdge: 720, frameRate: 'project', rateControl: 'bitrate', mbps: 4, x264Preset: 'medium', audioKbps: 128, encoder: 'x264' },
  { id: 'master', name: 'High quality master — canvas size, CRF 16', builtin: true, shortEdge: 'canvas', frameRate: 'project', rateControl: 'crf', crf: 16, x264Preset: 'slow', audioKbps: 320, encoder: 'x264' },
  { id: 'draft', name: 'Quick draft — 540p, fast', builtin: true, shortEdge: 540, frameRate: 'project', rateControl: 'crf', crf: 26, x264Preset: 'veryfast', audioKbps: 128, encoder: 'x264' },
  { id: 'hw1080', name: 'Fast 1080p (Mac hardware encoder)', builtin: true, shortEdge: 1080, frameRate: 'project', rateControl: 'bitrate', mbps: 'suggest', x264Preset: 'medium', audioKbps: 192, encoder: 'videotoolbox' },
];

export interface ResolvedPreset {
  sizeKey: string; // `${w}x${h}`, one of outputSizeOptions
  width: number;
  height: number;
  frameRate: Rational;
  rateControl: 'bitrate' | 'crf';
  mbps: number;
  crf: number;
  x264Preset: X264Preset;
  audioKbps: number;
  encoder: VideoEncoder;
}

/** Turn a preset into concrete settings for this canvas and project frame rate. */
export function resolvePreset(p: ExportPreset, canvasW: number, canvasH: number, projectRate: Rational, crfDefault: number): ResolvedPreset {
  const sizes = outputSizeOptions(canvasW, canvasH);
  const size =
    p.shortEdge === 'canvas'
      ? sizes[0]
      : sizes.find((s) => Math.min(s.width, s.height) === p.shortEdge) ?? sizes[0];
  const frameRate = p.frameRate === 'project' ? projectRate : p.frameRate;
  return {
    sizeKey: `${size.width}x${size.height}`,
    width: size.width,
    height: size.height,
    frameRate,
    rateControl: p.rateControl,
    mbps: typeof p.mbps === 'number' ? p.mbps : suggestBitrateMbps(size.width, size.height, frameRate),
    crf: p.crf ?? crfDefault,
    x264Preset: p.x264Preset,
    audioKbps: p.audioKbps,
    encoder: p.encoder,
  };
}

/** Make a saved preset from the current dialog settings. */
export function presetFromSettings(name: string, s: Omit<ResolvedPreset, 'sizeKey'>, canvasW: number, canvasH: number, projectRate: Rational): ExportPreset {
  const isCanvas = s.width === canvasW && s.height === canvasH;
  const sameRate = s.frameRate.num * projectRate.den === projectRate.num * s.frameRate.den;
  return {
    id: `user_${Date.now().toString(36)}`,
    name: name.trim() || 'My preset',
    shortEdge: isCanvas ? 'canvas' : Math.min(s.width, s.height),
    frameRate: sameRate ? 'project' : s.frameRate,
    rateControl: s.rateControl,
    mbps: s.mbps,
    crf: s.crf,
    x264Preset: s.x264Preset,
    audioKbps: s.audioKbps,
    encoder: s.encoder,
  };
}

/** Check a stored preset (saved presets are read back from local storage). */
export function isValidPreset(x: unknown): x is ExportPreset {
  const p = x as ExportPreset;
  return (
    !!p && typeof p.id === 'string' && typeof p.name === 'string' &&
    (p.shortEdge === 'canvas' || (typeof p.shortEdge === 'number' && p.shortEdge > 0)) &&
    (p.frameRate === 'project' || (typeof p.frameRate === 'object' && p.frameRate.num > 0 && p.frameRate.den > 0)) &&
    (p.rateControl === 'bitrate' || p.rateControl === 'crf') && typeof p.audioKbps === 'number' &&
    (p.encoder === 'x264' || p.encoder === 'videotoolbox')
  );
}
