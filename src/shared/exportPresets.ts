/**
 * Export presets. Sizes are given by the short edge ("1080p") so a preset keeps the canvas shape:
 * 1080p is 1920×1080 for a 16:9 canvas and 1080×1920 for 9:16. Saved presets are stored per
 * computer by the export dialog.
 */
import { type VideoCodec, type VideoEncoder, type X264Preset, outputSizeOptions, suggestBitrateMbps } from './exportPlan';
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
  /** Absent in presets saved before codecs were added: H.264. */
  codec?: VideoCodec;
  proresProfile?: 'standard' | 'hq';
  /** File type; absent = MP4 (ProRes is always .mov). */
  container?: 'mp4' | 'mov';
  group?: 'General' | 'Apple devices';
}

export const BUILTIN_PRESETS: ExportPreset[] = [
  { id: 'share1080', name: 'Share — 1080p, 30 fps', builtin: true, shortEdge: 1080, frameRate: { num: 30, den: 1 }, rateControl: 'bitrate', mbps: 12, x264Preset: 'medium', audioKbps: 192, encoder: 'x264' },
  { id: 'small720', name: 'Small file — 720p', builtin: true, shortEdge: 720, frameRate: 'project', rateControl: 'bitrate', mbps: 4, x264Preset: 'medium', audioKbps: 128, encoder: 'x264' },
  { id: 'master', name: 'High quality master — canvas size, CRF 16', builtin: true, shortEdge: 'canvas', frameRate: 'project', rateControl: 'crf', crf: 16, x264Preset: 'slow', audioKbps: 320, encoder: 'x264' },
  { id: 'draft', name: 'Quick draft — 540p, fast', builtin: true, shortEdge: 540, frameRate: 'project', rateControl: 'crf', crf: 26, x264Preset: 'veryfast', audioKbps: 128, encoder: 'x264' },
  { id: 'hw1080', name: 'Fast 1080p (Mac hardware encoder)', builtin: true, shortEdge: 1080, frameRate: 'project', rateControl: 'bitrate', mbps: 'suggest', x264Preset: 'medium', audioKbps: 192, encoder: 'videotoolbox' },
  // Apple devices: H.264 High / HEVC Main tagged hvc1, 8-bit 4:2:0, AAC-LC 48 kHz, fast-start — what
  // iPhone, iPad, Mac (QuickTime, Photos) and Apple TV play natively.
  { id: 'apple-h264', group: 'Apple devices', name: 'iPhone, iPad & Mac — H.264 1080p (plays everywhere)', builtin: true, shortEdge: 1080, frameRate: 'project', rateControl: 'bitrate', mbps: 'suggest', x264Preset: 'medium', audioKbps: 192, encoder: 'x264', codec: 'h264', container: 'mp4' },
  { id: 'apple-hevc', group: 'Apple devices', name: 'iPhone, iPad & Mac — HEVC 1080p (about half the size)', builtin: true, shortEdge: 1080, frameRate: 'project', rateControl: 'bitrate', mbps: 'suggest', x264Preset: 'medium', audioKbps: 192, encoder: 'x264', codec: 'hevc', container: 'mov' },
  { id: 'apple-4k', group: 'Apple devices', name: 'Apple TV & 4K displays — HEVC 4K', builtin: true, shortEdge: 2160, frameRate: 'project', rateControl: 'bitrate', mbps: 'suggest', x264Preset: 'medium', audioKbps: 256, encoder: 'x264', codec: 'hevc', container: 'mov' },
  { id: 'apple-messages', group: 'Apple devices', name: 'Messages & AirDrop — HEVC 720p, small', builtin: true, shortEdge: 720, frameRate: 'project', rateControl: 'bitrate', mbps: 2.5, x264Preset: 'medium', audioKbps: 128, encoder: 'x264', codec: 'hevc', container: 'mov' },
  { id: 'apple-hw-hevc', group: 'Apple devices', name: 'Fast HEVC 1080p (Mac hardware encoder)', builtin: true, shortEdge: 1080, frameRate: 'project', rateControl: 'bitrate', mbps: 'suggest', x264Preset: 'medium', audioKbps: 192, encoder: 'videotoolbox', codec: 'hevc', container: 'mov' },
  { id: 'apple-prores', group: 'Apple devices', name: 'Final Cut Pro — ProRes 422 (canvas size)', builtin: true, shortEdge: 'canvas', frameRate: 'project', rateControl: 'bitrate', x264Preset: 'medium', audioKbps: 192, encoder: 'x264', codec: 'prores', container: 'mov' },
  { id: 'apple-prores-hq', group: 'Apple devices', name: 'Master — ProRes 422 HQ (canvas size)', builtin: true, shortEdge: 'canvas', frameRate: 'project', rateControl: 'bitrate', x264Preset: 'medium', audioKbps: 192, encoder: 'x264', codec: 'prores', proresProfile: 'hq', container: 'mov' },
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
  codec: VideoCodec;
  proresProfile: 'standard' | 'hq';
  container: 'mp4' | 'mov';
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
    mbps: typeof p.mbps === 'number' ? p.mbps : suggestBitrateMbps(size.width, size.height, frameRate, p.codec === 'hevc' ? 'hevc' : 'h264'),
    crf: p.crf ?? crfDefault,
    x264Preset: p.x264Preset,
    audioKbps: p.audioKbps,
    encoder: p.encoder,
    codec: p.codec ?? 'h264',
    proresProfile: p.proresProfile ?? 'standard',
    container: p.codec === 'prores' ? 'mov' : p.container ?? 'mp4',
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
    codec: s.codec,
    proresProfile: s.proresProfile,
    container: s.container,
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
    (p.encoder === 'x264' || p.encoder === 'videotoolbox') &&
    (p.codec === undefined || p.codec === 'h264' || p.codec === 'hevc' || p.codec === 'prores')
  );
}
