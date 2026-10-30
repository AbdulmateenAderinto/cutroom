/**
 * Colour adjustments in export: flat colours come out as applyColor() predicts (the same
 * transform the preview's SVG filter uses), for video (SD BT.601 and HD BT.709) and photos.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runExport } from '../../src/main/export/exportRunner';
import { type ColorAdjust, NEUTRAL, applyColor } from '../../src/shared/color';
import { type MediaRef, createProject } from '../../src/shared/model';
import { addClip, addMedia, setColor } from '../../src/shared/ops';
import { FIXTURE_DIR, OUTPUT_DIR, ensureDirs, mediaRefFor } from '../helpers/fixtures';

const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
// Four flat patches: orange, teal, mid grey, dark red (quadrants of the frame).
const PATCHES = [[230, 140, 40], [40, 160, 150], [128, 128, 128], [110, 30, 30]];
const hex = (c: number[]) => `0x${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const quadSrc = (w: number, h: number) =>
  `color=c=${hex(PATCHES[0])}:s=${w / 2}x${h / 2}[a];color=c=${hex(PATCHES[1])}:s=${w / 2}x${h / 2}[b];` +
  `color=c=${hex(PATCHES[2])}:s=${w / 2}x${h / 2}[c];color=c=${hex(PATCHES[3])}:s=${w / 2}x${h / 2}[d];[a][b]hstack[top];[c][d]hstack[bot];[top][bot]vstack`;

let SD: MediaRef;
let HD: MediaRef;
let PHOTO: MediaRef;

beforeAll(async () => {
  ensureDirs();
  const sd = path.join(FIXTURE_DIR, 'quad-sd.mp4');
  if (!existsSync(sd)) ff(['-f', 'lavfi', '-t', '1', '-i', `${quadSrc(640, 360)},fps=30,format=yuv420p`, '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', sd]);
  const hd = path.join(FIXTURE_DIR, 'quad-hd.mp4');
  if (!existsSync(hd)) ff(['-f', 'lavfi', '-t', '1', '-i', `${quadSrc(1280, 720)},fps=30,scale=out_color_matrix=bt709,format=yuv420p`, '-c:v', 'libx264', '-qp', '0', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', hd]);
  const png = path.join(FIXTURE_DIR, 'quad.png');
  if (!existsSync(png)) ff(['-f', 'lavfi', '-i', quadSrc(640, 360), '-frames:v', '1', png]);
  [SD, HD, PHOTO] = await Promise.all([sd, hd, png].map(mediaRefFor));
});

function rgbAt(file: string, x: number, y: number, matrix: 'bt709' | 'bt601' | 'rgb' = 'bt709'): number[] {
  const conv = matrix === 'rgb' ? 'format=rgb24' : `scale=in_color_matrix=${matrix}:in_range=tv,format=rgb24`;
  return [...execFileSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-frames:v', '1', '-vf', `${conv},crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-'])];
}

const CASES: [string, Partial<ColorAdjust>][] = [
  ['neutral', {}],
  ['exposure +1', { exposure: 1 }],
  ['exposure -1, contrast 1.5', { exposure: -1, contrast: 1.5 }],
  ['black and white', { saturation: 0 }],
  ['vivid, warm', { saturation: 1.6, temperature: 0.8 }],
  ['flat, cool', { contrast: 0.5, temperature: -1 }],
];

describe('colour adjustments in export', () => {
  const sources = [
    ['SD video (BT.601)', () => SD, 'bt601'],
    ['HD video (BT.709)', () => HD, 'bt709'],
    ['photo', () => PHOTO, 'rgb'],
  ] as const;
  for (const [srcName, get, matrix] of sources) {
    it(`${srcName}: every patch matches applyColor() for ${CASES.length} settings`, async () => {
      const m = get();
      // What the source decodes to (as the preview sees it), at the middle of each patch.
      const w = m.info.displayWidth;
      const h = m.info.displayHeight;
      const source = PATCHES.map((_, i) => rgbAt(m.path, Math.round(w * (i % 2 ? 0.75 : 0.25)), Math.round(h * (i < 2 ? 0.25 : 0.75)), matrix));
      let worst = 0;
      let where = '';
      for (const [name, adj] of CASES) {
        let p = addMedia({ ...createProject('color'), canvas: { width: 320, height: 180, preset: 'custom' } }, [m]);
        p = addClip(p, m.id)!.project;
        p = setColor(p, p.sequence.items[0].id, adj);
        const out = path.join(OUTPUT_DIR, `color-${srcName.split(' ')[0]}-${name.replace(/\W+/g, '_')}.mp4`);
        const r = await runExport(p, { outputPath: out, width: 320, height: 180, frameRate: { num: 30, den: 1 }, canvasMapping: 'fit', videoBitrateMbps: 8, x264Preset: 'veryfast', audioBitrateKbps: 128, rateControl: 'crf', crf: 12 }, { previewPlatform: 'other' });
        expect(r.status, JSON.stringify(r).slice(0, 800)).toBe('done');
        source.forEach((rgb, i) => {
          const got = rgbAt(out, i % 2 ? 240 : 80, i < 2 ? 45 : 135);
          const want = applyColor({ ...NEUTRAL, ...adj }, rgb);
          const err = Math.max(...got.map((v, k) => Math.abs(v - want[k])));
          if (err > worst) {
            worst = err;
            where = `${name}, patch ${i}: got ${got} want ${want.map(Math.round)}`;
          }
        });
      }
      expect(worst, where).toBeLessThanOrEqual(4);
    });
  }
});
