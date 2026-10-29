/**
 * Captions are derived, not stored: each media file has a transcript (words with SOURCE times),
 * and buildCues() maps the words of every clip onto the timeline. Trims, splits, reordering and
 * deleted pauses therefore keep captions in sync automatically.
 *
 * Preview and export draw cues with the same Canvas 2D code (src/renderer/captions/draw.ts).
 */
import { type ClipItem, type Project, type TranscriptWord, findMedia, layoutSequence } from './model';
import { type Rational, type Ticks, TICKS_PER_SECOND, snapToFrame } from './time';

export type CaptionLook = 'outline' | 'box' | 'plain';

export interface CaptionSettings {
  enabled: boolean;
  look: CaptionLook;
  fontSize: number; // % of canvas height
  position: number; // vertical centre of the caption block, 0 (top) .. 1 (bottom)
  color: string; // text colour
  highlight: string | null; // colour of the word being spoken (null = no word highlight)
  uppercase: boolean;
  maxChars: number; // per line (approximate, before measuring)
}

export const DEFAULT_CAPTIONS: CaptionSettings = {
  enabled: true,
  look: 'outline',
  fontSize: 4.8,
  position: 0.78,
  color: '#ffffff',
  highlight: '#ffd23f',
  uppercase: false,
  maxChars: 28,
};

export interface CueWord {
  text: string;
  start: Ticks; // timeline time
  end: Ticks;
}

export interface Cue {
  start: Ticks; // timeline time, frame aligned
  end: Ticks;
  words: CueWord[];
}

const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'uh-huh', 'er', 'erm', 'ah', 'hmm', 'hm', 'mm', 'mhm']);

export function normalizeWord(t: string): string {
  return t.toLowerCase().replace(/[^a-z'-]/g, '');
}

export function isFiller(text: string): boolean {
  return FILLERS.has(normalizeWord(text));
}

/** Source ranges of filler words in one transcript. */
export function fillerRanges(words: TranscriptWord[]): { start: Ticks; end: Ticks }[] {
  return words.filter((w) => isFiller(w.text)).map((w) => ({ start: w.start, end: w.end }));
}

/** Words of one clip, mapped to timeline time and clipped to the clip's range. */
export function clipWords(project: Project, clip: ClipItem, clipStart: Ticks): CueWord[] {
  const media = findMedia(project, clip.mediaId);
  const words = media?.transcript?.words ?? [];
  const out: CueWord[] = [];
  for (const w of words) {
    if (w.end <= clip.sourceIn || w.start >= clip.sourceOut) continue;
    // A word must be mostly inside the clip to be shown.
    const inside = Math.min(w.end, clip.sourceOut) - Math.max(w.start, clip.sourceIn);
    if (inside < (w.end - w.start) / 2) continue;
    out.push({
      text: w.text,
      start: clipStart + Math.max(0, w.start - clip.sourceIn),
      end: clipStart + Math.min(clip.sourceOut, w.end) - clip.sourceIn,
    });
  }
  return out;
}

const MAX_CUE = 4 * TICKS_PER_SECOND;
const GAP_BREAK = 0.7 * TICKS_PER_SECOND;
const MIN_CUE = 0.5 * TICKS_PER_SECOND;

/** Group words into on-screen cues (≤ 2 lines, broken at pauses, sentence ends and clip edges). */
export function buildCues(project: Project, settings: CaptionSettings = project.captions ?? DEFAULT_CAPTIONS): Cue[] {
  const rate: Rational = project.frameRate;
  const cues: Cue[] = [];
  const limit = settings.maxChars * 2;
  for (const l of layoutSequence(project).items) {
    if (l.item.kind !== 'clip') continue;
    let cur: CueWord[] = [];
    let chars = 0;
    const flush = () => {
      if (cur.length) cues.push({ start: cur[0].start, end: cur[cur.length - 1].end, words: cur });
      cur = [];
      chars = 0;
    };
    for (const w of clipWords(project, l.item, l.start)) {
      const prev = cur[cur.length - 1];
      const len = w.text.trim().length + 1;
      if (prev && (w.start - prev.end > GAP_BREAK || chars + len > limit || w.end - cur[0].start > MAX_CUE)) flush();
      cur.push({ ...w, text: w.text.trim() });
      chars += len;
      if (/[.!?]$/.test(w.text.trim()) && chars > 6) flush(); // new line after each sentence (unless tiny)
    }
    flush();
  }
  // Frame-align, give short cues a minimum duration and close tiny gaps so captions don't flicker.
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    const next = cues[i + 1];
    c.start = snapToFrame(c.start, rate, 'round');
    let end = Math.max(c.end, c.start + MIN_CUE);
    if (next && next.start - end < 0.3 * TICKS_PER_SECOND) end = next.start;
    if (next) end = Math.min(end, next.start);
    c.end = snapToFrame(end, rate, 'round');
    if (c.end <= c.start) c.end = c.start + snapToFrame(MIN_CUE, rate, 'round');
  }
  const duration = layoutSequence(project).duration;
  return cues.filter((c) => c.start < duration).map((c) => ({ ...c, end: Math.min(c.end, duration) }));
}

export function cueAt(cues: Cue[], t: Ticks): Cue | null {
  for (const c of cues) if (t >= c.start && t < c.end) return c;
  return null;
}

/** Index of the word being spoken at t within a cue (for highlighting), or -1. */
export function activeWord(cue: Cue, t: Ticks): number {
  let idx = -1;
  for (let i = 0; i < cue.words.length; i++) if (t >= cue.words[i].start) idx = i;
  return idx;
}

/**
 * Replace the words of a cue's time span in the media's transcript with edited text.
 * New words are spread evenly across the original span.
 */
export function replaceWords(words: TranscriptWord[], start: Ticks, end: Ticks, text: string): TranscriptWord[] {
  const before = words.filter((w) => w.end <= start);
  const after = words.filter((w) => w.start >= end);
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const step = tokens.length ? (end - start) / tokens.length : 0;
  const mid = tokens.map((t, i) => ({ text: t, start: Math.round(start + i * step), end: Math.round(start + (i + 1) * step) }));
  return [...before, ...mid, ...after];
}
