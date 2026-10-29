import { describe, expect, it } from 'vitest';
import { IDENTITY, ease, evalAnimation, hasAnimation, keyframeValue } from '../../src/shared/animation';
import { createProject } from '../../src/shared/model';
import * as ops from '../../src/shared/ops';
import { parseProject, serializeProject } from '../../src/shared/serialize';
import { TICKS_PER_SECOND as S } from '../../src/shared/time';

describe('easing', () => {
  it('starts at 0, ends at 1, and is monotonic', () => {
    for (const e of ['linear', 'easeIn', 'easeOut', 'easeInOut'] as const) {
      expect(ease(e, 0)).toBe(0);
      expect(ease(e, 1)).toBe(1);
      let prev = -1;
      for (let p = 0; p <= 1; p += 0.05) {
        expect(ease(e, p)).toBeGreaterThanOrEqual(prev);
        prev = ease(e, p);
      }
    }
    expect(ease('hold', 0.99)).toBe(0);
  });
});

describe('keyframes', () => {
  const keys = [
    { at: 0, value: 1, easing: 'linear' as const },
    { at: 2 * S, value: 2, easing: 'hold' as const },
    { at: 4 * S, value: 0, easing: 'linear' as const },
  ];
  it('interpolates between keys and holds outside them', () => {
    expect(keyframeValue(keys, -S, 'scale')).toBe(1);
    expect(keyframeValue(keys, S, 'scale')).toBeCloseTo(1.5);
    expect(keyframeValue(keys, 3 * S, 'scale')).toBe(2); // hold
    expect(keyframeValue(keys, 10 * S, 'scale')).toBe(0);
    expect(keyframeValue(undefined, 0, 'opacity')).toBe(1);
  });
});

describe('presets', () => {
  it('in/out presets start and end hidden and are identity in the middle', () => {
    const anim = { in: { preset: 'fade' as const, duration: S / 2 }, out: { preset: 'slideLeft' as const, duration: S / 2 } };
    expect(evalAnimation(anim, 0, 3 * S, 0).opacity).toBe(0);
    expect(evalAnimation(anim, 1.5 * S, 3 * S, 0)).toEqual(IDENTITY);
    expect(evalAnimation(anim, 3 * S, 3 * S, 0).x).toBeLessThan(-1); // fully off to the left
  });
  it('motion presets run across the whole clip', () => {
    const anim = { motion: { preset: 'kenBurnsIn' as const, amount: 0.5 } };
    expect(evalAnimation(anim, 0, 4 * S, 0).scale).toBe(1);
    expect(evalAnimation(anim, 4 * S, 4 * S, 0).scale).toBeCloseTo(1.15);
  });
});

describe('animation ops', () => {
  function proj() {
    let p = createProject();
    p = ops.addMedia(p, [{
      id: 'm', name: 'm.mp4', path: '/m.mp4', warnings: [],
      info: { container: 'mp4', fileSize: 1, duration: 10 * S, videoCodec: 'h264', width: 1920, height: 1080, displayWidth: 1920, displayHeight: 1080,
        rotation: 0, frameRate: { num: 30, den: 1 }, avgFrameRate: { num: 30, den: 1 }, isVFR: false, pixFmt: 'yuv420p', colorTransfer: '', isHDR: false,
        hasAudio: false, audioCodec: null, audioSampleRate: null, audioChannels: null },
    }]);
    return ops.addClip(p, 'm')!.project;
  }
  it('keyframes snap to source frames, stay sorted, clamp values, and clean up when empty', () => {
    let p = proj();
    const id = p.sequence.items[0].id;
    p = ops.setKeyframe(p, id, 'opacity', Math.round(2.01 * S), 5);
    p = ops.setKeyframe(p, id, 'opacity', S, 0.5);
    const c = p.sequence.items[0] as any;
    expect(c.animation.keyframes.opacity.map((k: any) => k.at)).toEqual([S, 2 * S]);
    expect(c.animation.keyframes.opacity[1].value).toBe(1); // clamped
    p = ops.removeKeyframe(p, id, 'opacity', S);
    p = ops.removeKeyframe(p, id, 'opacity', 2 * S);
    expect((p.sequence.items[0] as any).animation).toBeUndefined();
    expect(hasAnimation(undefined)).toBe(false);
  });
  it('trimming the start keeps keyframes on the same content', () => {
    let p = proj();
    const id = p.sequence.items[0].id;
    p = ops.setKeyframe(p, id, 'scale', 3 * S, 2);
    const before = evalAnimation((p.sequence.items[0] as any).animation, 3 * S, 10 * S, 0).scale;
    p = ops.trimEdge(p, id, 'start', S);
    const c = p.sequence.items[0] as any;
    // the same source moment (3 s) is now at timeline 2 s
    expect(evalAnimation(c.animation, 2 * S, c.sourceOut - c.sourceIn, c.sourceIn).scale).toBe(before);
  });
  it('saves as the current format and still opens v1 files', () => {
    let p = proj();
    p = ops.setAnimation(p, p.sequence.items[0].id, (a) => ({ ...a, in: { preset: 'pop', duration: S } }));
    const text = serializeProject(p);
    expect(JSON.parse(text).version).toBe(3);
    expect(parseProject(text).sequence.items[0]).toEqual(p.sequence.items[0]);
    const v1 = JSON.parse(serializeProject(proj()));
    v1.version = 1;
    expect(parseProject(JSON.stringify(v1)).version).toBe(3);
  });
});
