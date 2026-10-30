/**
 * Draws captions and titles with Canvas 2D. The preview draws live with this code, and export
 * renders the very same function into PNG images that FFmpeg overlays, so text looks identical in both.
 */
import { type CaptionSettings, type Cue, activeWord, buildCues, cueAt } from '../../shared/captions';
import type { CaptionTrack } from '../../shared/exportPlan';
import type { Project, TitleClip } from '../../shared/model';
import { FONT_STACKS, type TitleState, isAnimating, titleEnd, titles, titlesAt } from '../../shared/titles';
import { type Rational, type Ticks, frameToTicks, ticksToSeconds } from '../../shared/time';

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

/** Draw one cue onto a w×h canvas. `active` = index of the highlighted word (-1 for none). */
export function drawCue(ctx: CanvasRenderingContext2D, w: number, h: number, cue: Cue, s: CaptionSettings, active: number) {
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

// ---------------------------------------------------------------------------------------------
// Titles

function titleFont(t: TitleClip, h: number) {
  const st = t.style;
  const size = (st.size / 100) * h;
  return { size, font: `${st.italic ? 'italic ' : ''}${st.weight} ${size}px ${FONT_STACKS[st.font]}` };
}

/** Line breaks are kept; long lines wrap at word boundaries within maxWidth. */
export function layoutTitle(ctx: CanvasRenderingContext2D, t: TitleClip, w: number, h: number) {
  const st = t.style;
  const { size, font } = titleFont(t, h);
  ctx.font = font;
  const text = st.uppercase ? t.text.toUpperCase() : t.text;
  const maxW = st.maxWidth * w;
  const lines: { text: string; width: number }[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/ +/)) {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > maxW) {
        lines.push({ text: line, width: ctx.measureText(line).width });
        line = word;
      } else line = next;
    }
    lines.push({ text: line, width: ctx.measureText(line).width });
  }
  const lineH = size * 1.2;
  const blockW = Math.max(1, ...lines.map((l) => l.width));
  const blockH = lines.length * lineH;
  const ax = st.x * w;
  const left = st.align === 'left' ? ax : st.align === 'center' ? ax - blockW / 2 : ax - blockW;
  const top = st.y * h - blockH / 2;
  const padX = st.look === 'box' ? size * 0.4 : 0;
  const padY = st.look === 'box' ? size * 0.2 : 0;
  return { lines, size, font, lineH, left, top, blockW, blockH, padX, padY };
}

/** Outer bounds of a title (including its box), in canvas pixels, for selection and dragging. */
export function titleBounds(ctx: CanvasRenderingContext2D, t: TitleClip, w: number, h: number) {
  const L = layoutTitle(ctx, t, w, h);
  return { x: L.left - L.padX, y: L.top - L.padY, w: L.blockW + 2 * L.padX, h: L.blockH + 2 * L.padY };
}

function rgba(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function drawTitle(ctx: CanvasRenderingContext2D, w: number, h: number, t: TitleClip, state: TitleState) {
  if (state.opacity <= 0) return;
  const st = t.style;
  const L = layoutTitle(ctx, t, w, h);
  ctx.save();
  ctx.globalAlpha = Math.min(1, state.opacity);
  const cx = L.left + L.blockW / 2;
  const cy = L.top + L.blockH / 2;
  ctx.translate(cx, cy + state.dy * h);
  ctx.scale(state.scale, state.scale);
  ctx.translate(-cx, -cy);
  if (st.look === 'box' && st.boxOpacity > 0) {
    ctx.fillStyle = rgba(st.boxColor, st.boxOpacity);
    ctx.beginPath();
    ctx.roundRect(L.left - L.padX, L.top - L.padY, L.blockW + 2 * L.padX, L.blockH + 2 * L.padY, L.size * 0.18);
    ctx.fill();
  }
  ctx.font = L.font;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  // Typewriter: reveal characters in reading order; the layout uses the full text so nothing moves.
  let chars = state.reveal >= 1 ? Infinity : Math.floor(state.reveal * L.lines.reduce((n, l) => n + l.text.length, 0));
  L.lines.forEach((line, i) => {
    if (chars <= 0) return;
    const shown = chars >= line.text.length ? line.text : line.text.slice(0, chars);
    chars -= line.text.length;
    const x = st.align === 'left' ? L.left : st.align === 'center' ? L.left + (L.blockW - line.width) / 2 : L.left + L.blockW - line.width;
    const y = L.top + i * L.lineH + L.lineH / 2;
    if (st.look === 'outline') {
      ctx.strokeStyle = 'rgba(0,0,0,0.9)';
      ctx.lineWidth = L.size * 0.14;
      ctx.strokeText(shown, x, y);
    } else if (st.look === 'shadow') {
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = L.size * 0.12;
      ctx.shadowOffsetY = L.size * 0.04;
    }
    ctx.fillStyle = st.color;
    ctx.fillText(shown, x, y);
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  });
  ctx.restore();
}

/** Everything drawn over the picture at timeline time t: titles (by row), then the caption. */
export function drawOverlay(ctx: CanvasRenderingContext2D, w: number, h: number, project: Project, time: Ticks, cues: Cue[]) {
  ctx.clearRect(0, 0, w, h);
  for (const { title, state } of titlesAt(project, time)) drawTitle(ctx, w, h, title, state);
  const s = project.captions;
  if (s?.enabled) {
    const cue = cueAt(cues, time);
    if (cue) drawCue(ctx, w, h, cue, s, s.highlight ? activeWord(cue, time) : -1);
  }
}

export function overlayCues(project: Project): Cue[] {
  const s = project.captions;
  return s?.enabled ? buildCues(project, s) : [];
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
 * Render every distinct overlay state (captions and titles) as a w×h transparent PNG with its
 * timeline time span, for the exporter. States change at caption cues and highlighted words, at
 * title starts and ends, and on every output frame while a title animates.
 */
export async function renderOverlayTrack(project: Project, w: number, h: number, rate: Rational): Promise<CaptionTrackPayload | null> {
  const s = project.captions;
  const cues = overlayCues(project);
  const ts = titles(project).filter((t) => t.text.trim());
  if (!cues.length && !ts.length) return null;
  await document.fonts.ready;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
  const blank = await toPngBase64(canvas);
  const bounds = new Set<Ticks>();
  for (const cue of cues) {
    bounds.add(cue.start).add(cue.end);
    if (s?.highlight) for (const wd of cue.words) if (wd.start > cue.start && wd.start < cue.end) bounds.add(wd.start);
  }
  const fps = rate.num / rate.den;
  for (const t of ts) {
    bounds.add(t.start).add(titleEnd(t));
    const f0 = Math.floor(ticksToSeconds(t.start) * fps);
    const f1 = Math.ceil(ticksToSeconds(titleEnd(t)) * fps);
    for (let f = f0; f <= f1; f++) {
      const at = frameToTicks(f, rate);
      if (isAnimating(t, at)) bounds.add(at);
    }
  }
  const times = [...bounds].sort((a, b) => a - b);
  const visible = { ...project, titles: ts };
  const segments: CaptionTrackPayload['segments'] = [];
  for (let i = 0; i < times.length - 1; i++) {
    const at = times[i];
    if (!cueAt(cues, at) && !titlesAt(visible, at).length) continue;
    drawOverlay(ctx, w, h, visible, at, cues);
    segments.push({ start: ticksToSeconds(at), end: ticksToSeconds(times[i + 1]), png: await toPngBase64(canvas) });
  }
  return segments.length ? { width: w, height: h, blank, segments } : null;
}
