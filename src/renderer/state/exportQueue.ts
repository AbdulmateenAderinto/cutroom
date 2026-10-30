/**
 * Export queue: exports set up now and rendered one after another (each with the project as it was
 * when queued). The main process runs one export at a time; if another export (the Export dialog,
 * AI control) is running when the next item is due, the queue waits and tries again.
 */
import type { ExportProgress, ExportResult } from '../../preload/api';
import type { ExportSettings } from '../../shared/exportPlan';
import type { Project } from '../../shared/model';
import { store, toast } from './store';

export interface QueueItem {
  id: number;
  project: Project;
  settings: ExportSettings;
  status: 'waiting' | 'running' | 'done' | 'failed' | 'cancelled';
  progress?: ExportProgress;
  result?: ExportResult;
}

let nextId = 1;
let retry: ReturnType<typeof setTimeout> | null = null;
let offProgress: (() => void) | null = null;

const items = () => store.get().exportQueue;
function patch(id: number, p: Partial<QueueItem>) {
  store.set((s) => ({ exportQueue: s.exportQueue.map((q) => (q.id === id ? { ...q, ...p } : q)) }));
}

/** Add an export to the queue; refuses a file another queued export will write. */
export function queueExport(project: Project, settings: ExportSettings, by = ''): { id: number } | { error: string } {
  if (items().some((q) => (q.status === 'waiting' || q.status === 'running') && q.settings.outputPath === settings.outputPath)) {
    const error = 'Another export in the queue writes that file. Choose a different file name.';
    toast(error, 'error');
    return { error };
  }
  const id = nextId++;
  store.set((s) => ({ exportQueue: [...s.exportQueue, { id, project, settings, status: 'waiting' }] }));
  toast(`${by}Queued “${settings.outputPath.split(/[\\/]/).pop()}”.`);
  void runQueue();
  return { id };
}

export function queueRunning(): boolean {
  return items().some((q) => q.status === 'running');
}

async function runQueue() {
  if (queueRunning()) return;
  const next = items().find((q) => q.status === 'waiting');
  if (!next) return;
  if (retry) clearTimeout(retry);
  retry = null;
  patch(next.id, { status: 'running', progress: undefined });
  offProgress ??= window.cutroom.onExportProgress((p) => {
    const run = items().find((q) => q.status === 'running');
    if (run) patch(run.id, { progress: p });
  });
  const result = await window.cutroom.startExport(next.project, next.settings);
  if (result.status === 'failed' && /already running/i.test(result.message)) {
    // Another export holds the encoder: wait for it.
    patch(next.id, { status: 'waiting', progress: undefined });
    retry = setTimeout(() => void runQueue(), 2000);
    return;
  }
  patch(next.id, { status: result.status, result });
  const name = next.settings.outputPath.split(/[\\/]/).pop();
  if (result.status === 'failed') toast(`Queued export “${name}” failed: ${result.message}`, 'error');
  void runQueue();
}

/** Cancel the running export, or take a waiting one off the queue. */
export function cancelQueued(id: number) {
  const q = items().find((x) => x.id === id);
  if (!q) return;
  if (q.status === 'running') void window.cutroom.cancelExport();
  else if (q.status === 'waiting') patch(id, { status: 'cancelled' });
}

export function clearFinished() {
  store.set((s) => ({ exportQueue: s.exportQueue.filter((q) => q.status === 'waiting' || q.status === 'running') }));
}
