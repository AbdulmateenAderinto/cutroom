import { useEffect, useState } from 'react';
import { CANVAS_PRESETS, type CanvasPreset } from '../../shared/model';
import * as A from '../state/actions';
import { isDirty, store, useStore } from '../state/store';

const mod = () => (window.cutroom.platform === 'darwin' ? '⌘' : 'Ctrl+');

export function CanvasControl() {
  const canvas = useStore((s) => s.project.canvas);
  const [w, setW] = useState(String(canvas.width));
  const [h, setH] = useState(String(canvas.height));
  useEffect(() => {
    setW(String(canvas.width));
    setH(String(canvas.height));
  }, [canvas.width, canvas.height]);
  const applyCustom = () => {
    const width = Number(w);
    const height = Number(h);
    if (width >= 16 && height >= 16) A.applyCanvasPreset('custom', { width, height });
    else {
      setW(String(canvas.width));
      setH(String(canvas.height));
    }
  };
  return (
    <div className="canvas-control" title="Canvas: the shape and size of your video. Clips keep their framing (Fit/Fill/Manual) when it changes.">
      <span className="label">Canvas</span>
      <select
        className="input"
        value={canvas.preset}
        onChange={(e) => A.applyCanvasPreset(e.target.value as CanvasPreset)}
        aria-label="Canvas preset"
      >
        {CANVAS_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      <input
        className="input mono dim"
        aria-label="Canvas width"
        title="Width in pixels (even numbers; H.264 requires it)"
        value={w}
        onChange={(e) => setW(e.target.value.replace(/\D/g, ''))}
        onBlur={applyCustom}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <span className="muted">×</span>
      <input
        className="input mono dim"
        aria-label="Canvas height"
        title="Height in pixels (even numbers)"
        value={h}
        onChange={(e) => setH(e.target.value.replace(/\D/g, ''))}
        onBlur={applyCustom}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </div>
  );
}

function AiControlButton() {
  const [on, setOn] = useState<boolean | null>(null);
  const dialog = useStore((s) => s.dialog);
  useEffect(() => {
    window.cutroom.aiStatus().then((st) => setOn(st.running));
  }, [dialog]);
  return (
    <button className="btn ghost ai-btn" onClick={() => store.set({ dialog: 'ai' })} title="Let Claude edit with you through MCP">
      <span className={`ai-dot${on ? ' on' : ''}`} /> AI control{on ? ': on' : ''}
    </button>
  );
}

export function TopBar() {
  const name = useStore((s) => s.project.name);
  const path = useStore((s) => s.projectPath);
  const dirty = useStore(isDirty);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const hasClips = useStore((s) => s.project.sequence.items.some((i) => i.kind === 'clip'));
  const m = mod();
  return (
    <header className="topbar">
      <div className="brand" aria-hidden>
        <span className="logo">◩</span> Cutroom
      </div>
      <div className="group">
        <button className="btn" onClick={A.newProject} title={`New project (${m}N)`}>New</button>
        <button className="btn" onClick={() => A.openProject()} title={`Open a project (${m}O)`}>Open…</button>
        <button className="btn" onClick={() => A.saveProject()} title={`Save (${m}S). Save As: ${m}⇧S`}>Save</button>
        <button className="btn" onClick={() => store.set({ dialog: 'versions' })} title="Save a named version of the project, or go back to one">Versions…</button>
      </div>
      <div className="project-name" title={path ?? 'Not saved yet'}>
        {name}
        {dirty && <span className="dirty-dot" title="Unsaved changes">●</span>}
      </div>
      <div className="group">
        <button className="btn" disabled={!canUndo} onClick={A.doUndo} title={`Undo (${m}Z)`}>↶ Undo</button>
        <button className="btn" disabled={!canRedo} onClick={A.doRedo} title={`Redo (${m}⇧Z)`}>↷ Redo</button>
      </div>
      <div className="spacer" />
      <CanvasControl />
      <AiControlButton />
      <QueueButton />
      <button className="btn ghost" onClick={() => store.set({ dialog: 'shortcuts' })} title="Keyboard shortcuts (?)">
        Shortcuts
      </button>
      <button
        className="btn primary"
        disabled={!hasClips}
        onClick={() => store.set({ dialog: 'export' })}
        title={hasClips ? `Export an MP4 (${m}E)` : 'Add clips to the timeline to export'}
      >
        Export…
      </button>
    </header>
  );
}

/** Shown once something has been queued: how many exports are left, and the running one's progress. */
function QueueButton() {
  const left = useStore((s) => s.exportQueue.filter((q) => q.status === 'waiting' || q.status === 'running').length);
  const total = useStore((s) => s.exportQueue.length);
  const pct = useStore((s) => {
    const run = s.exportQueue.find((q) => q.status === 'running');
    return run ? Math.round((run.progress?.fraction ?? 0) * 100) : null;
  });
  if (!total) return null;
  return (
    <button className="btn ghost" onClick={() => store.set({ dialog: 'queue' })} title="Export queue">
      Queue {left ? `${left} left${pct !== null ? ` · ${pct}%` : ''}` : '✓'}
    </button>
  );
}
