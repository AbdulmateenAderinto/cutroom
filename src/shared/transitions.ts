/**
 * Transitions between two neighbouring clips, centred on the cut, so the timeline length does
 * not change. Stored on the left clip (`ClipItem.transition`).
 *
 * - crossfade: for a window of D around the cut both clips are shown and mixed. It uses footage
 *   past the left clip's end and before the right clip's start ("handles"), so D is limited to
 *   what the files have.
 * - dipBlack / dipWhite: the left clip fades to the colour over D/2, the right clip fades in from
 *   it over D/2. Needs no extra footage.
 *
 * The mix at any time comes from transitionMix(), used by the preview; the exporter renders the
 * same per-frame values with FFmpeg (xfade / fade), checked by the integration tests.
 */
import { type ClipItem, type LaidOutItem, type MediaRef, type Project, type TransitionKind, clipSpeed, findMedia, layoutSequence, scaledDuration } from './model';
import { type Rational, type Ticks, TICKS_PER_SECOND, frameDuration, snapToFrame } from './time';

export const TRANSITION_KINDS: { id: TransitionKind; label: string }[] = [
  { id: 'crossfade', label: 'Crossfade' },
  { id: 'dipBlack', label: 'Dip to black' },
  { id: 'dipWhite', label: 'Dip to white' },
];
export const DEFAULT_TRANSITION = Math.round(0.5 * TICKS_PER_SECOND);
export const MAX_TRANSITION = 4 * TICKS_PER_SECOND;

export interface ResolvedTransition {
  kind: TransitionKind;
  a: LaidOutItem; // left clip
  b: LaidOutItem; // right clip
  cut: Ticks;
  half: Ticks; // effective half length (≤ requested), on the frame grid
  start: Ticks; // cut - half
  end: Ticks; // cut + half
  requested: Ticks;
  /** Why it is shorter than requested (or missing), for the inspector. */
  limitedBy?: 'footage' | 'clip length';
}

/** Footage available past a clip's end and before its start, in timeline time. */
export function handles(c: ClipItem, m: MediaRef | undefined): { before: Ticks; after: Ticks } {
  if (!m) return { before: 0, after: 0 };
  const sp = clipSpeed(c);
  return { before: scaledDuration(c.sourceIn, sp), after: scaledDuration(Math.max(0, m.info.duration - c.sourceOut), sp) };
}

function resolve(project: Project, a: LaidOutItem, b: LaidOutItem | undefined, rate: Rational): ResolvedTransition | null {
  if (a.item.kind !== 'clip' || !a.item.transition || !b || b.item.kind !== 'clip') return null;
  const { kind, duration } = a.item.transition;
  const pf = frameDuration(rate);
  let half = snapToFrame(Math.floor(duration / 2), rate, 'floor');
  let limitedBy: ResolvedTransition['limitedBy'];
  // Each side may use at most half of its own clip (so two transitions on one clip don't overlap).
  const lenLimit = snapToFrame(Math.floor(Math.min(a.end - a.start, b.end - b.start) / 2), rate, 'floor');
  if (lenLimit < half) {
    half = lenLimit;
    limitedBy = 'clip length';
  }
  if (kind === 'crossfade') {
    const ha = handles(a.item, findMedia(project, a.item.mediaId)).after;
    const hb = handles(b.item, findMedia(project, b.item.mediaId)).before;
    const footage = snapToFrame(Math.min(ha, hb), rate, 'floor');
    if (footage < half) {
      half = footage;
      limitedBy = 'footage';
    }
  }
  if (half < pf) return null;
  return { kind, a, b, cut: a.end, half, start: a.end - half, end: a.end + half, requested: duration, limitedBy };
}

/** Every active transition of the timeline, in order. */
export function resolveTransitions(project: Project, items = layoutSequence(project).items): ResolvedTransition[] {
  const out: ResolvedTransition[] = [];
  items.forEach((l, i) => {
    const r = resolve(project, l, items[i + 1], project.frameRate);
    if (r) out.push(r);
  });
  return out;
}

/** The transition after a clip (resolved), or why it can't be shown, for the inspector. */
export function transitionInfo(project: Project, clipId: string): { resolved: ResolvedTransition | null; reason?: string } {
  const items = layoutSequence(project).items;
  const i = items.findIndex((l) => l.item.id === clipId);
  const a = items[i];
  const b = items[i + 1];
  if (!a || a.item.kind !== 'clip' || !a.item.transition) return { resolved: null };
  if (!b) return { resolved: null, reason: 'This is the last clip: there is no next clip to transition to.' };
  if (b.item.kind !== 'clip') return { resolved: null, reason: 'The next item is a gap: transitions only work between two clips.' };
  const r = resolve(project, a, b, project.frameRate);
  if (!r) {
    return {
      resolved: null,
      reason: a.item.transition.kind === 'crossfade'
        ? 'A crossfade needs footage after this clip’s end and before the next clip’s start. Trim a little off the end of this clip and the start of the next.'
        : 'The clips are too short for this transition.',
    };
  }
  return { resolved: r };
}

/**
 * The mix at timeline time t inside a transition.
 * crossfade: `b` = weight of the incoming clip (0 → 1 across the window), shown over the outgoing one.
 * dips: `colour` = how much of the colour covers the picture (0 → 1 → 0, full at the cut).
 */
export function transitionMix(tr: ResolvedTransition, t: Ticks): { b: number; colour: number } {
  if (t < tr.start || t >= tr.end) return { b: t >= tr.end ? 1 : 0, colour: 0 };
  if (tr.kind === 'crossfade') return { b: (t - tr.start) / (tr.end - tr.start), colour: 0 };
  if (t < tr.cut) return { b: 0, colour: (t - tr.start) / tr.half };
  return { b: 1, colour: 1 - (t - tr.cut) / tr.half };
}

export function dipColour(kind: TransitionKind): string {
  return kind === 'dipWhite' ? '#ffffff' : '#000000';
}
