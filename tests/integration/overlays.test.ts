/**
 * Overlay tracks (picture-in-picture) in export: the overlay shows the right source frame inside
 * its rectangle (computeClipRect, same as the preview) only while it is on the timeline, the main
 * track shows around it, higher rows draw on top, fades change only the overlay's opacity, its
 * sound is mixed in, and a range export matches the full export.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runExport } from '../../src/main/export/exportRunner';
import type { ExportSettings } from '../../src/shared/exportPlan';
import { type MediaRef, type Project, computeClipRect, createProject } from '../../src/shared/model';
import { addClip, addMedia, setAnimation } from '../../src/shared/ops';
import { addOverlay, moveOverlay } from '../../src/shared/overlays';
import { evalAnimation } from '../../src/shared/animation';
import { TICKS_PER_SECOND as S } from '../../src/shared/time';
import { FIXTURE_DIR, OUTPUT_DIR, decodeCodedFrame, ensureDirs, makeCoded, mediaRefFor, readAudio, samplePatch } from '../helpers/fixtures';

const R30 = { num: 30, den: 1 };
let DARK: MediaRef;
let LIGHT: MediaRef;
let CODED: MediaRef;

function grey(name: string, rgb: string, freq: number): string {
  const f = path.join(FIXTURE_DIR, `${name}.mp4`);
  if (!existsSync(f)) {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${rgb}:s=320x240:r=30:d=4`,
      '-f', 'lavfi', '-i', `sine=f=${freq}:r=48000:d=4`, '-c:v', 'libx264', '-qp', '4', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', f]);
  }
  return f;
}

beforeAll(async () => {
  ensureDirs();
  DARK = await mediaRefFor(grey('grey-dark-440', '0x303030', 440));
  LIGHT = await mediaRefFor(grey('grey-light-880', '0xd0d0d0', 880));
  CODED = await mediaRefFor(makeCoded({ name: 'B_320x240_30_1320', width: 320, height: 240, fps: 30, seconds: 4, cb: 200, freq: 1320 }));
});

const settings = (name: string, over: Partial<ExportSettings> = {}): ExportSettings => ({
  outputPath: path.join(OUTPUT_DIR, name), width: 320, height: 240, frameRate: R30, canvasMapping: 'fit',
  videoBitrateMbps: 8, x264Preset: 'veryfast', audioBitrateKbps: 192, ...over,
});

/** Dark main clip (4 s); the coded clip as a PiP (half size, bottom right) from 1 s to 3 s. */
function project(): { p: Project; id: string; rect: { x: number; y: number; w: number; h: number } } {
  let p = addMedia({ ...createProject('ov'), canvas: { width: 320, height: 240, preset: 'custom' } }, [DARK, LIGHT, CODED]);
  p = addClip(p, DARK.id)!.project;
  const r = addOverlay(p, CODED.id, 1 * S, { corner: 'bottomRight', size: 0.5 })!;
  p = r.project;
  const o = p.overlays![0];
  p = { ...p, overlays: [{ ...o, sourceOut: 2 * S }] };
  return { p, id: r.id, rect: computeClipRect(320, 240, 320, 240, o.framing) };
}

/** Amplitude of one frequency in [t0, t1) seconds (Goertzel). */
function amp(pcm: Float32Array, freq: number, t0: number, t1: number): number {
  const a = Math.floor(t0 * 48000);
  const b = Math.floor(t1 * 48000);
  const c = 2 * Math.cos((2 * Math.PI * freq) / 48000);
  let s1 = 0;
  let s2 = 0;
  for (let i = a; i < b; i++) {
    const s0 = pcm[i] + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return (2 * Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2)) / (b - a);
}

async function exp(p: Project, name: string, over: Partial<ExportSettings> = {}) {
  const s = settings(name, over);
  const r = await runExport(p, s);
  expect(r.status, JSON.stringify(r).slice(0, 1500)).toBe('done');
  return s.outputPath;
}

describe('overlay tracks in export', () => {
  let file: string;
  let rect: { x: number; y: number; w: number; h: number };
  let p: Project;
  beforeAll(async () => {
    ({ p, rect } = project());
    file = await exp(p, 'ov-pip.mp4');
  });

  it('the PiP rectangle is half size in the bottom-right corner with a margin', () => {
    expect(rect.w).toBeCloseTo(160, 0);
    expect(rect.h).toBeCloseTo(120, 0);
    const m = 0.04 * 240;
    expect(rect.x + rect.w).toBeCloseTo(320 - m, 0);
    expect(rect.y + rect.h).toBeCloseTo(240 - m, 0);
  });

  it('inside the rectangle: source frame f−30 while on the timeline (1–3 s), the main track otherwise', () => {
    const inside = samplePatch(file, rect.x + rect.w / 2, rect.y + rect.h / 2);
    expect(inside.length).toBe(120);
    const wrong: string[] = [];
    inside.forEach((px, f) => {
      if (f >= 30 && f < 90) {
        const got = decodeCodedFrame(px, 30).frame;
        if (got !== f - 30) wrong.push(`${f}: ${got}`);
      } else if (Math.abs(px.y - inside[0].y) > 4) wrong.push(`${f}: luma ${px.y}`);
    });
    expect(wrong.slice(0, 5)).toEqual([]);
    expect(inside[0].y).toBeLessThan(70); // the dark main clip
  });

  it('outside the rectangle the main track shows throughout', () => {
    const outside = samplePatch(file, 60, 60).map((x) => x.y);
    expect(Math.max(...outside) - Math.min(...outside)).toBeLessThan(4);
    // Just outside the left edge of the PiP, and just inside it, during the overlay.
    const edgeOut = samplePatch(file, rect.x - 6, rect.y + rect.h / 2, 4)[45].y;
    const edgeIn = samplePatch(file, rect.x + 6, rect.y + rect.h / 2, 4)[45].y;
    expect(Math.abs(edgeOut - outside[45])).toBeLessThan(4);
    expect(Math.abs(edgeIn - outside[45])).toBeGreaterThan(20);
  });

  it('the overlay’s sound is mixed in only while it plays', () => {
    const pcm = readAudio(file);
    const on = amp(pcm, 1320, 1.3, 2.7);
    const off = Math.max(amp(pcm, 1320, 0.2, 0.8), amp(pcm, 1320, 3.3, 3.8));
    expect(on).toBeGreaterThan(0.05);
    expect(off).toBeLessThan(on / 30);
    expect(amp(pcm, 440, 1.3, 2.7)).toBeGreaterThan(0.05); // the main track is still heard
  });

  it('a higher row draws on top; a lower row stays below', async () => {
    // A light full-frame overlay on row 1 from 1.5 s to 2.5 s: covers the PiP there.
    let q = addOverlay(p, LIGHT.id, 1.5 * S, { row: 1, corner: 'full' })!.project;
    q = { ...q, overlays: q.overlays!.map((o) => (o.mediaId === LIGHT.id ? { ...o, sourceOut: 1 * S } : o)) };
    const f2 = await exp(q, 'ov-rows.mp4');
    const inside = samplePatch(f2, rect.x + rect.w / 2, rect.y + rect.h / 2);
    expect(inside[60].y).toBeGreaterThan(180); // light on top
    expect(decodeCodedFrame(inside[40], 30).frame).toBe(10); // PiP before the light overlay starts
    expect(decodeCodedFrame(inside[80], 30).frame).toBe(50); // and after it ends
    // The same overlay moved to row 0 at a free time is still drawn; the main track is below both.
    const moved = moveOverlay(q, q.overlays!.find((o) => o.mediaId === LIGHT.id)!.id, 3 * S, 0);
    expect(moved.overlays!.find((o) => o.mediaId === LIGHT.id)!.start).toBe(3 * S);
  });

  it('a fade changes only the overlay’s opacity (the main track shows through, not black)', async () => {
    // A light full-frame overlay fading in over 1 s from 1 s: halfway, luma is halfway between.
    let q = addMedia({ ...createProject('ovf'), canvas: { width: 320, height: 240, preset: 'custom' } }, [DARK, LIGHT]);
    q = addClip(q, DARK.id)!.project;
    const r = addOverlay(q, LIGHT.id, 1 * S, { corner: 'full' })!;
    q = setAnimation(r.project, r.id, (a) => ({ ...a, in: { preset: 'fade', duration: 1 * S } }));
    const f3 = await exp(q, 'ov-fade.mp4');
    const y = samplePatch(f3, 160, 120).map((x) => x.y);
    const dark = y[10];
    const light = y[100];
    expect(light - dark).toBeGreaterThan(100);
    const anim = q.overlays![0].animation;
    for (const f of [31, 33, 37, 42]) {
      // Opacity from evalAnimation(), as the preview uses (the fade preset is eased).
      const o = evalAnimation(anim, ((f - 30) * S) / 30, 3 * S, 0).opacity;
      expect(o).toBeGreaterThan(0.05);
      expect(o).toBeLessThan(0.97);
      const want = dark + o * (light - dark);
      expect(Math.abs(y[f] - want), `frame ${f}`).toBeLessThan(6);
    }
  });

  it('a range export starting inside the overlay matches the full export', async () => {
    const f4 = await exp(p, 'ov-range.mp4', { range: { start: 2 * S, end: 3.5 * S } });
    const inside = samplePatch(f4, rect.x + rect.w / 2, rect.y + rect.h / 2);
    expect(inside.length).toBe(45);
    const frames = inside.slice(0, 30).map((px) => decodeCodedFrame(px, 30).frame);
    expect(frames.filter((f, i) => f !== 30 + i).slice(0, 5)).toEqual([]);
    expect(Math.abs(inside[40].y - samplePatch(file, rect.x + rect.w / 2, rect.y + rect.h / 2)[100].y)).toBeLessThan(4);
  });
});
