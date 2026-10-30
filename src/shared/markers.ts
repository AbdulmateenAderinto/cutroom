/**
 * Timeline markers: named points in time (M adds one at the playhead). They keep their timeline
 * position when clips are edited, ↑/↓ stop at them, and an export can carry them as chapters
 * (MP4/MOV chapter marks, shown by QuickTime, Apple TV, VLC…).
 */
import { type Marker, type MarkerColor, type Project, newId } from './model';
import { type Ticks, snapToFrame, ticksToSeconds } from './time';

export const MARKER_COLORS: { id: MarkerColor; label: string; hex: string }[] = [
  { id: 'yellow', label: 'Yellow', hex: '#f5c542' },
  { id: 'red', label: 'Red', hex: '#ef5b5b' },
  { id: 'green', label: 'Green', hex: '#4cc38a' },
  { id: 'blue', label: 'Blue', hex: '#5aa0ff' },
  { id: 'purple', label: 'Purple', hex: '#b07cf2' },
];

export function markers(p: Project): Marker[] {
  return [...(p.markers ?? [])].sort((a, b) => a.time - b.time);
}
export function findMarker(p: Project, id: string): Marker | undefined {
  return p.markers?.find((m) => m.id === id);
}
const withMarkers = (p: Project, ms: Marker[]): Project => ({ ...p, markers: [...ms].sort((a, b) => a.time - b.time) });

/** Add a marker at t (on the frame grid). If one is already on that frame, it is returned instead. */
export function addMarker(p: Project, t: Ticks, opts: { label?: string; color?: MarkerColor } = {}): { project: Project; id: string; existed: boolean } {
  const time = Math.max(0, snapToFrame(t, p.frameRate));
  const hit = (p.markers ?? []).find((m) => m.time === time);
  if (hit) return { project: p, id: hit.id, existed: true };
  const n = (p.markers ?? []).length + 1;
  const m: Marker = { id: newId('mrk'), time, label: opts.label ?? `Marker ${n}`, color: opts.color ?? 'yellow' };
  return { project: withMarkers(p, [...(p.markers ?? []), m]), id: m.id, existed: false };
}

export function updateMarker(p: Project, id: string, patch: Partial<Omit<Marker, 'id'>>): Project {
  if (!findMarker(p, id)) return p;
  return withMarkers(p, (p.markers ?? []).map((m) => {
    if (m.id !== id) return m;
    const next = { ...m, ...patch };
    next.time = Math.max(0, snapToFrame(next.time, p.frameRate));
    next.label = next.label.slice(0, 200);
    return next;
  }));
}

export function deleteMarker(p: Project, id: string): Project {
  return withMarkers(p, (p.markers ?? []).filter((m) => m.id !== id));
}

/**
 * FFmpeg metadata file with one chapter per marker inside [start, end) of the timeline (times
 * relative to `start`, as in a range export). A chapter runs to the next marker or the end. If
 * the first marker is after `start`, an untitled chapter covers the beginning, so players show
 * the right chapter from the first frame. Returns null when there are no markers in the range.
 */
export function chapterMetadata(p: Project, start: Ticks, end: Ticks): string | null {
  const inside = markers(p).filter((m) => m.time >= start && m.time < end);
  if (!inside.length) return null;
  const ms = (t: Ticks) => Math.round(ticksToSeconds(t - start) * 1000);
  const points = inside[0].time > start ? [{ time: start, label: 'Start' }, ...inside] : inside;
  const esc = (s: string) => s.replace(/([=;#\\\n])/g, '\\$1');
  const lines = [';FFMETADATA1'];
  points.forEach((m, i) => {
    const next = points[i + 1]?.time ?? end;
    lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${ms(m.time)}`, `END=${ms(next)}`, `title=${esc(m.label)}`);
  });
  return lines.join('\n') + '\n';
}
