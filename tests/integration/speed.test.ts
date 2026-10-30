/**
 * Speed changes in export: every output frame is the source frame the shared maths says
 * (sourceAt), the length is exact, and the sound keeps its pitch.
 */
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { timeStretchFilter } from '../../src/main/export/encoders';
import { runExport } from '../../src/main/export/exportRunner';
import type { ExportSettings } from '../../src/shared/exportPlan';
import { type ClipItem, type MediaRef, createProject, layoutSequence, sourceAt } from '../../src/shared/model';
import { addClip, addMedia, setSpeed, speedRamp } from '../../src/shared/ops';
import { TICKS_PER_SECOND as S, frameToTicks, ticksToFrame } from '../../src/shared/time';
import { OUTPUT_DIR, decodeCodedFrame, ensureDirs, ffmpegHas, ffprobe, makeCoded, makeSync, mediaRefFor, readAudio, rms, samplePatch, toneFrequency } from '../helpers/fixtures';

let A: MediaRef;
let B: MediaRef;
const R30 = { num: 30, den: 1 };

beforeAll(async () => {
  ensureDirs();
  A = await mediaRefFor(makeCoded({ name: 'A_320x240_30', width: 320, height: 240, fps: 30, seconds: 4, cb: 60, freq: 440 }));
  B = await mediaRefFor(makeCoded({ name: 'B_320x240_30', width: 320, height: 240, fps: 30, seconds: 4, cb: 128, freq: 880 }));
});

const settings = (name: string): ExportSettings => ({
  outputPath: path.join(OUTPUT_DIR, name), width: 320, height: 240, frameRate: R30, canvasMapping: 'fit',
  videoBitrateMbps: 8, x264Preset: 'veryfast', audioBitrateKbps: 192,
});

describe('speed in export', () => {
  for (const speed of [1, 2, 0.5, 1.5, 0.25]) {
    it(`${speed}×: every frame is the expected source frame, then the next clip; pitch kept`, async () => {
      let p = addMedia({ ...createProject('speed'), canvas: { width: 320, height: 240, preset: 'custom' } }, [A, B]);
      p = addClip(p, A.id)!.project;
      p = addClip(p, B.id)!.project;
      p = setSpeed(p, p.sequence.items[0].id, speed);
      const lay = layoutSequence(p);
      const clip = p.sequence.items[0] as ClipItem;
      const aFrames = ticksToFrame(lay.items[0].end, R30, 'round');
      expect(aFrames).toBe(Math.round(120 / speed));
      const s = settings(`speed-${speed}.mp4`);
      const r = await runExport(p, s);
      expect(r.status, JSON.stringify(r).slice(0, 800)).toBe('done');
      const got = samplePatch(s.outputPath, 160, 120).map((px) => decodeCodedFrame(px, 30));
      expect(got.length).toBe(aFrames + 120);
      const bad: string[] = [];
      for (let j = 0; j < aFrames; j++) {
        const want = ticksToFrame(sourceAt(clip, 0, frameToTicks(j, R30)), R30, 'floor');
        if (got[j].frame !== want || Math.abs(got[j].cb - 60) > 15) bad.push(`${j}: got ${got[j].frame} want ${want}`);
      }
      expect(bad.slice(0, 5)).toEqual([]);
      expect(got[aFrames].frame).toBe(0); // B starts right after
      expect(Math.abs(got[aFrames].cb - 128)).toBeLessThan(15);
      const pcm = readAudio(s.outputPath);
      const aSec = aFrames / 30;
      // Length within one AAC frame (the encoder pads/rounds the last frame) ...
      const audio = ffprobe(s.outputPath).streams.find((x: any) => x.codec_type === 'audio');
      expect(Math.abs(Number(audio.duration_ts) - (aSec + 4) * 48000)).toBeLessThan(1024);
      // ... and the 440 → 880 Hz switch is at the video cut (same check as the A/V sync tests).
      // At 0.25× atempo's stretched sound may end a little early (within the limits measured below;
      // ≈ 20 ms with FFmpeg 9), so the "before" window stops short of that. rubberband is on time.
      const early = speed === 0.25 && (await timeStretchFilter()) === 'atempo' ? 0.03 : 0.005;
      expect(Math.abs(toneFrequency(pcm, aSec - early - 0.02, aSec - early) - 440)).toBeLessThan(60);
      expect(Math.abs(toneFrequency(pcm, aSec + 0.005, aSec + 0.025) - 880)).toBeLessThan(60);
      expect(Math.abs(toneFrequency(pcm, aSec * 0.2, aSec * 0.8) - 440)).toBeLessThan(10); // pitch kept
      expect(Math.abs(toneFrequency(pcm, aSec + 0.5, aSec + 3) - 880)).toBeLessThan(10);
    });
  }
});

describe('speed: sound lines up with the picture', () => {
  const hasRubberband = ffmpegHas('filters', 'rubberband'); // in the FFmpeg the export uses
  // Measured limits per filter (see ExportExtras.timeStretch). Negative = sound early.
  const limits: Record<string, Record<number, number>> = {
    rubberband: { 0.25: 0.06, 0.5: 0.04, 2: 0.025 },
    atempo: { 0.25: 0.13, 0.5: 0.05, 2: 0.025 },
  };
  for (const filter of ['rubberband', 'atempo'] as const) {
    for (const speed of [0.25, 0.5, 2]) {
      it.skipIf(filter === 'rubberband' && !hasRubberband)(`${filter} at ${speed}×: beeps within ${limits[filter][speed] * 1000} ms of the flashes`, async () => {
        const SYNC = await mediaRefFor(makeSync('sync30'));
        let p = addMedia({ ...createProject('sync'), canvas: { width: 320, height: 180, preset: 'custom' } }, [SYNC]);
        p = addClip(p, SYNC.id)!.project;
        p = setSpeed(p, p.sequence.items[0].id, speed);
        const s = { ...settings(`speed-sync-${filter}-${speed}.mp4`), width: 320, height: 180 };
        const r = await runExport(p, s, { timeStretch: filter });
        expect(r.status, JSON.stringify(r).slice(0, 800)).toBe('done');
        const flashes = samplePatch(s.outputPath, 160, 90)
          .map((px, i) => ({ on: px.y > 150, t: i / 30 }))
          .filter((f, i, all) => f.on && (i === 0 || !all[i - 1].on))
          .map((f) => f.t);
        const pcm = readAudio(s.outputPath);
        // Beep onset: where the 2 ms RMS first reaches half of that beep's peak.
        const errs = flashes.map((t) => {
          const a = Math.max(0, Math.floor((t - 0.3) * 48000));
          const b = Math.floor((t + 0.3) * 48000);
          const env: number[] = [];
          for (let i = a; i < b; i += 24) env.push(rms(pcm, i / 48000, (i + 96) / 48000));
          const peak = Math.max(...env);
          const j = env.findIndex((v) => v >= peak / 2);
          return (a + j * 24 + 48) / 48000 - t;
        });
        console.log(`      ${filter} ${speed}×: beep − flash = ${errs.map((e) => `${(e * 1000).toFixed(1)}`).join(', ')} ms`);
        expect(flashes.length).toBeGreaterThanOrEqual(2);
        expect(Math.max(...errs.map(Math.abs))).toBeLessThan(limits[filter][speed]);
      });
    }
  }
});

describe('speed ramp in export', () => {
  it('1× → 0.25× in 8 steps: every frame is the expected source frame of its part; pitch kept', async () => {
    let p = addMedia({ ...createProject('ramp'), canvas: { width: 320, height: 240, preset: 'custom' } }, [A]);
    p = addClip(p, A.id)!.project;
    const r = speedRamp(p, p.sequence.items[0].id, 1, 0.25, 8);
    if ('error' in r) throw new Error(r.error);
    p = r.project;
    const lay = layoutSequence(p);
    const total = ticksToFrame(lay.duration, R30, 'round');
    const s = settings('speed-ramp.mp4');
    const e = await runExport(p, s);
    expect(e.status, JSON.stringify(e).slice(0, 800)).toBe('done');
    const got = samplePatch(s.outputPath, 160, 120).map((px) => decodeCodedFrame(px, 30).frame);
    expect(got.length).toBe(total);
    const bad: string[] = [];
    for (let j = 0; j < total; j++) {
      const t = frameToTicks(j, R30);
      const l = lay.items.find((x) => t >= x.start && t < x.end)!;
      const want = ticksToFrame(sourceAt(l.item as ClipItem, l.start, t), R30, 'floor');
      if (got[j] !== want) bad.push(`${j}: got ${got[j]} want ${want}`);
    }
    expect(bad.slice(0, 5)).toEqual([]);
    // The footage runs forward without skipping more than the speed allows, and slows down.
    expect(got[total - 1]).toBeGreaterThanOrEqual(117);
    const pcm = readAudio(s.outputPath);
    expect(Math.abs(toneFrequency(pcm, 0.2, 0.5) - 440)).toBeLessThan(10);
    expect(Math.abs(toneFrequency(pcm, total / 30 - 1.5, total / 30 - 0.5) - 440)).toBeLessThan(10);
  });
});
