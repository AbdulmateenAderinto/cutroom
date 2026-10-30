/**
 * Export options: a marked range (frame-exact, same frames as the full export), constant quality
 * (CRF), the hardware-encoder arguments, and settings validation.
 */
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runExport } from '../../src/main/export/exportRunner';
import { addAudioClip } from '../../src/shared/audio';
import { type ExportSettings, buildExportPlan, validateExportSettings } from '../../src/shared/exportPlan';
import { type MediaRef, type Project, createProject } from '../../src/shared/model';
import { addClip, addMedia, setAnimation } from '../../src/shared/ops';
import { TICKS_PER_SECOND as S, frameDuration } from '../../src/shared/time';
import { OUTPUT_DIR, decodeCodedFrame, ensureDirs, ffprobe, makeCoded, makeNoisy, mediaRefFor, readAudio, samplePatch, toneFrequency } from '../helpers/fixtures';

const F30 = frameDuration({ num: 30, den: 1 });
let A: MediaRef, B: MediaRef, C: MediaRef;

function settings(name: string, over: Partial<ExportSettings> = {}): ExportSettings {
  return {
    outputPath: path.join(OUTPUT_DIR, name), width: 320, height: 240, frameRate: { num: 30, den: 1 }, canvasMapping: 'fit',
    videoBitrateMbps: 8, x264Preset: 'veryfast', audioBitrateKbps: 192, ...over,
  };
}

beforeAll(async () => {
  ensureDirs();
  A = await mediaRefFor(makeCoded({ name: 'A_320x240_30', width: 320, height: 240, fps: 30, seconds: 4, cb: 60, freq: 440 }));
  B = await mediaRefFor(makeCoded({ name: 'B_320x240_30', width: 320, height: 240, fps: 30, seconds: 4, cb: 128, freq: 880 }));
  C = await mediaRefFor(makeCoded({ name: 'C_320x240_30', width: 320, height: 240, fps: 30, seconds: 4, cb: 196, freq: 1320 }));
});

const idOf = (cb: number) => (Math.abs(cb - 60) < 15 ? 'A' : Math.abs(cb - 128) < 15 ? 'B' : Math.abs(cb - 196) < 15 ? 'C' : '?');

function threeClips(): Project {
  let p = addMedia({ ...createProject('opts'), canvas: { width: 320, height: 240, preset: 'custom' } }, [A, B, C]);
  for (const m of [A, B, C]) p = addClip(p, m.id)!.project;
  return p;
}

describe('export a marked range', () => {
  it('exports exactly timeline frames 100–259 (A frame 100 → C frame 19), audio switching at the cut', async () => {
    const p = threeClips(); // A 0–120, B 120–240, C 240–360
    const s = settings('range.mp4', { range: { start: 100 * F30, end: 260 * F30 } });
    const plan = buildExportPlan(p, s, 'x.mp4', (m) => m.path);
    expect(plan.totalFrames).toBe(160);
    expect(plan.timelineFrames).toBe(260); // built up to the range end; frames 0–99 are trimmed off
    const r = await runExport(p, s);
    expect(r.status, JSON.stringify(r).slice(0, 800)).toBe('done');
    const got = samplePatch(s.outputPath, 160, 120).map((px) => {
      const d = decodeCodedFrame(px, 30);
      return `${idOf(d.cb)}${d.frame}`;
    });
    const want: string[] = [];
    for (let f = 100; f < 260; f++) want.push(f < 120 ? `A${f}` : f < 240 ? `B${f - 120}` : `C${f - 240}`);
    expect(got.length).toBe(160);
    expect(got.filter((g, i) => g !== want[i]).slice(0, 5)).toEqual([]);
    const pcm = readAudio(s.outputPath);
    expect(pcm.length / 48000).toBeCloseTo(160 / 30, 2);
    expect(toneFrequency(pcm, 0.1, 0.6)).toBeCloseTo(440, -1); // A until 20/30 s
    expect(Math.abs(toneFrequency(pcm, 20 / 30 + 0.005, 20 / 30 + 0.03) - 880)).toBeLessThan(60);
    expect(toneFrequency(pcm, 4.7, 5.2)).toBeCloseTo(1320, -1);
  });

  it('clips outside the range are not decoded (no input for them), music outside is skipped', async () => {
    let p = threeClips();
    p = addAudioClip(p, A.id, 0)!.project; // music 0–4 s: outside a range starting at 8 s
    const s = settings('range-late.mp4', { range: { start: 8.5 * S, end: 11 * S } });
    const plan = buildExportPlan(p, s, 'x.mp4', (m) => m.path);
    const inputs = plan.args.filter((a, i) => plan.args[i - 1] === '-i');
    expect(inputs).toEqual([C.path]); // only clip C (8–12 s); A, B and the music are skipped
    const r = await runExport(p, s);
    expect(r.status, JSON.stringify(r).slice(0, 800)).toBe('done');
    const frames = samplePatch(s.outputPath, 160, 120).map((px) => decodeCodedFrame(px, 30));
    expect(frames.length).toBe(75);
    expect(frames[0].frame).toBe(15); // 8.5 s = C frame 15
    expect(idOf(frames[0].cb)).toBe('C');
  });

  it('a clip straddling the range start keeps its animation timing', async () => {
    let p = threeClips();
    const b = p.sequence.items[1].id;
    p = setAnimation(p, b, (a) => ({ ...a, in: { preset: 'fade', duration: 2 * S } })); // fades in over 4–6 s
    const full = settings('range-anim-full.mp4', {});
    const part = settings('range-anim-part.mp4', { range: { start: 5 * S, end: 6 * S } });
    expect((await runExport(p, full)).status).toBe('done');
    expect((await runExport(p, part)).status).toBe('done');
    const yFull = samplePatch(full.outputPath, 40, 40).slice(150, 180).map((x) => x.y);
    const yPart = samplePatch(part.outputPath, 40, 40).map((x) => x.y);
    expect(yPart.length).toBe(30);
    expect(Math.max(...yPart.map((y, i) => Math.abs(y - yFull[i])))).toBeLessThan(4);
  });

  it('rejects an empty or out-of-timeline range', () => {
    const p = threeClips();
    expect(validateExportSettings(p, settings('x.mp4', { range: { start: S, end: S } }), () => true).join()).toMatch(/range/);
    expect(validateExportSettings(p, settings('x.mp4', { range: { start: 0, end: 20 * S } }), () => true).join()).toMatch(/range/);
    expect(validateExportSettings(p, settings('x.mp4', { range: { start: S, end: 2 * S } }), () => true)).toEqual([]);
  });
});

describe('constant quality and encoders', () => {
  it('CRF: lower values give a higher video bitrate; no bitrate target is passed', async () => {
    const noisy = await mediaRefFor(makeNoisy('noisy_crf', 3));
    const p = addClip(addMedia({ ...createProject('crf'), canvas: { width: 320, height: 240, preset: 'custom' } }, [noisy]), noisy.id)!.project;
    const hi = settings('crf18.mp4', { rateControl: 'crf', crf: 18 });
    const lo = settings('crf32.mp4', { rateControl: 'crf', crf: 32 });
    const plan = buildExportPlan(p, hi, 'x.mp4', (m) => m.path);
    expect(plan.args[plan.args.indexOf('-crf') + 1]).toBe('18');
    expect(plan.args).not.toContain('-b:v');
    expect((await runExport(p, hi)).status).toBe('done');
    expect((await runExport(p, lo)).status).toBe('done');
    const vbr = (f: string) => Number(ffprobe(f).streams.find((x: any) => x.codec_type === 'video').bit_rate);
    expect(vbr(hi.outputPath)).toBeGreaterThan(vbr(lo.outputPath) * 2);
  });

  it('VideoToolbox: hardware encoder arguments; CRF is refused with it', () => {
    const p = threeClips();
    const plan = buildExportPlan(p, settings('x.mp4', { encoder: 'videotoolbox' }), 'x.mp4', (m) => m.path);
    const i = plan.args.indexOf('-c:v');
    expect(plan.args[i + 1]).toBe('h264_videotoolbox');
    expect(plan.args).toContain('-b:v');
    expect(plan.args).not.toContain('-preset');
    const errs = validateExportSettings(p, settings('x.mp4', { encoder: 'videotoolbox', rateControl: 'crf', crf: 20 }), () => true);
    expect(errs.join()).toMatch(/hardware/);
  });

  it('CRF outside the allowed range is refused', () => {
    const errs = validateExportSettings(threeClips(), settings('x.mp4', { rateControl: 'crf', crf: 60 }), () => true);
    expect(errs.join()).toMatch(/CRF/);
  });
});
