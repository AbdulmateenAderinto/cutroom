/**
 * Silence and scene detection on synthetic media with known pauses / cuts, then the edits they
 * drive, verified in a real export.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { detectScenes, detectSilence } from '../../src/main/analysis/analyze';
import { runExport } from '../../src/main/export/exportRunner';
import { type MediaRef, createProject } from '../../src/shared/model';
import { addClip, addMedia, removeSourceRanges, splitAtSourceTimes } from '../../src/shared/ops';
import { TICKS_PER_SECOND as S, secondsToTicks } from '../../src/shared/time';
import { FIXTURE_DIR, OUTPUT_DIR, ensureDirs, mediaRefFor, readAudio, rms, samplePatch } from '../helpers/fixtures';

const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
let TALK: MediaRef;
let SHOTS: MediaRef;

beforeAll(async () => {
  ensureDirs();
  const talk = path.join(FIXTURE_DIR, 'talk_pauses.mp4');
  if (!existsSync(talk)) {
    // Tone ("speech") 0–1 s, pause 1–2 s, tone 2–2.5 s, pause 2.5–4 s, tone 4–5 s.
    const expr = "0.5*sin(2*PI*300*t)*(lt(t,1)+between(t,2,2.5)+gte(t,4))";
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=5', '-f', 'lavfi', '-i', `aevalsrc='${expr}':s=48000:d=5`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-shortest', talk]);
  }
  const shots = path.join(FIXTURE_DIR, 'three_shots.mp4');
  if (!existsSync(shots)) {
    ff(['-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=30:d=1.5', '-f', 'lavfi', '-i', 'color=c=white:s=320x240:r=30:d=1.5',
      '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=30:d=1', '-f', 'lavfi', '-i', 'sine=d=4',
      '-filter_complex', '[0][1][2]concat=n=3:v=1:a=0[v]', '-map', '[v]', '-map', '3:a',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', shots]);
  }
  TALK = await mediaRefFor(talk);
  SHOTS = await mediaRefFor(shots);
});

describe('silence', () => {
  it('omitted (undefined) options fall back to the defaults', async () => {
    const r = await detectSilence(TALK.path, 5, { noiseDb: undefined, minDuration: undefined });
    expect(r.length).toBe(2);
  });

  it('finds the pauses at the right times', async () => {
    const r = await detectSilence(TALK.path, 5, { noiseDb: -35, minDuration: 0.5 });
    expect(r.length).toBe(2);
    expect(r[0].start).toBeCloseTo(1, 1);
    expect(r[0].end).toBeCloseTo(2, 1);
    expect(r[1].start).toBeCloseTo(2.5, 1);
    expect(r[1].end).toBeCloseTo(4, 1);
  });

  it('removing them shortens the edit and the export has no long pauses left', async () => {
    let p = addMedia({ ...createProject(), canvas: { width: 320, height: 240, preset: 'custom' } }, [TALK]);
    p = addClip(p, TALK.id)!.project;
    const ranges = (await detectSilence(TALK.path, 5, { minDuration: 0.5 })).map((x) => ({ start: secondsToTicks(x.start), end: secondsToTicks(x.end) }));
    const r = removeSourceRanges(p, p.sequence.items[0].id, ranges, { padding: secondsToTicks(0.1) });
    expect(r.parts).toBe(3);
    // 2.5 s of pauses minus 2 × 0.1 s padding per pause ≈ 2.1 s removed
    expect(r.removed / S).toBeGreaterThan(1.9);
    expect(r.removed / S).toBeLessThan(2.3);
    const out = path.join(OUTPUT_DIR, 'no-pauses.mp4');
    const res = await runExport(r.project, { outputPath: out, width: 320, height: 240, frameRate: { num: 30, den: 1 }, canvasMapping: 'fit', videoBitrateMbps: 2, x264Preset: 'veryfast', audioBitrateKbps: 128 });
    expect(res.status).toBe('done');
    const pcm = readAudio(out);
    const dur = pcm.length / 48000;
    expect(dur).toBeCloseTo(5 - r.removed / S, 1);
    let longestQuiet = 0;
    let run = 0;
    for (let t = 0; t < dur; t += 0.05) {
      run = rms(pcm, t, t + 0.05) < 0.01 ? run + 0.05 : 0;
      longestQuiet = Math.max(longestQuiet, run);
    }
    expect(longestQuiet).toBeLessThan(0.35); // only the kept padding (0.1 + 0.1) plus AAC edges
  });
});

describe('scenes', () => {
  it('finds the two cuts and splitting puts each shot in its own clip', async () => {
    const cuts = await detectScenes(SHOTS.path, 0.3);
    expect(cuts.length).toBe(2);
    expect(cuts[0]).toBeCloseTo(1.5, 1);
    expect(cuts[1]).toBeCloseTo(3, 1);
    let p = addMedia({ ...createProject(), canvas: { width: 320, height: 240, preset: 'custom' } }, [SHOTS]);
    p = addClip(p, SHOTS.id)!.project;
    const r = splitAtSourceTimes(p, p.sequence.items[0].id, cuts.map(secondsToTicks));
    expect(r.parts).toBe(3);
    const clips = r.project.sequence.items as any[];
    expect(clips[1].sourceIn / S).toBeCloseTo(1.5, 1);
    expect(clips[2].sourceIn / S).toBeCloseTo(3, 1);
    // Reverse the shots and check the export's shot order.
    const reversed = { ...r.project, sequence: { items: [...clips].reverse() } };
    const out = path.join(OUTPUT_DIR, 'scenes-reversed.mp4');
    const res = await runExport(reversed, { outputPath: out, width: 320, height: 240, frameRate: { num: 30, den: 1 }, canvasMapping: 'fit', videoBitrateMbps: 2, x264Preset: 'veryfast', audioBitrateKbps: 128 });
    expect(res.status).toBe('done');
    const frames = samplePatch(out, 160, 120);
    const colourAt = (i: number) => {
      const { y, v } = frames[i];
      return v > 180 ? 'red' : y > 200 ? 'white' : y < 30 ? 'black' : '?';
    };
    expect([colourAt(5), colourAt(40), colourAt(100)]).toEqual(['black', 'white', 'red']);
  });
});
