/**
 * Rotation in export, checked against the shared geometry (computeClipRect + animateRect + the
 * angle, rotated around the picture's centre — what the preview does with CSS): points well inside
 * the rotated picture are red, points well outside are the background, for a static rotation, a
 * rotation keyframed from 0° to 90°, and a rotated overlay (PiP).
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runExport } from '../../src/main/export/exportRunner';
import { evalAnimation } from '../../src/shared/animation';
import { type ClipItem, type MediaRef, type Project, animateRect, clipAngle, computeClipRect, createProject } from '../../src/shared/model';
import { addClip, addMedia, setFraming, setKeyframe } from '../../src/shared/ops';
import { addOverlay, findOverlay } from '../../src/shared/overlays';
import { TICKS_PER_SECOND as S, frameToTicks } from '../../src/shared/time';
import { FIXTURE_DIR, OUTPUT_DIR, ensureDirs, mediaRefFor } from '../helpers/fixtures';

const R30 = { num: 30, den: 1 };
const W = 320;
const H = 240;
let BAR: MediaRef; // solid red, 4:1
let GREY: MediaRef;

const solid = (name: string, c: string, w: number, h: number) => {
  const f = path.join(FIXTURE_DIR, `${name}.mp4`);
  if (!existsSync(f)) {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${c}:s=${w}x${h}:r=30:d=2,format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv`,
      '-f', 'lavfi', '-i', 'sine=d=2', '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-c:a', 'aac', '-shortest', f]);
  }
  return f;
};

beforeAll(async () => {
  ensureDirs();
  BAR = await mediaRefFor(solid('red-bar-4x1', '0xff0000', 400, 100));
  GREY = await mediaRefFor(solid('grey-640x480', '0x404040', 640, 480));
});

/** RGB frames of an export (W×H). */
function frames(file: string): Uint8Array[] {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 });
  const n = raw.length / (W * H * 3);
  return Array.from({ length: n }, (_, i) => raw.subarray(i * W * H * 3, (i + 1) * W * H * 3));
}
const isRed = (f: Uint8Array, x: number, y: number) => {
  const i = (Math.round(y) * W + Math.round(x)) * 3;
  return f[i] > 200 && f[i + 1] < 60 && f[i + 2] < 60;
};

/** Grid points at least `margin` px inside / outside the rotated rectangle. */
function check(f: Uint8Array, rect: { x: number; y: number; w: number; h: number }, angle: number, margin = 3): string[] {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const a = (-angle * Math.PI) / 180;
  const bad: string[] = [];
  for (let y = 2; y < H - 2; y += 6) {
    for (let x = 2; x < W - 2; x += 6) {
      // Into the picture's own (unrotated) coordinates.
      const dx = x - cx;
      const dy = y - cy;
      const u = dx * Math.cos(a) - dy * Math.sin(a);
      const v = dx * Math.sin(a) + dy * Math.cos(a);
      const inside = Math.abs(u) < rect.w / 2 - margin && Math.abs(v) < rect.h / 2 - margin;
      const outside = Math.abs(u) > rect.w / 2 + margin || Math.abs(v) > rect.h / 2 + margin;
      if (inside && !isRed(f, x, y)) bad.push(`(${x},${y}) should be red`);
      if (outside && isRed(f, x, y)) bad.push(`(${x},${y}) should not be red`);
    }
  }
  return bad;
}

function base(): Project {
  let p = addMedia({ ...createProject('rot'), canvas: { width: W, height: H, preset: 'custom' }, background: '#000000' }, [BAR, GREY]);
  return addClip(p, BAR.id)!.project;
}
const exp = async (p: Project, name: string) => {
  const outputPath = path.join(OUTPUT_DIR, name);
  const r = await runExport(p, { outputPath, width: W, height: H, frameRate: R30, canvasMapping: 'fit', videoBitrateMbps: 8, x264Preset: 'veryfast', audioBitrateKbps: 128 });
  expect(r.status, JSON.stringify(r).slice(0, 1500)).toBe('done');
  return frames(outputPath);
};

describe('rotation in export', () => {
  for (const angle of [30, 90, -135]) {
    it(`static ${angle}°: the picture is rotated around its centre, corners off the canvas cut off`, async () => {
      let p = base();
      const id = p.sequence.items[0].id;
      p = setFraming(p, id, { mode: 'manual', scale: 0.8, x: 0.05, y: 0, rotation: angle });
      const fs = await exp(p, `rot-${angle}.mp4`);
      const rect = computeClipRect(400, 100, W, H, (p.sequence.items[0] as ClipItem).framing);
      expect(check(fs[10], rect, angle).slice(0, 5)).toEqual([]);
    });
  }

  it('keyframed 0° → 90° over 1 s: every 5th frame matches the shared angle', async () => {
    let p = base();
    const id = p.sequence.items[0].id;
    p = setFraming(p, id, { mode: 'manual', scale: 0.7, x: 0, y: 0 });
    p = setKeyframe(p, id, 'rotation', 0, 0, 'linear');
    p = setKeyframe(p, id, 'rotation', 1 * S, 90, 'linear');
    const fs = await exp(p, 'rot-keyframed.mp4');
    const c = p.sequence.items[0] as ClipItem;
    const r0 = computeClipRect(400, 100, W, H, c.framing);
    const bad: string[] = [];
    for (let j = 0; j < 45; j += 5) {
      const st = evalAnimation(c.animation, frameToTicks(j, R30), 2 * S, c.sourceIn);
      bad.push(...check(fs[j], animateRect(r0, st, W, H), clipAngle(c.framing, st.rotation)).map((b) => `frame ${j}: ${b}`));
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('a rotated overlay (PiP) over another clip', async () => {
    let p = addMedia({ ...createProject('rotov'), canvas: { width: W, height: H, preset: 'custom' } }, [BAR, GREY]);
    p = addClip(p, GREY.id)!.project;
    const r = addOverlay(p, BAR.id, 0, { corner: 'center', size: 0.6 })!;
    p = setFraming(r.project, r.id, { ...findOverlay(r.project, r.id)!.framing, rotation: 45 });
    const fs = await exp(p, 'rot-overlay.mp4');
    const rect = computeClipRect(400, 100, W, H, findOverlay(p, r.id)!.framing);
    expect(check(fs[10], rect, 45).slice(0, 5)).toEqual([]);
    // Outside the PiP the grey main clip shows (not black: the rotated layer is transparent there).
    const i = (10 * W + 10) * 3;
    expect(Math.abs(fs[10][i] - 0x40)).toBeLessThan(8);
  });
});
