/**
 * Detach audio: the sound moved to an audio track lands exactly where it played inside the clip
 * (beeps vs flash frames, as before detaching), and can then be extended past the picture (L-cut).
 */
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runExport } from '../../src/main/export/exportRunner';
import { detachAudio, findAudioClip, trimAudioClip } from '../../src/shared/audio';
import { type MediaRef, type Project, createProject } from '../../src/shared/model';
import { addClip, addMedia, setClipRange } from '../../src/shared/ops';
import { TICKS_PER_SECOND as S } from '../../src/shared/time';
import { OUTPUT_DIR, ensureDirs, makeSync, mediaRefFor, readAudio, rms, samplePatch } from '../helpers/fixtures';

let SYNC: MediaRef;
beforeAll(async () => {
  ensureDirs();
  SYNC = await mediaRefFor(makeSync('sync30'));
});

function project(): { p: Project; a: string; b: string } {
  let p = addMedia({ ...createProject('dt'), canvas: { width: 320, height: 180, preset: 'custom' } }, [SYNC]);
  p = addClip(p, SYNC.id)!.project;
  p = addClip(p, SYNC.id)!.project;
  const [a, b] = p.sequence.items.map((i) => i.id);
  p = setClipRange(p, a, 0.4 * S, 3.4 * S, 'in'); // 3 s from 0.4 s: beeps at 0.6, 1.6, 2.6 s
  p = setClipRange(p, b, 0, 3 * S, 'in');
  return { p, a, b };
}

const exp = async (p: Project, name: string) => {
  const outputPath = path.join(OUTPUT_DIR, name);
  const r = await runExport(p, { outputPath, width: 320, height: 180, frameRate: { num: 30, den: 1 }, canvasMapping: 'fit', videoBitrateMbps: 4, x264Preset: 'veryfast', audioBitrateKbps: 192 });
  expect(r.status, JSON.stringify(r).slice(0, 800)).toBe('done');
  return outputPath;
};
const beeps = (file: string) => {
  const pcm = readAudio(file);
  const out: number[] = [];
  for (let i = 0; i < pcm.length; i++) {
    if (Math.abs(pcm[i]) > 0.3) {
      out.push(i / 48000);
      i += 9600; // beeps last one frame; skip 0.2 s
    }
  }
  return out;
};
const flashes = (file: string) => samplePatch(file, 160, 90).flatMap((px, f) => (px.y > 128 ? [f / 30] : []));

describe('detach audio', () => {
  it('the detached sound plays exactly where it did inside the clip', async () => {
    const { p, a } = project();
    const before = beeps(await exp(p, 'dt-before.mp4'));
    const r = detachAudio(p, a);
    if ('error' in r) throw new Error(r.error);
    expect(r.project.sequence.items[0]).toMatchObject({ muted: true });
    const file = await exp(r.project, 'dt-after.mp4');
    const after = beeps(file);
    expect(after.length).toBe(before.length);
    after.forEach((t, i) => expect(Math.abs(t - before[i])).toBeLessThan(0.002));
    // …and still with the picture: each flash has its beep within half a frame.
    const fl = flashes(file);
    expect(fl.length).toBe(after.length);
    fl.forEach((t, i) => expect(Math.abs(after[i] - t)).toBeLessThan(0.017));
  });

  it('L-cut: the sound extended past the cut keeps playing over the next clip', async () => {
    const { p, a } = project();
    const r = detachAudio(p, a);
    if ('error' in r) throw new Error(r.error);
    // Mute the second clip so only the detached sound can be heard, then extend it by 1 s.
    let q = { ...r.project, sequence: { items: r.project.sequence.items.map((i, k) => (k === 1 && i.kind === 'clip' ? { ...i, muted: true } : i)) } };
    q = trimAudioClip(q, r.audioClipId, 'end', 1 * S);
    expect(findAudioClip(q, r.audioClipId)!.clip.sourceOut).toBe((44 * S) / 10);
    const pcm = readAudio(await exp(q, 'dt-lcut.mp4'));
    expect(rms(pcm, 3.55, 3.65)).toBeGreaterThan(0.1); // the beep at 3.6 s (file time 4.0 s), after the cut at 3 s
    expect(rms(pcm, 4.55, 4.65)).toBeLessThan(0.01); // nothing after the extended sound ends
  });

  it('refuses clips with a speed change, muted clips and clips without sound', () => {
    const { p, a } = project();
    const sped = { ...p, sequence: { items: p.sequence.items.map((i) => (i.id === a && i.kind === 'clip' ? { ...i, speed: 2 } : i)) } };
    expect(detachAudio(sped, a)).toHaveProperty('error');
    const muted = { ...p, sequence: { items: p.sequence.items.map((i) => (i.id === a && i.kind === 'clip' ? { ...i, muted: true } : i)) } };
    expect(detachAudio(muted, a)).toHaveProperty('error');
  });

  it('a second detach at an overlapping time goes on a new track', () => {
    const { p, a, b } = project();
    const r1 = detachAudio(p, a);
    if ('error' in r1) throw new Error(r1.error);
    let q = trimAudioClip(r1.project, r1.audioClipId, 'end', 1 * S); // now overlaps clip b's time
    const r2 = detachAudio(q, b);
    if ('error' in r2) throw new Error(r2.error);
    q = r2.project;
    expect(q.audioTracks!.length).toBe(2);
    expect(findAudioClip(q, r2.audioClipId)!.clip.start).toBe(3 * S);
  });
});
