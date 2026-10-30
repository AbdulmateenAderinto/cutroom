/**
 * Media housekeeping: find missing files in a folder (relink many at once), and copy a project's
 * media into one folder ("collect files").
 */
import { copyFile, readdir, stat } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const MAX_FILES = 100_000;

/**
 * Look for files under `folder` (and its sub-folders) with the wanted names. A file of the same
 * size is preferred when there are several with one name. Returns name → path for those found.
 */
export async function findInFolder(folder: string, wanted: { name: string; size?: number }[]): Promise<Record<string, string>> {
  const byName = new Map<string, { size?: number }>();
  for (const w of wanted) byName.set(w.name.toLowerCase(), { size: w.size });
  const found: Record<string, string> = {};
  const sizeOk: Record<string, boolean> = {};
  let seen = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8 || seen > MAX_FILES) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable folder
    }
    for (const e of entries) {
      if (++seen > MAX_FILES) return;
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (e.isFile()) {
        const key = e.name.toLowerCase();
        const w = byName.get(key);
        if (!w || sizeOk[key]) continue;
        let size = -1;
        try {
          size = (await stat(full)).size;
        } catch {
          continue;
        }
        const exact = w.size === undefined || w.size === size;
        if (exact || !found[key]) {
          found[key] = full;
          sizeOk[key] = exact;
        }
      }
    }
  };
  await walk(folder, 0);
  const out: Record<string, string> = {};
  for (const w of wanted) {
    const f = found[w.name.toLowerCase()];
    if (f) out[w.name] = f;
  }
  return out;
}

/**
 * Copy files into `folder` (names kept; " 2", " 3"… added on clashes; files already in it are
 * left alone). Returns old path → new path. Never overwrites anything.
 */
export async function collectFiles(files: string[], folder: string, onProgress?: (done: number, total: number) => void): Promise<Record<string, string>> {
  mkdirSync(folder, { recursive: true });
  const out: Record<string, string> = {};
  const target = path.resolve(folder);
  let done = 0;
  for (const f of [...new Set(files)]) {
    if (path.dirname(path.resolve(f)) === target) {
      out[f] = f;
    } else {
      const ext = path.extname(f);
      const stem = path.basename(f, ext);
      let dest = path.join(folder, `${stem}${ext}`);
      for (let n = 2; existsSync(dest); n++) dest = path.join(folder, `${stem} ${n}${ext}`);
      await copyFile(f, dest);
      out[f] = dest;
    }
    onProgress?.(++done, files.length);
  }
  return out;
}
