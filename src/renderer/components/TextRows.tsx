/**
 * Text rows on the timeline, above the video track. Higher rows draw on top in the picture, so
 * they are shown higher here too.
 *
 * Mouse: drag a title to move it (also up/down to another row; above the top row makes a new
 * row); drag its edges to change when it starts/ends.
 */
import { useRef } from 'react';
import type { TitleClip } from '../../shared/model';
import { MAX_TITLE_ROWS, moveTitle, trimTitle } from '../../shared/titles';
import { formatDuration, secondsToTicks, ticksToSeconds } from '../../shared/time';
import { beginGesture, endGesture, store, updateGesture, useStore } from '../state/store';
import type { TimeHelpers } from './AudioTracks';

const NO_TITLES: TitleClip[] = [];

export function TextRows(h: TimeHelpers) {
  const list = useStore((s) => s.project.titles ?? NO_TITLES);
  const selection = useStore((s) => s.selection);
  const rowsRef = useRef<HTMLDivElement>(null);
  const count = list.reduce((n, t) => Math.max(n, t.row + 1), 0);
  if (!count) return null;
  const rows = Array.from({ length: count }, (_, i) => count - 1 - i); // top row first

  const rowAtY = (clientY: number, current: number): number => {
    const els = rowsRef.current?.querySelectorAll<HTMLElement>('.tl-text-row');
    if (!els?.length) return current;
    const top = els[0].getBoundingClientRect().top;
    if (clientY < top) return Math.min(MAX_TITLE_ROWS - 1, count); // above the top row: a new row
    for (const r of els) {
      const b = r.getBoundingClientRect();
      if (clientY >= b.top && clientY < b.bottom) return Number(r.dataset.row);
    }
    return current;
  };

  const drag = (e: React.PointerEvent, t: TitleClip, mode: 'move' | 'start' | 'end') => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    store.set({ selection: { kind: 'title', id: t.id } });
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    let started = false;
    const move = (ev: PointerEvent) => {
      if (!started) {
        if (Math.abs(ev.clientX - x0) < 3 && mode === 'move' && Math.abs(ev.clientY - e.clientY) < 6) return;
        started = true;
        beginGesture();
      }
      const dx = secondsToTicks((ev.clientX - x0) / h.pps);
      updateGesture((p) => {
        if (mode === 'move') {
          const s = h.snap(t.start + dx, ev.altKey, t.id);
          const e2 = h.snap(t.start + dx + t.duration, ev.altKey, t.id) - t.duration;
          return moveTitle(p, t.id, s !== t.start + dx ? s : e2, rowAtY(ev.clientY, t.row));
        }
        if (mode === 'start') return trimTitle(p, t.id, 'start', h.snap(t.start + dx, ev.altKey, t.id) - t.start);
        return trimTitle(p, t.id, 'end', h.snap(t.start + t.duration + dx, ev.altKey, t.id) - (t.start + t.duration));
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

  const endX = h.tToX(h.duration);
  return (
    <div className="tl-text" ref={rowsRef}>
      {rows.map((row) => (
        <div key={row} className="tl-text-row" data-row={row}>
          {list.filter((t) => t.row === row).map((t) => {
            const sel = selection?.kind === 'title' && selection.id === t.id;
            const w = Math.max(4, ticksToSeconds(t.duration) * h.pps);
            return (
              <div
                key={t.id}
                className={`tclip${sel ? ' selected' : ''}`}
                style={{ left: h.tToX(t.start), width: w }}
                onPointerDown={(e) => drag(e, t, 'move')}
                title={`${t.text} — ${formatDuration(t.duration)}. Drag to move (up/down for another row); edges change the timing.`}
              >
                <span className="tclip-label">T&nbsp; {t.text.replace(/\n/g, ' · ') || '(empty)'}</span>
                <div className="trim-handle left" onPointerDown={(e) => drag(e, t, 'start')} title="Drag to change the start" />
                <div className="trim-handle right" onPointerDown={(e) => drag(e, t, 'end')} title="Drag to change the end" />
              </div>
            );
          })}
          <div className="tl-past-end" style={{ left: endX }} title="After the end of the video: not exported" />
        </div>
      ))}
    </div>
  );
}
