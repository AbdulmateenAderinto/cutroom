/**
 * Local speech-to-text with whisper.cpp (https://github.com/ggml-org/whisper.cpp).
 *
 * - The `whisper-cli` program comes from Homebrew (`brew install whisper-cpp`) or CUTROOM_WHISPER.
 *   On Apple Silicon it uses the GPU (Metal) and runs many times faster than real time.
 * - Models are downloaded once, only when the person clicks Download, from the official
 *   whisper.cpp model repository on Hugging Face, into <userData>/models. A model file the person
 *   already has can be used instead.
 * - Audio is converted to 16 kHz mono WAV with FFmpeg, transcribed with word timestamps
 *   (-ml 1 -sow), and parsed into words with SOURCE times.
 */
import { execFile, spawn } from 'node:child_process';
import { closeSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Transcript, TranscriptWord } from '../../shared/model';
import { secondsToTicks } from '../../shared/time';
import { ffmpegPath } from '../media/ffbin';

export interface ModelInfo {
  id: string;
  file: string;
  label: string;
  sizeMB: number;
  english: boolean;
}

export const MODELS: ModelInfo[] = [
  { id: 'base.en', file: 'ggml-base.en.bin', label: 'Base (English) — good default', sizeMB: 142, english: true },
  { id: 'base', file: 'ggml-base.bin', label: 'Base (multilingual)', sizeMB: 142, english: false },
  { id: 'small.en', file: 'ggml-small.en.bin', label: 'Small (English) — more accurate, slower', sizeMB: 466, english: true },
  { id: 'small', file: 'ggml-small.bin', label: 'Small (multilingual)', sizeMB: 466, english: false },
  { id: 'tiny.en', file: 'ggml-tiny.en.bin', label: 'Tiny (English) — fastest, least accurate', sizeMB: 75, english: true },
];

export const MODEL_URL = (file: string) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${file}`;

const DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
const NAMES = ['whisper-cli', 'whisper-cpp'];

export function findWhisper(): string | null {
  const env = process.env.CUTROOM_WHISPER;
  if (env && existsSync(env)) return env;
  for (const d of [...DIRS, ...(process.env.PATH ?? '').split(path.delimiter)]) {
    for (const n of NAMES) {
      const p = path.join(d, n);
      if (d && existsSync(p)) return p;
    }
  }
  return null;
}

/** whisper.cpp model files start with the ggml magic number (0x67676d6c, stored little-endian). */
export function isWhisperModel(file: string): boolean {
  try {
    if (statSync(file).size < 1_000_000) return false;
    const fd = openSync(file, 'r');
    const buf = Buffer.alloc(4);
    readSync(fd, buf, 0, 4, 0);
    closeSync(fd);
    return buf.toString('latin1') === 'lmgg';
  } catch {
    return false;
  }
}

export function modelPath(modelsDir: string, id: string): string {
  const m = MODELS.find((x) => x.id === id);
  return path.join(modelsDir, m?.file ?? `ggml-${id}.bin`);
}

export async function downloadModel(
  modelsDir: string,
  id: string,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<string> {
  const m = MODELS.find((x) => x.id === id);
  if (!m) throw new Error(`Unknown model ${id}`);
  mkdirSync(modelsDir, { recursive: true });
  const target = path.join(modelsDir, m.file);
  const partial = `${target}.partial`;
  const res = await fetch(MODEL_URL(m.file), { signal, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}).`);
  const total = Number(res.headers.get('content-length')) || m.sizeMB * 1e6;
  const out = createWriteStream(partial);
  let got = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
      onProgress(Math.min(0.999, got / total));
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  } catch (e) {
    out.destroy();
    try { unlinkSync(partial); } catch {}
    throw e;
  }
  if (!isWhisperModel(partial)) {
    try { unlinkSync(partial); } catch {}
    throw new Error('The downloaded file is not a whisper.cpp model.');
  }
  renameSync(partial, target);
  return target;
}

/** Parse whisper.cpp JSON output (-oj) made with word-level segments (-ml 1 -sow). */
export function parseWhisperJson(json: any): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  for (const seg of json?.transcription ?? []) {
    const raw: string = seg.text ?? '';
    const text = raw.trim();
    if (!text || /^\[.*\]$/.test(text) || /^\(.*\)$/.test(text)) continue; // [BLANK_AUDIO], (music)
    const start = secondsToTicks((seg.offsets?.from ?? 0) / 1000);
    const end = secondsToTicks((seg.offsets?.to ?? 0) / 1000);
    const prev = words[words.length - 1];
    // Pieces without a leading space (punctuation, "'s") belong to the previous word.
    if (prev && !/^\s/.test(raw)) {
      prev.text += text;
      prev.end = Math.max(prev.end, end);
    } else {
      words.push({ text, start, end: Math.max(end, start + 1) });
    }
  }
  return words;
}

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 30 * 60_000, maxBuffer: 16 << 20 }, (err, _o, stderr) =>
      err ? reject(new Error(stderr?.toString().trim().split('\n').pop() || err.message)) : resolve());
  });
}

export interface TranscribeOptions {
  model: string; // path to a ggml model
  language: string; // 'auto' or a code like 'en'
  modelName: string;
}

export async function transcribeFile(
  media: string,
  opts: TranscribeOptions,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<Transcript> {
  const bin = findWhisper();
  if (!bin) throw new Error('whisper.cpp is not installed. Install it with "brew install whisper-cpp", then try again.');
  if (!isWhisperModel(opts.model)) throw new Error('No speech model is set up. Download one in Transcription setup.');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cutroom-whisper-'));
  try {
    const wav = path.join(dir, 'audio.wav');
    await run(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', media, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
    onProgress(0.02);
    const prefix = path.join(dir, 'out');
    const threads = String(Math.max(2, Math.min(8, os.cpus().length - 1)));
    const args = ['-m', opts.model, '-f', wav, '-l', opts.language || 'auto', '-ml', '1', '-sow', '-oj', '-of', prefix, '-pp', '-t', threads];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let tail = '';
      child.stderr.on('data', (c: Buffer) => {
        const s = c.toString();
        tail = (tail + s).slice(-4000);
        for (const m of s.matchAll(/progress\s*=\s*(\d+)%/g)) onProgress(0.02 + 0.97 * (Number(m[1]) / 100));
      });
      const onAbort = () => child.kill('SIGTERM');
      signal?.addEventListener('abort', onAbort, { once: true });
      child.on('error', reject);
      child.on('close', (code) => {
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted) reject(new Error('Transcription cancelled.'));
        else if (code === 0) resolve();
        else reject(new Error(`whisper.cpp failed: ${tail.trim().split('\n').pop() ?? `exit ${code}`}`));
      });
    });
    const json = JSON.parse(readFileSync(`${prefix}.json`, 'utf8'));
    const words = parseWhisperJson(json);
    const language = json?.result?.language ?? opts.language;
    onProgress(1);
    return { language, model: opts.modelName, words };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
