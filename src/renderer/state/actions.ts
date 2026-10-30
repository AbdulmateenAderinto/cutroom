/**
 * User-level actions shared by buttons, menus and keyboard shortcuts.
 */
import type { AudioClip, MediaRef, OverlayClip, Project, TitleClip, TrackItem } from '../../shared/model';
import { createProject, evenDim, findMedia, layoutSequence, newId, sourceAt } from '../../shared/model';
import * as ops from '../../shared/ops';
import {
  addAudioClip, addAudioTrack, audioClipEnd, deleteAudioClip, detachAudio as detachAudioOp, findAudioClip, mediaNeedingSpeechAnalysis, moveAudioClip,
  removeAudioTrack, setSpeech, soundFromSilence, splitAudioClip, updateAudioClip,
} from '../../shared/audio';
import { type TitlePreset, addTitle, deleteTitle, duplicateTitle, findTitle, moveTitle, splitTitle, updateTitle } from '../../shared/titles';
import { addMarker, deleteMarker } from '../../shared/markers';
import {
  type PipCorner, addOverlay, deleteOverlay, duplicateOverlay, findOverlay, moveOverlay, overlayEnd, pasteOverlay, splitOverlay, trimOverlay,
} from '../../shared/overlays';
import { clipLayout } from '../../shared/overlays';
import { TICKS_PER_SECOND, type Ticks, formatDuration, formatTimecode, snapToFrame, frameDuration, secondsToTicks, ticksToSeconds } from '../../shared/time';
import { engine } from '../preview/engine';
import { needsProxy, proxySource } from '../preview/mediaUrl';
import { playhead } from './playhead';
import { commit, isDirty, loadProject, redo, selectedItemIds, store, toast, undo } from './store';

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
    // HDR video is tone-mapped to SDR by default (it is edited and exported as SDR BT.709).
    added.push({ id: newId('media'), name, path: fresh[i], info: r.info, warnings: r.warnings, ...(r.info.isHDR ? { input: { toneMap: true } } : {}) });
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

// ---------------------------------------------------------------------------------------------
// Preview copies (formats the preview can't play directly; the export uses the originals)

function setProxy(id: string, v: ReturnType<typeof store.get>['proxies'][string]) {
  store.set((st) => ({ proxies: { ...st.proxies, [id]: v } }));
}

/** Start making preview copies for media that need one (cached by the app, so quick when already made). */
export function ensureProxies() {
  const s = store.get();
  for (const m of s.project.media) {
    if (!needsProxy(m) || s.missing[m.id]) continue;
    const source = proxySource(m);
    const cur = s.proxies[m.id];
    if (cur && cur.source === source && cur.status !== 'failed') continue;
    if (cur?.status === 'failed' && cur.source === source) continue; // don't retry in a loop
    setProxy(m.id, { source, status: 'making', fraction: 0 });
    void api().makeProxy(m.path, m.info, m.input).then((r) => {
      if (store.get().proxies[m.id]?.source !== source) return; // relinked or changed meanwhile
      setProxy(m.id, r.ok ? { source, status: 'ready', path: r.path } : { source, status: 'failed', error: r.error });
      if (!r.ok) toast(`Could not prepare a preview of ${m.name}: ${r.error}. Export still uses the original.`, 'error');
    });
  }
}

/** Progress events from the main process (by file path). */
export function proxyProgress(path: string, fraction: number) {
  const s = store.get();
  for (const m of s.project.media) {
    const p = s.proxies[m.id];
    if (m.path === path && p?.status === 'making') setProxy(m.id, { ...p, fraction });
  }
}

// ---------------------------------------------------------------------------------------------
// Keyboard-first editing: trim to playhead, jump between cuts, select, move, copy/paste

/** Q / W: trim the start / end of the clip under the playhead to the playhead (ripple). */
export function trimToPlayhead(edge: 'start' | 'end') {
  const t = playhead.get().time;
  const sel = store.get().selection;
  const ov = sel?.kind === 'overlay' ? findOverlay(store.get().project, sel.id) : undefined;
  if (ov && t > ov.start && t < overlayEnd(ov)) {
    // A selected overlay clip is trimmed in place (its other edge stays put).
    commit((p) => trimOverlay(p, ov.id, edge, edge === 'start' ? t - ov.start : t - overlayEnd(ov)));
    return;
  }
  const lay = layoutSequence(store.get().project);
  const l = lay.items.find((x) => t > x.start && t < x.end) ?? lay.items.find((x) => t === x.start && edge === 'end');
  if (!l || l.item.kind !== 'clip') return toast('Put the playhead inside a clip first.');
  const id = l.item.id;
  if (edge === 'start') {
    commit((p) => ops.trimEdge(p, id, 'start', t - l.start), { selection: { kind: 'item', id } });
    engine.seek(l.start); // the clip now starts where the playhead was; stay on that frame
  } else {
    commit((p) => ops.trimEdge(p, id, 'end', t - l.end), { selection: { kind: 'item', id } });
  }
}

/** ↑ / ↓: jump to the previous / next cut (clip boundary, title or audio clip edge). */
export function jumpToEdit(dir: -1 | 1) {
  const p = store.get().project;
  const lay = layoutSequence(p);
  const pts = new Set<Ticks>([0, lay.duration]);
  for (const l of lay.items) pts.add(l.start).add(l.end);
  for (const tr of p.audioTracks ?? []) for (const c of tr.clips) pts.add(c.start).add(audioClipEnd(c));
  for (const ti of p.titles ?? []) pts.add(ti.start).add(ti.start + ti.duration);
  for (const o of p.overlays ?? []) pts.add(o.start).add(overlayEnd(o));
  for (const m of p.markers ?? []) pts.add(m.time);
  const t = playhead.get().time;
  const sorted = [...pts].filter((x) => x <= lay.duration).sort((a, b) => a - b);
  const target = dir > 0 ? sorted.find((x) => x > t) : [...sorted].reverse().find((x) => x < t);
  if (target !== undefined) engine.seek(Math.min(target, Math.max(0, lay.duration - frameDuration(p.frameRate))));
}

/** ⌘A: select every clip on the main track. */
export function selectAllClips() {
  const ids = store.get().project.sequence.items.filter((i) => i.kind === 'clip').map((i) => i.id);
  if (ids.length) store.set({ selection: ids.length > 1 ? { kind: 'items', ids } : { kind: 'item', id: ids[0] } });
}

/**
 * Click on a main-track item with ⌘/Ctrl (add or remove it) or Shift (everything between the
 * selected item and this one).
 */
export function extendSelection(id: string, mode: 'toggle' | 'range') {
  const s = store.get();
  const cur = selectedItemIds(s.selection, s.project);
  let ids: string[];
  if (mode === 'toggle') ids = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  else {
    const order = s.project.sequence.items.map((i) => i.id);
    const anchor = cur.length ? order.indexOf(cur[0]) : order.indexOf(id);
    const to = order.indexOf(id);
    ids = order.slice(Math.min(anchor, to), Math.max(anchor, to) + 1);
  }
  store.set({ selection: ids.length > 1 ? { kind: 'items', ids } : ids.length ? { kind: 'item', id: ids[0] } : null, previewMediaId: null });
}

/** X: select the video-track clip under the playhead. */
export function selectAtPlayhead() {
  const t = playhead.get().time;
  const l = layoutSequence(store.get().project).items.find((x) => t >= x.start && t < x.end);
  if (l) store.set({ selection: { kind: 'item', id: l.item.id } });
}

/** ⌥← / ⌥→: move the selected clip one place earlier/later (titles and audio clips: one frame). */
export function moveSelected(dir: -1 | 1) {
  const sel = store.get().selection;
  const p = store.get().project;
  const f = frameDuration(p.frameRate);
  if (sel?.kind === 'item') {
    const from = p.sequence.items.findIndex((i) => i.id === sel.id);
    if (from < 0) return;
    if ((dir < 0 && from === 0) || (dir > 0 && from === p.sequence.items.length - 1)) return;
    commit((q) => ops.moveItem(q, sel.id, dir < 0 ? from - 1 : from + 2));
  } else if (sel?.kind === 'title') {
    const t = findTitle(p, sel.id);
    if (t) commit((q) => moveTitle(q, sel.id, Math.max(0, t.start + dir * f)));
  } else if (sel?.kind === 'audio') {
    const hit = findAudioClip(p, sel.id);
    if (hit) commit((q) => moveAudioClip(q, sel.id, Math.max(0, hit.clip.start + dir * f)));
  } else if (sel?.kind === 'overlay') {
    const o = findOverlay(p, sel.id);
    if (o) commit((q) => moveOverlay(q, sel.id, Math.max(0, o.start + dir * f)));
  }
}

type Clip =
  | { kind: 'items'; items: TrackItem[] }
  | { kind: 'title'; title: TitleClip }
  | { kind: 'audio'; clip: AudioClip; trackId: string }
  | { kind: 'overlay'; clip: OverlayClip };
let clipboard: Clip | null = null;

/** ⌘C: copy the selected clip, title or audio clip (Cutroom's own clipboard). */
export function copySelection(): boolean {
  const sel = store.get().selection;
  const p = store.get().project;
  if (sel?.kind === 'item' || sel?.kind === 'items') {
    const ids = new Set(selectedItemIds(sel, p));
    const items = p.sequence.items.filter((i) => ids.has(i.id));
    if (items.length) clipboard = { kind: 'items', items: structuredClone(items) };
  } else if (sel?.kind === 'title') {
    const t = findTitle(p, sel.id);
    if (t) clipboard = { kind: 'title', title: structuredClone(t) };
  } else if (sel?.kind === 'audio') {
    const hit = findAudioClip(p, sel.id);
    if (hit) clipboard = { kind: 'audio', clip: structuredClone(hit.clip), trackId: hit.track.id };
  } else if (sel?.kind === 'overlay') {
    const o = findOverlay(p, sel.id);
    if (o) clipboard = { kind: 'overlay', clip: structuredClone(o) };
  } else return false;
  return true;
}

/** ⌘X: copy, then delete (closing the gap). */
export function cutSelection() {
  if (copySelection()) deleteSelected('close-gap');
}

/** ⌘V: paste at the playhead (a clip is inserted there, splitting the clip under the playhead). */
export function pasteAtPlayhead(): boolean {
  const c = clipboard;
  if (!c) return false;
  const t = playhead.get().time;
  const p = store.get().project;
  if (c.kind === 'items') {
    const r = ops.insertAt(p, c.items, t);
    if (!r.ids.length) {
      toast('The copied clip’s media is not in this project.');
      return true;
    }
    commit(() => r.project, { selection: r.ids.length > 1 ? { kind: 'items', ids: r.ids } : { kind: 'item', id: r.ids[0] } });
  } else if (c.kind === 'title') {
    const r = addTitle(p, t, { text: c.title.text, duration: c.title.duration, style: c.title.style });
    commit(() => updateTitle(r.project, r.id, (x) => ({ ...x, animIn: c.title.animIn, animOut: c.title.animOut, animLength: c.title.animLength })), { selection: { kind: 'title', id: r.id } });
  } else if (c.kind === 'overlay') {
    const r = pasteOverlay(p, c.clip, t);
    if (!r) {
      toast('The copied clip’s media is not in this project.');
      return true;
    }
    commit(() => r.project, { selection: { kind: 'overlay', id: r.id } });
  } else {
    const r = addAudioClip(p, c.clip.mediaId, t, (p.audioTracks ?? []).some((x) => x.id === c.trackId) ? c.trackId : undefined);
    if (!r) {
      toast('The copied audio’s media is not in this project.');
      return true;
    }
    let next = updateAudioClip(r.project, r.clipId, (x) => ({ ...x, sourceIn: c.clip.sourceIn, sourceOut: c.clip.sourceOut, volume: c.clip.volume, fadeIn: c.clip.fadeIn, fadeOut: c.clip.fadeOut }));
    next = moveAudioClip(next, r.clipId, t);
    commit(() => next, { selection: { kind: 'audio', id: r.clipId } });
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// In/out marks (export a range)

export function markIn() {
  const t = playhead.get().time;
  const { out } = store.get().marks;
  store.set({ marks: { in: t, out: out !== null && out <= t ? null : out } });
}
export function markOut() {
  const t = playhead.get().time;
  const { in: i } = store.get().marks;
  store.set({ marks: { in: i !== null && i >= t ? null : i, out: t } });
}
export function clearMarks() {
  store.set({ marks: { in: null, out: null } });
}
/** The marked range, or null when nothing is marked. */
export function markedRange(): { start: Ticks; end: Ticks } | null {
  const { in: i, out } = store.get().marks;
  if (i === null && out === null) return null;
  const dur = layoutSequence(store.get().project).duration;
  return { start: i ?? 0, end: Math.min(out ?? dur, dur) };
}

/** Add a title at the playhead (on the lowest free text row) and select it. */
export function addTitleAction(preset: TitlePreset = 'title') {
  const r = addTitle(store.get().project, playhead.get().time, { preset });
  commit(() => r.project, { selection: { kind: 'title', id: r.id } });
}

/** Put a clip's sound on an audio track (for J/L-cuts); the clip is muted. */
export function detachAudio(clipId: string) {
  const r = detachAudioOp(store.get().project, clipId);
  if ('error' in r) return toast(r.error, 'warn');
  commit(() => r.project, { selection: { kind: 'audio', id: r.audioClipId } });
  const track = findAudioClip(store.get().project, r.audioClipId)?.track;
  toast(`Sound moved to “${track?.name}”. Drag its edges past the picture's for a J- or L-cut.`);
}

/** Stepped speed ramp on a main-track clip; the parts are selected afterwards. */
export function rampSelected(clipId: string, from: number, to: number, steps = 8) {
  const r = ops.speedRamp(store.get().project, clipId, from, to, steps);
  if ('error' in r) return toast(r.error, 'warn');
  commit(() => r.project, { selection: { kind: 'items', ids: r.ids } });
}

const setWorking = (key: string, on: boolean) =>
  store.set((s) => ({ working: on ? [...s.working, key] : s.working.filter((k) => k !== key) }));

async function importDerived(path: string, name: string, derived: MediaRef['derived']): Promise<MediaRef | null> {
  const r = await api().probeMedia(path);
  if (!r.ok) {
    toast(`Could not read the new file: ${r.error}`, 'error');
    return null;
  }
  return { id: newId('media'), name, path, info: r.info, warnings: r.warnings, derived };
}

/**
 * ⇧F: freeze the frame at the playhead for 2 s (a still inserted there; the clip is split). The
 * still is saved next to the project file (or in the app's data folder until the project is saved).
 */
export async function freezeFrameAtPlayhead(duration: Ticks = 2 * TICKS_PER_SECOND): Promise<{ clipId: string; mediaId: string } | { error: string }> {
  const p0 = store.get().project;
  const t = snapToFrame(playhead.get().time, p0.frameRate, 'floor');
  const l = layoutSequence(p0).items.find((x) => t >= x.start && t < x.end);
  const fail = (error: string) => {
    toast(error, 'warn');
    return { error };
  };
  if (!l || l.item.kind !== 'clip') return fail('Put the playhead on a video clip first.');
  const m = findMedia(p0, l.item.mediaId);
  if (!m || m.info.kind !== 'video') return fail('Freeze frame works on video clips (a photo is already still).');
  if (store.get().missing[m.id]) return fail(`${m.name} is offline; relink it first.`);
  const at = sourceAt(l.item, l.start, t);
  setWorking('freeze', true);
  try {
    const r = await api().freezeFrame(m.path, m.info, at, store.get().projectPath);
    if (!r.ok) return fail(`Could not make the freeze frame: ${r.error}`);
    const ref = await importDerived(r.path, `${m.name} — frame ${formatTimecode(at, m.info.frameRate)}`, { kind: 'freeze', mediaId: m.id, sourceIn: at, sourceOut: at });
    if (!ref) return { error: 'unreadable' };
    const ins = ops.insertFreezeFrame(ops.addMedia(store.get().project, [ref]), ref, t, duration);
    if (!ins) return fail('The clip changed while the frame was being made; try again.');
    commit(() => ins.project, { selection: { kind: 'item', id: ins.id } });
    loadThumbnail(ref);
    if (!store.get().projectPath) toast('Freeze frame added. It is kept in the app’s data folder until you save the project (then new ones go next to it, in “Cutroom Media”).');
    return { clipId: ins.id, mediaId: ref.id };
  } finally {
    setWorking('freeze', false);
  }
}

/**
 * Play a clip backwards: a reversed copy of the footage it uses is made (re-encoded at high
 * quality) and the clip switches to it. On a reversed clip, switches back to the original.
 */
export async function reverseClip(clipId: string): Promise<{ mediaId: string } | { error: string }> {
  const p0 = store.get().project;
  const fail = (error: string) => {
    toast(error, 'warn');
    return { error };
  };
  const l = clipLayout(p0, clipId);
  if (!l || l.item.kind !== 'clip') return fail('Select a video clip first.');
  const clip = l.item;
  const back = ops.unreverse(p0, clipId);
  if (back) {
    commit(() => back);
    return { mediaId: (clipLayout(back, clipId)!.item as { mediaId: string }).mediaId };
  }
  const m = findMedia(p0, clip.mediaId);
  if (!m || m.info.kind !== 'video') return fail('Only video clips can be reversed.');
  if (store.get().missing[m.id]) return fail(`${m.name} is offline; relink it first.`);
  const key = `reverse:${clipId}`;
  if (store.get().working.includes(key)) return { error: 'already reversing' };
  setWorking(key, true);
  toast(`Reversing ${formatDuration(clip.sourceOut - clip.sourceIn)} of ${m.name}…`);
  try {
    const r = await api().reverseClip(m.path, m.info, clip.sourceIn, clip.sourceOut, store.get().projectPath);
    if (!r.ok) return fail(`Could not reverse the clip: ${r.error}`);
    const ref = await importDerived(r.path, `${m.name} (reversed)`, { kind: 'reverse', mediaId: m.id, sourceIn: clip.sourceIn, sourceOut: clip.sourceOut });
    if (!ref) return { error: 'unreadable' };
    const now = clipLayout(store.get().project, clipId);
    const same = now?.item.kind === 'clip' && now.item.mediaId === clip.mediaId && now.item.sourceIn === clip.sourceIn && now.item.sourceOut === clip.sourceOut;
    if (!same) {
      commit((p) => ops.addMedia(p, [ref]));
      return fail('The clip changed while it was being reversed; the reversed copy was added to the Media panel.');
    }
    commit((p) => ops.useReversed(ops.addMedia(p, [ref]), clipId, ref));
    loadThumbnail(ref);
    toast('Reversed. (Undo, or “Play forwards again”, returns to the original.)');
    return { mediaId: ref.id };
  } finally {
    setWorking(key, false);
  }
}

/** Change a media file's input transform (HDR tone mapping, LUT); a new preview copy is made. */
export function setMediaInput(mediaId: string, patch: Partial<NonNullable<MediaRef['input']>>) {
  commit((p) => ops.setMediaInput(p, mediaId, patch));
  ensureProxies();
}

export async function chooseLut(mediaId: string) {
  const r = await api().pickLut();
  if (!r) return;
  if (!r.ok) return toast(`Could not use that LUT: ${r.error}`, 'error');
  setMediaInput(mediaId, { lut: r.lut });
  toast(`LUT “${r.lut.name}” applied. A preview copy with it is being made.`);
}

/** Measure a file's background noise level and store it with the noise reduction setting. */
export async function measureNoiseFloor(mediaId: string, apply: (p: Project, nf: number) => Project) {
  const m = findMedia(store.get().project, mediaId);
  if (!m || store.get().working.includes(`noise:${mediaId}`)) return;
  setWorking(`noise:${mediaId}`, true);
  try {
    const nf = await api().noiseFloor(m.path);
    // Analysis data: applied to the current state (no extra undo step).
    store.set((s) => ({ project: apply(s.project, nf ?? -50) }));
  } finally {
    setWorking(`noise:${mediaId}`, false);
  }
}

let auditionEl: HTMLAudioElement | null = null;
/** Render 5 s from the playhead through the export and play it (to hear export-only sound processing). */
export async function listenToExport(seconds = 5) {
  const s = store.get();
  const dur = layoutSequence(s.project).duration;
  const start = Math.max(0, Math.min(playhead.get().time, dur - secondsToTicks(seconds)));
  if (dur <= 0) return toast('The timeline is empty.');
  setWorking('audition', true);
  try {
    const r = await api().audition(s.project, start, Math.min(seconds, ticksToSeconds(dur)));
    if (!r.ok) return toast(`Could not render the sound: ${r.error}`, 'error');
    engine.pause();
    auditionEl?.pause();
    auditionEl = new Audio(api().mediaUrl(r.path));
    void auditionEl.play().catch(() => {});
  } finally {
    setWorking('audition', false);
  }
}

/**
 * Stabilize a clip: a stabilized copy of the footage it uses is made (vid.stab, two passes) and the
 * clip switches to it. On a stabilized clip, switches back to the original.
 */
export async function stabilizeClip(clipId: string, strength = 0.5): Promise<{ mediaId: string } | { error: string }> {
  const p0 = store.get().project;
  const fail = (error: string) => {
    toast(error, 'warn');
    return { error };
  };
  const l = clipLayout(p0, clipId);
  if (!l || l.item.kind !== 'clip') return fail('Select a video clip first.');
  const clip = l.item;
  const m = findMedia(p0, clip.mediaId);
  if (m?.derived?.kind === 'stabilize') {
    const back = ops.unreverse(p0, clipId);
    if (back) {
      commit(() => back);
      return { mediaId: m.derived.mediaId };
    }
  }
  if (!m || m.info.kind !== 'video') return fail('Only video clips can be stabilized.');
  if (store.get().missing[m.id]) return fail(`${m.name} is offline; relink it first.`);
  const key = `stabilize:${clipId}`;
  if (store.get().working.includes(key)) return { error: 'already stabilizing' };
  setWorking(key, true);
  toast(`Stabilizing ${formatDuration(clip.sourceOut - clip.sourceIn)} of ${m.name}… (analysis, then a smoothed copy)`);
  try {
    const r = await api().stabilizeClip(m.path, m.info, clip.sourceIn, clip.sourceOut, strength, store.get().projectPath);
    if (!r.ok) return fail(`Could not stabilize the clip: ${r.error}`);
    const ref = await importDerived(r.path, `${m.name} (stabilized)`, { kind: 'stabilize', mediaId: m.id, sourceIn: clip.sourceIn, sourceOut: clip.sourceOut });
    if (!ref) return { error: 'unreadable' };
    const now = clipLayout(store.get().project, clipId);
    const same = now?.item.kind === 'clip' && now.item.mediaId === clip.mediaId && now.item.sourceIn === clip.sourceIn && now.item.sourceOut === clip.sourceOut;
    if (!same) {
      commit((p) => ops.addMedia(p, [ref]));
      return fail('The clip changed while it was being stabilized; the stabilized copy was added to the Media panel.');
    }
    commit((p) => ops.useStabilized(ops.addMedia(p, [ref]), clipId, ref));
    loadThumbnail(ref);
    toast('Stabilized. (Undo, or “Use original footage”, returns to the original.)');
    return { mediaId: ref.id };
  } finally {
    setWorking(key, false);
  }
}

/** M: add a marker at the playhead (or select the one already there). */
export function addMarkerAction() {
  const r = addMarker(store.get().project, playhead.get().time);
  if (r.existed) return void store.set({ selection: { kind: 'marker', id: r.id } });
  commit(() => r.project, { selection: { kind: 'marker', id: r.id } });
}

/** Add a video or photo on an overlay track at `at` (default: the playhead), as picture-in-picture. */
export function addOverlayAction(mediaId: string, at?: Ticks, opts: { row?: number; corner?: PipCorner } = {}) {
  const m = findMedia(store.get().project, mediaId);
  if (m?.info.kind === 'audio') return toast('Sound files go on an audio track; overlays are for video and photos.', 'warn');
  const r = addOverlay(store.get().project, mediaId, at ?? playhead.get().time, opts);
  if (!r) return toast('This file is too short to add (less than one frame).', 'warn');
  commit(() => r.project, { selection: { kind: 'overlay', id: r.id }, previewMediaId: null });
  engine.seek(playhead.get().time);
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
  const uses = s.project.sequence.items.filter((i) => i.kind === 'clip' && i.mediaId === mediaId).length +
    (s.project.overlays ?? []).filter((o) => o.mediaId === mediaId).length;
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
  if (sel?.kind === 'overlay') {
    const ro = splitOverlay(store.get().project, sel.id, playhead.get().time);
    if (!ro) return toast('Move the playhead inside the selected overlay clip to split it.');
    commit(() => ro.project, { selection: { kind: 'overlay', id: ro.rightId } });
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
  if (sel?.kind === 'overlay') return void commit((p) => deleteOverlay(p, sel.id), { selection: null });
  if (sel?.kind === 'marker') return void commit((p) => deleteMarker(p, sel.id), { selection: null });
  if (sel?.kind === 'audioTrack') {
    const t = store.get().project.audioTracks?.find((x) => x.id === sel.id);
    if (t && t.clips.length && !confirm(`Delete the track “${t.name}” and its ${t.clips.length} clip(s)?`)) return;
    return void commit((p) => removeAudioTrack(p, sel.id), { selection: null });
  }
  if (sel?.kind === 'items') {
    const ids = selectedItemIds(sel, store.get().project);
    return void commit((p) => ops.deleteItems(p, ids, mode), { selection: null });
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
  if (sel?.kind === 'overlay') {
    const r = duplicateOverlay(store.get().project, sel.id);
    if (r) commit(() => r.project, { selection: { kind: 'overlay', id: r.id } });
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
