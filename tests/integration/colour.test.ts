/**
 * Source colour interpretation matches the preview (Chromium): tagged matrix wins, untagged
 * video counts as SD by size (sourceColor); full-range sources are scaled to TV range.
 * The export is BT.709 limited range. Elsewhere pure green comes out as pure green; Chromium on
 * macOS shows SD primaries (SMPTE-C, EBU) converted to BT.709/sRGB, and the export does the same
 * (values measured in the preview: SMPTE-C green 63,251,0 and EBU green 0,255,28).
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runExport } from '../../src/main/export/exportRunner';
import { type PreviewPlatform, createProject } from '../../src/shared/model';
import { addClip, addMedia } from '../../src/shared/ops';
import { FIXTURE_DIR, OUTPUT_DIR, ensureDirs, mediaRefFor } from '../helpers/fixtures';

const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const GREEN = [0, 255, 0];
const SMPTE_C_GREEN = [63, 251, 0];
const EBU_GREEN = [0, 255, 28];
// RGB → YUV with a matrix/range, then the tags set on the frames (FFmpeg 8+ would otherwise
// convert untagged frames to match output tag options). '' tags = untagged.
const variants: Record<string, { size: string; matrix: string; range: string; tags: string; mac: number[] }> = {
  'untagged-sd': { size: '640x360', matrix: 'bt601', range: 'tv', tags: 'colorspace=unknown', mac: SMPTE_C_GREEN },
  'untagged-hd': { size: '1280x720', matrix: 'bt709', range: 'tv', tags: 'colorspace=unknown', mac: GREEN },
  'tagged-601-hd': { size: '1280x720', matrix: 'bt601', range: 'tv', tags: 'colorspace=smpte170m:color_primaries=smpte170m:color_trc=smpte170m', mac: SMPTE_C_GREEN },
  'tagged-pal-sd': { size: '640x360', matrix: 'bt601', range: 'tv', tags: 'colorspace=bt470bg:color_primaries=bt470bg:color_trc=bt709', mac: EBU_GREEN },
  'full-range-sd': { size: '640x360', matrix: 'bt601', range: 'pc', tags: 'colorspace=unknown:range=pc', mac: SMPTE_C_GREEN },
};

beforeAll(() => {
  ensureDirs();
  for (const [name, v] of Object.entries(variants)) {
    const f = path.join(FIXTURE_DIR, `green-${name}.mp4`);
    if (!existsSync(f)) {
      const fmt = v.range === 'pc' ? 'yuvj420p' : 'yuv420p';
      ff(['-f', 'lavfi', '-i', `color=c=0x00ff00:s=${v.size}:r=30:d=1,format=rgb24,scale=out_color_matrix=${v.matrix}:out_range=${v.range},format=${fmt},setparams=${v.tags}`,
        '-f', 'lavfi', '-i', 'sine=d=1', '-c:v', 'libx264', '-qp', '4', '-pix_fmt', fmt, '-c:a', 'aac', '-shortest', f]);
    }
  }
});

describe('colour interpretation', () => {
  for (const platform of ['other', 'mac'] as PreviewPlatform[]) {
    for (const [name, v] of Object.entries(variants)) {
      const want = platform === 'mac' ? v.mac : GREEN;
      it(`${platform}: ${name}: pure green exports as ${want.join(',')}`, async () => {
        const m = await mediaRefFor(path.join(FIXTURE_DIR, `green-${name}.mp4`));
        let p = addMedia({ ...createProject(), canvas: { width: 320, height: 180, preset: 'custom' } }, [m]);
        p = addClip(p, m.id)!.project;
        const out = path.join(OUTPUT_DIR, `green-${platform}-${name}.mp4`);
        const r = await runExport(p, { outputPath: out, width: 320, height: 180, frameRate: { num: 30, den: 1 }, canvasMapping: 'fit', videoBitrateMbps: 4, x264Preset: 'veryfast', audioBitrateKbps: 128 }, { previewPlatform: platform });
        expect(r.status).toBe('done');
        const rgb = [...execFileSync('ffmpeg', ['-loglevel', 'error', '-i', out, '-frames:v', '1', '-vf', 'scale=in_color_matrix=bt709:in_range=tv,format=rgb24,crop=1:1:160:90', '-f', 'rawvideo', '-'])];
        for (let c = 0; c < 3; c++) expect(Math.abs(rgb[c] - want[c]), `channel ${c}: ${rgb.join(',')}`).toBeLessThan(12);
      });
    }
  }
});
