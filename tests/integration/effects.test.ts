/**
 * Effects in export, against the shared definitions: blur (a sharp black/white edge becomes the
 * Gaussian profile with σ = blur × picture width) and masks (alpha from maskAlpha(), over a black
 * background, for an ellipse with a soft edge, a hard rectangle and an inverted ellipse; on a
 * scaled, rotated PiP the mask moves with the picture).
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runExport } from '../../src/main/export/exportRunner';
import { type ClipMask, maskAlpha } from '../../src/shared/effects';
import { type MediaRef, type Project, computeClipRect, createProject } from '../../src/shared/model';
import { addClip, addMedia, setEffects, setFraming } from '../../src/shared/ops';
import { FIXTURE_DIR, OUTPUT_DIR, ensureDirs, mediaRefFor } from '../helpers/fixtures';

const W = 320;
const H = 240;
let EDGE: MediaRef; // left half black, right half white (320×240)
let WHITE: MediaRef;

const make = (name: string, src: string) => {
  const f = path.join(FIXTURE_DIR, name);
  if (!existsSync(f)) {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `${src},format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv`,
      '-f', 'lavfi', '-i', 'sine=d=2', '-t', '2', '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-c:a', 'aac', '-shortest', f]);
  }
  return f;
};
beforeAll(async () => {
  ensureDirs();
  EDGE = await mediaRefFor(make('edge-bw.mp4', 'color=c=black:s=160x240:r=30:d=2[l];color=c=white:s=160x240:r=30:d=2[r];[l][r]hstack'));
  WHITE = await mediaRefFor(make('white-320.mp4', 'color=c=white:s=320x240:r=30:d=2'));
});

/** Grey levels (0..255, full range) of frame 10. */
function grey(file: string): Uint8Array {
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', 'select=eq(n\\,10),scale=in_range=tv:out_range=pc,format=gray', '-frames:v', '1', '-f', 'rawvideo', '-']);
}
const base = (m: MediaRef) => {
  const p = addMedia({ ...createProject('fx'), canvas: { width: W, height: H, preset: 'custom' }, background: '#000000' }, [m]);
  return addClip(p, m.id)!.project;
};
const exp = async (p: Project, name: string) => {
  const outputPath = path.join(OUTPUT_DIR, name);
  const r = await runExport(p, { outputPath, width: W, height: H, frameRate: { num: 30, den: 1 }, canvasMapping: 'fit', videoBitrateMbps: 8, x264Preset: 'veryfast', audioBitrateKbps: 128 });
  expect(r.status, JSON.stringify(r).slice(0, 1500)).toBe('done');
  return grey(outputPath);
};
// Standard normal CDF.
const phi = (x: number) => 0.5 * (1 + Math.sign(x) * Math.sqrt(1 - Math.exp((-2 * x * x) / Math.PI)));

describe('blur in export', () => {
  it('a sharp edge becomes the Gaussian profile (σ = 0.02 × width = 6.4 px)', async () => {
    let p = base(EDGE);
    p = setEffects(p, p.sequence.items[0].id, { blur: 0.02 });
    const g = await exp(p, 'fx-blur.mp4');
    const row = Array.from({ length: W }, (_, x) => g[120 * W + x]);
    const sigma = 0.02 * 320;
    const bad: string[] = [];
    for (let x = 140; x < 180; x++) {
      const want = 16 + (235 - 16) * phi((x + 0.5 - 160) / sigma); // limited-range black/white, read back as full range
      const wantFull = ((want - 16) * 255) / 219;
      if (Math.abs(row[x] - wantFull) > 8) bad.push(`${x}: ${row[x]} want ${wantFull.toFixed(0)}`);
    }
    expect(bad.slice(0, 5)).toEqual([]);
    expect(row[100]).toBeLessThan(6); // far from the edge: unchanged
    expect(row[220]).toBeGreaterThan(249);
  });
});

describe('masks in export', () => {
  const cases: [string, ClipMask][] = [
    ['soft ellipse', { shape: 'ellipse', x: 0.45, y: 0.55, w: 0.6, h: 0.5, feather: 0.3 }],
    ['hard rectangle', { shape: 'rect', x: 0.5, y: 0.5, w: 0.5, h: 0.4, feather: 0 }],
    ['soft rectangle', { shape: 'rect', x: 0.5, y: 0.5, w: 0.7, h: 0.6, feather: 0.4 }],
    ['inverted ellipse', { shape: 'ellipse', x: 0.5, y: 0.5, w: 0.5, h: 0.5, feather: 0.2, invert: true }],
  ];
  for (const [name, mask] of cases) {
    it(`${name}: white × maskAlpha() over black, point by point`, async () => {
      let p = base(WHITE);
      p = setEffects(p, p.sequence.items[0].id, { mask });
      const g = await exp(p, `fx-mask-${name.replace(/\W/g, '-')}.mp4`);
      const bad: string[] = [];
      for (let y = 4; y < H; y += 9) {
        for (let x = 4; x < W; x += 11) {
          const a = maskAlpha(mask, (x + 0.5) / W, (y + 0.5) / H);
          // A hard edge is exact only away from the border pixel.
          if (mask.feather === 0 && Math.abs(a - maskAlpha(mask, (x + 3) / W, (y + 3) / H)) > 0) continue;
          if (Math.abs(g[y * W + x] - 255 * a) > 10) bad.push(`(${x},${y}): ${g[y * W + x]} want ${(255 * a).toFixed(0)}`);
        }
      }
      expect(bad.slice(0, 5)).toEqual([]);
    });
  }

  it('on a scaled, rotated PiP the circle moves and turns with the picture', async () => {
    let p = base(WHITE);
    const id = p.sequence.items[0].id;
    p = setFraming(p, id, { mode: 'manual', scale: 0.5, x: 0.2, y: 0.1, rotation: 90 });
    const mask: ClipMask = { shape: 'ellipse', x: 0.5, y: 0.5, w: 0.5, h: 0.5 * (320 / 240), feather: 0 }; // a circle on a 4:3 picture
    p = setEffects(p, id, { mask });
    const g = await exp(p, 'fx-mask-pip.mp4');
    const r = computeClipRect(320, 240, W, H, { mode: 'manual', scale: 0.5, x: 0.2, y: 0.1 });
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const rad = 0.25 * r.w; // circle radius on screen
    expect(g[Math.round(cy) * W + Math.round(cx)]).toBeGreaterThan(245); // centre: white
    expect(g[Math.round(cy - rad + 4) * W + Math.round(cx)]).toBeGreaterThan(245); // just inside, above
    expect(g[Math.round(cy - rad - 4) * W + Math.round(cx)]).toBeLessThan(10); // just outside: black
    expect(g[Math.round(cy) * W + Math.round(cx + rad + 4)]).toBeLessThan(10);
  });
});
