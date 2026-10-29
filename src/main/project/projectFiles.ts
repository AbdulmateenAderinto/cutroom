/**
 * Safe project saving and loading.
 *
 * Save: write to a temporary file in the same folder, flush it to disk, then rename it over the
 * target. A rename within one folder is atomic, so a crash leaves either the old or the new
 * project — never a half-written one.
 *
 * Load: media paths are resolved by absolute path first, then relative to the project file
 * (so a project folder can be moved or copied to another Mac). Unresolvable media is reported
 * as missing so the UI can offer Relink.
 */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import type { Project } from '../../shared/model';
import { parseProject, serializeProject } from '../../shared/serialize';

export function writeFileAtomic(target: string, contents: string): void {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, target);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
}

/** Adds relative media paths (relative to the project file) before writing. */
export function saveProjectFile(file: string, project: Project): void {
  const dir = path.dirname(file);
  const withRel: Project = {
    ...project,
    media: project.media.map((m) => ({ ...m, relativePath: path.relative(dir, m.path).split(path.sep).join('/') })),
  };
  writeFileAtomic(file, serializeProject(withRel));
}

export interface LoadedProject {
  project: Project;
  missingMediaIds: string[];
}

export function loadProjectFile(file: string): LoadedProject {
  const project = parseProject(readFileSync(file, 'utf8'));
  const dir = path.dirname(file);
  const missingMediaIds: string[] = [];
  const media = project.media.map((m) => {
    if (existsSync(m.path)) return m;
    if (m.relativePath) {
      const candidate = path.resolve(dir, m.relativePath);
      if (existsSync(candidate)) return { ...m, path: candidate };
    }
    missingMediaIds.push(m.id);
    return m;
  });
  return { project: { ...project, media }, missingMediaIds };
}
