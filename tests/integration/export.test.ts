/**
 * Real exports with FFmpeg, inspected with ffprobe and by decoding frames/audio.
 * Run: npm run test:export
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runExport } from '../../src/main/export/exportRunner';
import type { ExportSettings } from '../../src/shared/exportPlan';
import { type MediaRef, type Project, createProject, layoutSequence } from '../../src/shared/model';
import { addClip, addMedia, deleteItem, moveItem, setClipRange, setFraming, splitAt } from '../../src/shared/ops';
import { TICKS_PER_SECOND as S, frameDuration } from '../../src/shared/time';
import {
  OUTPUT_DIR, decodeCodedFrame, ensureDirs, ffprobe, makeCoded, makeNoisy, makeSync, mediaRefFor, readAudio, rms,
  samplePatch, toneFrequency,
} from '../helpers/fixtures';

const F30 = frameDuration({ num: 30, den: 1 });
let A: MediaRef, B: MediaRef, C: MediaRef;

function settings(name: string, over: Partial<ExportSettings> = {}): ExportSettings {
  return {
    outputPath: path.join(OUTPUT_DIR, name),
    width: 320, height: 240,
    frameRate: { num: 30, den: 1 },
    canvasMapping: 'fit',
    videoBitrateMbps: 8,
    x264Preset: 'veryfast',
    audioBitrateKbps: 192,
    ...over,
  };
}

function base(canvasW = 320, canvasH = 240): Project {
  let p = createProject('test');
  p = { ...p, canvas: { width: canvasW, height: canvasH, preset: 'custom' } };
  return addMedia(p, [A, B, C]);
}

function add(p: Project, m: MediaRef): Project {
  return addClip(p, m.id)!.project;
}

beforeAll(async () => {
  ensureDirs();
  A = await mediaRefFor(makeCoded({ name: 'A_320x240_30', width: 320, height: 240, fps: 30, seconds: 4, cb: 60, freq: 440 }));
  B = await mediaRefFor(makeCoded({ name: 'B_320x240_30', width: 320, height: 240, fps: 30, seconds: 4, cb: 128, freq: 880 }));
  C = await mediaRefFor(makeCoded({ name: 'C_320x240_30', width: 320, height: 240, fps: 30, seconds: 4, cb: 196, freq: 1320 }));
});

const idOf = (cb: number) => (Math.abs(cb - 60) < 15 ? 'A' : Math.abs(cb - 128) < 15 ? 'B' : Math.abs(cb - 196) < 15 ? 'C' : '?');

describe('export: trims, splits, reorder, delete', () => {
  it('produces exactly the expected source frame at every output frame, with matching audio', async () => {
    let p = base();
    p = add(add(add(p, A), B), C);
    const [ca, cb, cc] = p.sequence.items.map((i) => i.id);
    // A: source 1.0s..2.0s  B: 0.5s..2.0s  C: whole 4s, then split C at 1s into it, delete the first half, move B first.
    p = setClipRange(p, ca, 1 * S, 2 * S, 'in');
    p = setClipRange(p, cb, 15 * F30, 60 * F30, 'in');
    const cStart = layoutSequence(p).items[2].start;
    const split = splitAt(p, cStart + 1 * S)!;
    p = deleteItem(split.project, split.leftId, 'close-gap');
    p = moveItem(p, cb, 0);
    void cc;

    // Expected per-output-frame (fixture, source frame)
    const expected: { id: string; frame: number }[] = [];
    for (let f = 15; f < 60; f++) expected.push({ id: 'B', frame: f }); // 45 frames
    for (let f = 30; f < 60; f++) expected.push({ id: 'A', frame: f }); // 30 frames
    for (let f = 30; f < 120; f++) expected.push({ id: 'C', frame: f }); // 90 frames (C has 120)

    const r = await runExport(p, settings('order.mp4'));
    expect(r.status, JSON.stringify(r)).toBe('done');
    const probe = ffprobe(path.join(OUTPUT_DIR, 'order.mp4'));
    const v = probe.streams.find((s: any) => s.codec_type === 'video');
    expect(v.codec_name).toBe('h264');
    expect(Number(v.nb_read_frames)).toBe(expected.length);

    const frames = samplePatch(path.join(OUTPUT_DIR, 'order.mp4'), 160, 120).map((px) => {
      const d = decodeCodedFrame(px, 30);
      return { id: idOf(d.cb), frame: d.frame };
    });
    const mismatches = frames.map((f, i) => ({ i, got: f, want: expected[i] })).filter((m) => m.got.id !== m.want.id || m.got.frame !== m.want.frame);
    expect(mismatches.slice(0, 5)).toEqual([]);

    // Audio: tone per segment, cuts aligned with video cuts (check 5–25 ms either side of each cut).
    const pcm = readAudio(path.join(OUTPUT_DIR, 'order.mp4'));
    expect(pcm.length / 48000).toBeCloseTo(expected.length / 30, 2);
    const cuts = [45 / 30, 75 / 30];
    const freqs = [880, 440, 1320];
    expect(toneFrequency(pcm, 0.2, 1.2)).toBeCloseTo(880, -1);
    expect(toneFrequency(pcm, 1.7, 2.3)).toBeCloseTo(440, -1);
    expect(toneFrequency(pcm, 3, 5)).toBeCloseTo(1320, -1);
    cuts.forEach((c, i) => {
      expect(Math.abs(toneFrequency(pcm, c - 0.03, c - 0.005) - freqs[i])).toBeLessThan(60);
      expect(Math.abs(toneFrequency(pcm, c + 0.005, c + 0.03) - freqs[i + 1])).toBeLessThan(60);
    });
  });

  it('leave-gap deletion renders background and silence for the gap', async () => {
    let p = add(add(add(base(), A), B), C);
    p = { ...p, background: '#000000' };
    const [, cb] = p.sequence.items.map((i) => i.id);
    p = deleteItem(p, cb, 'leave-gap');
    expect(p.sequence.items.map((i) => i.kind)).toEqual(['clip', 'gap', 'clip']);
    const r = await runExport(p, settings('gap.mp4'));
    expect(r.status, JSON.stringify(r).slice(0, 1500)).toBe('done');
    const file = path.join(OUTPUT_DIR, 'gap.mp4');
    const frames = samplePatch(file, 160, 120);
    expect(frames.length).toBe(360);
    expect(frames[180].y).toBeLessThan(20); // middle of the gap: black
    const pcm = readAudio(file);
    expect(rms(pcm, 4.5, 7.5)).toBeLessThan(0.001);
    expect(rms(pcm, 1, 3)).toBeGreaterThan(0.05); // lavfi sine amplitude is 1/8
  });
});

describe('export: audio/video sync', () => {
  it('flash frames and beeps stay aligned after fractional trims and reordering', async () => {
    const SYNC = await mediaRefFor(makeSync('sync30'));
    let p = createProject('sync');
    p = addMedia({ ...p, canvas: { width: 320, height: 180, preset: 'custom' } }, [SYNC]);
    p = add(add(add(p, SYNC), SYNC), SYNC);
    const ids = p.sequence.items.map((i) => i.id);
    p = setClipRange(p, ids[0], 7 * F30, 100 * F30, 'in'); // starts 0.233s in
    p = setClipRange(p, ids[1], 41 * F30, 170 * F30, 'in');
    p = setClipRange(p, ids[2], 3 * F30, 80 * F30, 'in');
    p = moveItem(p, ids[2], 0);
    const r = await runExport(p, settings('sync.mp4', { width: 320, height: 180 }));
    expect(r.status, JSON.stringify(r).slice(0, 1500)).toBe('done');
    const file = path.join(OUTPUT_DIR, 'sync.mp4');
    const flashes = samplePatch(file, 160, 90).flatMap((px, i) => (px.y > 150 ? [i / 30] : []));
    const pcm = readAudio(file);
    const beeps: number[] = [];
    for (let i = 480; i < pcm.length; i++) {
      if (Math.abs(pcm[i]) > 0.2 && rms(pcm, (i - 480) / 48000, (i - 48) / 48000) < 0.02) {
        beeps.push(i / 48000);
        i += 24000; // skip the rest of this beep (they are ≥ 1 s apart)
      }
    }
    expect(flashes.length).toBeGreaterThanOrEqual(6);
    expect(beeps.length).toBe(flashes.length);
    flashes.forEach((t, i) => expect(Math.abs(beeps[i] - t)).toBeLessThan(0.012)); // < half a frame
  });
});

describe('export: canvas and framing', () => {
  const RED = '#ff0000';
  // Red in limited-range BT.709 YUV is roughly Y≈63, Cb≈102, Cr≈240.
  const isRed = (px: { y: number; u: number; v: number }) => px.v > 200 && px.u < 130;

  it('fit pads with the background colour; fill covers the canvas; output keeps canvas size', async () => {
    let p = add(base(1080, 1080), A);
    p = { ...p, background: RED };
    const id = p.sequence.items[0].id;
    const fitR = await runExport(p, settings('fit.mp4', { width: 540, height: 540 }));
    expect(fitR.status).toBe('done');
    const fitFile = path.join(OUTPUT_DIR, 'fit.mp4');
    // 4:3 source in a square: fitted image is 540×405, bands of ~67px top and bottom.
    expect(isRed(samplePatch(fitFile, 270, 20)[5])).toBe(true);
    expect(isRed(samplePatch(fitFile, 270, 270)[5])).toBe(false);
    expect(isRed(samplePatch(fitFile, 20, 270)[5])).toBe(false);
    // Colour accuracy: decoded as BT.709 (as tagged), the padding must be pure red, not orange.
    const rgb = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', fitFile, '-frames:v', '1',
      '-vf', 'scale=in_color_matrix=bt709:in_range=tv,format=rgb24,crop=1:1:270:10', '-f', 'rawvideo', '-']);
    expect([...rgb].map((v, i) => Math.abs(v - [255, 0, 0][i]) <= 4)).toEqual([true, true, true]);

    const fillR = await runExport(setFraming(p, id, { mode: 'fill', scale: 1, x: 0, y: 0 }), settings('fill.mp4', { width: 540, height: 540 }));
    expect(fillR.status).toBe('done');
    const fillFile = path.join(OUTPUT_DIR, 'fill.mp4');
    expect(isRed(samplePatch(fillFile, 270, 20)[5])).toBe(false);
    expect(isRed(samplePatch(fillFile, 270, 520)[5])).toBe(false);
    const v = ffprobe(fillFile).streams.find((s: any) => s.codec_type === 'video');
    expect([v.width, v.height]).toEqual([540, 540]);
  });

  it('manual framing positions and scales the image', async () => {
    let p = add(base(1080, 1080), A);
    p = { ...p, background: RED };
    const id = p.sequence.items[0].id;
    // Fit size of a 4:3 source in 1080² is 1080×810; half of that is 540×405, centred 270px right
    // of the canvas centre → spans x 540..1080, y ≈ 338..742.
    p = setFraming(p, id, { mode: 'manual', scale: 0.5, x: 0.25, y: 0 });
    const r = await runExport(p, settings('manual.mp4', { width: 1080, height: 1080 }));
    expect(r.status).toBe('done');
    const f = path.join(OUTPUT_DIR, 'manual.mp4');
    expect(isRed(samplePatch(f, 300, 540)[3])).toBe(true);
    expect(isRed(samplePatch(f, 524, 540)[3])).toBe(true);
    expect(isRed(samplePatch(f, 560, 540)[3])).toBe(false);
    expect(isRed(samplePatch(f, 1060, 540)[3])).toBe(false);
    expect(isRed(samplePatch(f, 810, 320)[3])).toBe(true);
    expect(isRed(samplePatch(f, 810, 360)[3])).toBe(false);
  });

  it('manual framing larger than the canvas is cropped, not stretched', async () => {
    let p = add(base(320, 240), A);
    const id = p.sequence.items[0].id;
    p = setFraming(p, id, { mode: 'manual', scale: 4, x: 0, y: 0 });
    const r = await runExport(p, settings('zoom.mp4'));
    expect(r.status, JSON.stringify(r).slice(0, 1500)).toBe('done');
    // At 4× the centre 80×60 source pixels fill the frame; source is flat-coloured so it should decode to A frame 0.
    const px = samplePatch(path.join(OUTPUT_DIR, 'zoom.mp4'), 160, 120)[0];
    expect(idOf(px.u)).toBe('A');
  });

  it('regression: manual framing whose crop rounds past the frame edge still exports', async () => {
    // Found by the UI test: 1280×720 source, 1080×1920 canvas, 150% manual, exported at 720×1280.
    const W = await mediaRefFor(makeCoded({ name: 'W_1280x720_30', width: 1280, height: 720, fps: 30, seconds: 1, cb: 60, freq: 440 }));
    let p = createProject('crop');
    p = addMedia({ ...p, canvas: { width: 1080, height: 1920, preset: '9:16' } }, [W]);
    p = add(p, W);
    p = setFraming(p, p.sequence.items[0].id, { mode: 'manual', scale: 1.5, x: 0.1388888888888889, y: 0.05859375 });
    const r = await runExport(p, settings('crop-edge.mp4', { width: 720, height: 1280, frameRate: { num: 25, den: 1 } }));
    expect(r.status, JSON.stringify(r).slice(0, 600)).toBe('done');
  });

  it('portrait canvas with a different-aspect output letterboxes explicitly (fit) or crops (fill)', async () => {
    let p = add(base(1080, 1920), A);
    p = { ...p, background: RED };
    const id = p.sequence.items[0].id;
    p = setFraming(p, id, { mode: 'fill', scale: 1, x: 0, y: 0 });
    // Square output from a 9:16 canvas, mapping = fit → red side bars.
    const r = await runExport(p, settings('portrait-fit.mp4', { width: 640, height: 640, canvasMapping: 'fit' }));
    expect(r.status, JSON.stringify(r).slice(0, 1500)).toBe('done');
    const f = path.join(OUTPUT_DIR, 'portrait-fit.mp4');
    expect(isRed(samplePatch(f, 20, 320)[2])).toBe(true);
    expect(isRed(samplePatch(f, 320, 320)[2])).toBe(false);
    const r2 = await runExport(p, settings('portrait-fill.mp4', { width: 640, height: 640, canvasMapping: 'fill' }));
    expect(r2.status).toBe('done');
    expect(isRed(samplePatch(path.join(OUTPUT_DIR, 'portrait-fill.mp4'), 20, 320)[2])).toBe(false);
  });
});

describe('export: encoder settings', () => {
  it('honours resolution, fractional frame rate and approximate target bitrate', async () => {
    const N = await mediaRefFor(makeNoisy('noisy720'));
    let p = createProject('rate');
    p = addMedia({ ...p, canvas: { width: 1280, height: 720, preset: '16:9' } }, [N]);
    p = add(p, N);
    const r = await runExport(p, settings('bitrate.mp4', { width: 1280, height: 720, frameRate: { num: 30000, den: 1001 }, videoBitrateMbps: 4 }));
    expect(r.status, JSON.stringify(r)).toBe('done');
    if (r.status !== 'done') return;
    const pr = ffprobe(r.output.path);
    const v = pr.streams.find((s: any) => s.codec_type === 'video');
    const a = pr.streams.find((s: any) => s.codec_type === 'audio');
    expect(v.r_frame_rate).toBe('30000/1001');
    expect([v.width, v.height]).toEqual([1280, 720]);
    expect(v.profile).toBe('High');
    expect(a.codec_name).toBe('aac');
    expect(Number(a.sample_rate)).toBe(48000);
    expect(a.channels).toBe(2);
    const mbps = Number(v.bit_rate) / 1e6;
    console.log(`target 4 Mb/s → measured ${mbps.toFixed(2)} Mb/s`);
    expect(mbps).toBeGreaterThan(3.0);
    expect(mbps).toBeLessThan(5.0);
    // 6 s of source at 29.97 → floor(6s / project frame) frames
    expect(Number(v.nb_read_frames)).toBe(180); // round(6 s × 29.97)
  });
});

describe('export: failure and cancellation leave no misleading files', () => {
  it('cancelled export removes the partial file and writes no output', async () => {
    const N = await mediaRefFor(makeNoisy('noisy720'));
    let p = createProject('cancel');
    p = addMedia({ ...p, canvas: { width: 1280, height: 720, preset: '16:9' } }, [N]);
    p = add(add(add(p, N), N), N);
    const ctrl = new AbortController();
    let sawProgress = false;
    const out = settings('cancelled.mp4', { width: 1280, height: 720, x264Preset: 'slow' });
    const pending = runExport(p, out, {
      signal: ctrl.signal,
      onProgress: (pr) => {
        if (pr.fraction > 0 && !sawProgress) {
          sawProgress = true;
          ctrl.abort();
        }
      },
    });
    const r = await pending;
    expect(r.status).toBe('cancelled');
    expect(sawProgress).toBe(true);
    expect(existsSync(out.outputPath)).toBe(false);
    expect(readdirSync(OUTPUT_DIR).filter((f) => f.startsWith('cancelled'))).toEqual([]);
  });

  it('a missing source file fails with a readable message before running', async () => {
    let p = add(base(), A);
    p = { ...p, media: p.media.map((m) => (m.id === A.id ? { ...m, path: '/nonexistent/A.mp4' } : m)) };
    const r = await runExport(p, settings('missing.mp4'));
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.message).toMatch(/offline/);
    expect(existsSync(path.join(OUTPUT_DIR, 'missing.mp4'))).toBe(false);
  });

  it('an FFmpeg failure mid-run removes the partial file', async () => {
    // A file that probes fine but whose path vanishes between validation and encoding is hard to
    // stage; instead corrupt the input mapping so FFmpeg itself errors.
    let p = add(base(), A);
    const r = await runExport(p, settings('ffail.mp4'), { mediaPath: () => path.join(OUTPUT_DIR, 'does-not-exist.mp4') });
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.message).toMatch(/could not be found/);
    expect(existsSync(path.join(OUTPUT_DIR, 'ffail.mp4'))).toBe(false);
    expect(existsSync(path.join(OUTPUT_DIR, 'ffail.mp4.partial'))).toBe(false);
  });

  it('refuses to write into a folder that does not exist', async () => {
    const p = add(base(), A);
    const r = await runExport(p, settings('x.mp4', { outputPath: '/nonexistent-dir/x.mp4' }));
    expect(r.status).toBe('failed');
  });
});
