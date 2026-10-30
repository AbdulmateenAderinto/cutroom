/**
 * Waveform peaks for drawing audio on the timeline: 100 peaks per second (0..255), computed once
 * with FFmpeg from a low-rate mono decode and cached on disk.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ffmpegPath } from './ffbin';

export const PEAKS_PER_SECOND = 100;
const RATE = 8000;

export async function waveformPeaks(cacheDir: string, file: string): Promise<Uint8Array> {
  const st = statSync(file);
  const key = createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}|v1`).digest('hex');
  const cached = path.join(cacheDir, `${key}.peaks`);
  if (existsSync(cached)) return new Uint8Array(readFileSync(cached));
  const per = RATE / PEAKS_PER_SECOND;
  const peaks: number[] = [];
  let current = 0;
  let count = 0;
  let carry: Buffer = Buffer.alloc(0);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk: Buffer) => {
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const usable = buf.length - (buf.length % 2);
      for (let i = 0; i < usable; i += 2) {
        current = Math.max(current, Math.abs(buf.readInt16LE(i)));
        if (++count === per) {
          peaks.push(Math.min(255, Math.round((current / 32768) * 255)));
          current = 0;
          count = 0;
        }
      }
      carry = buf.subarray(usable);
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
  });
  if (count) peaks.push(Math.min(255, Math.round((current / 32768) * 255)));
  const out = Uint8Array.from(peaks);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cached, out);
  return out;
}

/**
 * The background noise level of a file's sound (dBFS): the 10th percentile of the levels of
 * 50 ms windows (the quiet parts), over at most the first 2 minutes. Used to set up noise reduction.
 * Read at full bandwidth (48 kHz): resampling lower would hide high-frequency hiss.
 */
export function noiseFloor(file: string): Promise<number | null> {
  return new Promise((resolve) => {
    const p = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', '-loglevel', 'error', '-t', '120', '-i', file, '-vn', '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    p.stdout.on('data', (d) => chunks.push(d));
    p.on('error', () => resolve(null));
    p.on('close', () => {
      const buf = Buffer.concat(chunks);
      const n = Math.floor(buf.length / 4);
      if (n < 24000) return resolve(null);
      const pcm = new Float32Array(buf.buffer, buf.byteOffset, n);
      const levels: number[] = [];
      for (let i = 0; i + 2400 <= n; i += 2400) {
        let s = 0;
        for (let k = i; k < i + 2400; k++) s += pcm[k] * pcm[k];
        const rms = Math.sqrt(s / 2400);
        if (rms > 1e-6) levels.push(20 * Math.log10(rms));
      }
      if (!levels.length) return resolve(null);
      levels.sort((a, b) => a - b);
      resolve(Math.round(levels[Math.floor(levels.length * 0.1)] * 10) / 10);
    });
  });
}
