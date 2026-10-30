/**
 * Project versions: named snapshots saved next to the project file, in "<name> versions/", as
 * ordinary .cutroom files (they open on their own too). Restoring one replaces the edit in the
 * window (as one undo step); the version files are never changed.
 */
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Project } from '../../shared/model';
import { PROJECT_EXTENSION } from '../../shared/model';
import { loadProjectFile, saveProjectFile } from './projectFiles';

export function versionsDir(projectPath: string): string {
  const stem = path.basename(projectPath, path.extname(projectPath));
  return path.join(path.dirname(projectPath), `${stem} versions`);
}

const safe = (s: string) => s.replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').trim().slice(0, 80) || 'Version';

export function saveVersion(projectPath: string, project: Project, label: string): { file: string; name: string } {
  const dir = versionsDir(projectPath);
  mkdirSync(dir, { recursive: true });
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}.${p2(d.getMinutes())}.${p2(d.getSeconds())}`;
  let file = path.join(dir, `${stamp} ${safe(label)}.${PROJECT_EXTENSION}`);
  for (let n = 2; existsSync(file); n++) file = path.join(dir, `${stamp} ${safe(label)} ${n}.${PROJECT_EXTENSION}`);
  saveProjectFile(file, project);
  return { file, name: path.basename(file, `.${PROJECT_EXTENSION}`) };
}

export function listVersions(projectPath: string): { file: string; name: string; savedAt: number }[] {
  const dir = versionsDir(projectPath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(`.${PROJECT_EXTENSION}`))
    .map((f) => {
      const file = path.join(dir, f);
      return { file, name: path.basename(f, `.${PROJECT_EXTENSION}`), savedAt: statSync(file).mtimeMs };
    })
    .sort((a, b) => b.savedAt - a.savedAt);
}

export function loadVersion(projectPath: string, file: string) {
  // Only files in this project's versions folder.
  if (path.dirname(path.resolve(file)) !== path.resolve(versionsDir(projectPath))) throw new Error('Not a version of this project.');
  return loadProjectFile(file);
}
