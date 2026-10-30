/**
 * Preview copies for files the preview (Chromium) can't play. Made once with FFmpeg in the
 * background and cached in the app's data folder; the export always reads the original.
 *
 *   remux     picture copied as-is into MP4, sound converted to AAC (fast)
 *   transcode H.264 copy, at most 1920×1080, every frame kept at its original time
 *   audio     AAC copy of a sound file
 *   image     PNG copy of a still image (HEIC: the JPEG made by heic.ts)
 *
 * Colours: the transcode reads the source with the same matrix/range the export uses and writes
 * BT.709, so preview and export agree.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { sourceColorSteps } from '../../shared/exportPlan';
import type { MediaInfo } from '../../shared/model';
import { ticksToSeconds } from '../../shared/time';
import { ffmpegPath } from './ffbin';
import { getConvertDir, heicToJpeg, isHeic } from './heic';

const VERSION = 1; // bump to invalidate cached copies after changing the recipes below

export function proxyPath(dir: string, file: string, mode: NonNullable<MediaInfo['preview']>): string {
  const st = statSync(file);
  const key = createHash('sha1').update(`${path.resolve(file)}|${st.size}|${st.mtimeMs}|${mode}|v${VERSION}`).digest('hex');
  const ext = mode === 'image' ? 'png' : mode === 'audio' ? 'm4a' : 'mp4';
  return path.join(dir, `${key}.${ext}`);
}

/** Fit within 1920×1080 (either orientation), even sizes, square pixels. */
export function proxySize(info: MediaInfo): { w: number; h: number } {
  const long = Math.max(info.displayWidth, info.displayHeight);
  const short = Math.min(info.displayWidth, info.displayHeight);
  const k = Math.min(1, 1920 / long, 1080 / short);
  const even = (v: number) => Math.max(2, 2 * Math.round(v / 2));
  return { w: even(info.displayWidth * k), h: even(info.displayHeight * k) };
}

export function proxyArgs(file: string, info: MediaInfo, mode: NonNullable<MediaInfo['preview']>, out: string): string[] {
  const head = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', '-i', file];
  const sound = ['-c:a', 'aac', '-b:a', '192k', '-ac', '2'];
  if (mode === 'audio') return [...head, '-vn', '-map', '0:a:0', ...sound, '-f', 'mp4', out];
  if (mode === 'image') return [...head, '-frames:v', '1', '-f', 'image2', '-c:v', 'png', out];
  const maps = ['-map', '0:v:0', ...(info.hasAudio ? ['-map', '0:a:0'] : [])];
  if (mode === 'remux') {
    return [...head, ...maps, '-c:v', 'copy', ...(info.hasAudio ? sound : []), '-movflags', '+faststart', '-f', 'mp4', out];
  }
  const { w, h } = proxySize(info);
  // Same colour interpretation as the export (and the preview of the original would use).
  const c = sourceColorSteps(info, process.platform === 'darwin' ? 'mac' : 'other');
  const inM = c.matrix === 'bt601' ? ':in_color_matrix=bt601' : ':in_color_matrix=bt709';
  const vf = `${c.tagSource}${c.toBt709}scale=w=${w}:h=${h}:flags=bicubic${inM}:in_range=${c.range}:out_color_matrix=bt709:out_range=tv,format=yuv420p,setsar=1`;
  return [
    ...head, ...maps, '-vf', vf,
    // Every frame at its original time (VFR included), frequent keyframes for quick seeking.
    '-fps_mode', 'passthrough', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-g', '15', '-bf', '0',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    ...(info.hasAudio ? sound : []), '-movflags', '+faststart', '-f', 'mp4', out,
  ];
}

const running = new Map<string, Promise<string>>();

/** Make (or reuse) the preview copy. Remuxing falls back to transcoding if the copy can't be made. */
export function makeProxy(dir: string, file: string, info: MediaInfo, onProgress?: (fraction: number) => void): Promise<string> {
  const mode = info.preview;
  if (!mode || mode === 'native') return Promise.resolve(file);
  if (mode === 'image' && isHeic(file)) return heicToJpeg(getConvertDir() ?? path.join(dir, '..', 'converted'), file);
  const out = proxyPath(dir, file, mode);
  if (existsSync(out)) return Promise.resolve(out);
  const key = out;
  let job = running.get(key);
  if (!job) {
    job = run(dir, file, info, mode, out, onProgress).catch((e) => {
      if (mode !== 'remux') throw e;
      return run(dir, file, info, 'transcode', proxyPath(dir, file, 'transcode'), onProgress);
    }).finally(() => running.delete(key));
    running.set(key, job);
  }
  return job;
}

function run(dir: string, file: string, info: MediaInfo, mode: NonNullable<MediaInfo['preview']>, out: string, onProgress?: (f: number) => void): Promise<string> {
  if (existsSync(out)) return Promise.resolve(out);
  mkdirSync(dir, { recursive: true });
  const partial = `${out}.partial${path.extname(out)}`;
  const total = ticksToSeconds(info.duration);
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), proxyArgs(file, info, mode, partial), { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => {
      err = (err + d.toString()).slice(-10000);
    });
    p.stdout.on('data', (d) => {
      const m = /out_time_us=(\d+)/.exec(d.toString());
      if (m && total > 0 && info.kind !== 'image') onProgress?.(Math.min(0.99, Number(m[1]) / 1e6 / total));
    });
    p.on('close', (code) => {
      if (code === 0 && existsSync(partial)) {
        renameSync(partial, out);
        onProgress?.(1);
        resolve(out);
      } else {
        rmSync(partial, { force: true });
        reject(new Error(err.trim().split('\n').pop() || `FFmpeg exited with ${code}`));
      }
    });
  });
}
