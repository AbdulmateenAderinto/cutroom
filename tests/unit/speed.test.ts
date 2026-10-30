import { describe, expect, it } from 'vitest';
import { evalAnimation } from '../../src/shared/animation';
import { buildCues } from '../../src/shared/captions';
import { type ClipItem, type MediaRef, type Project, createProject, itemDuration, layoutSequence, sourceAt, timelineAt } from '../../src/shared/model';
import * as ops from '../../src/shared/ops';
import { parseProject, serializeProject } from '../../src/shared/serialize';
import { TICKS_PER_SECOND as S, frameDuration } from '../../src/shared/time';

const R30 = { num: 30, den: 1 };
const NTSC = { num: 30000, den: 1001 };
const f30 = frameDuration(R30);

function media(id: string, seconds: number, rate = R30, kind?: 'image'): MediaRef {
  return {
    id, name: id, path: `/m/${id}`, warnings: [],
    info: {
      kind, container: '', fileSize: 1, duration: Math.round(seconds * S), videoCodec: 'h264', width: 640, height: 360,
      displayWidth: 640, displayHeight: 360, rotation: 0, frameRate: rate, avgFrameRate: rate, isVFR: false, pixFmt: 'yuv420p',
      colorTransfer: '', isHDR: false, hasAudio: true, audioCodec: 'aac', audioSampleRate: 48000, audioChannels: 2,
    },
  };
}
function proj(): Project {
  let p = ops.addMedia(createProject(), [media('a', 10), media('b', 4), media('n', 6, NTSC), media('photo', 3600, R30, 'image')]);
  for (const id of ['a', 'b']) p = ops.addClip(p, id)!.project;
  return p;
}
const clipOf = (p: Project, i: number) => p.sequence.items[i] as ClipItem;

describe('speed', () => {
  it('2× halves the timeline length and moves later clips; the footage is unchanged', () => {
    let p = proj();
    const a = clipOf(p, 0).id;
    p = ops.setSpeed(p, a, 2);
    const c = clipOf(p, 0);
    expect([c.sourceIn, c.sourceOut, c.speed]).toEqual([0, 10 * S, 2]);
    expect(itemDuration(c)).toBe(5 * S);
    expect(layoutSequence(p).items[1].start).toBe(5 * S);
    expect(ops.setSpeed(p, a, 1).sequence.items[0]).not.toHaveProperty('speed');
  });

  it('timeline durations stay on the frame grid for odd speeds and NTSC', () => {
    for (const sp of [0.25, 0.33, 0.5, 0.75, 1.37, 1.5, 3, 4]) {
      let p = ops.addClip(proj(), 'n')!.project;
      const id = p.sequence.items[2].id;
      p = ops.setSpeed(p, id, sp);
      const d = itemDuration(p.sequence.items[2]);
      const nf = frameDuration(R30);
      expect(d % nf, `speed ${sp}`).toBe(0);
    }
  });

  it('clamps and rounds speeds; photos have no speed', () => {
    let p = proj();
    p = ops.setSpeed(p, clipOf(p, 0).id, 9);
    expect(clipOf(p, 0).speed).toBe(4);
    p = ops.setSpeed(p, clipOf(p, 0).id, 0.123);
    expect(clipOf(p, 0).speed).toBe(0.25);
    p = ops.setSpeed(p, clipOf(p, 0).id, 1.234);
    expect(clipOf(p, 0).speed).toBe(1.23);
    const ph = ops.addClip(proj(), 'photo')!;
    expect((ops.setSpeed(ph.project, ph.clipId, 2).sequence.items[2] as ClipItem).speed).toBeUndefined();
  });

  it('slow motion can not run past the end of the file', () => {
    let p = proj();
    const b = clipOf(p, 1).id; // 4 s file
    p = ops.setSpeed(p, b, 0.5);
    expect(itemDuration(clipOf(p, 1))).toBe(8 * S);
    p = ops.trimEdge(p, b, 'end', 10 * S); // already shows the whole file
    expect(clipOf(p, 1).sourceOut).toBe(4 * S);
  });

  it('split at timeline time t cuts the footage at sourceAt(t); both halves keep the speed', () => {
    let p = proj();
    p = ops.setSpeed(p, clipOf(p, 0).id, 2);
    const r = ops.splitAt(p, 1.5 * S)!; // 1.5 s on the timeline = 3 s of footage
    const [l, rr] = [clipOf(r.project, 0), clipOf(r.project, 1)];
    expect(l.sourceOut).toBe(3 * S);
    expect(rr.sourceIn).toBe(3 * S);
    expect(rr.speed).toBe(2);
    expect(itemDuration(l) + itemDuration(rr)).toBe(5 * S);
    expect(layoutSequence(r.project).items[2].start).toBe(5 * S);
  });

  it('trimming by a timeline delta moves the source by delta × speed', () => {
    let p = proj();
    const a = clipOf(p, 0).id;
    p = ops.setSpeed(p, a, 2);
    p = ops.trimEdge(p, a, 'start', 30 * f30); // 1 s on the timeline
    expect(clipOf(p, 0).sourceIn).toBe(2 * S);
    expect(itemDuration(clipOf(p, 0))).toBe(4 * S);
  });

  it('source/timeline mapping round-trips', () => {
    const c = { ...clipOf(proj(), 0), sourceIn: 2 * S, speed: 0.5 };
    expect(sourceAt(c, 10 * S, 12 * S)).toBe(3 * S);
    expect(timelineAt(c, 10 * S, 3 * S)).toBe(12 * S);
  });

  it('keyframes stay on the footage: a keyframe at source 4 s lands at timeline 2 s at 2×', () => {
    let p = proj();
    const a = clipOf(p, 0).id;
    p = ops.setKeyframe(p, a, 'opacity', 0, 0, 'linear');
    p = ops.setKeyframe(p, a, 'opacity', 4 * S, 1);
    p = ops.setSpeed(p, a, 2);
    const c = clipOf(p, 0);
    expect(evalAnimation(c.animation, 2 * S, 5 * S, c.sourceIn, 2).opacity).toBeCloseTo(1, 6);
    expect(evalAnimation(c.animation, 1 * S, 5 * S, c.sourceIn, 2).opacity).toBeCloseTo(0.5, 6);
  });

  it('captions follow the speed', () => {
    let p = proj();
    p = ops.setTranscript(p, 'a', { language: 'en', model: 'test', words: [{ text: 'hello', start: 4 * S, end: 5 * S }] } as never);
    p = ops.setCaptions(p, (c) => ({ ...c, enabled: true }));
    p = ops.setSpeed(p, clipOf(p, 0).id, 2);
    const cue = buildCues(p, p.captions!)[0];
    expect([cue.words[0].start, cue.words[0].end]).toEqual([2 * S, 2.5 * S]);
  });

  it('removing a pause reports the timeline time saved', () => {
    let p = proj();
    p = ops.setSpeed(p, clipOf(p, 0).id, 2);
    const r = ops.removeSourceRanges(p, clipOf(p, 0).id, [{ start: 2 * S, end: 4 * S }]);
    expect(r.removed).toBe(1 * S);
  });

  it('saves and reopens', () => {
    let p = proj();
    p = ops.setSpeed(p, clipOf(p, 0).id, 1.5);
    expect(clipOf(parseProject(serializeProject(p)), 0).speed).toBe(1.5);
  });
});
