/**
 * 3D LUTs (.cube) used as media input transforms. Each chosen LUT is copied into the app's LUT
 * folder under its content hash (<sha1>.cube), so FFmpeg can be pointed at a plain file name (it
 * runs with that folder as its working directory) and nothing in a filter graph needs escaping.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { MediaInput } from '../../shared/model';

let lutDir: string | null = null;
export function setLutDir(dir: string) {
  lutDir = dir;
}
export function getLutDir(): string {
  return lutDir ?? path.join(process.cwd(), '.cutroom-luts');
}

/** Checks a .cube file well enough to give a clear message (FFmpeg does the real parsing). */
export function checkCube(text: string): string | null {
  const m = /^\s*LUT_3D_SIZE\s+(\d+)/m.exec(text);
  if (!m) return /^\s*LUT_1D_SIZE/m.test(text) ? 'This is a 1D LUT; a 3D LUT (.cube with LUT_3D_SIZE) is needed.' : 'Not a .cube 3D LUT (no LUT_3D_SIZE line).';
  const n = Number(m[1]);
  if (n < 2 || n > 129) return `Unsupported LUT size ${n}.`;
  const rows = text.split(/\r?\n/).filter((l) => /^\s*[-+]?(\d|\.\d)/.test(l) && l.trim().split(/\s+/).length === 3).length;
  if (rows < n * n * n) return `The LUT has ${rows} entries; ${n * n * n} expected.`;
  return null;
}

export function importLut(source: string): NonNullable<MediaInput['lut']> {
  const data = readFileSync(source);
  const problem = checkCube(data.toString('utf8'));
  if (problem) throw new Error(problem);
  const file = `${createHash('sha1').update(data).digest('hex')}.cube`;
  mkdirSync(getLutDir(), { recursive: true });
  const dest = path.join(getLutDir(), file);
  if (!existsSync(dest)) copyFileSync(source, dest);
  return { file, name: path.basename(source), source };
}

/** Make sure the app's copy exists (copied again from the original if needed). */
export function ensureLut(lut: NonNullable<MediaInput['lut']>): string | null {
  const dest = path.join(getLutDir(), lut.file);
  if (existsSync(dest)) return null;
  try {
    if (existsSync(lut.source)) {
      const again = importLut(lut.source);
      if (again.file === lut.file) return null;
      return `The LUT “${lut.name}” has changed since it was chosen; choose it again.`;
    }
  } catch (e) {
    return (e as Error).message;
  }
  return `The LUT “${lut.name}” is missing (${lut.source}).`;
}
