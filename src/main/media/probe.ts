/**
 * Media inspection with ffprobe, plus the (deliberately narrow) list of supported inputs for
 * this milestone. Anything outside it is rejected with a readable reason rather than half-working.
 */
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import type { MediaInfo } from '../../shared/model';
import { type Rational, parseRational, rateToFloat, secondsToTicks } from '../../shared/time';
import { ffprobePath } from './ffbin';

export type ProbeResult =
  | { ok: true; info: MediaInfo; warnings: string[] }
  | { ok: false; error: string };

export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v'];
/** Audio formats the preview (Chromium) can play; FFmpeg decodes them all for export. */
export const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'aac', 'wav', 'flac'];
/** Still images the preview can show; HEIC is not supported by Chromium or FFmpeg 6. */
export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];
export const SUPPORTED_EXTENSIONS = [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS, ...IMAGE_EXTENSIONS];
/** Photos have no length of their own; clips of them can be any length up to this. */
export const IMAGE_MAX_DURATION_S = 3600;
const AUDIO_CODECS = ['mp3', 'aac', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_u8', 'alac'];

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

export async function probeMedia(file: string): Promise<ProbeResult> {
  const ext = file.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'heic' || ext === 'heif') {
    return { ok: false, error: 'HEIC photos are not supported yet. Export them as JPEG first (Photos app → File → Export).' };
  }
  if (IMAGE_EXTENSIONS.includes(ext)) return probeImage(file);
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    return { ok: false, error: `“.${ext}” files are not supported yet. This version imports MP4/MOV (H.264) video, MP3/M4A/AAC/WAV/FLAC audio and JPEG/PNG/WebP photos.` };
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
  if (AUDIO_EXTENSIONS.includes(ext) || (!v && a)) return probeAudio(file, data, a);
  if (!v) return { ok: false, error: 'No video or audio stream found in this file.' };

  const warnings: string[] = [];
  const codec: string = v.codec_name ?? 'unknown';
  if (codec !== 'h264' && codec !== 'hevc') {
    return {
      ok: false,
      error: `Video codec “${codec}” is not supported yet (preview cannot play it). Convert to H.264 first, e.g. ffmpeg -i in.mov -c:v libx264 -crf 18 -c:a aac out.mp4`,
    };
  }
  if (codec === 'hevc') warnings.push('HEVC (H.265): preview depends on hardware decoding (macOS supports it); this path is not yet tested.');

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
  if (isHDR) warnings.push('HDR video: no tone mapping yet, so colours will look washed out or wrong in the export.');
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

  let audioCodec: string | null = null;
  if (a) {
    audioCodec = a.codec_name ?? 'unknown';
    if (audioCodec !== 'aac') warnings.push(`Audio codec “${audioCodec}” is untested; it may be silent in preview (export decodes it with FFmpeg).`);
  }

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
    },
  };
}

/** Audio-only files (music, voice-over) for audio tracks. */
function probeAudio(file: string, data: any, a: any): ProbeResult {
  if (!a) return { ok: false, error: 'No audio stream found in this file.' };
  const codec: string = a.codec_name ?? 'unknown';
  if (!AUDIO_CODECS.includes(codec)) {
    return { ok: false, error: `Audio codec “${codec}” is not supported yet. Use MP3, AAC (M4A), WAV or FLAC.` };
  }
  const durSec = Number(a.duration) || Number(data.format?.duration) || 0;
  if (durSec <= 0) return { ok: false, error: 'Could not determine the duration of this file.' };
  let fileSize = Number(data.format?.size) || 0;
  try {
    fileSize = statSync(file).size;
  } catch {}
  const none = { num: 30, den: 1 };
  return {
    ok: true,
    warnings: [],
    info: {
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
async function probeImage(file: string): Promise<ProbeResult> {
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
    },
  };
}
