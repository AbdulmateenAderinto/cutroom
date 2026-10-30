/**
 * HEIC/HEIF photos (iPhone): converted once with macOS's built-in `sips` to a full-quality JPEG in
 * the app's data folder. The preview and the export both use that copy; the project keeps
 * referring to the original file. (Neither Chromium nor FFmpeg 6 decodes HEIC.)
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

export const isHeic = (file: string) => /\.(heic|heif)$/i.test(file);

/** The app's folder for converted photos (set once at startup; tests may leave it unset). */
let convertDir: string | null = null;
export function setConvertDir(dir: string) {
  convertDir = dir;
}
export function getConvertDir(): string | null {
  return convertDir;
}

/** For the export: HEIC originals are read from their converted JPEG (FFmpeg 6 can't decode HEIC). */
export async function decodablePath(file: string): Promise<string> {
  return isHeic(file) && convertDir ? heicToJpeg(convertDir, file) : file;
}

export function heicJpegPath(dir: string, file: string): string {
  const st = statSync(file);
  const key = createHash('sha1').update(`${path.resolve(file)}|${st.size}|${st.mtimeMs}`).digest('hex');
  return path.join(dir, `${key}.jpg`);
}

/** The sips command for one conversion (structured arguments, no shell). */
export function sipsArgs(file: string, out: string): string[] {
  return ['-s', 'format', 'jpeg', '-s', 'formatOptions', '95', file, '--out', out];
}

export async function heicToJpeg(dir: string, file: string): Promise<string> {
  const out = heicJpegPath(dir, file);
  if (existsSync(out)) return out;
  mkdirSync(dir, { recursive: true });
  const tmp = `${out}.partial.jpg`;
  await new Promise<void>((resolve, reject) => {
    execFile('/usr/bin/sips', sipsArgs(file, tmp), { timeout: 60_000 }, (err, _o, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve()));
  });
  renameSync(tmp, out);
  return out;
}
