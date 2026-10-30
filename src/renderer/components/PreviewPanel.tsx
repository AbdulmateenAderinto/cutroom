import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { evalAnimation } from '../../shared/animation';
import { type ClipItem, type LaidOutItem, animateRect, clipSpeed, computeClipRect, findMedia, layoutSequence, toManualFraming } from '../../shared/model';
import { asClip, overlayLayout, overlaysAt } from '../../shared/overlays';
import { setFraming } from '../../shared/ops';
import { formatTimecode } from '../../shared/time';
import { OverlayLayer, TitleHandles } from '../captions/OverlayLayer';
import { engine } from '../preview/engine';
import * as A from '../state/actions';
import { usePlayhead } from '../state/playhead';
import { beginGesture, endGesture, store, updateGesture, useStore } from '../state/store';

function useStageSize(wrap: React.RefObject<HTMLDivElement | null>, aspect: number) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const update = () => {
      const pad = 24;
      const W = Math.max(0, el.clientWidth - pad);
      const H = Math.max(0, el.clientHeight - pad);
      const w = Math.min(W, H * aspect);
      setSize({ w: Math.floor(w), h: Math.floor(w / aspect) });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [wrap, aspect]);
  return size;
}

interface Target {
  clip: ClipItem;
  lay: LaidOutItem;
  overlay: boolean;
}

/**
 * Clips in the picture at the playhead (not in source preview), topmost first: overlay-track clips
 * (highest track first), then the main-track clip.
 */
function useTargetsUnderPlayhead(): Target[] {
  const project = useStore((s) => s.project);
  const sourceMode = useStore((s) => s.previewMediaId !== null);
  const time = usePlayhead((p) => p.time);
  if (sourceMode) return [];
  const out: Target[] = overlaysAt(project, time).reverse().map((o) => ({ clip: asClip(o), lay: overlayLayout(o), overlay: true }));
  const lay = layoutSequence(project);
  const hit = lay.items.find((l) => time >= l.start && time < l.end) ?? (time >= lay.duration ? lay.items[lay.items.length - 1] : undefined);
  if (hit?.item.kind === 'clip') out.push({ clip: hit.item, lay: hit, overlay: false });
  return out;
}

export function PreviewPanel() {
  const wrap = useRef<HTMLDivElement>(null);
  const va = useRef<HTMLVideoElement>(null);
  const vb = useRef<HTMLVideoElement>(null);
  const im = useRef<HTMLImageElement>(null);
  const tv = useRef<HTMLVideoElement>(null);
  const timg = useRef<HTMLImageElement>(null);
  const dip = useRef<HTMLDivElement>(null);
  const ovl = useRef<HTMLDivElement>(null);
  const project = useStore((s) => s.project);
  const previewMediaId = useStore((s) => s.previewMediaId);
  const snapping = useStore((s) => s.snapping);
  const playing = usePlayhead((p) => p.playing);
  const time = usePlayhead((p) => p.time);
  const [offline, setOffline] = useState<string | null>(null);
  const [preparingId, setPreparing] = useState<string | null>(null);
  const preparing = useStore((s) => (preparingId ? s.proxies[preparingId] : undefined));
  const preparingName = preparingId ? findMedia(project, preparingId)?.name : undefined;
  const sourceMedia = previewMediaId ? findMedia(project, previewMediaId) : undefined;
  const canvas = sourceMedia
    ? { width: sourceMedia.info.displayWidth, height: sourceMedia.info.displayHeight }
    : project.canvas;
  const size = useStageSize(wrap, canvas.width / canvas.height);
  const targets = useTargetsUnderPlayhead();
  const selectedId = useStore((s) => (s.selection?.kind === 'item' || s.selection?.kind === 'overlay' ? s.selection.id : null));
  // The clip the framing handles act on: the selected one if it is in the picture, else the main clip.
  const active = targets.find((x) => x.clip.id === selectedId) ?? targets.find((x) => !x.overlay) ?? null;
  const clip = active?.clip ?? null;

  useEffect(() => {
    engine.onOffline = setOffline;
    engine.onPreparing = setPreparing;
    engine.attach(va.current!, vb.current!, im.current!, { tv: tv.current!, timg: timg.current!, dip: dip.current!, overlays: ovl.current! });
    return () => engine.detach();
  }, []);

  const duration = engine.duration;
  const rate = engine.project.frameRate;

  // --- Direct manipulation of framing (drag to move, corner handle to scale) ---
  const media = clip ? findMedia(project, clip.mediaId) : undefined;
  /** Where a target is drawn at the playhead (framing + animation, as the engine draws it). */
  const rectOf = (x: Target) => {
    const m = findMedia(project, x.clip.mediaId);
    if (!m) return null;
    const base = computeClipRect(m.info.displayWidth, m.info.displayHeight, canvas.width, canvas.height, x.clip.framing);
    const d = x.lay.end - x.lay.start;
    return animateRect(base, evalAnimation(x.clip.animation, Math.min(Math.max(0, time - x.lay.start), d), d, x.clip.sourceIn, clipSpeed(x.clip)), canvas.width, canvas.height);
  };
  const rect = active ? rectOf(active) : null;
  const k = size.w / canvas.width; // canvas px → screen px
  const showOverlay = !!(clip && rect && !playing && selectedId === clip.id);

  const startDrag = (e: React.PointerEvent, kind: 'move' | 'scale') => {
    if (!clip || !media || playing) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const { width: cw, height: ch } = project.canvas;
    const startFraming = toManualFraming(media.info.displayWidth, media.info.displayHeight, cw, ch, clip.framing);
    const r0 = computeClipRect(media.info.displayWidth, media.info.displayHeight, cw, ch, startFraming);
    const stage = (target.closest('.stage-outer') as HTMLElement).getBoundingClientRect();
    const centre = { x: stage.left + (r0.x + r0.w / 2) * k, y: stage.top + (r0.y + r0.h / 2) * k };
    const dist0 = Math.hypot(e.clientX - centre.x, e.clientY - centre.y) || 1;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const id = clip.id;
    store.set({ selection: { kind: active?.overlay ? 'overlay' : 'item', id } });
    beginGesture();
    const move = (ev: PointerEvent) => {
      let f = { ...startFraming };
      if (kind === 'move') {
        f.x = startFraming.x + (ev.clientX - x0) / size.w;
        f.y = startFraming.y + (ev.clientY - y0) / size.h;
        if (snapping && !ev.altKey) {
          if (Math.abs(f.x) * size.w < 6) f.x = 0;
          if (Math.abs(f.y) * size.h < 6) f.y = 0;
        }
      } else {
        const d = Math.hypot(ev.clientX - centre.x, ev.clientY - centre.y);
        f.scale = Math.max(0.05, Math.min(20, startFraming.scale * (d / dist0)));
      }
      updateGesture((p) => setFraming(p, id, f));
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      endGesture();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };

  const onStagePointerDown = (e: React.PointerEvent) => {
    if (playing) return;
    const stage = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = (e.clientX - stage.left) / k;
    const y = (e.clientY - stage.top) / k;
    // The topmost clip under the pointer (an overlay above the main track).
    const hit = targets.find((tg) => {
      const r = rectOf(tg);
      return r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
    });
    if (!hit) return;
    if (selectedId !== hit.clip.id) {
      store.set({ selection: { kind: hit.overlay ? 'overlay' : 'item', id: hit.clip.id } });
      return;
    }
    startDrag(e, 'move');
  };

  return (
    <main className="panel preview">
      <header className="panel-head">
        <h2>{sourceMedia ? <>Source: <span className="accent">{sourceMedia.name}</span></> : 'Timeline preview'}</h2>
        {sourceMedia && (
          <div className="row gap">
            <button className="btn small" onClick={() => A.addMediaToTimeline(sourceMedia.id)}>+ Add to timeline</button>
            <button className="btn small" onClick={() => store.set({ previewMediaId: null })} title="Esc">Back to timeline</button>
          </div>
        )}
        {!sourceMedia && <span className="muted small">{project.canvas.width}×{project.canvas.height}</span>}
      </header>
      <div className="stage-wrap" ref={wrap}>
        {/* The outer box is not clipped, so the framing outline and scale handle stay reachable
            when a clip is larger than the canvas. The inner .stage clips the picture like the export. */}
        <div className="stage-outer" style={{ width: size.w, height: size.h }} onPointerDown={onStagePointerDown}>
          <div className="stage" style={{ background: sourceMedia ? '#000' : project.background }}>
            <video ref={va} className="stage-video" />
            <video ref={vb} className="stage-video" />
            <img ref={im} className="stage-video" alt="" />
            {/* Transition layers: the other clip of a crossfade, and the colour of a dip. */}
            <video ref={tv} className="stage-video transition-video" />
            <img ref={timg} className="stage-video" alt="" />
            <div ref={dip} className="stage-dip" />
            <div ref={ovl} className="stage-overlays" />
            {!sourceMedia && <OverlayLayer project={project} width={size.w} height={size.h} />}
            {preparingId && !offline && (
              <div className="stage-message">
                <strong>{preparing?.status === 'failed' ? 'No preview for this file' : `Preparing a preview… ${Math.round((preparing?.fraction ?? 0) * 100)}%`}</strong>
                <span>
                  {preparing?.status === 'failed'
                    ? `${preparingName}: ${preparing.error ?? 'the preview copy could not be made'}. The export still uses the original.`
                    : `${preparingName} is in a format the preview can't play directly, so a lighter copy is being made (once). The export uses the original.`}
                </span>
              </div>
            )}
            {offline && (
              <div className="stage-message">
                <strong>Media offline</strong>
                <span>{offline} could not be found. Relink it in the Media panel.</span>
              </div>
            )}
            {!sourceMedia && duration === 0 && (
              <div className="stage-message">
                <strong>Your timeline is empty</strong>
                <span>Import videos, then click “+ Add to timeline” or drag them onto the timeline below.</span>
              </div>
            )}
          </div>
          {showOverlay && rect && (
            <div
              className="frame-overlay"
              style={{ left: rect.x * k, top: rect.y * k, width: rect.w * k, height: rect.h * k }}
              onPointerDown={(e) => startDrag(e, 'move')}
              title="Drag to reposition (switches framing to Manual). Alt disables centre snapping."
            >
              <div className="frame-handle" onPointerDown={(e) => startDrag(e, 'scale')} title="Drag to scale" />
            </div>
          )}
          {!sourceMedia && <TitleHandles project={project} width={size.w} height={size.h} playing={playing} />}
        </div>
      </div>
      <footer className="transport">
        <button className="btn" onClick={A.seekToStart} title="Go to start (Home)">⏮</button>
        <button className="btn" onClick={() => engine.step(-1)} title="Previous frame (←). Shift+← = 10 frames">◀ 1f</button>
        <button className="btn primary play" onClick={() => engine.toggle()} title="Play / Pause (Space)">
          {playing ? '❚❚ Pause' : '▶ Play'}
        </button>
        <button className="btn" onClick={() => engine.step(1)} title="Next frame (→). Shift+→ = 10 frames">1f ▶</button>
        <button className="btn" onClick={A.seekToEnd} title="Go to end (End)">⏭</button>
        <span className="timecode mono" title="Current time / total (HH:MM:SS:frames)">
          {formatTimecode(time, rate)} <span className="muted">/ {formatTimecode(duration, rate)}</span>
        </span>
      </footer>
    </main>
  );
}
