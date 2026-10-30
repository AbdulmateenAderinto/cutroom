/**
 * Parallel export (settings.parallel): the parts are range exports joined without re-encoding the
 * picture, the sound encoded once. With ProRes (every frame coded on its own) and PCM sound the
 * result must be identical to a one-pass export, frame for frame and sample for sample, across a
 * transition, an overlay and a speed change that straddle part boundaries.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runExport } from '../../src/main/export/exportRunner';
import { type ExportSettings, segmentRanges } from '../../src/shared/exportPlan';
import { type MediaRef, type Project, createProject } from '../../src/shared/model';
import { addClip, addMedia, setSpeed, setTransition } from '../../src/shared/ops';
import { addOverlay } from '../../src/shared/overlays';
import { TICKS_PER_SECOND as S } from '../../src/shared/time';
import { FIXTURE_DIR, OUTPUT_DIR, ensureDirs, mediaRefFor } from '../helpers/fixtures';

let A: MediaRef;
let B: MediaRef;
beforeAll(async () => {
  ensureDirs();
  const make = (name: string, video: string, freq: number) => {
    const f = path.join(FIXTURE_DIR, name);
    if (!existsSync(f)) {
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', video,
        '-f', 'lavfi', '-i', `sine=f=${freq}:r=48000:d=6,volume='0.3+0.3*sin(t*5)':eval=frame`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', f]);
    }
    return mediaRefFor(f);
  };
  A = await make('par-a.mp4', 'gradients=s=320x240:r=30:d=6:speed=0.05', 440);
  B = await make('par-b.mp4', 'mandelbrot=s=320x240:r=30,trim=duration=6', 660);
});

function project(): Project {
  let p = addMedia({ ...createProject('par'), canvas: { width: 320, height: 240, preset: 'custom' } }, [A, B]);
  p = addClip(p, A.id)!.project;
  p = addClip(p, B.id)!.project;
  p = addClip(p, A.id)!.project;
  const [c1, c2, c3] = p.sequence.items.filter((i) => i.kind === 'clip').map((i) => i.id);
  p = setTransition(p, c2, 'crossfade', S);
  p = setSpeed(p, c3, 1.5);
  const o = addOverlay(p, B.id, 4 * S);
  if ('error' in o) throw new Error(o.error);
  void c1;
  return o.project;
}

const base = (name: string, over: Partial<ExportSettings> = {}): ExportSettings => ({
  outputPath: path.join(OUTPUT_DIR, name), width: 320, height: 240, frameRate: { num: 30, den: 1 }, canvasMapping: 'fit',
  videoBitrateMbps: 2, x264Preset: 'veryfast', audioBitrateKbps: 192, ...over,
});
const md5s = (file: string, stream: 'v' | 'a') =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', `0:${stream}:0`, '-f', 'framemd5', '-'], { maxBuffer: 64 << 20 })
    .toString().split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop()!.trim());
const probe = (file: string) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]).toString());

describe('parallel export', () => {
  it('splits at frame boundaries, fewer parts when short', () => {
    const r = { num: 30000, den: 1001 };
    const parts = segmentRanges({ start: 0, end: 10 * S }, r, 4);
    expect(parts).toHaveLength(4);
    expect(parts[0].start).toBe(0);
    for (let i = 1; i < parts.length; i++) expect(parts[i].start).toBe(parts[i - 1].end);
    expect(segmentRanges({ start: 0, end: 3 * S }, r, 4)).toHaveLength(1);
  });

  it('ProRes: identical picture and sound to a one-pass export', async () => {
    const p = project();
    const one = base('par-one.mov', { codec: 'prores' });
    const par = base('par-par.mov', { codec: 'prores', parallel: true });
    expect((await runExport(p, one)).status).toBe('done');
    const progress: number[] = [];
    const r = await runExport(p, par, { parts: 3, onProgress: (x) => progress.push(x.fraction) });
    expect(r.status, JSON.stringify(r).slice(0, 1500)).toBe('done');
    const v1 = md5s(one.outputPath, 'v');
    const v2 = md5s(par.outputPath, 'v');
    expect(v2.length).toBe(v1.length);
    expect(v2).toEqual(v1);
    // The sound as one stream (packet sizes may differ between the files; the samples must not).
    const pcm = (f: string) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', f, '-map', '0:a:0', '-f', 'md5', '-']).toString().trim();
    expect(pcm(par.outputPath)).toBe(pcm(one.outputPath));
    expect(progress.length).toBeGreaterThan(0);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
    // The parts folder is gone.
    expect(readdirSync(OUTPUT_DIR).some((f) => f.startsWith('par-par.mov.partial'))).toBe(false);
  });

  it('H.264 and HEVC: right length, tags and colour, sound encoded once', async () => {
    const p = project();
    for (const [name, codec, tag] of [['par-h264.mp4', 'h264', 'avc1'], ['par-hevc.mp4', 'hevc', 'hvc1']] as const) {
      const s = base(name, { codec, parallel: true });
      const r = await runExport(p, s, { parts: 4 });
      expect(r.status, JSON.stringify(r).slice(0, 1500)).toBe('done');
      const info = probe(s.outputPath);
      const v = info.streams.find((x: any) => x.codec_type === 'video');
      const a = info.streams.find((x: any) => x.codec_type === 'audio');
      expect(v.codec_tag_string).toBe(tag);
      expect(v.color_primaries).toBe('bt709');
      expect(a.codec_name).toBe('aac');
      if (r.status === 'done') expect(Math.abs(r.output.durationSeconds - Number(probe(base('par-one.mov').outputPath).format.duration))).toBeLessThan(0.05);
      expect(md5s(s.outputPath, 'v')).toHaveLength(md5s(base('par-one.mov').outputPath, 'v').length);
    }
  });

  it('range and loudness: measured on the joined mix', async () => {
    const p = project();
    const s = base('par-loud.mp4', { parallel: true, loudness: -16, range: { start: 1 * S, end: 13 * S } });
    const r = await runExport(p, s, { parts: 3 });
    expect(r.status, JSON.stringify(r).slice(0, 1500)).toBe('done');
    if (r.status === 'done') expect(Math.abs(r.output.durationSeconds - 12)).toBeLessThan(0.05);
    const st = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', s.outputPath, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    const I = Number(/Integrated loudness:\s+I:\s+(-?[\d.]+) LUFS/.exec(st)?.[1]);
    expect(Math.abs(I - -16), `${I} LUFS`).toBeLessThan(1);
  });

  it('cancelling leaves no file and no parts', async () => {
    const p = project();
    const s = base('par-cancel.mp4', { parallel: true, x264Preset: 'veryslow' });
    const ac = new AbortController();
    const job = runExport(p, s, { parts: 3, signal: ac.signal, onProgress: (x) => x.fraction > 0.05 && ac.abort() });
    const r = await job;
    expect(r.status).toBe('cancelled');
    expect(existsSync(s.outputPath)).toBe(false);
    expect(readdirSync(OUTPUT_DIR).some((f) => f.startsWith('par-cancel'))).toBe(false);
  });
});
