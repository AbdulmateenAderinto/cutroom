/**
 * Which video encoders work on this computer. Apple's hardware encoder (VideoToolbox) is listed by
 * FFmpeg builds for macOS even where it can't run, so it is checked with a real one-frame encode.
 */
import { execFile } from 'node:child_process';
import { ffmpegPath } from '../media/ffbin';

export interface EncoderAvailability {
  videotoolbox: boolean;
  /** Why the hardware encoder can't be used (shown in the export dialog). */
  reason?: string;
}

let cached: Promise<EncoderAvailability> | null = null;

export function encoderAvailability(): Promise<EncoderAvailability> {
  cached ??= probe();
  return cached;
}

async function probe(): Promise<EncoderAvailability> {
  if (process.platform !== 'darwin') return { videotoolbox: false, reason: 'Hardware encoding (VideoToolbox) is only available on macOS.' };
  let bin: string;
  try {
    bin = ffmpegPath();
  } catch (e) {
    return { videotoolbox: false, reason: (e as Error).message };
  }
  return new Promise((resolve) => {
    execFile(
      bin,
      ['-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=256x256:r=30:d=0.2',
        '-c:v', 'h264_videotoolbox', '-b:v', '2M', '-pix_fmt', 'yuv420p', '-f', 'null', '-'],
      { timeout: 20_000 },
      (err, _out, stderr) => {
        if (!err) return resolve({ videotoolbox: true });
        const msg = String(stderr || err.message).trim().split('\n').pop() ?? '';
        resolve({
          videotoolbox: false,
          reason: /Unknown encoder|not found/i.test(msg)
            ? 'This FFmpeg build has no VideoToolbox support. The Homebrew build (brew install ffmpeg) includes it.'
            : `The hardware encoder did not work on this Mac: ${msg}`,
        });
      },
    );
  });
}

let filterList: Promise<string> | null = null;
/** The filters this FFmpeg build has (`ffmpeg -filters`, read once). */
function filters(): Promise<string> {
  filterList ??= new Promise((resolve) => {
    let bin: string;
    try {
      bin = ffmpegPath();
    } catch {
      return resolve('');
    }
    execFile(bin, ['-hide_banner', '-filters'], { timeout: 15_000, maxBuffer: 4 << 20 }, (err, out) => resolve(err ? '' : String(out)));
  });
  return filterList;
}
export async function hasFilter(name: string): Promise<boolean> {
  return new RegExp(`\\s${name}\\s`).test(await filters());
}

let stretch: Promise<'rubberband' | 'atempo'> | null = null;

/** The best pitch-preserving time-stretch filter in this FFmpeg build (for speed changes). */
export function timeStretchFilter(): Promise<'rubberband' | 'atempo'> {
  stretch ??= new Promise((resolve) => {
    let bin: string;
    try {
      bin = ffmpegPath();
    } catch {
      return resolve('atempo');
    }
    execFile(bin, ['-hide_banner', '-filters'], { timeout: 15_000, maxBuffer: 4 << 20 }, (err, out) => {
      resolve(!err && /\srubberband\s/.test(String(out)) ? 'rubberband' : 'atempo');
    });
  });
  return stretch;
}
