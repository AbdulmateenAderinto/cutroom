/**
 * Loudness normalization in export (two-pass EBU R128): the result measures at the target
 * (checked independently with FFmpeg's ebur128 meter) with true peaks under the ceiling, for a
 * quiet and a loud mix, the whole timeline and a range.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runExport } from '../../src/main/export/exportRunner';
import { type MediaRef, type Project, createProject } from '../../src/shared/model';
import { addClip, addMedia, setClipAudio } from '../../src/shared/ops';
import { TICKS_PER_SECOND as S } from '../../src/shared/time';
import { FIXTURE_DIR, OUTPUT_DIR, ensureDirs, mediaRefFor } from '../helpers/fixtures';

let SPEECHY: MediaRef;
beforeAll(async () => {
  ensureDirs();
  // Pink noise with a slow level swell (like speech/music dynamics), 8 s.
  const f = path.join(FIXTURE_DIR, 'loud-noise.mp4');
  if (!existsSync(f)) {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=320x240:r=30:d=8',
      '-f', 'lavfi', '-i', "anoisesrc=c=pink:a=0.2:d=8:r=48000,volume='0.3+0.7*abs(sin(t*0.9))':eval=frame", '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '192k', '-shortest', f]);
  }
  SPEECHY = await mediaRefFor(f);
});

/** Integrated loudness (LUFS) and true peak (dBTP) of a file, from FFmpeg's ebur128 meter. */
function measure(file: string): { I: number; TP: number } {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8' });
  const s = r.stderr;
  const I = Number(/Integrated loudness:\s+I:\s+(-?[\d.]+) LUFS/.exec(s)?.[1]);
  const TP = Number(/True peak:\s+Peak:\s+(-?[\d.]+) dBFS/.exec(s)?.[1]);
  return { I, TP };
}

function project(volume: number): Project {
  let p = addMedia({ ...createProject('loud'), canvas: { width: 320, height: 240, preset: 'custom' } }, [SPEECHY]);
  p = addClip(p, SPEECHY.id)!.project;
  return setClipAudio(p, p.sequence.items[0].id, { volume });
}
const exp = async (p: Project, name: string, over: Record<string, unknown>) => {
  const outputPath = path.join(OUTPUT_DIR, name);
  const progress: number[] = [];
  const r = await runExport(p, { outputPath, width: 320, height: 240, frameRate: { num: 30, den: 1 }, canvasMapping: 'fit', videoBitrateMbps: 2, x264Preset: 'veryfast', audioBitrateKbps: 192, ...over }, { onProgress: (x) => progress.push(x.fraction) });
  expect(r.status, JSON.stringify(r).slice(0, 1500)).toBe('done');
  return { file: outputPath, progress };
};

describe('loudness normalization', () => {
  it('quiet (×0.3) and loud (×2) mixes both end up at −16 LUFS, peaks under −1.5 dBTP', async () => {
    const before = measure((await exp(project(0.3), 'loud-off.mp4', {})).file);
    for (const [vol, name] of [[0.3, 'quiet'], [2, 'loud']] as const) {
      const { file, progress } = await exp(project(vol), `loud-${name}.mp4`, { loudness: -16 });
      const m = measure(file);
      expect(Math.abs(m.I - -16), `${name}: ${m.I} LUFS`).toBeLessThan(1);
      expect(m.TP).toBeLessThan(-1.0);
      // Both passes show progress, in order.
      expect(progress.some((x) => x < 0.5)).toBe(true);
      expect(progress.some((x) => x > 0.5)).toBe(true);
      expect([...progress].sort((a, b) => a - b)).toEqual(progress);
    }
    expect(before.I).toBeLessThan(-22); // the quiet mix really was quiet
  });

  it('a range export is normalized on its own', async () => {
    const { file } = await exp(project(1), 'loud-range.mp4', { loudness: -23, range: { start: 2 * S, end: 6 * S } });
    const m = measure(file);
    expect(Math.abs(m.I - -23)).toBeLessThan(1);
    const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString());
    expect(Math.abs(dur - 4)).toBeLessThan(0.1);
  });
});
