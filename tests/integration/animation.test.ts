/**
 * Animated exports: every output frame is measured and compared with evalAnimation(), the same
 * function the preview uses.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runExport } from '../../src/main/export/exportRunner';
import { evalAnimation } from '../../src/shared/animation';
import type { ExportSettings } from '../../src/shared/exportPlan';
import { type MediaRef, type Project, animateRect, computeClipRect, createProject } from '../../src/shared/model';
import { addClip, addMedia, setAnimation, setKeyframe, splitAt } from '../../src/shared/ops';
import { TICKS_PER_SECOND as S, frameToTicks } from '../../src/shared/time';
import { FIXTURE_DIR, OUTPUT_DIR, ensureDirs, mediaRefFor } from '../helpers/fixtures';

let WHITE: MediaRef;
const R30 = { num: 30, den: 1 };

beforeAll(async () => {
  ensureDirs();
  const f = path.join(FIXTURE_DIR, 'white_320x240.mp4');
  if (!existsSync(f)) {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white:s=320x240:r=30:d=3',
      '-f', 'lavfi', '-i', 'sine=d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f]);
  }
  WHITE = await mediaRefFor(f);
});

function project(): Project {
  let p = createProject('anim');
  p = addMedia({ ...p, canvas: { width: 320, height: 240, preset: 'custom' }, background: '#000000' }, [WHITE]);
  return addClip(p, WHITE.id)!.project;
}

const settings = (name: string): ExportSettings => ({
  outputPath: path.join(OUTPUT_DIR, name), width: 320, height: 240, frameRate: R30, canvasMapping: 'fit',
  videoBitrateMbps: 4, x264Preset: 'veryfast', audioBitrateKbps: 128,
});

/** Luma of one row (y) for every frame. */
function rows(file: string, y: number): Uint8Array[] {
  const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-vf', `format=gray,crop=iw:1:0:${y}`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 });
  const out: Uint8Array[] = [];
  for (let o = 0; o + 320 <= raw.length; o += 320) out.push(raw.subarray(o, o + 320));
  return out;
}
// format=gray expands video range (16–235) to full range (0–255).
const luma = (opacity: number) => 255 * opacity;

describe('animation export', () => {
  it('fade in/out: brightness follows the opacity curve frame by frame', async () => {
    let p = project();
    const id = p.sequence.items[0].id;
    p = setAnimation(p, id, (a) => ({ ...a, in: { preset: 'fade', duration: S / 2 }, out: { preset: 'fade', duration: S / 2 } }));
    const r = await runExport(p, settings('anim-fade.mp4'));
    expect(r.status, JSON.stringify(r).slice(0, 600)).toBe('done');
    const frames = rows(path.join(OUTPUT_DIR, 'anim-fade.mp4'), 120);
    expect(frames.length).toBe(90);
    const clip = p.sequence.items[0] as any;
    const errs = frames.map((row, j) => {
      const want = luma(evalAnimation(clip.animation, frameToTicks(j, R30), 3 * S, 0).opacity);
      return Math.abs(row[160] - want);
    });
    expect(Math.max(...errs)).toBeLessThan(6);
    expect(frames[0][160]).toBeLessThan(25); // starts dark
    expect(frames[45][160]).toBeGreaterThan(225); // fully visible in the middle
  });

  it('keyframed position and scale land where the shared maths says, every frame', async () => {
    let p = project();
    const id = p.sequence.items[0].id;
    p = { ...p, background: '#000000' };
    // Half size, sliding from the left edge to the right edge over 2 s with easing.
    p = setKeyframe(p, id, 'scale', 0, 0.5, 'linear');
    p = setKeyframe(p, id, 'x', 0, -0.25, 'easeInOut');
    p = setKeyframe(p, id, 'x', 2 * S, 0.25);
    p = setKeyframe(p, id, 'scale', 2 * S, 0.7);
    const r = await runExport(p, settings('anim-move.mp4'));
    expect(r.status, JSON.stringify(r).slice(0, 600)).toBe('done');
    const frames = rows(path.join(OUTPUT_DIR, 'anim-move.mp4'), 120);
    const clip = p.sequence.items[0] as any;
    const base = computeClipRect(320, 240, 320, 240, clip.framing);
    let worst = 0;
    frames.forEach((row, j) => {
      const st = evalAnimation(clip.animation, frameToTicks(j, R30), 3 * S, 0);
      const want = animateRect(base, st, 320, 240);
      const lit = [...row].map((v, x) => (v > 128 ? x : -1)).filter((x) => x >= 0);
      const left = lit[0];
      const right = lit[lit.length - 1] + 1;
      worst = Math.max(worst, Math.abs(left - Math.max(0, want.x)), Math.abs(right - Math.min(320, want.x + want.w)));
    });
    expect(worst).toBeLessThanOrEqual(2); // pixels, incl. rounding and chroma/encoder edges
  });

  it('keyframes stay with the content after a split (anchored to source time)', async () => {
    let p = project();
    const id = p.sequence.items[0].id;
    p = setKeyframe(p, id, 'opacity', 0, 0, 'linear');
    p = setKeyframe(p, id, 'opacity', 3 * S, 1);
    const whole = p.sequence.items[0] as any;
    const sp = splitAt(p, 1 * S)!;
    const right = sp.project.sequence.items[1] as any;
    // At timeline 2 s the right half shows source 2 s — same opacity as the unsplit clip.
    const a = evalAnimation(whole.animation, 2 * S, 3 * S, 0).opacity;
    const b = evalAnimation(right.animation, 1 * S, 2 * S, right.sourceIn).opacity;
    expect(b).toBeCloseTo(a, 6);
    const r = await runExport(sp.project, settings('anim-split.mp4'));
    expect(r.status).toBe('done');
    const frames = rows(path.join(OUTPUT_DIR, 'anim-split.mp4'), 120);
    expect(Math.abs(frames[60][160] - luma(a))).toBeLessThan(6);
  });
});
