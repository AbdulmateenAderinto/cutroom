/**
 * File formats: each one is probed, gets the right kind of preview (direct, copy with converted
 * sound, H.264 copy), its preview copy shows exactly the same frame at every frame, and exporting
 * it (from the original) is frame-exact with its sound.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runExport } from '../../src/main/export/exportRunner';
import { probeMedia } from '../../src/main/media/probe';
import { makeProxy } from '../../src/main/media/proxy';
import { type MediaRef, createProject } from '../../src/shared/model';
import { addClip, addMedia } from '../../src/shared/ops';
import { FIXTURE_DIR, OUTPUT_DIR, decodeCodedFrame, ensureDirs, ffmpegHas, makeCoded, mediaRefFor, readAudio, samplePatch, toneFrequency } from '../helpers/fixtures';

const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const TAGS = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'];
const KEEP = 'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv';
const proxyDir = mkdtempSync(path.join(os.tmpdir(), 'cutroom-proxies-'));
let SRC: string;

/** The coded clip (frame numbers in the picture, 440 Hz tone) re-encoded in another format. */
const VIDEO: { name: string; file: string; args: string[]; preview: string }[] = [
  { name: 'ProRes 422 .mov', file: 'fmt-prores.mov', args: ['-vf', KEEP, '-c:v', 'prores_ks', '-profile:v', '2', ...TAGS, '-c:a', 'pcm_s16le'], preview: 'transcode' },
  { name: 'DNxHR .mxf', file: 'fmt-dnxhr.mxf', args: ['-vf', `${KEEP},format=yuv422p`, '-c:v', 'dnxhd', '-profile:v', 'dnxhr_hq', ...TAGS, '-c:a', 'pcm_s16le', '-ar', '48000'], preview: 'transcode' },
  { name: 'H.264 + Opus .mkv', file: 'fmt-h264.mkv', args: ['-c:v', 'copy', '-c:a', 'libopus', '-b:a', '128k'], preview: 'remux' },
  { name: 'H.264 + AC-3 .mts (camcorder, starts at 1.4 s)', file: 'fmt-h264.mts', args: ['-c:v', 'copy', '-c:a', 'ac3', '-output_ts_offset', '1.4', '-f', 'mpegts'], preview: 'remux' },
  // AVI stores no colour tags, so it is made HD (treated as BT.709, like the coded values) — an
  // untagged SD file is read as BT.601 by the preview and the export alike. PCM sound: FFmpeg's AVI
  // writer shifts the video by a frame when interleaving MP3, so the fixture itself would be off.
  { name: 'MPEG-4 + PCM .avi', file: 'fmt-mpeg4-pcm-hd.avi', args: ['-vf', `scale=1280:720:flags=neighbor,${KEEP}`, '-c:v', 'mpeg4', '-q:v', '1', ...TAGS, '-c:a', 'pcm_s16le'], preview: 'transcode' },
  { name: 'VP9 + Opus .webm', file: 'fmt-vp9.webm', args: ['-vf', KEEP, '-c:v', 'libvpx-vp9', '-crf', '4', '-b:v', '0', '-deadline', 'realtime', '-cpu-used', '8', ...TAGS, '-c:a', 'libopus'], preview: 'native' },
];

beforeAll(() => {
  ensureDirs();
  SRC = makeCoded({ name: 'A_320x240_30', width: 320, height: 240, fps: 30, seconds: 4, cb: 60, freq: 440 });
  for (const v of VIDEO) {
    const f = path.join(FIXTURE_DIR, v.file);
    if (!existsSync(f)) ff(['-i', SRC, ...v.args, f]);
  }
});

const frameNumbers = (file: string) => {
  const w = Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().split(',')[0]);
  const h = w === 1280 ? 720 : 240;
  return samplePatch(file, w / 2, h / 2).map((px) => decodeCodedFrame(px, 30).frame);
};

describe('video formats', () => {
  for (const v of VIDEO) {
    it(`${v.name}: preview “${v.preview}”, preview copy and export are frame-exact`, async () => {
      const file = path.join(FIXTURE_DIR, v.file);
      const r = await probeMedia(file);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (!r.ok) return;
      expect(r.info.preview ?? 'native').toBe(v.preview);
      expect(Math.abs(r.info.duration / 705_600_000 - 4)).toBeLessThan(0.1);
      // The preview copy (if any) shows source frame i at frame i, all 120 frames.
      if (v.preview !== 'native') {
        const copy = await makeProxy(proxyDir, file, r.info);
        const got = frameNumbers(copy);
        expect(got.length).toBe(120);
        expect(got.filter((f, i) => f !== i).slice(0, 5)).toEqual([]);
        expect(toneFrequency(readAudio(copy), 1, 3)).toBeCloseTo(440, -1);
      }
      // Export from the original.
      const m: MediaRef = await mediaRefFor(file);
      let p = addMedia({ ...createProject('fmt'), canvas: { width: 320, height: 240, preset: 'custom' } }, [m]);
      p = addClip(p, m.id)!.project; // (Fit: an HD source is scaled down; the frames are flat colours)
      const out = path.join(OUTPUT_DIR, `${v.file}.export.mp4`);
      const e = await runExport(p, { outputPath: out, width: 320, height: 240, frameRate: { num: 30, den: 1 }, canvasMapping: 'fit', videoBitrateMbps: 8, x264Preset: 'veryfast', audioBitrateKbps: 192 });
      expect(e.status, JSON.stringify(e).slice(0, 800)).toBe('done');
      const got = frameNumbers(out);
      expect(got.filter((f, i) => f !== i).slice(0, 5)).toEqual([]);
      expect(toneFrequency(readAudio(out), 1, 3)).toBeCloseTo(440, -1);
    });
  }

  it('an animated GIF becomes a video clip with an H.264 preview copy', async () => {
    const gif = path.join(FIXTURE_DIR, 'fmt-anim.gif');
    if (!existsSync(gif)) ff(['-f', 'lavfi', '-i', 'testsrc2=s=200x120:r=10:d=2', gif]);
    const r = await probeMedia(gif);
    expect(r.ok && r.info.kind === 'video' && r.info.preview === 'transcode').toBe(true);
    if (!r.ok) return;
    const copy = await makeProxy(proxyDir, gif, r.info);
    const n = Number(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', copy]).toString());
    expect(n).toBe(20);
  });
});

describe('sound and photo formats', () => {
  beforeAll(() => {
    const tone = ['-f', 'lavfi', '-i', 'sine=f=660:r=48000:d=3'];
    const make = (name: string, args: string[]) => {
      const f = path.join(FIXTURE_DIR, name);
      if (!existsSync(f)) ff([...tone, ...args, f]);
    };
    make('fmt-tone.aiff', ['-c:a', 'pcm_s16be']);
    make('fmt-tone.ogg', ['-c:a', ffmpegHas('encoders', 'libvorbis') ? 'libvorbis' : 'libopus']); // Homebrew's ffmpeg has no Vorbis
    make('fmt-tone.wma', ['-c:a', 'wmav2']);
    for (const ext of ['tiff', 'bmp']) {
      const f = path.join(FIXTURE_DIR, `fmt-photo.${ext}`);
      if (!existsSync(f)) ff(['-f', 'lavfi', '-i', 'testsrc2=s=300x200', '-frames:v', '1', f]);
    }
  });

  for (const [file, preview] of [['fmt-tone.aiff', 'audio'], ['fmt-tone.ogg', 'native'], ['fmt-tone.wma', 'audio']] as const) {
    it(`${file}: imported as audio, preview “${preview}”, the copy plays the same tone`, async () => {
      const f = path.join(FIXTURE_DIR, file);
      const r = await probeMedia(f);
      expect(r.ok && r.info.kind === 'audio').toBe(true);
      if (!r.ok) return;
      expect(r.info.preview ?? 'native').toBe(preview);
      if (preview === 'audio') expect(toneFrequency(readAudio(await makeProxy(proxyDir, f, r.info)), 0.5, 2.5)).toBeCloseTo(660, -1);
    });
  }

  it('TIFF gets a PNG preview copy; BMP is shown directly', async () => {
    const tif = await probeMedia(path.join(FIXTURE_DIR, 'fmt-photo.tiff'));
    expect(tif.ok && tif.info.kind === 'image' && tif.info.preview === 'image').toBe(true);
    if (tif.ok) {
      const png = await makeProxy(proxyDir, path.join(FIXTURE_DIR, 'fmt-photo.tiff'), tif.info);
      expect(png.endsWith('.png') && existsSync(png)).toBe(true);
    }
    const bmp = await probeMedia(path.join(FIXTURE_DIR, 'fmt-photo.bmp'));
    expect(bmp.ok && bmp.info.kind === 'image' && !bmp.info.preview).toBe(true);
  });

  it('HEIC: converted with macOS (sips) on a Mac; elsewhere refused with a clear message', async () => {
    const fake = path.join(FIXTURE_DIR, 'fmt-photo.heic');
    writeFileSync(fake, 'not really heic');
    const r = await probeMedia(fake);
    if (process.platform === 'darwin') return; // covered by the macOS run with a real HEIC file
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Mac/);
  });

  it('unreadable files are refused, not half-imported', async () => {
    const junk = path.join(FIXTURE_DIR, 'fmt-junk.mkv');
    writeFileSync(junk, Buffer.alloc(4096, 7));
    const r = await probeMedia(junk);
    expect(r.ok).toBe(false);
  });
});
