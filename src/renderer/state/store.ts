/**
 * UI state: a tiny observable store (no library) plus the actions the UI calls.
 *
 * Undo/redo: the project is immutable, so history is just a list of previous project snapshots
 * (unchanged parts are shared between snapshots, so this is cheap).
 * Drags (trim, reorder, framing) use begin/update/end "gestures" so a whole drag is one undo step.
 */
import { useSyncExternalStore } from 'react';
import type { FfmpegStatus } from '../../preload/api';
import { type Project, createProject } from '../../shared/model';

export type Selection = { kind: 'item'; id: string } | { kind: 'media'; id: string } | null;
export type DialogName = 'export' | 'shortcuts' | 'ai' | 'speech' | null;

export interface Toast {
  id: number;
  kind: 'info' | 'warn' | 'error';
  text: string;
}

export interface Review {
  clipId: string;
  kind: 'silence' | 'scenes' | 'fillers';
  ranges: { start: number; end: number }[]; // source ticks (silence, fillers)
  times: number[]; // source ticks (scene changes)
}

export interface AppState {
  project: Project;
  projectPath: string | null;
  savedProject: Project; // compare by identity to know if there are unsaved changes
  past: Project[];
  future: Project[];
  selection: Selection;
  snapping: boolean;
  pxPerSecond: number;
  previewMediaId: string | null; // non-null while previewing a source file instead of the timeline
  thumbs: Record<string, string>;
  missing: Record<string, boolean>;
  importing: string[]; // names of files being inspected
  toasts: Toast[];
  dialog: DialogName;
  ffmpeg: FfmpegStatus | null;
  /** Detected ranges/times awaiting review in the Smart tools section (source time). */
  review: Review | null;
  /** Transcription progress per media id (0..1). */
  transcribing: Record<string, number>;
  /** Transient visual offset while trimming a clip's start (see Timeline). */
  trimPreview: { id: string; offset: number } | null;
}

type Listener = () => void;

function createStore<T>(initial: T) {
  let state = initial;
  const listeners = new Set<Listener>();
  return {
    get: () => state,
    set(patch: Partial<T> | ((s: T) => Partial<T>)) {
      const p = typeof patch === 'function' ? (patch as (s: T) => Partial<T>)(state) : patch;
      state = { ...state, ...p };
      listeners.forEach((l) => l());
    },
    subscribe(l: Listener) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
}

const initialProject = createProject();

export const store = createStore<AppState>({
  project: initialProject,
  projectPath: null,
  savedProject: initialProject,
  past: [],
  future: [],
  selection: null,
  snapping: true,
  pxPerSecond: 60,
  previewMediaId: null,
  thumbs: {},
  missing: {},
  importing: [],
  toasts: [],
  dialog: null,
  ffmpeg: null,
  trimPreview: null,
  review: null,
  transcribing: {},
});

export function useStore<R>(selector: (s: AppState) => R): R {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()));
}

export const isDirty = (s: AppState) => s.project !== s.savedProject;

// ---------------------------------------------------------------------------------------------
// History

const HISTORY_LIMIT = 200;
let gestureBase: Project | null = null;

/** Apply an edit as one undoable step. Returns false if nothing changed. */
export function commit(edit: (p: Project) => Project, extra: Partial<AppState> = {}): boolean {
  const s = store.get();
  const next = edit(s.project);
  if (next === s.project) {
    if (Object.keys(extra).length) store.set(extra);
    return false;
  }
  store.set({ project: next, past: [...s.past, s.project].slice(-HISTORY_LIMIT), future: [], ...extra });
  return true;
}

export function gestureActive(): boolean {
  return gestureBase !== null;
}

export function beginGesture() {
  gestureBase = store.get().project;
}

/** During a drag: recompute from the state at drag start, without adding history. */
export function updateGesture(edit: (base: Project) => Project, extra: Partial<AppState> = {}) {
  if (!gestureBase) return;
  store.set({ project: edit(gestureBase), ...extra });
}

export function endGesture(extra: Partial<AppState> = {}) {
  const base = gestureBase;
  gestureBase = null;
  const s = store.get();
  if (base && s.project !== base) {
    store.set({ past: [...s.past, base].slice(-HISTORY_LIMIT), future: [], ...extra });
  } else store.set(extra);
}

export function undo() {
  const s = store.get();
  const prev = s.past[s.past.length - 1];
  if (!prev) return;
  store.set({ project: prev, past: s.past.slice(0, -1), future: [s.project, ...s.future], selection: validSelection(prev, s.selection) });
}

export function redo() {
  const s = store.get();
  const next = s.future[0];
  if (!next) return;
  store.set({ project: next, past: [...s.past, s.project], future: s.future.slice(1), selection: validSelection(next, s.selection) });
}

function validSelection(p: Project, sel: Selection): Selection {
  if (!sel) return null;
  if (sel.kind === 'item') return p.sequence.items.some((i) => i.id === sel.id) ? sel : null;
  return p.media.some((m) => m.id === sel.id) ? sel : null;
}

/** Replace the whole project (new/open/recover). Clears history. */
export function loadProject(project: Project, projectPath: string | null, opts: { missing?: string[]; savedClean?: boolean } = {}) {
  const missing: Record<string, boolean> = {};
  for (const id of opts.missing ?? []) missing[id] = true;
  const saved = opts.savedClean === false ? createProject() : project;
  store.set({
    project, projectPath, savedProject: saved, past: [], future: [], selection: null,
    previewMediaId: null, missing, thumbs: {}, trimPreview: null, review: null,
  });
}

// ---------------------------------------------------------------------------------------------
// Toasts

let toastSeq = 0;
export function toast(text: string, kind: Toast['kind'] = 'info', ms = kind === 'error' ? 9000 : 4000) {
  const id = ++toastSeq;
  store.set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
  setTimeout(() => dismissToast(id), ms);
}

export function dismissToast(id: number) {
  store.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}
