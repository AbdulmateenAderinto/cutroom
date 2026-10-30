import { useEffect, useMemo, useRef } from 'react';
import type { Project } from '../../shared/model';
import { setTitleStyle, titlesAt } from '../../shared/titles';
import { usePlayhead } from '../state/playhead';
import { beginGesture, endGesture, store, updateGesture, useStore } from '../state/store';
import { drawOverlay, overlayCues, titleBounds } from './draw';

/** Live captions and titles over the preview, drawn with the same code the exporter uses. */
export function OverlayLayer({ project, width, height }: { project: Project; width: number; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const time = usePlayhead((p) => p.time);
  const cues = useMemo(() => overlayCues(project), [project]);
  const dpr = window.devicePixelRatio || 1;
  const hasTitles = !!project.titles?.length;
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    const w = Math.round(width * dpr);
    const h = Math.round(height * dpr);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    drawOverlay(ctx, w, h, project, time, cues);
  }, [project, cues, time, width, height, dpr]);
  if (!cues.length && !hasTitles) return null;
  return <canvas ref={ref} className="caption-layer" style={{ width, height }} />;
}

let measure: CanvasRenderingContext2D | null = null;

/**
 * Invisible hit areas over the titles on screen: click to select a title, drag to move it.
 * Rendered above the clip framing handles so titles can be grabbed even over a selected clip.
 */
export function TitleHandles({ project, width, height, playing }: { project: Project; width: number; height: number; playing: boolean }) {
  const time = usePlayhead((p) => p.time);
  const selection = useStore((s) => s.selection);
  const snapping = useStore((s) => s.snapping);
  if (playing) return null;
  measure ??= document.createElement('canvas').getContext('2d');
  const visible = titlesAt(project, time);
  if (!measure || !visible.length) return null;

  const startDrag = (e: React.PointerEvent, id: string, x0f: number, y0f: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    store.set({ selection: { kind: 'title', id } });
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const cx = e.clientX;
    const cy = e.clientY;
    let started = false;
    const move = (ev: PointerEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - cx, ev.clientY - cy) < 3) return;
        started = true;
        beginGesture();
      }
      let x = x0f + (ev.clientX - cx) / width;
      let y = y0f + (ev.clientY - cy) / height;
      if (snapping && !ev.altKey) {
        if (Math.abs(x - 0.5) * width < 6) x = 0.5;
        if (Math.abs(y - 0.5) * height < 6) y = 0.5;
      }
      updateGesture((p) => setTitleStyle(p, id, { x, y }));
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      if (started) endGesture();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };

  return (
    <>
      {visible.map(({ title }) => {
        const b = titleBounds(measure!, title, width, height);
        const sel = selection?.kind === 'title' && selection.id === title.id;
        return (
          <div
            key={title.id}
            className={`title-hit${sel ? ' selected' : ''}`}
            style={{ left: b.x - 4, top: b.y - 4, width: b.w + 8, height: b.h + 8 }}
            onPointerDown={(e) => startDrag(e, title.id, title.style.x, title.style.y)}
            onDoubleClick={() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Title text"]')?.focus()}
            title="Drag to move (Alt: no centre snapping). Double-click to edit the text."
          />
        );
      })}
    </>
  );
}
