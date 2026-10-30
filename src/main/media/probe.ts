/**
 * Media inspection with ffprobe. Anything FFmpeg can decode in the supported file types is
 * accepted; probe also decides how the preview shows it (see shared/formats.ts). Files that can't
 * be read are rejected with a readable reason rather than half-working.
 */
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, SUPPORTED_EXTENSIONS, VIDEO_EXTENSIONS, audioPreviewMode, imagePreviewMode, videoPreviewMode } from '../../shared/formats';
import type { MediaInfo } from '../../shared/model';
import { type Rational, parseRational, rateToFloat, secondsToTicks } from '../../shared/time';
import { ffprobePath } from './ffbin';
import { getConvertDir, heicToJpeg, isHeic } from './heic';

export { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, SUPPORTED_EXTENSIONS, VIDEO_EXTENSIONS };

export type ProbeResult =
  | { ok: true; info: MediaInfo; warnings: string[] }
  | { ok: false; error: string };

/** Photos have no length of their own; clips of them can be any length up to this. */
export const IMAGE_MAX_DURATION_S = 3600;

function ffprobeJson(file: string): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile(
      ffprobePath(),
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { maxBuffer: 16 * 1024 * 1024, timeout: 30_000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr?.toString().trim() || err.message));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('ffprobe returned unreadable output'));
        }
      },
    );
  });
}

function rotationOf(stream: any): number {
  let r = 0;
  for (const sd of stream.side_data_list ?? []) if (typeof sd.rotation === 'number') r = sd.rotation;
  if (!r && stream.tags?.rotate) r = Number(stream.tags.rotate) || 0;
  return ((Math.round(r) % 360) + 360) % 360;
}

export interface ProbeOptions {
  /** Where HEIC photos are converted to JPEG (macOS); without it HEIC is rejected. */
  convertDir?: string;
}

export async function probeMedia(file: string, opts: ProbeOptions = { convertDir: getConvertDir() ?? undefined }): Promise<ProbeResult> {
  const ext = file.split('.').pop()?.toLowerCase() ?? '';
  if (isHeic(file)) {
    // Neither Chromium nor FFmpeg 6 reads HEIC; macOS converts it (sips) to a full-quality JPEG
    // that both the preview and the export use. The project still refers to the original file.
    if (process.platform !== 'darwin' || !opts.convertDir) {
      return { ok: false, error: 'HEIC photos can only be imported on a Mac (Cutroom uses macOS to convert them). Export them as JPEG first.' };
    }
    let jpeg: string;
    try {
      jpeg = await heicToJpeg(opts.convertDir, file);
    } catch (e) {
      return { ok: false, error: `Could not convert this HEIC photo: ${(e as Error).message}` };
    }
    const r = await probeImage(jpeg, 'image');
    if (r.ok) r.warnings.push('HEIC photo: converted to a full-quality JPEG copy for preview and export (the original is not changed).');
    return r;
  }
  if (IMAGE_EXTENSIONS.includes(ext)) return probeImage(file, imagePreviewMode(ext));
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    return { ok: false, error: `“.${ext}” files are not supported. Cutroom imports video (${VIDEO_EXTENSIONS.join(', ')}), audio (${AUDIO_EXTENSIONS.join(', ')}) and photos (${IMAGE_EXTENSIONS.join(', ')}).` };
  }
  let data: any;
  try {
    data = await ffprobeJson(file);
  } catch (e) {
    return { ok: false, error: `Could not read this file: ${(e as Error).message}` };
  }
  const streams: any[] = data.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === 'audio');
  if (AUDIO_EXTENSIONS.includes(ext) || (!v && a)) return probeAudio(file, data, a, ext);
  if (!v) return { ok: false, error: 'No video or audio stream found in this file.' };

  const warnings: string[] = [];
  const codec: string = v.codec_name ?? 'unknown';
  if (!v.codec_name || codec === 'none' || codec === 'unknown') {
    return { ok: false, error: 'The video in this file uses a codec FFmpeg cannot decode.' };
  }
  const preview = videoPreviewMode({ ext, container: data.format?.format_name ?? '', videoCodec: codec, audioCodec: a?.codec_name ?? null, platform: process.platform });
  if (preview === 'transcode') warnings.push(`${codec.toUpperCase()} can't be played directly by the preview: a lighter H.264 preview copy is made in the background. The export uses the original.`);
  if (preview === 'remux') warnings.push('The preview uses a copy with converted sound (made in the background). The export uses the original.');

  const width = Number(v.width) || 0;
  const height = Number(v.height) || 0;
  if (!width || !height) return { ok: false, error: 'The video stream has no picture size.' };

  const rotation = rotationOf(v);
  const sar = parseRational(v.sample_aspect_ratio?.replace(':', '/')) ?? { num: 1, den: 1 };
  const rotated = rotation % 180 !== 0;
  const fw = rotated ? height : width;
  const fh = rotated ? width : height;
  const displayWidth = Math.round(fw * rateToFloat(sar));
  const displayHeight = fh;
  if (rotation) warnings.push(`Rotation metadata (${rotation}°) is applied; the clip is shown upright.`);
  if (sar.num !== sar.den) warnings.push('Non-square pixels: the image is resized to square pixels.');

  const r = parseRational(v.r_frame_rate);
  const avg = parseRational(v.avg_frame_rate);
  let frameRate: Rational = r ?? avg ?? { num: 30, den: 1 };
  if (rateToFloat(frameRate) > 240 && avg) frameRate = avg; // timebase-like r_frame_rate on some VFR files
  const avgFrameRate = avg ?? frameRate;
  const isVFR = Math.abs(rateToFloat(avgFrameRate) - rateToFloat(frameRate)) / rateToFloat(frameRate) > 0.002;
  if (isVFR) warnings.push('Variable frame rate: export converts to the project frame rate; a frame may occasionally differ from the preview.');

  const colorTransfer: string = v.color_transfer ?? '';
  const isHDR = ['smpte2084', 'arib-std-b67'].includes(colorTransfer);
  if (isHDR) warnings.push('HDR video: it is tone-mapped to SDR (BT.709) for editing and export (Media panel → this file → Picture).');
  const pixFmt: string = v.pix_fmt ?? '';
  const cs: string = v.color_space ?? '';
  const colorMatrix: MediaInfo['colorMatrix'] =
    cs === 'bt709' ? 'bt709'
      : ['smpte170m', 'bt470bg', 'bt601', 'fcc'].includes(cs) ? 'bt601'
        : cs && cs !== 'unknown' && cs !== 'reserved' ? 'other'
          : height < 720 && width < 1280 ? 'bt601' : 'bt709';
  const colorRange: MediaInfo['colorRange'] = v.color_range === 'pc' || /^yuvj/.test(pixFmt) ? 'pc' : 'tv';
  const tag = (t: string | undefined) => (t && !['unknown', 'reserved', 'unspecified'].includes(t) ? t : '');
  const colorTags = { matrix: tag(v.color_space), primaries: tag(v.color_primaries) };
  if (/10|12/.test(pixFmt)) warnings.push('10/12-bit video: exported as 8-bit.');
  if (v.field_order && !['progressive', 'unknown'].includes(v.field_order)) warnings.push('Interlaced video: not deinterlaced.');

  const durSec = Number(v.duration) || Number(data.format?.duration) || 0;
  if (durSec <= 0) return { ok: false, error: 'Could not determine the duration of this file.' };

  const audioCodec: string | null = a ? a.codec_name ?? 'unknown' : null;

  let fileSize = Number(data.format?.size) || 0;
  try {
    fileSize = statSync(file).size;
  } catch {}

  return {
    ok: true,
    warnings,
    info: {
      kind: 'video',
      container: data.format?.format_name ?? '',
      fileSize,
      duration: secondsToTicks(durSec),
      videoCodec: codec,
      width,
      height,
      displayWidth,
      displayHeight,
      rotation,
      frameRate,
      avgFrameRate,
      isVFR,
      pixFmt,
      colorTransfer,
      isHDR,
      colorMatrix,
      colorRange,
      colorTags,
      hasAudio: !!a,
      audioCodec,
      audioSampleRate: a ? Number(a.sample_rate) || null : null,
      audioChannels: a ? Number(a.channels) || null : null,
      ...(preview !== 'native' ? { preview } : {}),
    },
  };
}

/** Audio-only files (music, voice-over) for audio tracks. */
function probeAudio(file: string, data: any, a: any, ext: string): ProbeResult {
  if (!a) return { ok: false, error: 'No audio stream found in this file.' };
  const codec: string = a.codec_name ?? 'unknown';
  if (!a.codec_name || codec === 'none') return { ok: false, error: 'The sound in this file uses a codec FFmpeg cannot decode.' };
  const preview = audioPreviewMode({ ext, container: data.format?.format_name ?? '', audioCodec: codec, platform: process.platform });
  const durSec = Number(a.duration) || Number(data.format?.duration) || 0;
  if (durSec <= 0) return { ok: false, error: 'Could not determine the duration of this file.' };
  let fileSize = Number(data.format?.size) || 0;
  try {
    fileSize = statSync(file).size;
  } catch {}
  const none = { num: 30, den: 1 };
  return {
    ok: true,
    warnings: preview === 'audio' ? ['The preview plays a converted copy of this sound (made in the background). The export uses the original.'] : [],
    info: {
      ...(preview !== 'native' ? { preview } : {}),
      kind: 'audio',
      container: data.format?.format_name ?? '',
      fileSize,
      duration: secondsToTicks(durSec),
      videoCodec: '', width: 0, height: 0, displayWidth: 0, displayHeight: 0, rotation: 0,
      frameRate: none, avgFrameRate: none, isVFR: false, pixFmt: '', colorTransfer: '', isHDR: false,
      hasAudio: true,
      audioCodec: codec,
      audioSampleRate: Number(a.sample_rate) || null,
      audioChannels: Number(a.channels) || null,
    },
  };
}

/** Photos. Orientation comes from the first decoded frame (EXIF), which FFmpeg and Chromium both apply. */
async function probeImage(file: string, preview: 'native' | 'image'): Promise<ProbeResult> {
  let data: any;
  try {
    data = await new Promise((resolve, reject) => {
      execFile(ffprobePath(), ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_frames', '-read_intervals', '%+#1', file],
        { maxBuffer: 16 << 20, timeout: 30_000 }, (err, stdout, stderr) => {
          if (err) return reject(new Error(stderr?.toString().trim() || err.message));
          try { resolve(JSON.parse(stdout)); } catch { reject(new Error('unreadable ffprobe output')); }
        });
    });
  } catch (e) {
    return { ok: false, error: `Could not read this image: ${(e as Error).message}` };
  }
  const v = (data.streams ?? []).find((x: any) => x.codec_type === 'video');
  const frame = (data.frames ?? [])[0];
  if (!v || !v.width || !v.height) return { ok: false, error: 'This file does not contain a readable image.' };
  let rotation = 0;
  for (const sd of frame?.side_data_list ?? []) if (typeof sd.rotation === 'number') rotation = ((Math.round(sd.rotation) % 360) + 360) % 360;
  const rotated = rotation % 180 !== 0;
  const pixFmt: string = v.pix_fmt ?? '';
  let fileSize = 0;
  try {
    fileSize = statSync(file).size;
  } catch {}
  const rate = { num: 30, den: 1 };
  return {
    ok: true,
    warnings: [],
    info: {
      kind: 'image',
      container: v.codec_name ?? '',
      fileSize,
      duration: secondsToTicks(IMAGE_MAX_DURATION_S),
      videoCodec: v.codec_name ?? '',
      width: v.width,
      height: v.height,
      displayWidth: rotated ? v.height : v.width,
      displayHeight: rotated ? v.width : v.height,
      rotation,
      frameRate: rate, avgFrameRate: rate, isVFR: false,
      pixFmt,
      colorTransfer: '', isHDR: false,
      colorMatrix: 'bt709', colorRange: 'tv',
      hasAlpha: /a/.test(pixFmt.replace('yuvj', '')) && /(rgba|bgra|argb|abgr|ya|yuva|gbrap)/.test(pixFmt),
      hasAudio: false, audioCodec: null, audioSampleRate: null, audioChannels: null,
      ...(preview !== 'native' ? { preview } : {}),
    },
  };
}
