/**
 * Autosave for crash recovery. The renderer periodically sends unsaved projects here; they are
 * written (atomically) to <userData>/recovery/<projectId>.json and removed after a normal save
 * or an explicit discard. On launch, leftover files mean the app did not close cleanly.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { Project } from '../../shared/model';
import { parseProject, serializeProject } from '../../shared/serialize';
import { writeFileAtomic } from './projectFiles';

export interface RecoveryEntry {
  projectId: string;
  projectName: string;
  projectPath: string | null;
  savedAt: string;
}

const safeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '');

export class RecoveryStore {
  constructor(private dir: string) {}

  private file(id: string) {
    return path.join(this.dir, `${safeId(id)}.json`);
  }

  write(project: Project, projectPath: string | null) {
    mkdirSync(this.dir, { recursive: true });
    const payload = JSON.stringify({ savedAt: new Date().toISOString(), projectPath, project: JSON.parse(serializeProject(project)) });
    writeFileAtomic(this.file(project.id), payload);
  }

  clear(id: string) {
    const f = this.file(id);
    if (existsSync(f)) unlinkSync(f);
  }

  list(): RecoveryEntry[] {
    if (!existsSync(this.dir)) return [];
    const out: RecoveryEntry[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const data = JSON.parse(readFileSync(path.join(this.dir, name), 'utf8'));
        out.push({ projectId: data.project.id, projectName: data.project.name, projectPath: data.projectPath ?? null, savedAt: data.savedAt });
      } catch {
        // unreadable leftovers are ignored
      }
    }
    return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  load(id: string): { project: Project; projectPath: string | null } | null {
    const f = this.file(id);
    if (!existsSync(f)) return null;
    const data = JSON.parse(readFileSync(f, 'utf8'));
    return { project: parseProject(JSON.stringify(data.project)), projectPath: data.projectPath ?? null };
  }
}
