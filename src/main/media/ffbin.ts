/**
 * Locates ffmpeg/ffprobe. macOS GUI apps do not inherit your shell PATH, so the Homebrew
 * locations are checked explicitly. Override with CUTROOM_FFMPEG / CUTROOM_FFPROBE.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

// Homebrew's `ffmpeg-full` (keg-only, so not on PATH) first: the plain `ffmpeg` formula has no
// zscale (HDR tone mapping), vid.stab or rubberband.
const CANDIDATE_DIRS = ['/opt/homebrew/opt/ffmpeg-full/bin', '/usr/local/opt/ffmpeg-full/bin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

export interface FfmpegStatus {
  ok: boolean;
  ffmpeg: string | null;
  ffprobe: string | null;
  version: string | null;
  hasLibx264: boolean;
  hasAac: boolean;
  message: string | null; // readable explanation when !ok
}

let resolved: { ffmpeg: string | null; ffprobe: string | null } | null = null;

function find(name: 'ffmpeg' | 'ffprobe', extraDirs: string[]): string | null {
  const env = name === 'ffmpeg' ? process.env.CUTROOM_FFMPEG : process.env.CUTROOM_FFPROBE;
  if (env && existsSync(env)) return env;
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const dirs = [...extraDirs, ...CANDIDATE_DIRS, ...(process.env.PATH ?? '').split(path.delimiter)];
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, exe);
    if (existsSync(p)) return p;
  }
  return null;
}

/** extraDirs: e.g. a bundled resources/bin directory in a packaged app (checked first). */
export function resolveBinaries(extraDirs: string[] = []) {
  if (!resolved) resolved = { ffmpeg: find('ffmpeg', extraDirs), ffprobe: find('ffprobe', extraDirs) };
  return resolved;
}

export function ffmpegPath(): string {
  const p = resolveBinaries().ffmpeg;
  if (!p) throw new Error('FFmpeg was not found. Install it with "brew install ffmpeg" and restart Cutroom.');
  return p;
}

export function ffprobePath(): string {
  const p = resolveBinaries().ffprobe;
  if (!p) throw new Error('ffprobe was not found. Install FFmpeg with "brew install ffmpeg" and restart Cutroom.');
  return p;
}

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

export async function checkFfmpeg(): Promise<FfmpegStatus> {
  const { ffmpeg, ffprobe } = resolveBinaries();
  const base: FfmpegStatus = { ok: false, ffmpeg, ffprobe, version: null, hasLibx264: false, hasAac: false, message: null };
  if (!ffmpeg || !ffprobe) {
    return { ...base, message: 'FFmpeg and ffprobe are required for importing and exporting. Install them with "brew install ffmpeg", then restart Cutroom.' };
  }
  try {
    const v = await run(ffmpeg, ['-hide_banner', '-version']);
    const encoders = await run(ffmpeg, ['-hide_banner', '-encoders']);
    const version = v.split('\n')[0] ?? null;
    const hasLibx264 = /\blibx264\b/.test(encoders);
    const hasAac = /\baac\b/.test(encoders);
    const ok = hasLibx264 && hasAac;
    return {
      ...base, ok, version, hasLibx264, hasAac,
      message: ok ? null : 'Your FFmpeg build lacks the libx264 or AAC encoder needed for MP4 export. The Homebrew build ("brew install ffmpeg") includes both.',
    };
  } catch (e) {
    return { ...base, message: `FFmpeg could not be started: ${(e as Error).message}` };
  }
}
