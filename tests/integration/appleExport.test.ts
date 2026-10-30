/**
 * Exports for Apple devices and editors: HEVC tagged hvc1 (MP4 and .mov), H.264 in .mov, ProRes 422 /
 * HQ in .mov with PCM sound. Checked with ffprobe against what Apple players and Final Cut expect,
 * and decoded frame by frame.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runExport } from '../../src/main/export/exportRunner';
import { type ExportSettings, validateExportSettings } from '../../src/shared/exportPlan';
import { BUILTIN_PRESETS, resolvePreset } from '../../src/shared/exportPresets';
import { type MediaRef, type Project, createProject } from '../../src/shared/model';
import { addClip, addMedia } from '../../src/shared/ops';
import { OUTPUT_DIR, decodeCodedFrame, ensureDirs, ffprobe, makeCoded, mediaRefFor, samplePatch } from '../helpers/fixtures';

let A: MediaRef;
const R30 = { num: 30, den: 1 };

beforeAll(async () => {
  ensureDirs();
  A = await mediaRefFor(makeCoded({ name: 'A_320x240_30', width: 320, height: 240, fps: 30, seconds: 4, cb: 60, freq: 440 }));
});

function project(): Project {
  const p = addMedia({ ...createProject('apple'), canvas: { width: 320, height: 240, preset: 'custom' } }, [A]);
  return addClip(p, A.id)!.project;
}
const settings = (name: string, over: Partial<ExportSettings>): ExportSettings => ({
  outputPath: path.join(OUTPUT_DIR, name), width: 320, height: 240, frameRate: R30, canvasMapping: 'fit',
  videoBitrateMbps: 2, x264Preset: 'veryfast', audioBitrateKbps: 192, ...over,
});

/** Byte offsets of the top-level 'moov' and 'mdat' atoms (fast-start = moov first). */
function atoms(file: string): Record<string, number> {
  const buf = readFileSync(file);
  const out: Record<string, number> = {};
  let i = 0;
  while (i + 8 <= buf.length) {
    let size = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    if (size === 1) size = Number(buf.readBigUInt64BE(i + 8));
    out[type] ??= i;
    if (size < 8) break;
    i += size;
  }
  return out;
}

function framesExact(file: string) {
  const got = samplePatch(file, 160, 120).map((px) => decodeCodedFrame(px, 30).frame);
  expect(got.length).toBe(120);
  expect(got.filter((f, i) => f !== i).slice(0, 5)).toEqual([]);
}

describe('exports for Apple devices', () => {
  for (const ext of ['mp4', 'mov']) {
    it(`HEVC .${ext}: hvc1 tag, Main profile, 8-bit 4:2:0, BT.709, AAC, fast start, every frame right`, async () => {
      const s = settings(`apple-hevc.${ext}`, { codec: 'hevc' });
      const r = await runExport(project(), s);
      expect(r.status, JSON.stringify(r).slice(0, 800)).toBe('done');
      const info = ffprobe(s.outputPath);
      const v = info.streams.find((x: any) => x.codec_type === 'video');
      const a = info.streams.find((x: any) => x.codec_type === 'audio');
      expect([v.codec_name, v.codec_tag_string, v.profile, v.pix_fmt, v.color_space]).toEqual(['hevc', 'hvc1', 'Main', 'yuv420p', 'bt709']);
      expect([a.codec_name, a.profile, Number(a.sample_rate), a.channels]).toEqual(['aac', 'LC', 48000, 2]);
      expect(info.format.format_name).toContain(ext === 'mov' ? 'mov' : 'mp4');
      const at = atoms(s.outputPath);
      expect(at.moov).toBeLessThan(at.mdat);
      framesExact(s.outputPath);
    });
  }

  it('HEVC with constant quality; H.264 in a QuickTime .mov is tagged avc1', async () => {
    const h = settings('apple-hevc-crf.mov', { codec: 'hevc', rateControl: 'crf', crf: 26 });
    expect((await runExport(project(), h)).status).toBe('done');
    expect(ffprobe(h.outputPath).streams[0].codec_name).toBe('hevc');
    const m = settings('apple-h264.mov', { codec: 'h264' });
    expect((await runExport(project(), m)).status).toBe('done');
    const v = ffprobe(m.outputPath).streams.find((x: any) => x.codec_type === 'video');
    expect([v.codec_name, v.codec_tag_string, v.profile]).toEqual(['h264', 'avc1', 'High']);
    expect(ffprobe(m.outputPath).format.format_name).toContain('mov');
  });

  for (const profile of ['standard', 'hq'] as const) {
    it(`ProRes 422${profile === 'hq' ? ' HQ' : ''} .mov: 10-bit 4:2:2, apl0 frame headers, PCM sound, every frame right`, async () => {
      const s = settings(`apple-prores-${profile}.mov`, { codec: 'prores', proresProfile: profile });
      const r = await runExport(project(), s);
      expect(r.status, JSON.stringify(r).slice(0, 800)).toBe('done');
      const info = ffprobe(s.outputPath);
      const v = info.streams.find((x: any) => x.codec_type === 'video');
      const a = info.streams.find((x: any) => x.codec_type === 'audio');
      expect([v.codec_name, v.profile, v.pix_fmt, v.codec_tag_string]).toEqual(['prores', profile === 'hq' ? 'HQ' : 'Standard', 'yuv422p10le', profile === 'hq' ? 'apch' : 'apcn']);
      expect(readFileSync(s.outputPath).includes(Buffer.from('apl0'))).toBe(true); // vendor in the ProRes frame headers
      expect([a.codec_name, Number(a.sample_rate)]).toEqual(['pcm_s16le', 48000]);
      framesExact(s.outputPath);
    });
  }

  it('refuses ProRes in .mp4, ProRes with the hardware encoder, and other file endings', () => {
    const p = project();
    expect(validateExportSettings(p, settings('x.mp4', { codec: 'prores' }), () => true).join()).toMatch(/\.mov/);
    expect(validateExportSettings(p, settings('x.mov', { codec: 'prores', encoder: 'videotoolbox' }), () => true).join()).toMatch(/software/);
    expect(validateExportSettings(p, settings('x.mkv', {}), () => true).join()).toMatch(/\.mp4 or \.mov/);
    expect(validateExportSettings(p, settings('x.mov', { codec: 'hevc' }), () => true)).toEqual([]);
  });

  it('Apple presets resolve to HEVC/H.264/ProRes with the right container and shape', () => {
    const r = (id: string, w = 1080, h = 1920) => resolvePreset(BUILTIN_PRESETS.find((p) => p.id === id)!, w, h, R30, 20);
    expect(r('apple-hevc')).toMatchObject({ codec: 'hevc', container: 'mov', width: 1080, height: 1920 });
    expect(r('apple-4k', 1920, 1080)).toMatchObject({ codec: 'hevc', width: 3840, height: 2160 });
    expect(r('apple-h264')).toMatchObject({ codec: 'h264', container: 'mp4' });
    expect(r('apple-prores-hq')).toMatchObject({ codec: 'prores', proresProfile: 'hq', container: 'mov', width: 1080, height: 1920 });
    // HEVC's suggested bitrate is lower than H.264's for the same size.
    expect(r('apple-hevc').mbps).toBeLessThan(r('apple-h264').mbps);
  });
});
