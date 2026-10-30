/**
 * Synthetic media for tests, generated with FFmpeg's lavfi sources.
 *
 * "Coded" clips encode their own frame number in the picture so an export can be decoded back
 * and checked frame by frame:
 *   Y  (brightness) = 16 + (frame mod fps) * step
 *   Cr (red chroma) = 40 + floor(frame / fps) * 20      (which second)
 *   Cb (blue chroma)= the fixture's id colour            (which file)
 * Each fixture also has a distinct sine tone, so audio can be attributed to a clip.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import type { MediaRef } from '../../src/shared/model';
import { newId } from '../../src/shared/model';
import { probeMedia } from '../../src/main/media/probe';

export const FIXTURE_DIR = path.resolve(__dirname, '../.fixtures');
export const OUTPUT_DIR = path.resolve(__dirname, '../.output');

export function ensureDirs() {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });
}

/** Runs FFmpeg with the output file (last argument) written to a temporary name and renamed into
 *  place, so test files running in parallel never see (or probe) a half-written fixture. */
function ff(args: string[]) {
  const out = args[args.length - 1];
  const tmp = path.join(path.dirname(out), `.tmp-${process.pid}-${path.basename(out)}`);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args.slice(0, -1), tmp], { stdio: ['ignore', 'ignore', 'pipe'] });
  renameSync(tmp, out);
}

export interface CodedSpec {
  name: string;
  width: number;
  height: number;
  fps: number;
  seconds: number;
  cb: number; // fixture id colour
  freq: number; // audio tone
  rateExpr?: string; // e.g. "30000/1001"
}

export function codedStep(fps: number) {
  return Math.floor(200 / fps);
}

export function makeCoded(spec: CodedSpec): string {
  ensureDirs();
  const out = path.join(FIXTURE_DIR, `${spec.name}.mp4`);
  if (existsSync(out)) return out;
  const fpsI = Math.round(spec.fps);
  const step = codedStep(fpsI);
  const rate = spec.rateExpr ?? String(spec.fps);
  const vf =
    `nullsrc=s=${spec.width}x${spec.height}:r=${rate}:d=${spec.seconds},format=yuv420p,` +
    `geq=lum='16+mod(N\\,${fpsI})*${step}':cb='${spec.cb}':cr='40+floor(N/${fpsI})*20',` +
    // Tagged BT.709 so the exporter passes the YUV values through untouched (they encode frame numbers).
    // The frames themselves are tagged: FFmpeg 8+ converts untagged frames to match -colorspace.
    `setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv`;
  ff([
    '-f', 'lavfi', '-i', vf,
    '-f', 'lavfi', '-i', `sine=f=${spec.freq}:r=48000:d=${spec.seconds}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '8', '-g', '12', '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', out,
  ]);
  return out;
}

/** Flash frame (white) at every whole second, with a 1-frame 1 kHz beep at exactly the same time. */
export function makeSync(name: string, fps = 30, seconds = 6): string {
  ensureDirs();
  const out = path.join(FIXTURE_DIR, `${name}.mp4`);
  if (existsSync(out)) return out;
  const vf = `nullsrc=s=320x180:r=${fps}:d=${seconds},format=yuv420p,geq=lum='if(eq(mod(N\\,${fps})\\,0)\\,235\\,16)':cb=128:cr=128`;
  const af = `aevalsrc='if(lt(mod(t\\,1)\\,${(1 / fps).toFixed(5)})\\,0.8*sin(2*PI*1000*t)\\,0)':s=48000:d=${seconds}`;
  ff(['-f', 'lavfi', '-i', vf, '-f', 'lavfi', '-i', af, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', out]);
  return out;
}

/** Hard-to-compress content for bitrate tests. */
export function makeNoisy(name: string, seconds = 6): string {
  ensureDirs();
  const out = path.join(FIXTURE_DIR, `${name}.mp4`);
  if (existsSync(out)) return out;
  ff(['-f', 'lavfi', '-i', `testsrc2=s=1280x720:r=30:d=${seconds},noise=alls=25:allf=t`,
    '-f', 'lavfi', '-i', `sine=f=300:r=48000:d=${seconds}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out]);
  return out;
}

export async function mediaRefFor(file: string): Promise<MediaRef> {
  const r = await probeMedia(file);
  if (!r.ok) throw new Error(r.error);
  return { id: newId('media'), name: path.basename(file), path: file, info: r.info, warnings: r.warnings };
}

// ---------------------------------------------------------------------------------------------
// Reading results back

export function ffprobe(file: string): any {
  const out = execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-count_frames', file]);
  return JSON.parse(out.toString());
}

/** Average Y/Cb/Cr of a small square at (cx, cy) for every frame (yuv444 so chroma is per-pixel). */
export function samplePatch(file: string, cx: number, cy: number, size = 8): { y: number; u: number; v: number }[] {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-an',
    '-vf', `crop=${size}:${size}:${cx - size / 2}:${cy - size / 2},format=yuv444p`, '-f', 'rawvideo', '-'],
  { maxBuffer: 1 << 28 });
  const plane = size * size;
  const frameBytes = plane * 3;
  const frames: { y: number; u: number; v: number }[] = [];
  for (let off = 0; off + frameBytes <= raw.length; off += frameBytes) {
    const avg = (p: number) => {
      let s = 0;
      for (let i = 0; i < plane; i++) s += raw[off + p * plane + i];
      return s / plane;
    };
    frames.push({ y: avg(0), u: avg(1), v: avg(2) });
  }
  return frames;
}

export function decodeCodedFrame(px: { y: number; u: number; v: number }, fps: number): { frame: number; cb: number } {
  const step = codedStep(fps);
  const inSecond = Math.round((px.y - 16) / step);
  const second = Math.round((px.v - 40) / 20);
  return { frame: second * fps + inSecond, cb: px.u };
}

/** Mono float32 PCM at 48 kHz. */
export function readAudio(file: string): Float32Array {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'],
    { maxBuffer: 1 << 28 });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
}

/** Estimate tone frequency in [t0, t1) seconds by counting zero crossings. */
export function toneFrequency(pcm: Float32Array, t0: number, t1: number, sr = 48000): number {
  const a = Math.floor(t0 * sr);
  const b = Math.min(pcm.length, Math.floor(t1 * sr));
  let crossings = 0;
  for (let i = a + 1; i < b; i++) if ((pcm[i - 1] < 0) !== (pcm[i] < 0)) crossings++;
  return crossings / 2 / ((b - a) / sr);
}

export function rms(pcm: Float32Array, t0: number, t1: number, sr = 48000): number {
  const a = Math.floor(t0 * sr);
  const b = Math.min(pcm.length, Math.floor(t1 * sr));
  let s = 0;
  for (let i = a; i < b; i++) s += pcm[i] * pcm[i];
  return Math.sqrt(s / Math.max(1, b - a));
}
