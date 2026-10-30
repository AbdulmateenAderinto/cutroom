/**
 * Media input transforms: HDR (PQ) tone mapping and 3D LUTs. The export applies them, the
 * preview copy shows the same picture (same FFmpeg chain), and without them HDR looks washed out.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runExport } from '../../src/main/export/exportRunner';
import { importLut, setLutDir } from '../../src/main/media/luts';
import { probeMedia } from '../../src/main/media/probe';
import { makeProxy } from '../../src/main/media/proxy';
import { type MediaRef, type Project, createProject } from '../../src/shared/model';
import { addClip, addMedia } from '../../src/shared/ops';
import { FIXTURE_DIR, OUTPUT_DIR, ensureDirs, ffmpegHas } from '../helpers/fixtures';
import { ffmpegPath } from '../../src/main/media/ffbin';

const ff = (args: string[]) => execFileSync(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
// Tone mapping (and making the HDR fixture) needs zscale; the export refuses without it.
const HAS_ZSCALE = ffmpegHas('filters', 'zscale');
const work = mkdtempSync(path.join(os.tmpdir(), 'cutroom-input-'));
setLutDir(path.join(work, 'luts'));
// Four patches: orange, teal, white, mid grey.
const quad = 'color=c=0xff8000:s=160x120[a];color=c=0x00a0a0:s=160x120[b];color=c=white:s=160x120[c];color=c=0x808080:s=160x120[d];[a][b]hstack[t];[c][d]hstack[u];[t][u]vstack';
let HDR: MediaRef;
let SDR: MediaRef;

const ref = async (file: string, input?: MediaRef['input']): Promise<MediaRef> => {
  const r = await probeMedia(file);
  if (!r.ok) throw new Error(r.error);
  return { id: `m_${path.basename(file)}`, name: path.basename(file), path: file, info: r.info, warnings: r.warnings, input };
};

beforeAll(async () => {
  ensureDirs();
  const hdr = path.join(FIXTURE_DIR, 'quad-pq203-prores.mov');
  if (HAS_ZSCALE && !existsSync(hdr)) {
    // SDR patches converted to PQ / BT.2020 with SDR white at the HDR reference white (203 nits,
    // BT.2408), stored as 10-bit ProRes with HDR10 tags.
    ff(['-f', 'lavfi', '-i', `${quad},fps=30,format=gbrpf32le,zscale=tin=bt709:pin=bt709:min=bt709:rin=full:t=smpte2084:p=bt2020:m=bt2020nc:r=tv:npl=203,format=yuv422p10le`, '-t', '1',
      '-c:v', 'prores_ks', '-profile:v', '3', '-color_trc', 'smpte2084', '-color_primaries', 'bt2020', '-colorspace', 'bt2020nc', '-color_range', 'tv', hdr]);
  }
  const sdr = path.join(FIXTURE_DIR, 'quad-sdr-709.mp4');
  if (!existsSync(sdr)) {
    ff(['-f', 'lavfi', '-i', `${quad},fps=30,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p`, '-t', '1', '-c:v', 'libx264', '-qp', '0',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', sdr]);
  }
  if (HAS_ZSCALE) HDR = await ref(hdr);
  SDR = await ref(sdr);
});

/** Mean RGB of the middle of each quadrant of the first frame (orange, teal, white, grey). */
function quads(file: string): number[][] {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=32:24:flags=area:in_color_matrix=bt709,format=rgb24', '-f', 'rawvideo', '-']);
  return [[8, 6], [24, 6], [8, 18], [24, 18]].map(([x, y]) => [0, 1, 2].map((k) => raw[(y * 32 + x) * 3 + k]));
}
async function exportOf(m: MediaRef, name: string) {
  let p: Project = addMedia({ ...createProject('in'), canvas: { width: 320, height: 240, preset: 'custom' } }, [m]);
  p = addClip(p, m.id)!.project;
  const outputPath = path.join(OUTPUT_DIR, name);
  const r = await runExport(p, { outputPath, width: 320, height: 240, frameRate: { num: 30, den: 1 }, canvasMapping: 'fit', videoBitrateMbps: 8, x264Preset: 'veryfast', audioBitrateKbps: 128 });
  expect(r.status, JSON.stringify(r).slice(0, 1200)).toBe('done');
  return outputPath;
}
const maxDiff = (a: number[][], b: number[][]) => Math.max(...a.flatMap((c, i) => c.map((v, k) => Math.abs(v - b[i][k]))));

describe.skipIf(!HAS_ZSCALE)('HDR tone mapping', () => {
  it('the HDR fixture is detected as HDR', () => {
    expect(HDR.info.isHDR).toBe(true);
  });

  it('tone-mapped export keeps the colours (orange stays orange, white near white); without it they wash out', async () => {
    const mapped = quads(await exportOf({ ...HDR, input: { toneMap: true } }, 'in-hdr-mapped.mp4'));
    const raw = quads(await exportOf(HDR, 'in-hdr-raw.mp4'));
    const sdr = quads(await exportOf(SDR, 'in-sdr.mp4'));
    // Orange: strong red over blue when tone-mapped; much less so read as if SDR.
    expect(mapped[0][0] - mapped[0][2]).toBeGreaterThan(150);
    expect(raw[0][0] - raw[0][2]).toBeLessThan(mapped[0][0] - mapped[0][2] - 40);
    // Up to reference white the Mobius curve keeps colours close to the SDR original.
    console.log('tone-mapped', JSON.stringify(mapped), 'SDR', JSON.stringify(sdr), 'untreated', JSON.stringify(raw));
    expect(maxDiff(mapped, sdr)).toBeLessThan(45);
    expect(mapped[2][0]).toBeGreaterThan(200);
  });

  it('the preview copy shows the same picture as the export', async () => {
    const m = { ...HDR, input: { toneMap: true } };
    const copy = await makeProxy(path.join(work, 'proxies'), m.path, m.info, undefined, m.input);
    const exp = quads(path.join(OUTPUT_DIR, 'in-hdr-mapped.mp4'));
    expect(maxDiff(quads(copy), exp)).toBeLessThanOrEqual(4);
  });
});

describe('3D LUTs', () => {
  let swap: NonNullable<MediaRef['input']>['lut'];
  beforeAll(() => {
    // 2×2×2 LUT that swaps red and blue (red changes fastest in .cube files).
    const rows: string[] = [];
    for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) rows.push(`${b} ${g} ${r}`);
    const f = path.join(work, 'swap rb (test).cube');
    writeFileSync(f, `TITLE "swap"\nLUT_3D_SIZE 2\n${rows.join('\n')}\n`);
    swap = importLut(f);
  });

  it('the LUT is copied under a hash name; bad files are refused with a reason', () => {
    expect(swap!.file).toMatch(/^[0-9a-f]{40}\.cube$/);
    const bad = path.join(work, 'bad.cube');
    writeFileSync(bad, 'LUT_1D_SIZE 4\n0 0 0\n');
    expect(() => importLut(bad)).toThrow(/1D/);
  });

  it('export applies it (orange becomes blue-ish); the preview copy matches', async () => {
    const m = { ...SDR, input: { lut: swap } };
    const file = await exportOf(m, 'in-lut.mp4');
    const got = quads(file);
    const orig = quads(await exportOf(SDR, 'in-lut-ref.mp4')); // own reference: the HDR tests may be skipped
    got.forEach((c, i) => {
      expect(Math.abs(c[0] - orig[i][2])).toBeLessThanOrEqual(4);
      expect(Math.abs(c[2] - orig[i][0])).toBeLessThanOrEqual(4);
    });
    const copy = await makeProxy(path.join(work, 'proxies'), m.path, m.info, undefined, m.input);
    expect(maxDiff(quads(copy), got)).toBeLessThanOrEqual(4);
  });

  it('a missing LUT is reported (and copied again from the original when that still exists)', async () => {
    const gone = { ...swap!, file: '0'.repeat(40) + '.cube', source: path.join(work, 'nope.cube') };
    let p: Project = addMedia({ ...createProject('in'), canvas: { width: 320, height: 240, preset: 'custom' } }, [{ ...SDR, input: { lut: gone } }]);
    p = addClip(p, SDR.id)!.project;
    const r = await runExport(p, { outputPath: path.join(OUTPUT_DIR, 'in-missing.mp4'), width: 320, height: 240, frameRate: { num: 30, den: 1 }, canvasMapping: 'fit', videoBitrateMbps: 8, x264Preset: 'veryfast', audioBitrateKbps: 128 });
    expect(r.status).toBe('failed');
    expect(JSON.stringify(r)).toMatch(/missing/);
  });
});
