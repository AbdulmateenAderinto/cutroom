/**
 * Overlay video tracks (V2, V3, …) on the timeline, between the text rows and the main track.
 * Higher rows draw on top in the picture, so they are shown higher here too.
 *
 * Mouse: drag a clip to move it (also up/down to another row; above the top row makes a new row);
 * drag its edges to trim. Drop media from the Media panel onto a row to add it there.
 */
import { useRef, useState } from 'react';
import { type OverlayClip, findMedia } from '../../shared/model';
import { MAX_OVERLAY_ROWS, moveOverlay, overlayDuration, overlayEnd, trimOverlay } from '../../shared/overlays';
import { formatDuration, secondsToTicks, ticksToSeconds } from '../../shared/time';
import * as A from '../state/actions';
import { beginGesture, endGesture, store, updateGesture, useStore } from '../state/store';
import type { TimeHelpers } from './AudioTracks';
import { MEDIA_DRAG_TYPE } from './MediaBin';

const NONE: OverlayClip[] = [];

export function OverlayRows(h: TimeHelpers) {
  const list = useStore((s) => s.project.overlays ?? NONE);
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const thumbs = useStore((s) => s.thumbs);
  const missing = useStore((s) => s.missing);
  const rowsRef = useRef<HTMLDivElement>(null);
  const [dropRow, setDropRow] = useState<number | null>(null);
  const count = list.reduce((n, o) => Math.max(n, o.row + 1), 0);
  if (!count) return null;
  const rows = Array.from({ length: count }, (_, i) => count - 1 - i); // top row first

  const rowAtY = (clientY: number, current: number): number => {
    const els = rowsRef.current?.querySelectorAll<HTMLElement>('.tl-ov-row');
    if (!els?.length) return current;
    const top = els[0].getBoundingClientRect().top;
    if (clientY < top) return Math.min(MAX_OVERLAY_ROWS - 1, count); // above the top row: a new row
    for (const r of els) {
      const b = r.getBoundingClientRect();
      if (clientY >= b.top && clientY < b.bottom) return Number(r.dataset.row);
    }
    return current;
  };

  const drag = (e: React.PointerEvent, o: OverlayClip, mode: 'move' | 'start' | 'end') => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    store.set({ selection: { kind: 'overlay', id: o.id } });
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    let started = false;
    const dur = overlayDuration(o);
    const move = (ev: PointerEvent) => {
      if (!started) {
        if (Math.abs(ev.clientX - x0) < 3 && mode === 'move' && Math.abs(ev.clientY - e.clientY) < 6) return;
        started = true;
        beginGesture();
      }
      const dx = secondsToTicks((ev.clientX - x0) / h.pps);
      updateGesture((p) => {
        if (mode === 'move') {
          const s = h.snap(o.start + dx, ev.altKey, o.id);
          const e2 = h.snap(o.start + dx + dur, ev.altKey, o.id) - dur;
          return moveOverlay(p, o.id, s !== o.start + dx ? s : e2, rowAtY(ev.clientY, o.row));
        }
        if (mode === 'start') return trimOverlay(p, o.id, 'start', h.snap(o.start + dx, ev.altKey, o.id) - o.start);
        return trimOverlay(p, o.id, 'end', h.snap(overlayEnd(o) + dx, ev.altKey, o.id) - overlayEnd(o));
      });
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      if (started) endGesture();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };

  const onDragOver = (e: React.DragEvent, row: number) => {
    if (!e.dataTransfer.types.includes(MEDIA_DRAG_TYPE)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    setDropRow(row);
  };
  const onDrop = (e: React.DragEvent, row: number) => {
    const id = e.dataTransfer.getData(MEDIA_DRAG_TYPE);
    setDropRow(null);
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    A.addOverlayAction(id, h.snap(h.xToT(h.contentX(e.clientX)), e.altKey), { row });
  };

  const endX = h.tToX(h.duration);
  return (
    <div className="tl-ov" ref={rowsRef}>
      {rows.map((row) => (
        <div
          key={row}
          className={`tl-ov-row${dropRow === row ? ' drop' : ''}`}
          data-row={row}
          onDragOver={(e) => onDragOver(e, row)}
          onDragLeave={() => setDropRow(null)}
          onDrop={(e) => onDrop(e, row)}
        >
          <span className="tl-ov-label">V{row + 2}</span>
          {list.filter((o) => o.row === row).map((o) => {
            const sel = selection?.kind === 'overlay' && selection.id === o.id;
            const w = Math.max(4, ticksToSeconds(overlayDuration(o)) * h.pps);
            const name = findMedia(project, o.mediaId)?.name ?? '?';
            const off = !!missing[o.mediaId];
            return (
              <div
                key={o.id}
                className={`ovclip${sel ? ' selected' : ''}${off ? ' offline' : ''}`}
                data-overlay-id={o.id}
                style={{ left: h.tToX(o.start), width: w, backgroundImage: thumbs[o.mediaId] ? `url(${thumbs[o.mediaId]})` : undefined }}
                onPointerDown={(e) => drag(e, o, 'move')}
                title={`${name} — ${formatDuration(overlayDuration(o))}. Drag to move (up/down for another track); edges trim.`}
              >
                <span className="ovclip-label">⧉&nbsp; {off ? '⚠ ' : ''}{o.speed ? `${o.speed}× · ` : ''}{name}</span>
                <div className="trim-handle left" onPointerDown={(e) => drag(e, o, 'start')} title="Drag to trim the start" />
                <div className="trim-handle right" onPointerDown={(e) => drag(e, o, 'end')} title="Drag to trim the end" />
              </div>
            );
          })}
          <div className="tl-past-end" style={{ left: endX }} title="After the end of the main video track: not exported" />
        </div>
      ))}
    </div>
  );
}
