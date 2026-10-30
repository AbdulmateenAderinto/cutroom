/**
 * Media inspection: supported vs unsupported inputs, rotation metadata, warnings.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runExport } from '../../src/main/export/exportRunner';
import { probeMedia } from '../../src/main/media/probe';
import { createProject } from '../../src/shared/model';
import { addClip, addMedia } from '../../src/shared/ops';
import { FIXTURE_DIR, OUTPUT_DIR, ensureDirs, mediaRefFor, samplePatch } from '../helpers/fixtures';

const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const fx = (name: string) => path.join(FIXTURE_DIR, name);

beforeAll(() => {
  ensureDirs();
  // Left half dark, right half bright, so orientation is visible after rotation.
  const halves = 'nullsrc=s=320x240:r=30:d=2,format=yuv420p,geq=lum=if(lt(X\\,160)\\,40\\,210):cb=128:cr=128';
  if (!existsSync(fx('halves.mp4'))) ff(['-f', 'lavfi', '-i', halves, '-f', 'lavfi', '-i', 'sine=d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', fx('halves.mp4')]);
  if (!existsSync(fx('rotated90.mp4'))) ff(['-display_rotation', '90', '-i', fx('halves.mp4'), '-c', 'copy', fx('rotated90.mp4')]);
  if (!existsSync(fx('prores.mov'))) ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x240:d=1', '-c:v', 'prores_ks', fx('prores.mov')]);
  if (!existsSync(fx('silent.mp4'))) ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=25:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', fx('silent.mp4')]);
  if (!existsSync(fx('video.mkv'))) ff(['-i', fx('silent.mp4'), '-c', 'copy', fx('video.mkv')]);
  if (!existsSync(fx('audio-only.mp4'))) ff(['-f', 'lavfi', '-i', 'sine=d=1', '-c:a', 'aac', fx('audio-only.mp4')]);
  if (!existsSync(fx('hdr10.mp4'))) {
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x240:d=1', '-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', '-color_trc', 'smpte2084',
      '-color_primaries', 'bt2020', '-colorspace', 'bt2020nc', '-x265-params', 'log-level=error', '-tag:v', 'hvc1', fx('hdr10.mp4')]);
  }
  if (!existsSync(fx('garbage.mp4'))) execFileSync('sh', ['-c', `head -c 20000 /dev/urandom > "${fx('garbage.mp4')}"`]);
});

describe('probe', () => {
  it('accepts H.264/AAC MP4 and reports metadata', async () => {
    const r = await probeMedia(fx('halves.mp4'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.info).toMatchObject({ videoCodec: 'h264', width: 320, height: 240, displayWidth: 320, displayHeight: 240, hasAudio: true, audioCodec: 'aac', rotation: 0, isVFR: false });
    expect(r.info.frameRate).toEqual({ num: 30, den: 1 });
    expect(r.warnings).toEqual([]);
  });

  it('applies rotation metadata to display size', async () => {
    const r = await probeMedia(fx('rotated90.mp4'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.info.rotation % 180).toBe(90);
    expect([r.info.displayWidth, r.info.displayHeight]).toEqual([240, 320]);
    expect(r.warnings.join()).toMatch(/Rotation/);
  });

  it('accepts audio-only files for audio tracks', async () => {
    const r = await probeMedia(fx('audio-only.mp4'));
    expect(r.ok && r.info.kind).toBe('audio');
    if (r.ok) expect(r.info.hasAudio && r.info.audioCodec).toBe('aac');
  });

  it('accepts video without audio', async () => {
    const r = await probeMedia(fx('silent.mp4'));
    expect(r.ok && !r.info.hasAudio).toBe(true);
  });

  it('flags HDR (HEVC 10-bit PQ) with warnings rather than pretending it is fine', async () => {
    const r = await probeMedia(fx('hdr10.mp4'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.info.isHDR).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/HDR/);
    expect(r.warnings.join(' ')).toMatch(/HEVC/);
  });

  it('rejects unsupported inputs with readable reasons', async () => {
    const prores = await probeMedia(fx('prores.mov'));
    expect(prores.ok).toBe(false);
    if (!prores.ok) expect(prores.error).toMatch(/prores.*not supported/i);
    const mkv = await probeMedia(fx('video.mkv'));
    if (!mkv.ok) expect(mkv.error).toMatch(/\.mkv/);
    expect(mkv.ok).toBe(false);
    const garbageExt = await probeMedia(fx('prores.mov').replace('.mov', '.ogg'));
    expect(garbageExt.ok).toBe(false);
    const garbage = await probeMedia(fx('garbage.mp4'));
    expect(garbage.ok).toBe(false);
    if (!garbage.ok) expect(garbage.error).toMatch(/Could not read/);
    const missing = await probeMedia(fx('nope.mp4'));
    expect(missing.ok).toBe(false);
  });
});

describe('rotated media export', () => {
  it('exports rotated footage upright and unstretched', async () => {
    const m = await mediaRefFor(fx('rotated90.mp4'));
    let p = createProject('rot');
    p = addMedia({ ...p, canvas: { width: 240, height: 320, preset: 'custom' } }, [m]);
    p = addClip(p, m.id)!.project;
    const outputPath = path.join(OUTPUT_DIR, 'rotated.mp4');
    const r = await runExport(p, { outputPath, width: 240, height: 320, frameRate: { num: 30, den: 1 }, canvasMapping: 'fit', videoBitrateMbps: 4, x264Preset: 'veryfast', audioBitrateKbps: 128 });
    expect(r.status).toBe('done');
    const top = samplePatch(outputPath, 120, 40)[10].y;
    const bottom = samplePatch(outputPath, 120, 280)[10].y;
    const left = samplePatch(outputPath, 40, 160)[10].y;
    const right = samplePatch(outputPath, 200, 160)[10].y;
    // After a 90° rotation the dark/bright split runs across the frame (top vs bottom), not left/right.
    expect(Math.abs(top - bottom)).toBeGreaterThan(100);
    expect(Math.abs(left - right)).toBeLessThan(30);
  });
});
