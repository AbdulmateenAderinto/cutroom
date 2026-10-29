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
  DEFAULT_FRAMING,
  findMedia,
  itemDuration,
  layoutSequence,
  newId,
} from './model';
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

/**
 * Compute a legal (sourceIn, sourceOut) pair.
 * anchor 'in'  — keep sourceIn where requested and fit the duration (used when trimming the end).
 * anchor 'out' — keep sourceOut where requested and move sourceIn (used when trimming the start).
 */
export function legalRange(
  project: Project,
  media: MediaRef,
  sourceIn: Ticks,
  sourceOut: Ticks,
  anchor: 'in' | 'out',
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
  const available = snapProject(mediaDur - inT, pr, 'floor');
  let dur = snapProject(sourceOut - inT, pr, 'round');
  dur = Math.max(pf, Math.min(dur, available));
  return { sourceIn: inT, sourceOut: inT + dur };
}

export function addMedia(project: Project, media: MediaRef[]): Project {
  return { ...project, media: [...project.media, ...media] };
}

/** Removes a media item and every clip that uses it (gaps closed). */
export function removeMedia(project: Project, mediaId: string): Project {
  const p = { ...project, media: project.media.filter((m) => m.id !== mediaId) };
  return withItems(p, project.sequence.items.filter((i) => !(i.kind === 'clip' && i.mediaId === mediaId)));
}

export function createClip(project: Project, media: MediaRef): ClipItem | null {
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
  const left: ClipItem = { ...clip, sourceOut: clip.sourceIn + offset };
  // The right half starts on the source frame that is visible at the split point.
  const rightIn = snapToFrame(clip.sourceIn + offset, media.info.frameRate, 'floor');
  const right: ClipItem = {
    ...clip,
    id: newId('clip'),
    ...legalRange(project, media, rightIn, rightIn + (hit.end - t), 'in'),
  };
  items.splice(hit.index, 1, left, right);
  return { project: { ...project, sequence: { items } }, leftId: left.id, rightId: right.id };
}

export function updateClip(project: Project, clipId: string, fn: (c: ClipItem) => ClipItem): Project {
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
    return { ...c, ...legalRange(project, media, sourceIn, sourceOut, anchor) };
  });
}

/** Trim one edge by a timeline delta (positive = to the right). Ripple: later clips move. */
export function trimEdge(project: Project, clipId: string, edge: 'start' | 'end', delta: Ticks): Project {
  const clip = getItem(project, clipId);
  if (!clip || clip.kind !== 'clip') return project;
  if (edge === 'start') return setClipRange(project, clipId, clip.sourceIn + delta, clip.sourceOut, 'out');
  return setClipRange(project, clipId, clip.sourceIn, clip.sourceOut + delta, 'in');
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
  const items = project.sequence.items.flatMap((i): TrackItem[] => {
    if (i.id !== id) return [i];
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

export function setClipAudio(project: Project, clipId: string, audio: { volume?: number; muted?: boolean }): Project {
  return updateClip(project, clipId, (c) => ({
    ...c,
    volume: audio.volume !== undefined ? Math.max(0, Math.min(1, audio.volume)) : c.volume,
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
