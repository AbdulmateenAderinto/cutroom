/**
 * User-level actions shared by buttons, menus and keyboard shortcuts.
 */
import type { MediaRef, Project } from '../../shared/model';
import { createProject, evenDim, findMedia, layoutSequence, newId } from '../../shared/model';
import * as ops from '../../shared/ops';
import {
  addAudioClip, addAudioTrack, audioClipEnd, deleteAudioClip, findAudioClip, mediaNeedingSpeechAnalysis, moveAudioClip,
  removeAudioTrack, setSpeech, soundFromSilence, splitAudioClip, updateAudioClip,
} from '../../shared/audio';
import { type TitlePreset, addTitle, deleteTitle, duplicateTitle, splitTitle } from '../../shared/titles';
import { TICKS_PER_SECOND, frameDuration, secondsToTicks, ticksToSeconds } from '../../shared/time';
import { engine } from '../preview/engine';
import { playhead } from './playhead';
import { commit, isDirty, loadProject, redo, store, toast, undo } from './store';

const api = () => window.cutroom;

function selectedItemId(): string | null {
  const sel = store.get().selection;
  return sel?.kind === 'item' ? sel.id : null;
}

function inTextField(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

export function doUndo() {
  if (inTextField()) return void document.execCommand('undo');
  undo();
}

export function doRedo() {
  if (inTextField()) return void document.execCommand('redo');
  redo();
}

// ---------------------------------------------------------------------------------------------
// Media

export async function importFiles(paths: string[]) {
  const s = store.get();
  const existing = new Set(s.project.media.map((m) => m.path));
  const fresh = paths.filter((p) => {
    if (existing.has(p)) {
      toast(`${ops.basename(p)} is already in the project.`);
      return false;
    }
    return true;
  });
  if (!fresh.length) return;
  store.set((st) => ({ importing: [...st.importing, ...fresh.map(ops.basename)] }));
  // Inspect all files in parallel, then add them in the order they were chosen (one undo step).
  const results = await Promise.all(fresh.map((path) => api().probeMedia(path).catch((e) => ({ ok: false as const, error: String(e) }))));
  store.set((st) => ({ importing: st.importing.filter((n) => !fresh.map(ops.basename).includes(n)) }));
  const added: MediaRef[] = [];
  results.forEach((r, i) => {
    const name = ops.basename(fresh[i]);
    if (!r.ok) return toast(`Could not import ${name}: ${r.error}`, 'error');
    added.push({ id: newId('media'), name, path: fresh[i], info: r.info, warnings: r.warnings });
    if (r.warnings.length) toast(`${name}: ${r.warnings.join(' ')}`, 'warn', 8000);
  });
  if (!added.length) return;
  commit((p) => ops.addMedia(p, added));
  added.filter((m) => m.info.kind !== 'audio').forEach(loadThumbnail);
}

export function notify(text: string) {
  toast(text);
}

const waveLoading = new Set<string>();
export async function loadWaveform(mediaId: string) {
  const m = findMedia(store.get().project, mediaId);
  if (!m || !m.info.hasAudio || waveLoading.has(mediaId) || store.get().missing[mediaId]) return;
  waveLoading.add(mediaId);
  try {
    const peaks = await api().waveform(m.path);
    if (peaks) store.set((s) => ({ waves: { ...s.waves, [mediaId]: peaks } }));
  } finally {
    waveLoading.delete(mediaId);
  }
}

/** Add a title at the playhead (on the lowest free text row) and select it. */
export function addTitleAction(preset: TitlePreset = 'title') {
  const r = addTitle(store.get().project, playhead.get().time, { preset });
  commit(() => r.project, { selection: { kind: 'title', id: r.id } });
}

export function addAudioTrackAction() {
  const r = addAudioTrack(store.get().project);
  commit(() => r.project, { selection: { kind: 'audioTrack', id: r.trackId } });
}

/** Ducking needs to know where the video track has sound: analyse (locally) any media not yet analysed. */
export async function ensureSpeechAnalysis(): Promise<boolean> {
  const ids = mediaNeedingSpeechAnalysis(store.get().project);
  if (!ids.length) return true;
  toast(`Finding speech in ${ids.length} file${ids.length > 1 ? 's' : ''} so music can dip under it…`);
  for (const id of ids) {
    const m = findMedia(store.get().project, id);
    if (!m) continue;
    try {
      const silence = await api().detectSilence(m.path, ticksToSeconds(m.info.duration), { noiseDb: -35, minDuration: 0.3 });
      const speech = soundFromSilence(silence.map((x) => ({ start: secondsToTicks(x.start), end: secondsToTicks(x.end) })), m.info.duration);
      // Analysis data, not an edit: applied to the whole undo history so undo never loses it.
      store.set((st) => {
        const next = setSpeech(st.project, id, speech);
        return {
          project: next,
          savedProject: st.savedProject === st.project ? next : st.savedProject,
          past: st.past.map((x) => setSpeech(x, id, speech)),
          future: st.future.map((x) => setSpeech(x, id, speech)),
        };
      });
    } catch (e) {
      toast(`Could not analyse ${m.name}: ${(e as Error).message}`, 'error');
      return false;
    }
  }
  return true;
}

export async function loadThumbnail(media: MediaRef) {
  // Photos have a single frame; videos use a frame a little way in (first frames are often black).
  const at = media.info.kind === 'image' ? 0 : Math.min(1, ticksToSeconds(media.info.duration) * 0.1);
  const url = await api().thumbnail(media.path, at);
  if (url) store.set((s) => ({ thumbs: { ...s.thumbs, [media.id]: url } }));
}

export async function pickAndImport() {
  const paths = await api().pickMediaFiles();
  if (paths.length) await importFiles(paths);
}

export function addMediaToTimeline(mediaId: string, index?: number) {
  const m = findMedia(store.get().project, mediaId);
  if (m?.info.kind === 'audio') {
    // Music / voice-over goes on an audio track at the playhead.
    const r = addAudioClip(store.get().project, mediaId, playhead.get().time);
    if (!r) return toast('This file is too short to add.', 'warn');
    commit(() => r.project, { selection: { kind: 'audio', id: r.clipId }, previewMediaId: null });
    return;
  }
  const r = ops.addClip(store.get().project, mediaId, index);
  if (!r) return toast('This file is too short to add (less than one frame).', 'warn');
  commit(() => r.project, { selection: { kind: 'item', id: r.clipId }, previewMediaId: null });
}

export function removeMedia(mediaId: string) {
  const s = store.get();
  const m = findMedia(s.project, mediaId);
  const uses = s.project.sequence.items.filter((i) => i.kind === 'clip' && i.mediaId === mediaId).length;
  if (uses && !confirm(`Remove “${m?.name}”? ${uses} clip${uses > 1 ? 's' : ''} on the timeline use it and will be removed too. (The file on disk is not touched.)`)) return;
  commit((p) => ops.removeMedia(p, mediaId), { selection: null, previewMediaId: s.previewMediaId === mediaId ? null : s.previewMediaId });
}

export async function relink(mediaId: string) {
  const m = findMedia(store.get().project, mediaId);
  if (!m) return;
  const path = await api().pickRelinkFile(m.name);
  if (!path) return;
  const r = await api().probeMedia(path);
  if (!r.ok) return toast(`Could not use ${ops.basename(path)}: ${r.error}`, 'error');
  const notes: string[] = [];
  if (r.info.displayWidth !== m.info.displayWidth || r.info.displayHeight !== m.info.displayHeight) {
    notes.push(`size differs (${r.info.displayWidth}×${r.info.displayHeight} vs ${m.info.displayWidth}×${m.info.displayHeight})`);
  }
  if (Math.abs(r.info.duration - m.info.duration) > TICKS_PER_SECOND / 2) notes.push('duration differs');
  if (notes.length && !confirm(`The chosen file does not look like the original: ${notes.join(', ')}. Use it anyway? Clips will be kept within the new file's length.`)) return;
  commit((p) => ops.relinkMedia(p, mediaId, path, r.info, r.warnings));
  store.set((s) => ({ missing: { ...s.missing, [mediaId]: false } }));
  loadThumbnail({ ...m, path });
  toast(`Relinked ${m.name}.`);
}

// ---------------------------------------------------------------------------------------------
// Timeline editing

export function splitAtPlayhead() {
  const sel = store.get().selection;
  if (sel?.kind === 'title') {
    const rt = splitTitle(store.get().project, sel.id, playhead.get().time);
    if (!rt) return toast('Move the playhead inside the selected title to split it.');
    commit(() => rt.project, { selection: { kind: 'title', id: rt.rightId } });
    return;
  }
  if (sel?.kind === 'audio') {
    const ra = splitAudioClip(store.get().project, sel.id, playhead.get().time);
    if (!ra) return toast('Move the playhead inside the selected audio clip to split it.');
    commit(() => ra.project, { selection: { kind: 'audio', id: ra.rightId } });
    return;
  }
  const r = ops.splitAt(store.get().project, playhead.get().time);
  if (!r) return toast('Move the playhead inside a clip (not on its edge) to split it.');
  commit(() => r.project, { selection: { kind: 'item', id: r.rightId } });
}

export function deleteSelected(mode: ops.DeleteMode) {
  const sel = store.get().selection;
  if (sel?.kind === 'audio') return void commit((p) => deleteAudioClip(p, sel.id), { selection: null });
  if (sel?.kind === 'title') return void commit((p) => deleteTitle(p, sel.id), { selection: null });
  if (sel?.kind === 'audioTrack') {
    const t = store.get().project.audioTracks?.find((x) => x.id === sel.id);
    if (t && t.clips.length && !confirm(`Delete the track “${t.name}” and its ${t.clips.length} clip(s)?`)) return;
    return void commit((p) => removeAudioTrack(p, sel.id), { selection: null });
  }
  const id = selectedItemId();
  if (!id) return toast('Select a clip on the timeline first.');
  const items = store.get().project.sequence.items;
  const idx = items.findIndex((i) => i.id === id);
  commit((p) => ops.deleteItem(p, id, mode), { selection: null });
  const after = store.get().project.sequence.items;
  const nextSel = mode === 'close-gap' ? after[Math.min(idx, after.length - 1)] : undefined;
  if (nextSel) store.set({ selection: { kind: 'item', id: nextSel.id } });
}

export function duplicateSelected() {
  const sel = store.get().selection;
  if (sel?.kind === 'title') {
    const r = duplicateTitle(store.get().project, sel.id);
    if (r) commit(() => r.project, { selection: { kind: 'title', id: r.id } });
    return;
  }
  if (sel?.kind === 'audio') {
    const p = store.get().project;
    const hit = findAudioClip(p, sel.id);
    if (!hit) return;
    const r = addAudioClip(p, hit.clip.mediaId, audioClipEnd(hit.clip), hit.track.id);
    if (!r) return;
    let next = updateAudioClip(r.project, r.clipId, (c) => ({ ...c, sourceIn: hit.clip.sourceIn, sourceOut: hit.clip.sourceOut, volume: hit.clip.volume, fadeIn: hit.clip.fadeIn, fadeOut: hit.clip.fadeOut }));
    next = moveAudioClip(next, r.clipId, audioClipEnd(hit.clip));
    return void commit(() => next, { selection: { kind: 'audio', id: r.clipId } });
  }
  const id = selectedItemId();
  if (!id) return toast('Select a clip on the timeline first.');
  const r = ops.duplicateItem(store.get().project, id);
  if (r) commit(() => r.project, { selection: { kind: 'item', id: r.newId } });
}

// ---------------------------------------------------------------------------------------------
// Canvas

export function applyCanvasPreset(preset: Project['canvas']['preset'], custom?: { width: number; height: number }) {
  const p = store.get().project;
  let size: { width: number; height: number } | null = null;
  if (preset === 'match') {
    const sel = store.get().selection;
    const firstClip = p.sequence.items.find((i) => i.kind === 'clip');
    const mediaId = sel?.kind === 'media' ? sel.id : firstClip?.kind === 'clip' ? firstClip.mediaId : p.media[0]?.id;
    const m = mediaId ? findMedia(p, mediaId) : undefined;
    if (!m) return toast('Import a video first: “Match source” uses the first clip’s size.', 'warn');
    size = { width: evenDim(m.info.displayWidth), height: evenDim(m.info.displayHeight) };
  } else if (preset === 'custom') {
    size = custom ?? { width: p.canvas.width, height: p.canvas.height };
  } else {
    const def = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350] }[preset];
    size = { width: def[0], height: def[1] };
  }
  const width = Math.min(7680, evenDim(size.width));
  const height = Math.min(7680, evenDim(size.height));
  commit((pr) =>
    pr.canvas.width === width && pr.canvas.height === height && pr.canvas.preset === preset
      ? pr
      : ops.setCanvas(pr, { width, height, preset }),
  );
}

// ---------------------------------------------------------------------------------------------
// Project files

function confirmDiscard(): boolean {
  const s = store.get();
  if (!isDirty(s)) return true;
  if (!confirm('You have unsaved changes. Discard them?')) return false;
  api().clearRecovery(s.project.id).catch(() => {}); // discarded on purpose: don't offer it back later
  return true;
}

export function newProject() {
  if (!confirmDiscard()) return;
  engine.pause();
  loadProject(createProject(), null);
  playhead.set({ time: 0 });
}

export async function saveProject(saveAs = false): Promise<boolean> {
  const s = store.get();
  const r = await api().saveProject(s.project, saveAs ? null : s.projectPath);
  if (!r.ok) {
    if (!r.cancelled) toast(r.error ?? 'Could not save the project.', 'error');
    return false;
  }
  let saved = s.project;
  // Name an untitled project after its file the first time it's saved.
  const fileName = ops.basename(r.path).replace(/\.cutroom$/i, '');
  if (saved.name === 'Untitled' && fileName !== 'Untitled') {
    saved = { ...saved, name: fileName };
    await api().saveProject(saved, r.path);
  }
  // If the user kept editing while the dialog was open, keep their newer edits (still unsaved).
  const editedMeanwhile = store.get().project !== s.project;
  store.set(editedMeanwhile ? { projectPath: r.path, savedProject: saved } : { projectPath: r.path, savedProject: saved, project: saved });
  toast(`Saved ${ops.basename(r.path)}`);
  return true;
}

export async function openProject(path?: string) {
  if (!confirmDiscard()) return;
  const r = await api().openProject(path);
  if (!r.ok) {
    if (!r.cancelled) toast(r.error ?? 'Could not open the project.', 'error');
    return;
  }
  engine.pause();
  loadProject(r.project, r.path, { missing: r.missingMediaIds });
  playhead.set({ time: 0 });
  engine.seek(0);
  for (const m of r.project.media) if (!r.missingMediaIds.includes(m.id)) loadThumbnail(m);
  if (r.missingMediaIds.length) {
    toast(`${r.missingMediaIds.length} media file(s) could not be found. Use “Relink…” in the Media panel.`, 'warn', 10000);
  }
}

export async function recover(projectId: string) {
  const r = await api().loadRecovery(projectId);
  if (!r) return toast('That recovery file is no longer available.', 'error');
  loadProject(r.project, r.projectPath, { missing: r.missingMediaIds, savedClean: false });
  engine.seek(0);
  for (const m of r.project.media) if (!r.missingMediaIds.includes(m.id)) loadThumbnail(m);
  toast('Recovered unsaved work. Save it to keep it.', 'info', 7000);
}

// ---------------------------------------------------------------------------------------------
// Transport

export function seekToStart() {
  engine.seek(0);
}

export function seekToEnd() {
  engine.seek(Math.max(0, engine.duration - frameDuration(engine.project.frameRate)));
}

export function zoomBy(factor: number) {
  store.set((s) => ({ pxPerSecond: Math.max(2, Math.min(600, s.pxPerSecond * factor)) }));
}

export function zoomToFit(viewportPx: number) {
  const d = ticksToSeconds(layoutSequence(store.get().project).duration);
  if (d > 0) store.set({ pxPerSecond: Math.max(2, Math.min(600, (viewportPx - 80) / d)) });
}

// ---------------------------------------------------------------------------------------------
// Speech

export async function transcribeMedia(mediaId: string) {
  const m = findMedia(store.get().project, mediaId);
  if (!m || store.get().transcribing[mediaId] !== undefined) return;
  const st = await api().whisperStatus();
  if (!st.ready) {
    store.set({ dialog: 'speech' });
    return;
  }
  store.set((s) => ({ transcribing: { ...s.transcribing, [mediaId]: 0 } }));
  const off = api().onWhisperProgress((p) => {
    if (p.mediaId === mediaId) store.set((s) => ({ transcribing: { ...s.transcribing, [mediaId]: p.fraction } }));
  });
  try {
    const r = await api().transcribe(mediaId, m.path);
    if (!r.ok) return toast(`Transcription of ${m.name} failed: ${r.error}`, 'error');
    commit((p) => ops.setTranscript(p, mediaId, r.transcript));
    toast(r.transcript.words.length ? `Transcribed ${m.name}: ${r.transcript.words.length} words.` : `No speech found in ${m.name}.`);
  } finally {
    off();
    store.set((s) => {
      const { [mediaId]: _done, ...rest } = s.transcribing;
      return { transcribing: rest };
    });
  }
}
