/**
 * Overlay video tracks (V2, V3, …): clips placed freely in time above the main track, e.g.
 * picture-in-picture. Rows never have overlapping clips; higher rows draw on top.
 *
 * An overlay clip has every property of a main-track clip, so the clip operations in ops.ts
 * (framing, speed, colour, animation, volume, source range) work on it through updateClip(),
 * and the preview and export draw it with the same code as main clips (via asClip()).
 */
import { type ClipItem, type Framing, type LaidOutItem, type OverlayClip, type Project, computeClipRect, findMedia, itemDuration, layoutSequence, newId } from './model';
import { type Ticks, frameDuration, snapToFrame } from './time';

export const MAX_OVERLAY_ROWS = 6;

export function overlays(p: Project): OverlayClip[] {
  return p.overlays ?? [];
}
export function findOverlay(p: Project, id: string): OverlayClip | undefined {
  return overlays(p).find((o) => o.id === id);
}
/** The overlay seen as a main-track clip (for code shared with main clips). */
export function asClip(o: OverlayClip): ClipItem {
  const { row: _r, start: _s, kind: _k, ...rest } = o;
  return { ...rest, kind: 'clip' };
}
export function fromClip(o: OverlayClip, c: ClipItem): OverlayClip {
  const { kind: _k, transition: _t, ...rest } = c;
  return { ...rest, kind: 'overlay', row: o.row, start: o.start };
}
export const overlayDuration = (o: OverlayClip): Ticks => itemDuration(asClip(o));
export const overlayEnd = (o: OverlayClip): Ticks => o.start + overlayDuration(o);
/** A layout entry for an overlay, as the preview/export expect for clips. */
export function overlayLayout(o: OverlayClip): LaidOutItem {
  return { item: asClip(o), index: -1, start: o.start, end: overlayEnd(o) };
}
export function overlayRows(p: Project): number {
  return overlays(p).reduce((n, o) => Math.max(n, o.row + 1), 0);
}
/** Overlays visible at time t, lowest row first. */
export function overlaysAt(p: Project, t: Ticks): OverlayClip[] {
  return overlays(p).filter((o) => t >= o.start && t < overlayEnd(o)).sort((a, b) => a.row - b.row);
}

const sorted = (os: OverlayClip[]) => [...os].sort((a, b) => a.row - b.row || a.start - b.start);
const withOverlays = (p: Project, os: OverlayClip[]): Project => ({ ...p, overlays: sorted(os) });

function overlaps(os: OverlayClip[], row: number, start: Ticks, dur: Ticks, ignore?: string): boolean {
  return os.some((o) => o.id !== ignore && o.row === row && start < overlayEnd(o) && o.start < start + dur);
}
function freeStart(os: OverlayClip[], row: number, start: Ticks, dur: Ticks, ignore?: string): Ticks {
  let s = Math.max(0, start);
  for (const o of sorted(os.filter((x) => x.row === row && x.id !== ignore))) {
    if (s + dur <= o.start) break;
    if (s < overlayEnd(o)) s = overlayEnd(o);
  }
  return s;
}
function freeRow(os: OverlayClip[], start: Ticks, dur: Ticks): number {
  for (let r = 0; r < MAX_OVERLAY_ROWS; r++) if (!overlaps(os, r, start, dur)) return r;
  return MAX_OVERLAY_ROWS - 1;
}

export type PipCorner = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight' | 'center' | 'full';
export const PIP_POSITIONS: { id: PipCorner; label: string }[] = [
  { id: 'topLeft', label: '↖ Top left' },
  { id: 'topRight', label: '↗ Top right' },
  { id: 'bottomLeft', label: '↙ Bottom left' },
  { id: 'bottomRight', label: '↘ Bottom right' },
  { id: 'center', label: '• Centre' },
  { id: 'full', label: '⛶ Full frame' },
];

/**
 * Manual framing that puts a picture in a corner (or the centre) at `size` × the Fit size, with a
 * margin of 4% of the canvas's short side. 'full' is plain Fit.
 */
export function pipFraming(srcW: number, srcH: number, cw: number, ch: number, corner: PipCorner, size = 0.35): Framing {
  if (corner === 'full') return { mode: 'fit', scale: 1, x: 0, y: 0 };
  const r = computeClipRect(srcW, srcH, cw, ch, { mode: 'manual', scale: size, x: 0, y: 0 });
  const m = 0.04 * Math.min(cw, ch);
  const dx = (cw / 2 - m - r.w / 2) / cw;
  const dy = (ch / 2 - m - r.h / 2) / ch;
  const sx = corner === 'topLeft' || corner === 'bottomLeft' ? -1 : corner === 'center' ? 0 : 1;
  const sy = corner === 'topLeft' || corner === 'topRight' ? -1 : corner === 'center' ? 0 : 1;
  return { mode: 'manual', scale: size, x: sx * dx, y: sy * dy };
}

/** Add a whole media file as an overlay at `at` (lowest free row), as picture-in-picture by default. */
export function addOverlay(
  p: Project,
  mediaId: string,
  at: Ticks,
  opts: { row?: number; corner?: PipCorner; size?: number } = {},
): { project: Project; id: string } | null {
  const m = findMedia(p, mediaId);
  if (!m || m.info.kind === 'audio') return null;
  const pf = frameDuration(p.frameRate);
  const dur = m.info.kind === 'image'
    ? snapToFrame(4 * 705_600_000, p.frameRate)
    : snapToFrame(m.info.duration, p.frameRate, 'floor');
  if (dur < pf) return null;
  const os = overlays(p);
  let start = Math.max(0, snapToFrame(at, p.frameRate));
  const row = opts.row ?? freeRow(os, start, dur);
  if (overlaps(os, row, start, dur)) start = freeStart(os, row, start, dur);
  const framing = pipFraming(m.info.displayWidth, m.info.displayHeight, p.canvas.width, p.canvas.height, opts.corner ?? 'bottomRight', opts.size);
  const o: OverlayClip = {
    kind: 'overlay', id: newId('ovl'), mediaId, sourceIn: 0, sourceOut: dur, framing, volume: 1, muted: false,
    row: Math.min(MAX_OVERLAY_ROWS - 1, Math.max(0, row)), start,
  };
  return { project: withOverlays(p, [...os, o]), id: o.id };
}

/**
 * Change an overlay (timing changes that would overlap a neighbour on its row are refused; other
 * changes still apply).
 */
export function updateOverlay(p: Project, id: string, fn: (o: OverlayClip) => OverlayClip): Project {
  const os = overlays(p);
  const old = os.find((o) => o.id === id);
  if (!old) return p;
  let next = fn(old);
  if (overlaps(os, next.row, next.start, overlayDuration(next), id)) {
    if (overlayDuration(next) !== overlayDuration(old)) next = { ...next, sourceIn: old.sourceIn, sourceOut: old.sourceOut, speed: old.speed };
    next = { ...next, row: old.row, start: old.start };
  }
  return withOverlays(p, os.map((o) => (o.id === id ? next : o)));
}

/** Move to `start` (and `row`); lands in the nearest free space on that row. */
export function moveOverlay(p: Project, id: string, start: Ticks, row?: number): Project {
  const o = findOverlay(p, id);
  if (!o) return p;
  const r = Math.min(MAX_OVERLAY_ROWS - 1, Math.max(0, row ?? o.row));
  const s = freeStart(overlays(p), r, snapToFrame(Math.max(0, start), p.frameRate), overlayDuration(o), id);
  return withOverlays(p, overlays(p).map((x) => (x.id === id ? { ...x, start: s, row: r } : x)));
}

/**
 * Trim an edge by a timeline delta. The start edge moves `start` and the source in-point together
 * (the picture stays in place, like an audio clip). Never past a neighbour, the file, or 1 frame.
 */
export function trimOverlay(p: Project, id: string, edge: 'start' | 'end', delta: Ticks): Project {
  const o = findOverlay(p, id);
  const m = o && findMedia(p, o.mediaId);
  if (!o || !m) return p;
  const pf = frameDuration(p.frameRate);
  const sp = o.speed ?? 1;
  const others = overlays(p).filter((x) => x.row === o.row && x.id !== id);
  const prevEnd = Math.max(0, ...others.filter((x) => x.start < o.start).map(overlayEnd));
  const nextStart = Math.min(Number.MAX_SAFE_INTEGER, ...others.filter((x) => x.start > o.start).map((x) => x.start));
  let d = snapToFrame(delta, p.frameRate);
  const maxLen = m.info.kind === 'image' ? 3600 * 705_600_000 : m.info.duration;
  if (edge === 'start') {
    d = Math.max(d, -Math.floor(o.sourceIn / sp), prevEnd - o.start);
    d = Math.min(d, overlayDuration(o) - pf);
    return updateOverlay(p, id, (x) => ({ ...x, start: x.start + d, sourceIn: x.sourceIn + Math.round(d * sp) }));
  }
  d = Math.min(d, Math.floor((maxLen - o.sourceOut) / sp), nextStart - overlayEnd(o));
  d = Math.max(d, pf - overlayDuration(o));
  return updateOverlay(p, id, (x) => ({ ...x, sourceOut: x.sourceOut + Math.round(d * sp) }));
}

export function splitOverlay(p: Project, id: string, t: Ticks): { project: Project; rightId: string } | null {
  const o = findOverlay(p, id);
  if (!o) return null;
  const cut = snapToFrame(t, p.frameRate);
  const pf = frameDuration(p.frameRate);
  if (cut < o.start + pf || cut > overlayEnd(o) - pf) return null;
  const src = o.sourceIn + Math.round((cut - o.start) * (o.speed ?? 1));
  const left: OverlayClip = { ...o, sourceOut: src };
  const right: OverlayClip = { ...o, id: newId('ovl'), start: cut, sourceIn: src };
  return { project: withOverlays(p, overlays(p).flatMap((x) => (x.id === id ? [left, right] : [x]))), rightId: right.id };
}

export function deleteOverlay(p: Project, id: string): Project {
  return withOverlays(p, overlays(p).filter((o) => o.id !== id));
}

export function duplicateOverlay(p: Project, id: string): { project: Project; id: string } | null {
  const o = findOverlay(p, id);
  if (!o) return null;
  const os = overlays(p);
  const start = freeStart(os, o.row, overlayEnd(o), overlayDuration(o));
  const copy: OverlayClip = { ...structuredClone(o), id: newId('ovl'), start };
  return { project: withOverlays(p, [...os, copy]), id: copy.id };
}

/** Paste a copy of an overlay at `at` (same row if free there, else the lowest free row). */
export function pasteOverlay(p: Project, o: OverlayClip, at: Ticks): { project: Project; id: string } | null {
  if (!findMedia(p, o.mediaId)) return null;
  const os = overlays(p);
  const start = Math.max(0, snapToFrame(at, p.frameRate));
  const dur = overlayDuration(o);
  const row = overlaps(os, o.row, start, dur) ? freeRow(os, start, dur) : o.row;
  const copy: OverlayClip = { ...structuredClone(o), id: newId('ovl'), row, start: freeStart(os, row, start, dur) };
  return { project: withOverlays(p, [...os, copy]), id: copy.id };
}

/** Where a clip (main track or overlay track) sits on the timeline. */
export function clipLayout(p: Project, id: string): LaidOutItem | undefined {
  const o = findOverlay(p, id);
  return o ? overlayLayout(o) : layoutSequence(p).items.find((l) => l.item.id === id);
}
