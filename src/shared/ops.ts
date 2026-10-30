/**
 * Pure editing operations. Each takes a Project and returns a new Project (never mutates),
 * which makes undo/redo a simple stack of snapshots.
 *
 * Timing rules (keep preview and export frame-identical):
 *   - clip.sourceIn sits on the SOURCE frame grid, so the first frame shown is unambiguous;
 *   - clip duration is a whole number of PROJECT frames, so every cut lands on a frame boundary;
 *   - clip.sourceOut = sourceIn + duration, never beyond the end of the media.
 */
import {
  type ClipItem,
  type Framing,
  type GapItem,
  type MediaRef,
  type Project,
  type TrackItem,
  type Transcript,
  type TransitionKind,
  DEFAULT_FRAMING,
  MAX_SPEED,
  MIN_SPEED,
  clipSpeed,
  findMedia,
  itemDuration,
  layoutSequence,
  newId,
  sourceAt,
  timelineAt,
} from './model';
import { type AnimProperty, type ClipAnimation, type Easing, clampAnimValue, removeKeyframeAt, upsertKeyframe } from './animation';
import { type CaptionSettings, DEFAULT_CAPTIONS } from './captions';
import { type ColorAdjust, NEUTRAL, isNeutral, legalColor } from './color';
import { asClip, fromClip, updateOverlay } from './overlays';
import { type AudioFx, NO_FX, legalFx } from './audioFx';
import { type ClipEffects, legalEffects } from './effects';
import { type Rational, type Ticks, frameDuration, snapToFrame } from './time';

function withItems(project: Project, items: TrackItem[]): Project {
  return { ...project, sequence: { ...project.sequence, items: normalizeGaps(items) } };
}

/** Merge neighbouring gaps and drop gaps at the end of the sequence (they would just be dead air). */
export function normalizeGaps(items: TrackItem[]): TrackItem[] {
  const out: TrackItem[] = [];
  for (const it of items) {
    const prev = out[out.length - 1];
    if (it.kind === 'gap' && it.duration <= 0) continue;
    if (it.kind === 'gap' && prev?.kind === 'gap') {
      out[out.length - 1] = { ...prev, duration: prev.duration + it.duration };
    } else out.push(it);
  }
  while (out.length && out[out.length - 1].kind === 'gap') out.pop();
  return out;
}

const snapProject = (t: Ticks, rate: Rational, mode: 'floor' | 'round' = 'round') => snapToFrame(t, rate, mode);
export const PHOTO_DEFAULT = 4 * 705_600_000;

/**
 * Compute a legal (sourceIn, sourceOut) pair.
 * anchor 'in'  — keep sourceIn where requested and fit the duration (used when trimming the end).
 * anchor 'out' — keep sourceOut where requested and move sourceIn (used when trimming the start).
 * With a speed other than 1, the TIMELINE duration (source length / speed) is what lands on the
 * project frame grid.
 */
export function legalRange(
  project: Project,
  media: MediaRef,
  sourceIn: Ticks,
  sourceOut: Ticks,
  anchor: 'in' | 'out',
  speed = 1,
): { sourceIn: Ticks; sourceOut: Ticks } {
  const pr = project.frameRate;
  const pf = frameDuration(pr);
  const sr = media.info.frameRate;
  const mediaDur = media.info.duration;
  const maxIn = Math.max(0, mediaDur - pf);
  let inT: Ticks;
  if (anchor === 'out') {
    const outLimit = Math.min(sourceOut, mediaDur);
    inT = snapToFrame(Math.min(Math.max(0, sourceIn), Math.max(0, outLimit - pf)), sr, 'round');
    if (inT > outLimit - pf) inT = snapToFrame(Math.max(0, outLimit - pf), sr, 'floor');
    sourceOut = outLimit;
  } else {
    inT = snapToFrame(Math.min(Math.max(0, sourceIn), maxIn), sr, 'round');
    if (inT > maxIn) inT = snapToFrame(maxIn, sr, 'floor');
  }
  if (speed === 1) {
    const available = snapProject(mediaDur - inT, pr, 'floor');
    let dur = snapProject(sourceOut - inT, pr, 'round');
    dur = Math.max(pf, Math.min(dur, available));
    return { sourceIn: inT, sourceOut: inT + dur };
  }
  const available = snapProject((mediaDur - inT) / speed, pr, 'floor');
  let tdur = snapProject((sourceOut - inT) / speed, pr, 'round');
  tdur = Math.max(pf, Math.min(tdur, available));
  return { sourceIn: inT, sourceOut: inT + Math.min(mediaDur - inT, Math.round(tdur * speed)) };
}

/** Change a clip's colour adjustments (only the given ones); neutral settings are removed. */
export function setColor(project: Project, clipId: string, patch: Partial<ColorAdjust>): Project {
  return updateClip(project, clipId, (c) => {
    const color = legalColor({ ...(c.color ?? NEUTRAL), ...patch });
    const { color: _old, ...rest } = c;
    return isNeutral(color) ? rest : { ...rest, color };
  });
}

/** Set (or remove, kind = null) the transition from a clip into the next one. */
export function setTransition(project: Project, clipId: string, kind: TransitionKind | null, duration?: Ticks): Project {
  return updateClip(project, clipId, (c) => {
    const next = { ...c };
    if (!kind) delete next.transition;
    else {
      const d = duration ?? c.transition?.duration ?? Math.round(0.5 * 705_600_000);
      const pf = frameDuration(project.frameRate);
      next.transition = { kind, duration: Math.min(4 * 705_600_000, Math.max(2 * pf, snapToFrame(d, project.frameRate))) };
    }
    return next;
  });
}

/** Speeds are kept to two decimals so timeline lengths stay exact on the frame grid. */
export function legalSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1;
  return Math.round(Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed)) * 100) / 100;
}

/**
 * Change a clip's speed. The footage it shows (source in/out) stays the same, so the clip gets
 * shorter or longer on the timeline (later clips move). Keyframes stay on the same footage.
 */
export function setSpeed(project: Project, clipId: string, speed: number): Project {
  return updateClip(project, clipId, (c) => {
    const media = findMedia(project, c.mediaId);
    if (!media || media.info.kind === 'image') return c;
    const sp = legalSpeed(speed);
    const next: ClipItem = { ...c, ...legalRange(project, media, c.sourceIn, c.sourceOut, 'in', sp) };
    if (sp === 1) delete next.speed;
    else next.speed = sp;
    return next;
  });
}

export function addMedia(project: Project, media: MediaRef[]): Project {
  return { ...project, media: [...project.media, ...media] };
}

/** Removes a media item and every clip that uses it (gaps closed). */
export function removeMedia(project: Project, mediaId: string): Project {
  const p: Project = {
    ...project,
    media: project.media.filter((m) => m.id !== mediaId),
    ...(project.audioTracks ? { audioTracks: project.audioTracks.map((t) => ({ ...t, clips: t.clips.filter((c) => c.mediaId !== mediaId) })) } : {}),
    ...(project.overlays ? { overlays: project.overlays.filter((o) => o.mediaId !== mediaId) } : {}),
  };
  return withItems(p, project.sequence.items.filter((i) => !(i.kind === 'clip' && i.mediaId === mediaId)));
}

export function createClip(project: Project, media: MediaRef): ClipItem | null {
  if (media.info.kind === 'audio') return null; // audio-only files go on audio tracks
  if (media.info.kind === 'image') {
    // Photos start as 4-second clips; drag the edge or type a duration to change it.
    return { kind: 'clip', id: newId('clip'), mediaId: media.id, sourceIn: 0, sourceOut: snapProject(PHOTO_DEFAULT, project.frameRate),
      framing: { ...DEFAULT_FRAMING }, volume: 1, muted: false };
  }
  const dur = snapProject(media.info.duration, project.frameRate, 'floor');
  if (dur < frameDuration(project.frameRate)) return null;
  return {
    kind: 'clip',
    id: newId('clip'),
    mediaId: media.id,
    sourceIn: 0,
    sourceOut: dur,
    framing: { ...DEFAULT_FRAMING },
    volume: 1,
    muted: false,
  };
}

/** Insert a clip for the whole media file at `index` (default: end of sequence). */
export function addClip(project: Project, mediaId: string, index?: number): { project: Project; clipId: string } | null {
  const media = findMedia(project, mediaId);
  if (!media) return null;
  const clip = createClip(project, media);
  if (!clip) return null;
  const items = [...project.sequence.items];
  items.splice(index ?? items.length, 0, clip);
  return { project: withItems(project, items), clipId: clip.id };
}

/** Split the clip under timeline time t (snapped to the project frame grid). */
export function splitAt(project: Project, t: Ticks): { project: Project; leftId: string; rightId: string } | null {
  t = snapProject(t, project.frameRate);
  const lay = layoutSequence(project);
  const hit = lay.items.find((l) => t > l.start && t < l.end);
  if (!hit) return null;
  const pf = frameDuration(project.frameRate);
  const items = [...project.sequence.items];
  if (hit.item.kind === 'gap') {
    const a: GapItem = { ...hit.item, duration: t - hit.start };
    const b: GapItem = { kind: 'gap', id: newId('gap'), duration: hit.end - t };
    items.splice(hit.index, 1, a, b);
    return { project: { ...project, sequence: { items } }, leftId: a.id, rightId: b.id };
  }
  const clip = hit.item;
  const media = findMedia(project, clip.mediaId);
  if (!media) return null;
  const offset = t - hit.start;
  if (offset < pf || hit.end - t < pf) return null;
  const sp = clipSpeed(clip);
  const cut = sourceAt(clip, hit.start, t);
  const left: ClipItem = withEdges({ ...clip, sourceOut: cut }, true, false);
  // The right half starts on the source frame that is visible at the split point.
  const rightIn = snapToFrame(cut, media.info.frameRate, 'floor');
  const right: ClipItem = withEdges({
    ...clip,
    id: newId('clip'),
    ...legalRange(project, media, rightIn, rightIn + Math.round((hit.end - t) * sp), 'in', sp),
  }, false, true);
  items.splice(hit.index, 1, left, right);
  return { project: { ...project, sequence: { items } }, leftId: left.id, rightId: right.id };
}

/**
 * A part of a split clip keeps what belongs to its edges: the in-animation stays on the first
 * part; the out-animation and the transition to the next clip on the last. Keyframes follow the
 * footage, so they stay on both.
 */
function withEdges(c: ClipItem, first: boolean, last: boolean): ClipItem {
  const out: ClipItem = { ...c };
  if (!last) delete out.transition;
  if (c.animation) {
    const a: ClipAnimation = { ...c.animation };
    if (!first) delete a.in;
    if (!last) delete a.out;
    if (Object.keys(a).length) out.animation = a;
    else delete out.animation;
  }
  return out;
}

export function updateClip(project: Project, clipId: string, fn: (c: ClipItem) => ClipItem): Project {
  // Overlay clips have every clip property: the same edits apply to them (see overlays.ts).
  if (project.overlays?.some((o) => o.id === clipId)) return updateOverlay(project, clipId, (o) => fromClip(o, fn(asClip(o))));
  return {
    ...project,
    sequence: {
      items: project.sequence.items.map((i) => (i.kind === 'clip' && i.id === clipId ? fn(i) : i)),
    },
  };
}

/** Set a clip's source range, keeping it legal. `anchor` says which end the user is holding still. */
export function setClipRange(project: Project, clipId: string, sourceIn: Ticks, sourceOut: Ticks, anchor: 'in' | 'out'): Project {
  return updateClip(project, clipId, (c) => {
    const media = findMedia(project, c.mediaId);
    if (!media) return c;
    return { ...c, ...legalRange(project, media, sourceIn, sourceOut, anchor, clipSpeed(c)) };
  });
}

/** Trim one edge by a timeline delta (positive = to the right). Ripple: later clips move. */
export function trimEdge(project: Project, clipId: string, edge: 'start' | 'end', delta: Ticks): Project {
  const clip = getItem(project, clipId);
  if (!clip || clip.kind !== 'clip') return project;
  const d = Math.round(delta * clipSpeed(clip)); // timeline delta → source delta
  if (edge === 'start') return setClipRange(project, clipId, clip.sourceIn + d, clip.sourceOut, 'out');
  return setClipRange(project, clipId, clip.sourceIn, clip.sourceOut + d, 'in');
}

export function setGapDuration(project: Project, gapId: string, duration: Ticks): Project {
  const d = Math.max(frameDuration(project.frameRate), snapProject(duration, project.frameRate));
  return withItems(
    project,
    project.sequence.items.map((i) => (i.kind === 'gap' && i.id === gapId ? { ...i, duration: d } : i)),
  );
}

export function getItem(project: Project, id: string): TrackItem | undefined {
  return project.sequence.items.find((i) => i.id === id);
}

export type DeleteMode = 'close-gap' | 'leave-gap';

export function deleteItem(project: Project, id: string, mode: DeleteMode): Project {
  return deleteItems(project, [id], mode);
}

/** Delete several main-track items at once (one edit). */
export function deleteItems(project: Project, ids: string[], mode: DeleteMode): Project {
  const del = new Set(ids);
  const items = project.sequence.items.flatMap((i): TrackItem[] => {
    if (!del.has(i.id)) return [i];
    if (mode === 'close-gap' || i.kind === 'gap') return [];
    return [{ kind: 'gap', id: newId('gap'), duration: itemDuration(i) }];
  });
  return withItems(project, items);
}

/** Move an item so it sits before the item currently at `toIndex` (toIndex may equal items.length). */
export function moveItem(project: Project, id: string, toIndex: number): Project {
  const items = [...project.sequence.items];
  const from = items.findIndex((i) => i.id === id);
  if (from < 0) return project;
  const [it] = items.splice(from, 1);
  const dest = toIndex > from ? toIndex - 1 : toIndex;
  items.splice(Math.max(0, Math.min(items.length, dest)), 0, it);
  return withItems(project, items);
}

/**
 * Insert copies of `items` at timeline time t (snapped to a frame). If t is inside a clip, that
 * clip is split there first. Copies get new ids; clips whose media is not in the project are skipped.
 */
export function insertAt(project: Project, items: TrackItem[], t: Ticks): { project: Project; ids: string[] } {
  let p = project;
  t = snapProject(Math.max(0, t), p.frameRate);
  const split = splitAt(p, t);
  if (split) p = split.project;
  const index = layoutSequence(p).items.filter((l) => l.start < t).length;
  const copies = items
    .filter((it) => it.kind === 'gap' || findMedia(p, it.mediaId))
    .map((it) => ({ ...structuredClone(it), id: newId(it.kind) }) as TrackItem);
  if (!copies.length) return { project, ids: [] };
  const arr = [...p.sequence.items];
  arr.splice(index, 0, ...copies);
  return { project: withItems(p, arr), ids: copies.map((c) => c.id) };
}

export function duplicateItem(project: Project, id: string): { project: Project; newId: string } | null {
  const idx = project.sequence.items.findIndex((i) => i.id === id);
  if (idx < 0) return null;
  const src = project.sequence.items[idx];
  const copy: TrackItem = { ...src, id: newId(src.kind) } as TrackItem;
  const items = [...project.sequence.items];
  items.splice(idx + 1, 0, copy);
  return { project: withItems(project, items), newId: copy.id };
}

export function setFraming(project: Project, clipId: string, framing: Framing): Project {
  return updateClip(project, clipId, (c) => ({ ...c, framing }));
}

/** Replace a clip's animation (presets/keyframes). Empty animations are removed. */
export function setAnimation(project: Project, clipId: string, fn: (a: ClipAnimation) => ClipAnimation): Project {
  return updateClip(project, clipId, (c) => {
    const next = fn(c.animation ?? {});
    const kf = next.keyframes ? Object.fromEntries(Object.entries(next.keyframes).filter(([, v]) => v && v.length)) : undefined;
    const cleaned: ClipAnimation = { ...next, keyframes: kf && Object.keys(kf).length ? kf : undefined };
    for (const k of ['in', 'out', 'motion', 'keyframes'] as const) if (cleaned[k] === undefined) delete cleaned[k];
    const { animation: _old, ...rest } = c;
    return Object.keys(cleaned).length ? { ...rest, animation: cleaned } : rest;
  });
}

/** Add or update a keyframe at source time `at` (snapped to the source frame grid). */
export function setKeyframe(project: Project, clipId: string, prop: AnimProperty, at: Ticks, value: number, easing?: Easing): Project {
  const clip = getItem(project, clipId);
  if (!clip || clip.kind !== 'clip') return project;
  const media = findMedia(project, clip.mediaId);
  const t = media ? snapToFrame(at, media.info.frameRate, 'round') : at;
  return setAnimation(project, clipId, (a) => ({
    ...a,
    keyframes: { ...a.keyframes, [prop]: upsertKeyframe(a.keyframes?.[prop], t, clampAnimValue(prop, value), easing) },
  }));
}

export function removeKeyframe(project: Project, clipId: string, prop: AnimProperty, at: Ticks): Project {
  return setAnimation(project, clipId, (a) => ({ ...a, keyframes: { ...a.keyframes, [prop]: removeKeyframeAt(a.keyframes?.[prop], at) } }));
}

/**
 * Cut source ranges (e.g. silences, filler words) out of a clip. The clip is replaced by the
 * parts that remain, in order, as one edit. `padding` keeps a little of each removed range at
 * both ends so speech is not clipped. Parts shorter than `minKeep` are dropped.
 */
export function removeSourceRanges(
  project: Project,
  clipId: string,
  ranges: { start: Ticks; end: Ticks }[],
  opts: { padding?: Ticks; minKeep?: Ticks } = {},
): { project: Project; parts: number; removed: Ticks } {
  const clip = getItem(project, clipId);
  if (!clip || clip.kind !== 'clip') return { project, parts: 0, removed: 0 };
  const media = findMedia(project, clip.mediaId);
  if (!media) return { project, parts: 0, removed: 0 };
  const pf = frameDuration(project.frameRate);
  const padding = opts.padding ?? 0;
  const minKeep = Math.max(pf, opts.minKeep ?? 2 * pf);
  const cut = ranges
    .map((r) => ({ start: r.start + padding, end: r.end - padding }))
    .filter((r) => r.end > r.start && r.end > clip.sourceIn && r.start < clip.sourceOut)
    .sort((a, b) => a.start - b.start);
  const keep: { start: Ticks; end: Ticks }[] = [];
  let cursor = clip.sourceIn;
  for (const r of cut) {
    if (r.start > cursor) keep.push({ start: cursor, end: Math.min(r.start, clip.sourceOut) });
    cursor = Math.max(cursor, r.end);
  }
  if (cursor < clip.sourceOut) keep.push({ start: cursor, end: clip.sourceOut });
  const parts = keep.filter((k) => k.end - k.start >= minKeep);
  if (parts.length === 1 && parts[0].start === clip.sourceIn && parts[0].end === clip.sourceOut) return { project, parts: 1, removed: 0 };
  const newClips: ClipItem[] = parts.map((k, i) =>
    withEdges({ ...clip, id: i === 0 ? clip.id : newId('clip'), ...legalRange(project, media, k.start, k.end, 'in', clipSpeed(clip)) }, i === 0, i === parts.length - 1),
  );
  const items = project.sequence.items.flatMap((it) => (it.id === clipId ? newClips : [it]));
  const kept = newClips.reduce((s, c) => s + itemDuration(c), 0);
  return { project: withItems(project, items), parts: newClips.length, removed: itemDuration(clip) - kept }; // timeline time
}

/** Split a clip at the given SOURCE times (e.g. detected scene changes). */
export function splitAtSourceTimes(project: Project, clipId: string, times: Ticks[]): { project: Project; parts: number } {
  let p = project;
  let current = clipId;
  let parts = 1;
  for (const s of [...times].sort((a, b) => a - b)) {
    const clip = getItem(p, current);
    if (!clip || clip.kind !== 'clip' || s <= clip.sourceIn || s >= clip.sourceOut) continue;
    const l = layoutSequence(p).items.find((x) => x.item.id === current)!;
    const r = splitAt(p, timelineAt(clip, l.start, s));
    if (!r) continue;
    p = r.project;
    current = r.rightId;
    parts++;
  }
  return { project: p, parts };
}

export function setTranscript(project: Project, mediaId: string, transcript: Transcript | undefined): Project {
  return { ...project, media: project.media.map((m) => (m.id === mediaId ? { ...m, transcript } : m)) };
}

export function setCaptions(project: Project, fn: (c: CaptionSettings) => CaptionSettings | undefined): Project {
  const next = fn(project.captions ?? { ...DEFAULT_CAPTIONS, enabled: false });
  const { captions: _old, ...rest } = project;
  return next ? { ...rest, captions: next } : rest;
}

export function setClipAudio(project: Project, clipId: string, audio: { volume?: number; muted?: boolean }): Project {
  return updateClip(project, clipId, (c) => ({
    ...c,
    volume: audio.volume !== undefined ? Math.max(0, Math.min(2, audio.volume)) : c.volume,
    muted: audio.muted ?? c.muted,
  }));
}

export function setCanvas(project: Project, canvas: Project['canvas']): Project {
  return { ...project, canvas };
}

/**
 * Change the project frame rate. Existing durations are re-snapped to the new frame grid
 * (each clip changes by less than half a frame), so cuts stay frame-aligned.
 */
export function setFrameRate(project: Project, frameRate: Rational): Project {
  const p = { ...project, frameRate };
  const items = project.sequence.items.map((i): TrackItem => {
    if (i.kind === 'gap') return { ...i, duration: Math.max(frameDuration(frameRate), snapProject(i.duration, frameRate)) };
    const media = findMedia(project, i.mediaId);
    return media ? { ...i, ...legalRange(p, media, i.sourceIn, i.sourceOut, 'in') } : i;
  });
  return withItems(p, items);
}

export function relinkMedia(project: Project, mediaId: string, path: string, info: MediaRef['info'], warnings: string[]): Project {
  const p: Project = {
    ...project,
    media: project.media.map((m) =>
      m.id === mediaId ? { ...m, path, relativePath: undefined, info, warnings, name: basename(path) } : m,
    ),
  };
  // The replacement file may be shorter: keep every clip that uses it inside the new duration.
  const media = findMedia(p, mediaId)!;
  return withItems(
    p,
    p.sequence.items.map((i) =>
      i.kind === 'clip' && i.mediaId === mediaId ? { ...i, ...legalRange(p, media, i.sourceIn, i.sourceOut, 'in') } : i,
    ),
  );
}

export function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/**
 * Speed ramp, made of steps: the clip's footage is split into `steps` equal parts whose speeds go
 * evenly from `from` (first part) to `to` (last part). Each part is an ordinary clip, so preview,
 * export, sound (pitch kept) and every other tool treat it like any speed change. The change is
 * stepped, not continuous: with 8 steps over a second each speed lasts a few frames.
 */
export function speedRamp(project: Project, clipId: string, from: number, to: number, steps = 8): { project: Project; ids: string[] } | { error: string } {
  const clip = getItem(project, clipId);
  if (!clip || clip.kind !== 'clip') return { error: 'Select a clip on the main track.' };
  const media = findMedia(project, clip.mediaId);
  if (!media || media.info.kind === 'image') return { error: 'Photos have no speed.' };
  const n = Math.max(2, Math.min(24, Math.round(steps)));
  const fd = frameDuration(media.info.frameRate);
  const len = clip.sourceOut - clip.sourceIn;
  if (len < n * 2 * fd) return { error: `The clip is too short for ${n} steps (needs at least ${n * 2} frames of footage).` };
  const times = Array.from({ length: n - 1 }, (_, k) => snapToFrame(clip.sourceIn + (len * (k + 1)) / n, media.info.frameRate, 'round'));
  const index = project.sequence.items.findIndex((i) => i.id === clipId);
  const split = splitAtSourceTimes(project, clipId, times);
  let p = split.project;
  const ids = p.sequence.items.slice(index, index + split.parts).map((i) => i.id);
  ids.forEach((id, i) => {
    p = setSpeed(p, id, legalSpeed(from + ((to - from) * i) / (ids.length - 1)));
  });
  return { project: p, ids };
}

/**
 * Freeze frame: insert a still (`still`, a photo made from the frame at timeline time t) for
 * `duration` at t, splitting the clip there. The still gets the clip's framing and colour, so it
 * looks exactly like the frame it was made from; it is silent.
 */
export function insertFreezeFrame(project: Project, still: MediaRef, t: Ticks, duration: Ticks): { project: Project; id: string } | null {
  const lay = layoutSequence(project);
  const t0 = snapProject(t, project.frameRate);
  const hit = lay.items.find((l) => t0 >= l.start && t0 < l.end);
  if (!hit || hit.item.kind !== 'clip') return null;
  const src = hit.item;
  const base = createClip(project, still);
  if (!base) return null;
  const d = Math.max(frameDuration(project.frameRate), snapProject(duration, project.frameRate));
  const clip: ClipItem = { ...base, sourceOut: d, framing: src.framing, ...(src.color ? { color: src.color } : {}) };
  const r = insertAt(project, [clip], t0);
  return r.ids.length ? { project: r.project, id: r.ids[0] } : null;
}

/**
 * Swap a clip to a reversed copy of its footage (`reversed`, made from [sourceIn, sourceOut) of
 * the clip's file). Speed, framing, colour, volume and in/out animations are kept; keyframes are
 * dropped (they point at moments of the original footage). Reversing a reversed clip returns to
 * the original footage when that file is still in the project.
 */
export function useReversed(project: Project, clipId: string, reversed: MediaRef): Project {
  return updateClip(project, clipId, (c) => {
    const len = snapToFrame(reversed.info.duration, reversed.info.frameRate, 'floor');
    const next: ClipItem = { ...c, mediaId: reversed.id, sourceIn: 0, sourceOut: len };
    const range = legalRange(project, reversed, 0, len, 'in', clipSpeed(c));
    Object.assign(next, range);
    if (next.animation?.keyframes) {
      const { keyframes: _k, ...rest } = next.animation;
      if (Object.keys(rest).length) next.animation = rest;
      else delete next.animation;
    }
    return next;
  });
}

/** The original footage of a reversed clip, if its file is still in the project. */
export function unreverse(project: Project, clipId: string): Project | null {
  const c = getItem(project, clipId);
  if (!c || c.kind !== 'clip') return null;
  const d = findMedia(project, c.mediaId)?.derived;
  const orig = d?.kind === 'reverse' ? findMedia(project, d.mediaId) : undefined;
  if (!d || !orig) return null;
  return updateClip(project, clipId, (x) => {
    // Reversed time s maps back to original time (end − s): the clip's range flips.
    const sIn = d.sourceOut - x.sourceOut;
    const sOut = d.sourceOut - x.sourceIn;
    const next: ClipItem = { ...x, mediaId: orig.id, ...legalRange(project, orig, Math.max(d.sourceIn, sIn), Math.min(d.sourceOut, sOut), 'in', clipSpeed(x)) };
    if (next.animation?.keyframes) {
      const { keyframes: _k, ...rest } = next.animation;
      if (Object.keys(rest).length) next.animation = rest;
      else delete next.animation;
    }
    return next;
  });
}

/** Change how a media file's picture is read (HDR tone mapping, LUT); empty = removed. */
export function setMediaInput(project: Project, mediaId: string, patch: Partial<NonNullable<MediaRef['input']>>): Project {
  return {
    ...project,
    media: project.media.map((m) => {
      if (m.id !== mediaId) return m;
      const input = { ...m.input, ...patch };
      if (!input.toneMap) delete input.toneMap;
      if (!input.lut) delete input.lut;
      const { input: _old, ...rest } = m;
      return Object.keys(input).length ? { ...rest, input } : rest;
    }),
  };
}

/** EQ / noise reduction of a clip's sound (main track or overlay); neutral values remove it. */
export function setClipAudioFx(project: Project, clipId: string, patch: Partial<AudioFx>): Project {
  return updateClip(project, clipId, (c) => {
    const fx = legalFx({ ...NO_FX, ...c.audioFx, ...patch });
    const { audioFx: _old, ...rest } = c;
    return fx ? { ...rest, audioFx: fx } : rest;
  });
}

/** Blur / mask of a clip; patch replaces those fields (undefined removes them). */
export function setEffects(project: Project, clipId: string, patch: Partial<ClipEffects>): Project {
  return updateClip(project, clipId, (c) => {
    const fx = legalEffects({ ...c.effects, ...patch });
    const { effects: _old, ...rest } = c;
    return fx ? { ...rest, effects: fx } : rest;
  });
}
