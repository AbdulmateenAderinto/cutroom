/**
 * Files made from part of a clip, then used like imported media (the export reads them like any
 * other file, so preview and export agree):
 *
 *   freeze frame  one source frame as a PNG (display size, the colours the preview shows)
 *   reversed      a range of a clip played backwards: H.264 (high quality) with AAC sound
 *
 * Colours: the source is read with the same matrix/range as the export and the preview copies
 * (sourceColorSteps) and written as BT.709, so the new file looks the same as the original.
 * Every process gets its arguments as an array (no shell).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sourceColorSteps } from '../../shared/exportPlan';
import type { MediaInfo } from '../../shared/model';
import { type Ticks, frameDuration, ticksToSeconds } from '../../shared/time';
import { ffmpegPath } from './ffbin';

const f6 = (s: number) => s.toFixed(6);
const platform = () => (process.platform === 'darwin' ? 'mac' : 'other');

/** Longest range that can be reversed (it is re-encoded, so this bounds the time it takes). */
export const MAX_REVERSE_SECONDS = 600;

function colourIn(info: MediaInfo): { pre: string; scaleIn: string } {
  const c = sourceColorSteps(info, platform());
  return { pre: c.tagSource + c.toBt709, scaleIn: `in_color_matrix=${c.matrix === 'bt601' ? 'bt601' : 'bt709'}:in_range=${c.range}` };
}

/** The source frame that starts at or before `t` and is shown at t (as the export picks it). */
export function frameStart(info: MediaInfo, t: Ticks): Ticks {
  const fd = frameDuration(info.frameRate);
  return Math.floor((t + fd / 4) / fd) * fd;
}

export function freezeFrameArgs(file: string, info: MediaInfo, at: Ticks, out: string): string[] {
  const fd = frameDuration(info.frameRate);
  const ss = Math.max(0, frameStart(info, at) - Math.floor(fd / 2));
  const { pre, scaleIn } = colourIn(info);
  return [
    '-hide_banner', '-nostdin', '-y', '-loglevel', 'error',
    '-ss', f6(ticksToSeconds(ss)), '-i', file, '-map', '0:v:0', '-frames:v', '1',
    '-vf', `${pre}scale=w=${info.displayWidth}:h=${info.displayHeight}:flags=bicubic:${scaleIn}:out_range=pc,format=rgb24,setsar=1`,
    '-f', 'image2', '-c:v', 'png', out,
  ];
}

function run(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err = (err + d.toString()).slice(-8000)));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || `FFmpeg exited with ${code}`))));
  });
}

const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + Math.random().toString(36).slice(2, 6);
const base = (file: string) => path.basename(file, path.extname(file)).slice(0, 60);

export async function makeFreezeFrame(dir: string, file: string, info: MediaInfo, at: Ticks): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${base(file)} frame ${stamp()}.png`);
  const partial = `${out}.partial.png`;
  try {
    await run(freezeFrameArgs(file, info, at, partial));
    if (!existsSync(partial)) throw new Error('No frame at that time.');
    renameSync(partial, out);
    return out;
  } finally {
    rmSync(partial, { force: true });
  }
}

/**
 * Source frames [k0, k1) of the clip range, as chunks to reverse one at a time (the reverse filter
 * keeps a whole chunk in memory), last chunk first.
 */
export function reverseChunks(info: MediaInfo, sourceIn: Ticks, sourceOut: Ticks): { a: number; b: number }[] {
  const fd = frameDuration(info.frameRate);
  const k0 = Math.round(sourceIn / fd);
  const k1 = Math.round(sourceOut / fd);
  const size = info.displayWidth * info.displayHeight > 2_100_000 ? 30 : 60;
  const out: { a: number; b: number }[] = [];
  for (let b = k1; b > k0; b -= size) out.push({ a: Math.max(k0, b - size), b });
  return out;
}

export function reverseChunkArgs(file: string, info: MediaInfo, a: number, b: number, out: string): string[] {
  const fd = frameDuration(info.frameRate);
  const { pre, scaleIn } = colourIn(info);
  const r = info.frameRate;
  return [
    '-hide_banner', '-nostdin', '-y', '-loglevel', 'error',
    '-ss', f6(Math.max(0, ticksToSeconds(a * fd - Math.floor(fd / 2)))), '-i', file, '-map', '0:v:0', '-an',
    '-vf', `${pre}scale=w=${info.displayWidth}:h=${info.displayHeight}:flags=bicubic:${scaleIn}:out_color_matrix=bt709:out_range=tv,format=yuv420p,setsar=1,` +
      `trim=end_frame=${b - a},reverse,setpts=N/(${r.num}/${r.den})/TB`,
    '-r', `${r.num}/${r.den}`, '-fps_mode', 'cfr',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '12', '-g', '30', '-bf', '0', '-pix_fmt', 'yuv420p',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-f', 'mp4', out,
  ];
}

export function reverseAudioArgs(file: string, info: MediaInfo, sourceIn: Ticks, sourceOut: Ticks, out: string): string[] {
  const fd = frameDuration(info.frameRate);
  const k0 = Math.round(sourceIn / fd);
  const k1 = Math.round(sourceOut / fd);
  const samples = Math.round(ticksToSeconds((k1 - k0) * fd) * 48000);
  return [
    '-hide_banner', '-nostdin', '-y', '-loglevel', 'error',
    '-ss', f6(ticksToSeconds(k0 * fd)), '-i', file, '-map', '0:a:0', '-vn',
    '-af', `aresample=48000:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=end_sample=${samples},areverse`,
    '-c:a', 'pcm_s16le', '-f', 'wav', out,
  ];
}

/** The range [sourceIn, sourceOut) of `file` played backwards, as a new MP4. */
export async function makeReversed(
  dir: string, file: string, info: MediaInfo, sourceIn: Ticks, sourceOut: Ticks, onProgress?: (fraction: number) => void,
): Promise<string> {
  if (info.kind !== 'video') throw new Error('Only video clips can be reversed.');
  if (info.isHDR) throw new Error('HDR clips cannot be reversed yet (the copy would lose the HDR).');
  if (ticksToSeconds(sourceOut - sourceIn) > MAX_REVERSE_SECONDS) throw new Error(`Clips longer than ${MAX_REVERSE_SECONDS / 60} minutes cannot be reversed; split it first.`);
  mkdirSync(dir, { recursive: true });
  const tmp = mkdtempSync(path.join(dir, '.reverse-'));
  const out = path.join(dir, `${base(file)} reversed ${stamp()}.mp4`);
  try {
    const chunks = reverseChunks(info, sourceIn, sourceOut);
    const list: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const f = path.join(tmp, `v${String(i).padStart(5, '0')}.mp4`);
      await run(reverseChunkArgs(file, info, chunks[i].a, chunks[i].b, f));
      list.push(`file '${f.replace(/'/g, "'\\''")}'`);
      onProgress?.((i + 1) / (chunks.length + 1));
    }
    writeFileSync(path.join(tmp, 'list.txt'), list.join('\n') + '\n');
    const audio = path.join(tmp, 'a.wav');
    if (info.hasAudio) await run(reverseAudioArgs(file, info, sourceIn, sourceOut, audio));
    const partial = `${out}.partial.mp4`;
    await run([
      '-hide_banner', '-nostdin', '-y', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', path.join(tmp, 'list.txt'),
      ...(info.hasAudio ? ['-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac', '-b:a', '256k'] : ['-map', '0:v:0']),
      '-c:v', 'copy', '-movflags', '+faststart', '-f', 'mp4', partial,
    ]);
    renameSync(partial, out);
    onProgress?.(1);
    return out;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
