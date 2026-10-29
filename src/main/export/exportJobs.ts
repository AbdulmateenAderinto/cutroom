/**
 * One export at a time, shared by the Export dialog and AI control.
 */
import type { Project } from '../../shared/model';
import type { ExportSettings } from '../../shared/exportPlan';
import { type ExportProgress, type ExportResult, runExport } from './exportRunner';

export interface JobState {
  outputPath: string;
  startedAt: number;
  progress: ExportProgress | null;
  result: ExportResult | null;
  startedBy: 'user' | 'ai';
}

let abort: AbortController | null = null;
let last: JobState | null = null;

export function exportRunning() {
  return abort !== null;
}

export function lastExport(): JobState | null {
  return last;
}

export function cancelExport() {
  abort?.abort();
}

export async function startExport(
  project: Project,
  settings: ExportSettings,
  startedBy: JobState['startedBy'],
  onProgress?: (p: ExportProgress) => void,
): Promise<ExportResult> {
  if (abort) return { status: 'failed', message: 'An export is already running. Wait for it to finish or cancel it.', details: '' };
  abort = new AbortController();
  const job: JobState = { outputPath: settings.outputPath, startedAt: Date.now(), progress: null, result: null, startedBy };
  last = job;
  try {
    job.result = await runExport(project, settings, {
      signal: abort.signal,
      onProgress: (p) => {
        job.progress = p;
        onProgress?.(p);
      },
    });
    return job.result;
  } finally {
    abort = null;
  }
}
