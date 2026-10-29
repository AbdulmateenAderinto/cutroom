/**
 * Draws captions with Canvas 2D. The preview draws live with this code, and export renders the
 * very same function into PNG images that FFmpeg overlays, so captions look identical in both.
 */
import { type CaptionSettings, type Cue, activeWord, buildCues } from '../../shared/captions';
import type { CaptionTrack } from '../../shared/exportPlan';
import type { Project } from '../../shared/model';
import { ticksToSeconds } from '../../shared/time';

const FONT_STACK = '"Inter", "SF Pro Display", -apple-system, "Helvetica Neue", Arial, sans-serif';

interface Laid {
  text: string;
  x: number;
  y: number;
  index: number;
}

function layout(ctx: CanvasRenderingContext2D, cue: Cue, s: CaptionSettings, w: number, h: number) {
  const size = (s.fontSize / 100) * h;
  ctx.font = `800 ${size}px ${FONT_STACK}`;
  const maxWidth = w * 0.86;
  const space = ctx.measureText(' ').width;
  const words = cue.words.map((wd) => (s.uppercase ? wd.text.toUpperCase() : wd.text));
  const lines: { words: { text: string; width: number; index: number }[]; width: number }[] = [];
  let line: (typeof lines)[number] = { words: [], width: 0 };
  words.forEach((text, index) => {
    const width = ctx.measureText(text).width;
    const add = (line.words.length ? space : 0) + width;
    if (line.words.length && line.width + add > maxWidth) {
      lines.push(line);
      line = { words: [], width: 0 };
    }
    line.width += (line.words.length ? space : 0) + width;
    line.words.push({ text, width, index });
  });
  if (line.words.length) lines.push(line);
  const lineH = size * 1.22;
  const top = s.position * h - (lines.length * lineH) / 2;
  const laid: Laid[] = [];
  lines.forEach((ln, li) => {
    let x = (w - ln.width) / 2;
    const y = top + li * lineH + lineH / 2;
    for (const wd of ln.words) {
      laid.push({ text: wd.text, x, y, index: wd.index });
      x += wd.width + space;
    }
  });
  return { laid, lines, size, lineH, top, space };
}

/** Draw one cue onto a w×h transparent canvas. `active` = index of the highlighted word (-1 for none). */
export function drawCue(ctx: CanvasRenderingContext2D, w: number, h: number, cue: Cue, s: CaptionSettings, active: number) {
  ctx.clearRect(0, 0, w, h);
  const { laid, lines, size, lineH, top } = layout(ctx, cue, s, w, h);
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  if (s.look === 'box') {
    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    lines.forEach((ln, li) => {
      const pad = size * 0.3;
      const x = (w - ln.width) / 2 - pad;
      const y = top + li * lineH + (lineH - size * 1.15) / 2;
      const r = size * 0.22;
      ctx.beginPath();
      ctx.roundRect(x, y, ln.width + 2 * pad, size * 1.15, r);
      ctx.fill();
    });
  }
  for (const wd of laid) {
    const color = s.highlight && wd.index === active ? s.highlight : s.color;
    if (s.look === 'outline') {
      ctx.strokeStyle = 'rgba(0,0,0,0.92)';
      ctx.lineWidth = size * 0.16;
      ctx.strokeText(wd.text, wd.x, wd.y);
    } else if (s.look === 'plain') {
      ctx.shadowColor = 'rgba(0,0,0,0.7)';
      ctx.shadowBlur = size * 0.15;
    }
    ctx.fillStyle = color;
    ctx.fillText(wd.text, wd.x, wd.y);
    ctx.shadowBlur = 0;
  }
}

export type CaptionTrackPayload = CaptionTrack;

async function toPngBase64(canvas: OffscreenCanvas): Promise<string> {
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * Render every caption state (one per cue, or one per spoken word when highlighting) as a
 * w×h transparent PNG with its timeline time span, for the exporter.
 */
export async function renderCaptionTrack(project: Project, w: number, h: number): Promise<CaptionTrackPayload | null> {
  const s = project.captions;
  if (!s?.enabled) return null;
  const cues = buildCues(project, s);
  if (!cues.length) return null;
  await document.fonts.ready;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
  const blank = await toPngBase64(canvas);
  const segments: CaptionTrackPayload['segments'] = [];
  for (const cue of cues) {
    // States: the highlighted word changes at each word start (or a single state without highlight).
    const bounds = s.highlight ? [cue.start, ...cue.words.map((wd) => wd.start).filter((t) => t > cue.start && t < cue.end), cue.end] : [cue.start, cue.end];
    const uniq = [...new Set(bounds)].sort((a, b) => a - b);
    for (let i = 0; i < uniq.length - 1; i++) {
      drawCue(ctx, w, h, cue, s, s.highlight ? activeWord(cue, uniq[i]) : -1);
      segments.push({ start: ticksToSeconds(uniq[i]), end: ticksToSeconds(uniq[i + 1]), png: await toPngBase64(canvas) });
    }
  }
  return { width: w, height: h, blank, segments };
}
