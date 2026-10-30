/**
 * Timeline markers drawn on the ruler. Click one to go to it and select it (its name and colour
 * are edited in the inspector); drag it to move it.
 */
import { MARKER_COLORS, updateMarker } from '../../shared/markers';
import type { Marker } from '../../shared/model';
import { formatTimecode, secondsToTicks } from '../../shared/time';
import { engine } from '../preview/engine';
import { beginGesture, endGesture, store, updateGesture, useStore } from '../state/store';

const NONE: Marker[] = [];

export function MarkerFlags(props: { tToX: (t: number) => number; pps: number; snap: (t: number, alt: boolean, exclude?: string) => number }) {
  const list = useStore((s) => s.project.markers ?? NONE);
  const selection = useStore((s) => s.selection);
  const rate = useStore((s) => s.project.frameRate);
  if (!list.length) return null;

  const down = (e: React.PointerEvent, m: Marker) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    store.set({ selection: { kind: 'marker', id: m.id }, previewMediaId: null });
    engine.seek(m.time);
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    let started = false;
    const move = (ev: PointerEvent) => {
      if (!started) {
        if (Math.abs(ev.clientX - x0) < 3) return;
        started = true;
        beginGesture();
      }
      const t = Math.max(0, props.snap(m.time + secondsToTicks((ev.clientX - x0) / props.pps), ev.altKey));
      updateGesture((p) => updateMarker(p, m.id, { time: t }));
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      if (started) {
        endGesture();
        const moved = store.get().project.markers?.find((x) => x.id === m.id);
        if (moved) engine.seek(moved.time);
      }
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };

  return (
    <>
      {list.map((m) => {
        const sel = selection?.kind === 'marker' && selection.id === m.id;
        const hex = MARKER_COLORS.find((c) => c.id === m.color)?.hex ?? '#f5c542';
        return (
          <div
            key={m.id}
            className={`tl-marker${sel ? ' selected' : ''}`}
            data-marker-id={m.id}
            style={{ left: props.tToX(m.time), ['--marker' as string]: hex }}
            onPointerDown={(e) => down(e, m)}
            title={`${m.label} — ${formatTimecode(m.time, rate)}. Click to go there; drag to move.`}
          >
            <span className="tl-marker-flag" />
            <span className="tl-marker-label">{m.label}</span>
          </div>
        );
      })}
    </>
  );
}
