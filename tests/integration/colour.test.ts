/**
 * Source colour interpretation matches the preview (Chromium): tagged matrix wins, untagged
 * video under 720 lines is BT.601, otherwise BT.709; full-range sources are scaled to TV range.
 * The export is BT.709 limited range, so pure green must come out as pure green.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runExport } from '../../src/main/export/exportRunner';
import { createProject } from '../../src/shared/model';
import { addClip, addMedia } from '../../src/shared/ops';
import { FIXTURE_DIR, OUTPUT_DIR, ensureDirs, mediaRefFor } from '../helpers/fixtures';

const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const variants: Record<string, { size: string; extra: string[] }> = {
  'untagged-sd': { size: '640x360', extra: [] },
  'untagged-hd': { size: '1280x720', extra: ['-vf', 'scale=out_color_matrix=bt709,format=yuv420p'] },
  'tagged-601-hd': { size: '1280x720', extra: ['-colorspace', 'smpte170m', '-color_primaries', 'smpte170m', '-color_trc', 'smpte170m'] },
  'full-range-sd': { size: '640x360', extra: ['-vf', 'scale=out_range=pc,format=yuvj420p', '-color_range', 'pc'] },
};

beforeAll(() => {
  ensureDirs();
  for (const [name, v] of Object.entries(variants)) {
    const f = path.join(FIXTURE_DIR, `green-${name}.mp4`);
    if (!existsSync(f)) {
      ff(['-f', 'lavfi', '-i', `color=c=0x00ff00:s=${v.size}:r=30:d=1`, '-f', 'lavfi', '-i', 'sine=d=1',
        ...(v.extra.includes('-vf') ? [] : ['-pix_fmt', 'yuv420p']), ...v.extra, '-c:v', 'libx264', '-qp', '4', '-c:a', 'aac', '-shortest', f]);
    }
  }
});

describe('colour interpretation', () => {
  for (const name of Object.keys(variants)) {
    it(`${name}: pure green stays pure green`, async () => {
      const m = await mediaRefFor(path.join(FIXTURE_DIR, `green-${name}.mp4`));
      let p = addMedia({ ...createProject(), canvas: { width: 320, height: 180, preset: 'custom' } }, [m]);
      p = addClip(p, m.id)!.project;
      const out = path.join(OUTPUT_DIR, `green-${name}.mp4`);
      const r = await runExport(p, { outputPath: out, width: 320, height: 180, frameRate: { num: 30, den: 1 }, canvasMapping: 'fit', videoBitrateMbps: 4, x264Preset: 'veryfast', audioBitrateKbps: 128 });
      expect(r.status).toBe('done');
      const rgb = [...execFileSync('ffmpeg', ['-loglevel', 'error', '-i', out, '-frames:v', '1', '-vf', 'scale=in_color_matrix=bt709:in_range=tv,format=rgb24,crop=1:1:160:90', '-f', 'rawvideo', '-'])];
      expect(rgb[0]).toBeLessThan(12);
      expect(rgb[1]).toBeGreaterThan(243);
      expect(rgb[2]).toBeLessThan(12);
    });
  }
});
