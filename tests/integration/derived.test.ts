/**
 * Freeze frames and reversed clips: the still shows exactly the frame at the playhead (and the clip
 * continues after it); a reversed copy has every frame in reverse order with its sound reversed in
 * step; switching a clip to it and back keeps the right footage.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeFreezeFrame, makeReversed, reverseChunks } from '../../src/main/media/derived';
import { probeMedia } from '../../src/main/media/probe';
import { runExport } from '../../src/main/export/exportRunner';
import { type ClipItem, type MediaRef, type Project, createProject, layoutSequence, sourceAt } from '../../src/shared/model';
import { addClip, addMedia, insertFreezeFrame, setClipRange, unreverse, useReversed } from '../../src/shared/ops';
import { TICKS_PER_SECOND as S, frameToTicks } from '../../src/shared/time';
import { FIXTURE_DIR, OUTPUT_DIR, decodeCodedFrame, ensureDirs, makeCoded, makeSync, mediaRefFor, readAudio, samplePatch } from '../helpers/fixtures';

const R30 = { num: 30, den: 1 };
const dir = mkdtempSync(path.join(os.tmpdir(), 'cutroom-derived-'));
let A: MediaRef;
let SYNC: MediaRef;
beforeAll(async () => {
  ensureDirs();
  A = await mediaRefFor(makeCoded({ name: 'A_320x240_30', width: 320, height: 240, fps: 30, seconds: 4, cb: 60, freq: 440 }));
  SYNC = await mediaRefFor(makeSync('sync30'));
});

const ref = async (file: string, derived?: MediaRef['derived']): Promise<MediaRef> => {
  const r = await probeMedia(file);
  if (!r.ok) throw new Error(r.error);
  return { id: `m_${path.basename(file)}`, name: path.basename(file), path: file, info: r.info, warnings: [], derived };
};
const exp = async (p: Project, name: string) => {
  const outputPath = path.join(OUTPUT_DIR, name);
  const r = await runExport(p, { outputPath, width: p.canvas.width, height: p.canvas.height, frameRate: R30, canvasMapping: 'fit', videoBitrateMbps: 8, x264Preset: 'veryfast', audioBitrateKbps: 192 });
  expect(r.status, JSON.stringify(r).slice(0, 800)).toBe('done');
  return outputPath;
};
const frames = (file: string, w = 320, h = 240) => samplePatch(file, w / 2, h / 2).map((px) => decodeCodedFrame(px, 30));

describe('freeze frame', () => {
  // A grey ramp (in gamut, so a PNG keeps it exactly): luma 30 + 4 × (frame mod 50). The coded
  // fixtures store frame numbers in out-of-gamut colours, which no RGB still could hold.
  let RAMP: MediaRef;
  beforeAll(async () => {
    const f = path.join(FIXTURE_DIR, 'grey-ramp-30.mp4');
    if (!existsSync(f)) {
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
        "nullsrc=s=320x240:r=30:d=4,format=yuv420p,geq=lum='30+4*mod(N\\,50)':cb=128:cr=128,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv",
        '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=4', '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p',
        '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-c:a', 'aac', '-shortest', f]);
    }
    RAMP = await mediaRefFor(f);
  });
  const level = (k: number) => 30 + 4 * (k % 50);

  it('shows the frame at the playhead for 2 s, then the clip carries on from that frame; silent while frozen', async () => {
    let p = addMedia({ ...createProject('fz'), canvas: { width: 320, height: 240, preset: 'custom' } }, [RAMP]);
    p = addClip(p, RAMP.id)!.project;
    const t = frameToTicks(40, R30);
    const l = layoutSequence(p).items[0];
    const at = sourceAt(l.item as ClipItem, l.start, t);
    const still = await ref(await makeFreezeFrame(dir, RAMP.path, RAMP.info, at), { kind: 'freeze', mediaId: RAMP.id, sourceIn: at, sourceOut: at });
    expect(still.info.kind).toBe('image');
    expect([still.info.displayWidth, still.info.displayHeight]).toEqual([320, 240]);
    const r = insertFreezeFrame(addMedia(p, [still]), still, t, 2 * S)!;
    expect(r.project.sequence.items.map((i) => (i as ClipItem).mediaId)).toEqual([RAMP.id, still.id, RAMP.id]);
    const file = await exp(r.project, 'freeze.mp4');
    const y = samplePatch(file, 160, 120).map((px) => px.y);
    expect(y.length).toBe(180);
    const bad: string[] = [];
    y.forEach((v, j) => {
      const want = level(j < 40 ? j : j < 100 ? 40 : j - 60);
      if (Math.abs(v - want) > 1.5) bad.push(`${j}: ${v.toFixed(1)} want ${want}`);
    });
    expect(bad.slice(0, 5)).toEqual([]);
    const pcm = readAudio(file);
    let peak = 0;
    for (let i = Math.round(1.4 * 48000); i < Math.round(3.2 * 48000); i++) peak = Math.max(peak, Math.abs(pcm[i]));
    expect(peak).toBeLessThan(0.01);
  });
});

describe('reverse', () => {
  it('chunks cover the range exactly, last chunk first', () => {
    const c = reverseChunks(A.info, 0.5 * S, 3.5 * S);
    expect(c[0]).toEqual({ a: 45, b: 105 });
    expect(c[c.length - 1].a).toBe(15);
    expect(c.reduce((n, x) => n + x.b - x.a, 0)).toBe(90);
  });

  it('every frame in reverse order; a clip switched to it exports them; switching back restores it', async () => {
    const file = await makeReversed(dir, A.path, A.info, 0.5 * S, 3.5 * S);
    const rev = await ref(file, { kind: 'reverse', mediaId: A.id, sourceIn: 0.5 * S, sourceOut: 3.5 * S });
    expect(rev.info.duration).toBe(3 * S);
    const own = frames(file);
    expect(own.length).toBe(90);
    expect(own.map((g) => g.frame).filter((f, j) => f !== 104 - j).slice(0, 5)).toEqual([]);
    expect(own.every((g) => Math.abs(g.cb - 60) < 15)).toBe(true);

    let p = addMedia({ ...createProject('rv'), canvas: { width: 320, height: 240, preset: 'custom' } }, [A]);
    p = addClip(p, A.id)!.project;
    const id = p.sequence.items[0].id;
    p = setClipRange(p, id, 0.5 * S, 3.5 * S, 'in');
    const q = useReversed(addMedia(p, [rev]), id, rev);
    expect(q.sequence.items[0]).toMatchObject({ mediaId: rev.id, sourceIn: 0, sourceOut: 3 * S });
    const got = frames(await exp(q, 'reversed.mp4')).map((g) => g.frame);
    expect(got.filter((f, j) => f !== 104 - j).slice(0, 5)).toEqual([]);
    // Back to the original footage (also after trimming the reversed clip: the range flips).
    const trimmed = setClipRange(q, id, 1 * S, 3 * S, 'in'); // reversed 1–3 s = original 0.5–2.5 s
    expect(unreverse(trimmed, id)!.sequence.items[0]).toMatchObject({ mediaId: A.id, sourceIn: 0.5 * S, sourceOut: 2.5 * S });
  });

  it('the sound is reversed in step with the picture (beeps on the flash frames)', async () => {
    const file = await makeReversed(dir, SYNC.path, SYNC.info, 0.4 * S, 3.4 * S);
    const fl = samplePatch(file, 160, 90).flatMap((px, f) => (px.y > 128 ? [f / 30] : []));
    expect(fl.map((t) => Math.round(t * 30))).toEqual([11, 41, 71]); // source frames 90, 60, 30
    const pcm = readAudio(file);
    const beeps: number[] = [];
    for (let i = 0; i < pcm.length; i++) {
      if (Math.abs(pcm[i]) > 0.3) {
        beeps.push(i / 48000);
        i += 9600;
      }
    }
    expect(beeps.length).toBe(3);
    // A reversed beep ends where it started; its first sample is the old last one, so it begins
    // at the flash frame (within a few ms: the beep's edges are soft after AAC).
    beeps.forEach((t, i) => expect(Math.abs(t - fl[i])).toBeLessThan(0.006));
  });
});
