import { describe, expect, it } from 'vitest';
import { type ClipItem, type MediaRef, type Project, createProject } from '../../src/shared/model';
import * as ops from '../../src/shared/ops';
import { parseProject, serializeProject } from '../../src/shared/serialize';
import { TICKS_PER_SECOND as S } from '../../src/shared/time';
import { resolveTransitions, transitionInfo, transitionMix } from '../../src/shared/transitions';

const R30 = { num: 30, den: 1 };
function media(id: string, seconds: number): MediaRef {
  return {
    id, name: id, path: `/m/${id}`, warnings: [],
    info: {
      container: '', fileSize: 1, duration: seconds * S, videoCodec: 'h264', width: 640, height: 360, displayWidth: 640, displayHeight: 360,
      rotation: 0, frameRate: R30, avgFrameRate: R30, isVFR: false, pixFmt: 'yuv420p', colorTransfer: '', isHDR: false,
      hasAudio: true, audioCodec: 'aac', audioSampleRate: 48000, audioChannels: 2,
    },
  };
}
/** a: 0–3 s of a 4 s file (1 s after), b: 1–4 s of a 4 s file (1 s before). */
function proj(): Project {
  let p = ops.addMedia(createProject(), [media('a', 4), media('b', 4)]);
  p = ops.addClip(p, 'a')!.project;
  p = ops.addClip(p, 'b')!.project;
  const [a, b] = p.sequence.items.map((i) => i.id);
  p = ops.setClipRange(p, a, 0, 3 * S, 'in');
  p = ops.setClipRange(p, b, 1 * S, 4 * S, 'out');
  return p;
}
const first = (p: Project) => p.sequence.items[0] as ClipItem;
/** proj() with a transition after the first clip. */
const withT = (kind: Parameters<typeof ops.setTransition>[2], d: number, base = proj()) => ops.setTransition(base, first(base).id, kind, d);

describe('transitions', () => {
  it('a 1 s crossfade is centred on the cut and does not change the timeline length', () => {
    const p = withT('crossfade', 1 * S);
    const [t] = resolveTransitions(p);
    expect([t.start, t.cut, t.end]).toEqual([2.5 * S, 3 * S, 3.5 * S]);
    expect(t.limitedBy).toBeUndefined();
    expect(p.sequence.items.length).toBe(2);
  });

  it('a crossfade is limited by the footage past the cut', () => {
    const base = proj();
    let p = ops.setClipRange(base, first(base).id, 0, 3.8 * S, 'in'); // only 0.2 s after
    p = ops.setTransition(p, first(p).id, 'crossfade', 2 * S);
    const [t] = resolveTransitions(p);
    expect(t.half).toBe(0.2 * S);
    expect(t.limitedBy).toBe('footage');
    // With no footage left at all, there is no crossfade, and the inspector says why.
    const none = ops.setTransition(ops.setClipRange(p, first(p).id, 0, 4 * S, 'in'), first(p).id, 'crossfade', S);
    expect(resolveTransitions(none)).toEqual([]);
    expect(transitionInfo(none, first(none).id).reason).toMatch(/needs footage/);
  });

  it('dips need no extra footage; each side uses at most half of its clip', () => {
    const base = proj();
    let p = ops.setClipRange(base, first(base).id, 0, 4 * S, 'in');
    p = ops.setTransition(p, first(p).id, 'dipBlack', 8 * S);
    const [t] = resolveTransitions(p);
    expect(t.half).toBe(1.5 * S); // the second clip is 3 s long, max transition request is 4 s → 2 s, clip limit 1.5 s
    expect(t.limitedBy).toBe('clip length');
  });

  it('mix: crossfade weight rises linearly; dips cover fully at the cut', () => {
    let p = withT('crossfade', 1 * S);
    const [x] = resolveTransitions(p);
    expect(transitionMix(x, 2.5 * S)).toEqual({ b: 0, colour: 0 });
    expect(transitionMix(x, 3 * S).b).toBeCloseTo(0.5, 9);
    expect(transitionMix(x, 3.5 * S).b).toBe(1);
    p = ops.setTransition(p, first(p).id, 'dipWhite', 1 * S);
    const [d] = resolveTransitions(p);
    expect(transitionMix(d, 2.75 * S).colour).toBeCloseTo(0.5, 9);
    expect(transitionMix(d, 3 * S)).toEqual({ b: 1, colour: 1 });
    expect(transitionMix(d, 3.25 * S).colour).toBeCloseTo(0.5, 9);
  });

  it('no transition before a gap or after the last clip', () => {
    let p = withT('crossfade', S);
    p = ops.addClip(p, 'b')!.project;
    p = ops.deleteItem(p, p.sequence.items[1].id, 'leave-gap'); // clip, gap, clip
    expect(resolveTransitions(p)).toEqual([]);
    expect(transitionInfo(p, first(p).id).reason).toMatch(/gap/);
    const last = ops.setTransition(p, p.sequence.items[2].id, 'dipBlack', S);
    expect(transitionInfo(last, last.sequence.items[2].id).reason).toMatch(/last clip/);
  });

  it('removing, clamping and saving', () => {
    let p = withT('crossfade', 60 * S);
    expect(first(p).transition!.duration).toBe(4 * S);
    expect(first(parseProject(serializeProject(p))).transition).toEqual(first(p).transition);
    p = ops.setTransition(p, first(p).id, null);
    expect(first(p).transition).toBeUndefined();
  });
});
