/**
 * Timeline: one magnetic video track (clips play back-to-back; audio travels with each clip).
 *
 * Mouse:
 *   - click a clip to select it; drag its body to reorder
 *   - drag a clip's left/right edge to trim (later clips ripple)
 *   - click/drag the ruler to move the playhead
 *   - drop media from the Media panel to insert it
 * Snapping (toggle in the toolbar, or N) pulls edges and the playhead to cut points and the playhead.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { type LaidOutItem, type TrackItem, findMedia, itemDuration, layoutSequence } from '../../shared/model';
import * as ops from '../../shared/ops';
import { type Ticks, formatDuration, formatTimecode, secondsToTicks, snapToFrame, ticksToSeconds } from '../../shared/time';
import { engine } from '../preview/engine';
import * as A from '../state/actions';
import { playhead, usePlayhead } from '../state/playhead';
import { beginGesture, commit, endGesture, store, updateGesture, useStore } from '../state/store';
import { MEDIA_DRAG_TYPE } from './MediaBin';

const PAD = 16; // px before time zero
const SNAP_PX = 8;
const TICK_STEPS = [1 / 30, 1 / 10, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];

function useScrollState(ref: React.RefObject<HTMLDivElement | null>) {
  const [state, setState] = useState({ left: 0, width: 1000 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setState({ left: el.scrollLeft, width: el.clientWidth });
    update();
    el.addEventListener('scroll', update);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [ref]);
  return state;
}

export function Timeline() {
  const project = useStore((s) => s.project);
  const pps = useStore((s) => s.pxPerSecond);
  const snapping = useStore((s) => s.snapping);
  const selection = useStore((s) => s.selection);
  const thumbs = useStore((s) => s.thumbs);
  const missing = useStore((s) => s.missing);
  const trimPreview = useStore((s) => s.trimPreview);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scroll = useScrollState(scrollRef);
  const lay = useMemo(() => layoutSequence(project), [project]);
  const rate = project.frameRate;
  const [drag, setDrag] = useState<{ id: string; x: number; dx: number; index: number } | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const tToX = (t: Ticks) => PAD + ticksToSeconds(t) * pps;
  const xToT = (x: number) => secondsToTicks(Math.max(0, x - PAD) / pps);
  const contentWidth = Math.max(scroll.width, tToX(lay.duration) + 400);

  const contentX = (clientX: number) => {
    const el = scrollRef.current!;
    return clientX - el.getBoundingClientRect().left + el.scrollLeft;
  };

  /** Snap a timeline time to nearby cut points / the playhead (when snapping is on). */
  const snapTime = (t: Ticks, targets: Ticks[], bypass: boolean): Ticks => {
    if (!snapping || bypass) return t;
    let best = t;
    let bestPx = SNAP_PX;
    for (const target of targets) {
      const px = Math.abs(ticksToSeconds(target - t) * pps);
      if (px < bestPx) {
        bestPx = px;
        best = target;
      }
    }
    return best;
  };
  const cutPoints = (exclude?: string) => {
    const pts: Ticks[] = [0, lay.duration];
    for (const l of lay.items) if (l.item.id !== exclude) pts.push(l.start, l.end);
    return pts;
  };

  const insertionIndex = (t: Ticks) => lay.items.filter((l) => (l.start + l.end) / 2 < t).length;

  // --- Playhead scrubbing on the ruler ---
  const onRulerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const seekTo = (clientX: number, alt: boolean) => {
      const t = snapTime(xToT(contentX(clientX)), cutPoints(), alt);
      engine.seek(Math.min(snapToFrame(t, rate, 'round'), lay.duration));
    };
    if (store.get().previewMediaId) store.set({ previewMediaId: null });
    seekTo(e.clientX, e.altKey);
    const move = (ev: PointerEvent) => seekTo(ev.clientX, ev.altKey);
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };

  // --- Trim by dragging clip edges ---
  const onEdgeDown = (e: React.PointerEvent, l: LaidOutItem, edge: 'start' | 'end') => {
    e.preventDefault();
    e.stopPropagation();
    const item = l.item;
    store.set({ selection: { kind: 'item', id: item.id } });
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const targets = [...cutPoints(item.id), playhead.get().time];
    beginGesture();
    const base = store.get().project;
    const move = (ev: PointerEvent) => {
      let dx = secondsToTicks((ev.clientX - x0) / pps);
      if (edge === 'start') {
        dx = snapTime(l.start + dx, targets, ev.altKey) - l.start;
        if (item.kind === 'gap') {
          updateGesture((p) => ops.setGapDuration(p, item.id, item.duration - dx));
          return;
        }
        const next = ops.trimEdge(base, item.id, 'start', dx);
        const c = next.sequence.items.find((i) => i.id === item.id);
        // Keep the right-hand part of the timeline still while dragging; it ripples on release.
        const applied = c ? itemDuration(item) - itemDuration(c) : 0;
        updateGesture(() => next, { trimPreview: { id: item.id, offset: applied } });
      } else {
        dx = snapTime(l.end + dx, targets, ev.altKey) - l.end;
        if (item.kind === 'gap') updateGesture((p) => ops.setGapDuration(p, item.id, item.duration + dx));
        else updateGesture((p) => ops.trimEdge(p, item.id, 'end', dx));
      }
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      endGesture({ trimPreview: null });
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };

  // --- Select / reorder by dragging the clip body ---
  const onClipDown = (e: React.PointerEvent, l: LaidOutItem) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    store.set({ selection: { kind: 'item', id: l.item.id }, previewMediaId: null });
    const x0 = e.clientX;
    let active = false;
    let index = l.index;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      if (!active && Math.abs(dx) < 4) return;
      active = true;
      index = insertionIndex(xToT(contentX(ev.clientX)));
      setDrag({ id: l.item.id, x: tToX(l.start), dx, index });
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      setDrag(null);
      if (active && index !== l.index && index !== l.index + 1) commit((p) => ops.moveItem(p, l.item.id, index));
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };

  // --- Drop media from the bin ---
  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(MEDIA_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDropIndex(insertionIndex(xToT(contentX(e.clientX))));
  };
  const onDrop = (e: React.DragEvent) => {
    const id = e.dataTransfer.getData(MEDIA_DRAG_TYPE);
    setDropIndex(null);
    if (!id) return;
    e.preventDefault();
    A.addMediaToTimeline(id, insertionIndex(xToT(contentX(e.clientX))));
  };

  // Wheel: scroll horizontally; with ⌘/Ctrl, zoom around the pointer.
  useEffect(() => {
    const el = scrollRef.current!;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const x = e.clientX - el.getBoundingClientRect().left;
        const tAt = (el.scrollLeft + x - PAD) / store.get().pxPerSecond;
        A.zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15);
        requestAnimationFrame(() => (el.scrollLeft = tAt * store.get().pxPerSecond + PAD - x));
      } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const markerIndex = drag ? drag.index : dropIndex;
  const markerX = markerIndex === null ? null : tToX(markerIndex < lay.items.length ? lay.items[markerIndex].start : lay.duration);
  const selectedId = selection?.kind === 'item' ? selection.id : null;
  const hasSelection = !!selectedId;
  const previewIdx = trimPreview ? lay.items.findIndex((l) => l.item.id === trimPreview.id) : -1;

  return (
    <section className="timeline">
      <div className="tl-toolbar">
        <button className="btn small" onClick={A.splitAtPlayhead} title="Split the clip under the playhead (S or ⌘B)">✂ Split</button>
        <button className="btn small" onClick={A.duplicateSelected} disabled={!hasSelection} title="Duplicate the selected clip (⌘D)">Duplicate</button>
        <button className="btn small" onClick={() => A.deleteSelected('close-gap')} disabled={!hasSelection} title="Delete and close the gap (Delete)">Delete</button>
        <button className="btn small" onClick={() => A.deleteSelected('leave-gap')} disabled={!hasSelection} title="Delete but keep the space as a gap (Shift+Delete)">Delete, leave gap</button>
        <span className="sep" />
        <label className="check" title="Snap edges and the playhead to cut points (N). Hold Alt while dragging to bypass.">
          <input type="checkbox" checked={snapping} onChange={(e) => store.set({ snapping: e.target.checked })} />
          Snapping
        </label>
        <span className="spacer" />
        <span className="muted small">Total {formatTimecode(lay.duration, rate)}</span>
        <span className="sep" />
        <span className="muted small">Zoom</span>
        <button className="btn tiny" onClick={() => A.zoomBy(0.8)} title="Zoom out (−)">−</button>
        <input
          type="range"
          className="slider zoom"
          min={0}
          max={100}
          value={Math.round((Math.log(pps / 2) / Math.log(300)) * 100)}
          onChange={(e) => store.set({ pxPerSecond: 2 * Math.pow(300, Number(e.target.value) / 100) })}
          aria-label="Timeline zoom"
        />
        <button className="btn tiny" onClick={() => A.zoomBy(1.25)} title="Zoom in (+)">+</button>
        <button className="btn tiny" onClick={() => A.zoomToFit(scroll.width)} title="Fit the whole timeline in view">Fit</button>
      </div>
      <div className="tl-scroll" ref={scrollRef}>
        <div className="tl-content" style={{ width: contentWidth }}>
          <Ruler pps={pps} scrollLeft={scroll.left} width={scroll.width} rate={rate} onPointerDown={onRulerDown} />
          <div className="tl-track" onDragOver={onDragOver} onDragLeave={() => setDropIndex(null)} onDrop={onDrop}>
            {lay.items.length === 0 && (
              <div className="tl-empty">Drag media here, or use “+ Add to timeline” in the Media panel.</div>
            )}
            {lay.items.map((l) => {
              const offset = trimPreview && previewIdx >= 0 && l.index >= previewIdx ? trimPreview.offset : 0;
              return (
                <ClipBlock
                  key={l.item.id}
                  l={l}
                  x={tToX(l.start + offset)}
                  w={Math.max(2, ticksToSeconds(l.end - l.start) * pps)}
                  selected={selectedId === l.item.id}
                  dragging={drag?.id === l.item.id}
                  name={l.item.kind === 'clip' ? findMedia(project, l.item.mediaId)?.name ?? '?' : 'Gap'}
                  thumb={l.item.kind === 'clip' ? thumbs[l.item.mediaId] : undefined}
                  offline={l.item.kind === 'clip' && !!missing[l.item.mediaId]}
                  onDown={(e) => onClipDown(e, l)}
                  onEdge={(e, edge) => onEdgeDown(e, l, edge)}
                />
              );
            })}
            {drag && (
              <div className="clip-ghost" style={{ left: drag.x + drag.dx, width: Math.max(2, ticksToSeconds(itemDuration(lay.items.find((l) => l.item.id === drag.id)!.item)) * pps) }} />
            )}
            {markerX !== null && <div className="insert-marker" style={{ left: markerX - 1 }} />}
          </div>
          <Playhead pps={pps} scrollRef={scrollRef} />
        </div>
      </div>
    </section>
  );
}

function ClipBlock(props: {
  l: LaidOutItem;
  x: number;
  w: number;
  selected: boolean;
  dragging: boolean;
  name: string;
  thumb?: string;
  offline: boolean;
  onDown: (e: React.PointerEvent) => void;
  onEdge: (e: React.PointerEvent, edge: 'start' | 'end') => void;
}) {
  const item: TrackItem = props.l.item;
  const isGap = item.kind === 'gap';
  const audio = item.kind === 'clip' ? (item.muted ? ' · muted' : item.volume < 1 ? ` · ${Math.round(item.volume * 100)}%` : '') : '';
  return (
    <div
      className={`clip${isGap ? ' gap' : ''}${props.selected ? ' selected' : ''}${props.dragging ? ' dragging' : ''}${props.offline ? ' offline' : ''}`}
      style={{
        left: props.x,
        width: props.w,
        backgroundImage: props.thumb ? `url(${props.thumb})` : undefined,
      }}
      onPointerDown={props.onDown}
      title={`${props.name} — ${formatDuration(props.l.end - props.l.start)}. Drag to reorder; drag edges to trim.`}
    >
      <div className="clip-label">
        <span className="clip-name">{props.offline ? '⚠ ' : ''}{props.name}</span>
        <span className="clip-dur">{formatDuration(props.l.end - props.l.start)}{audio}</span>
      </div>
      <div className="trim-handle left" onPointerDown={(e) => props.onEdge(e, 'start')} title="Drag to trim the start" />
      <div className="trim-handle right" onPointerDown={(e) => props.onEdge(e, 'end')} title="Drag to trim the end" />
    </div>
  );
}

function Ruler(props: { pps: number; scrollLeft: number; width: number; rate: { num: number; den: number }; onPointerDown: (e: React.PointerEvent) => void }) {
  const { pps } = props;
  const step = TICK_STEPS.find((s) => s * pps >= 70) ?? 3600;
  const minor = step / 5;
  const t0 = Math.max(0, Math.floor((props.scrollLeft - PAD) / pps / step) * step);
  const t1 = (props.scrollLeft + props.width) / pps + step;
  const marks: { x: number; label?: string }[] = [];
  for (let t = t0; t <= t1; t += minor) {
    const isMajor = Math.abs(t / step - Math.round(t / step)) < 1e-6;
    const label = isMajor ? (step < 1 ? formatTimecode(secondsToTicks(t), props.rate).slice(3) : formatClock(t)) : undefined;
    marks.push({ x: PAD + t * pps, label });
  }
  return (
    <div className="tl-ruler" onPointerDown={props.onPointerDown} title="Click or drag to move the playhead">
      {marks.map((m, i) => (
        <div key={i} className={`tick${m.label ? ' major' : ''}`} style={{ left: m.x }}>
          {m.label && <span>{m.label}</span>}
        </div>
      ))}
    </div>
  );
}

function formatClock(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.round(s - m * 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function Playhead(props: { pps: number; scrollRef: React.RefObject<HTMLDivElement | null> }) {
  const time = usePlayhead((p) => p.time);
  const playing = usePlayhead((p) => p.playing);
  const sourceMode = useStore((s) => s.previewMediaId !== null);
  const x = PAD + ticksToSeconds(time) * props.pps;
  useEffect(() => {
    const el = props.scrollRef.current;
    if (!el || !playing) return;
    if (x > el.scrollLeft + el.clientWidth - 60 || x < el.scrollLeft) el.scrollLeft = x - 60;
  }, [x, playing, props.scrollRef]);
  if (sourceMode) return null;
  return (
    <div className="playhead" style={{ left: x }}>
      <div className="playhead-head" />
    </div>
  );
}

