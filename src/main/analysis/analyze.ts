/**
 * Local media analysis with FFmpeg (no AI models, nothing uploaded):
 *   - silence detection (FFmpeg silencedetect on the audio)
 *   - scene-change detection (FFmpeg's scene score on a downscaled copy of the video)
 * Results are in SOURCE seconds and cached per file + settings.
 */
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { ffmpegPath } from '../media/ffbin';

export interface Range {
  start: number;
  end: number;
}

export interface SilenceOptions {
  noiseDb: number; // quieter than this counts as silence, e.g. -35
  minDuration: number; // seconds
}

export const DEFAULT_SILENCE: SilenceOptions = { noiseDb: -35, minDuration: 0.6 };
export const DEFAULT_SCENE_THRESHOLD = 0.3;

const cache = new Map<string, unknown>();

function keyFor(file: string, extra: string) {
  try {
    const st = statSync(file);
    return `${file}|${st.size}|${st.mtimeMs}|${extra}`;
  } catch {
    return `${file}|${extra}`;
  }
}

function runFfmpeg(args: string[], timeoutMs = 10 * 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath(), ['-hide_banner', '-nostdin', '-nostats', ...args], { maxBuffer: 64 << 20, timeout: timeoutMs }, (err, _out, stderr) => {
      if (err) reject(new Error(stderr?.toString().trim().split('\n').pop() || err.message));
      else resolve(stderr.toString());
    });
  });
}

export function parseSilence(log: string, duration: number): Range[] {
  const ranges: Range[] = [];
  let start: number | null = null;
  for (const line of log.split('\n')) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (s) start = Math.max(0, Number(s[1]));
    const e = /silence_end:\s*([\d.]+)/.exec(line);
    if (e && start !== null) {
      ranges.push({ start, end: Number(e[1]) });
      start = null;
    }
  }
  if (start !== null && duration > start) ranges.push({ start, end: duration }); // silent until the end
  return ranges;
}

export async function detectSilence(file: string, duration: number, opts: Partial<SilenceOptions> = {}): Promise<Range[]> {
  // Ignore undefined options (e.g. omitted by an AI tool call) instead of letting them erase defaults.
  const o: SilenceOptions = {
    noiseDb: Number.isFinite(opts.noiseDb) ? opts.noiseDb! : DEFAULT_SILENCE.noiseDb,
    minDuration: Number.isFinite(opts.minDuration) && opts.minDuration! > 0 ? opts.minDuration! : DEFAULT_SILENCE.minDuration,
  };
  const key = keyFor(file, `sil:${o.noiseDb}:${o.minDuration}`);
  if (cache.has(key)) return cache.get(key) as Range[];
  const log = await runFfmpeg(['-i', file, '-vn', '-af', `silencedetect=noise=${o.noiseDb}dB:d=${o.minDuration}`, '-f', 'null', '-']);
  const r = parseSilence(log, duration);
  cache.set(key, r);
  return r;
}

export function parseScenes(log: string): number[] {
  const times: number[] = [];
  for (const line of log.split('\n')) {
    if (!line.includes('Parsed_showinfo')) continue;
    const m = /pts_time:\s*([\d.]+)/.exec(line);
    if (m) times.push(Number(m[1]));
  }
  return times;
}

export async function detectScenes(file: string, threshold = DEFAULT_SCENE_THRESHOLD): Promise<number[]> {
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) threshold = DEFAULT_SCENE_THRESHOLD;
  const key = keyFor(file, `scene:${threshold}`);
  if (cache.has(key)) return cache.get(key) as number[];
  const log = await runFfmpeg(['-i', file, '-an', '-vf', `scale=320:-2,select='gt(scene\\,${threshold})',showinfo`, '-f', 'null', '-']);
  const r = parseScenes(log);
  cache.set(key, r);
  return r;
}
