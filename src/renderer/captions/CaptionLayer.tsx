import { useEffect, useMemo, useRef } from 'react';
import { activeWord, buildCues, cueAt } from '../../shared/captions';
import type { Project } from '../../shared/model';
import { usePlayhead } from '../state/playhead';
import { drawCue } from './draw';

/** Live captions over the preview, drawn with the same code the exporter uses. */
export function CaptionLayer({ project, width, height }: { project: Project; width: number; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const time = usePlayhead((p) => p.time);
  const s = project.captions;
  const cues = useMemo(() => (s?.enabled ? buildCues(project, s) : []), [project, s]);
  const dpr = window.devicePixelRatio || 1;
  const cue = cueAt(cues, time);
  const active = cue && s?.highlight ? activeWord(cue, time) : -1;
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
    if (!cue || !s) ctx.clearRect(0, 0, w, h);
    else drawCue(ctx, w, h, cue, s, active);
  }, [cue, active, s, width, height, dpr]);
  if (!s?.enabled || !cues.length) return null;
  return <canvas ref={ref} className="caption-layer" style={{ width, height }} />;
}
