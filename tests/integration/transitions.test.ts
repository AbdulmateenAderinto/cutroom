/**
 * Transitions in export, measured frame by frame against transitionMix() (what the preview uses):
 * crossfade brightness and sound, dips to black/white, and a range export through a transition.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runExport } from '../../src/main/export/exportRunner';
import type { ExportSettings } from '../../src/shared/exportPlan';
import { type ClipItem, type MediaRef, type Project, createProject } from '../../src/shared/model';
import { addClip, addMedia, setClipRange, setTransition } from '../../src/shared/ops';
import { TICKS_PER_SECOND as S, frameToTicks } from '../../src/shared/time';
import { type ResolvedTransition, resolveTransitions, transitionLook, transitionMix } from '../../src/shared/transitions';
import { FIXTURE_DIR, OUTPUT_DIR, ensureDirs, mediaRefFor, readAudio, samplePatch } from '../helpers/fixtures';

const R30 = { num: 30, den: 1 };
let DARK: MediaRef;
let LIGHT: MediaRef;

function grey(name: string, rgb: string, freq: number): string {
  const f = path.join(FIXTURE_DIR, `${name}.mp4`);
  if (!existsSync(f)) {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${rgb}:s=320x240:r=30:d=4`,
      '-f', 'lavfi', '-i', `sine=f=${freq}:r=48000:d=4`, '-c:v', 'libx264', '-qp', '4', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', f]);
  }
  return f;
}

beforeAll(async () => {
  ensureDirs();
  DARK = await mediaRefFor(grey('grey-dark-440', '0x303030', 440));
  LIGHT = await mediaRefFor(grey('grey-light-880', '0xd0d0d0', 880));
});

/** Dark 0–3 s of its file, then light 1–4 s of its file (1 s of footage either side of the cut). */
function project(kind: 'crossfade' | 'dipBlack' | 'dipWhite' | null, d = 1 * S): Project {
  let p = addMedia({ ...createProject('tr'), canvas: { width: 320, height: 240, preset: 'custom' } }, [DARK, LIGHT]);
  p = addClip(p, DARK.id)!.project;
  p = addClip(p, LIGHT.id)!.project;
  const [a, b] = p.sequence.items.map((i) => i.id);
  p = setClipRange(p, a, 0, 3 * S, 'in');
  p = setClipRange(p, b, 1 * S, 4 * S, 'out');
  return kind ? setTransition(p, a, kind, d) : p;
}
const settings = (name: string, over: Partial<ExportSettings> = {}): ExportSettings => ({
  outputPath: path.join(OUTPUT_DIR, name), width: 320, height: 240, frameRate: R30, canvasMapping: 'fit',
  videoBitrateMbps: 8, x264Preset: 'veryfast', audioBitrateKbps: 192, ...over,
});

/** Amplitude of one frequency in [t0, t1) seconds (Goertzel). */
function amp(pcm: Float32Array, freq: number, t0: number, t1: number): number {
  const a = Math.floor(t0 * 48000);
  const b = Math.floor(t1 * 48000);
  const c = 2 * Math.cos((2 * Math.PI * freq) / 48000);
  let s1 = 0;
  let s2 = 0;
  for (let i = a; i < b; i++) {
    const s0 = pcm[i] + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return (2 * Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2)) / (b - a);
}

async function exportLuma(p: Project, name: string, over: Partial<ExportSettings> = {}) {
  const s = settings(name, over);
  const r = await runExport(p, s);
  expect(r.status, JSON.stringify(r).slice(0, 1000)).toBe('done');
  return { y: samplePatch(s.outputPath, 160, 120).map((x) => x.y), file: s.outputPath };
}

describe('transitions in export', () => {
  let levels: { dark: number; light: number };
  beforeAll(async () => {
    const { y } = await exportLuma(project(null), 'tr-none.mp4');
    levels = { dark: y[10], light: y[170] };
    expect(levels.light - levels.dark).toBeGreaterThan(100);
  });

  const expectedY = (tr: ResolvedTransition, f: number) => {
    const m = transitionMix(tr, frameToTicks(f, R30));
    const t = frameToTicks(f, R30);
    const base = tr.kind === 'crossfade' ? levels.dark + (levels.light - levels.dark) * m.b : t < tr.cut ? levels.dark : levels.light;
    const colourY = tr.kind === 'dipWhite' ? 235 : 16;
    return base + (colourY - base) * m.colour;
  };

  for (const kind of ['crossfade', 'dipBlack', 'dipWhite'] as const) {
    it(`${kind}: every frame's brightness follows transitionMix; timeline length unchanged`, async () => {
      const p = project(kind);
      const [tr] = resolveTransitions(p);
      const { y, file } = await exportLuma(p, `tr-${kind}.mp4`);
      expect(y.length).toBe(180);
      const errs = y.map((v, f) => Math.abs(v - expectedY(tr, f)));
      const worst = Math.max(...errs);
      const at = errs.indexOf(worst);
      expect(worst, `frame ${at}: ${y[at].toFixed(1)} vs ${expectedY(tr, at).toFixed(1)}`).toBeLessThan(4);
      // Sound: the outgoing tone fades out and the incoming one fades in (linear, like the preview).
      const pcm = readAudio(file);
      const full440 = amp(pcm, 440, 1, 2);
      const full880 = amp(pcm, 880, 4.5, 5.5);
      const t = (s: number) => [s - 0.02, s + 0.02] as const;
      if (kind === 'crossfade') {
        for (const [sec, w] of [[2.6, 0.1], [3.0, 0.5], [3.4, 0.9]] as const) {
          expect(Math.abs(amp(pcm, 440, ...t(sec)) / full440 - (1 - w))).toBeLessThan(0.08);
          expect(Math.abs(amp(pcm, 880, ...t(sec)) / full880 - w)).toBeLessThan(0.08);
        }
      } else {
        expect(amp(pcm, 440, ...t(2.75)) / full440).toBeCloseTo(0.5, 1);
        expect(amp(pcm, 440, 2.98, 3.0) + amp(pcm, 880, 3.0, 3.02)).toBeLessThan(0.1 * full440);
        expect(amp(pcm, 880, ...t(3.25)) / full880).toBeCloseTo(0.5, 1);
      }
    });
  }

  it('a range export through a crossfade has the same frames as the full export', async () => {
    const p = project('crossfade');
    const full = (await exportLuma(p, 'tr-full.mp4')).y;
    const part = (await exportLuma(p, 'tr-range.mp4', { range: { start: 2.8 * S, end: 3.2 * S } })).y;
    expect(part.length).toBe(12);
    part.forEach((v, i) => expect(Math.abs(v - full[84 + i])).toBeLessThan(1.5));
  });

  it('two transitions on one clip (in and out) both render', async () => {
    let p = project('crossfade', 0.6 * S);
    p = addClip(p, DARK.id)!.project;
    const second = p.sequence.items[1] as ClipItem;
    p = setTransition(p, second.id, 'dipBlack', 0.6 * S);
    const trs = resolveTransitions(p);
    expect(trs.map((t) => t.kind)).toEqual(['crossfade', 'dipBlack']);
    const { y } = await exportLuma(p, 'tr-two.mp4');
    const cut2 = Math.round((trs[1].cut / S) * 30);
    expect(y[cut2]).toBeLessThan(20); // black at the second cut
    expect(Math.abs(y[90] - (levels.dark + levels.light) / 2)).toBeLessThan(6); // mid-crossfade at the first
  });
});

describe('wipes and slides in export (FFmpeg xfade, checked against transitionLook)', () => {
  // Outgoing: left half red, right half blue. Incoming: green. Both with footage past the cut.
  let SPLIT: MediaRef;
  let GREEN: MediaRef;
  beforeAll(async () => {
    const f = path.join(FIXTURE_DIR, 'split-red-blue.mp4');
    if (!existsSync(f)) {
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
        'color=c=red:s=160x240:r=30:d=4[l];color=c=blue:s=160x240:r=30:d=4[r];[l][r]hstack,format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv',
        '-f', 'lavfi', '-i', 'sine=d=4', '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-c:a', 'aac', '-shortest', f]);
    }
    SPLIT = await mediaRefFor(f);
    const g = path.join(FIXTURE_DIR, 'green-320.mp4');
    if (!existsSync(g)) {
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x00c000:s=320x240:r=30:d=4,format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv',
        '-f', 'lavfi', '-i', 'sine=d=4', '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-c:a', 'aac', '-shortest', f.replace('split-red-blue', 'green-320')]);
    }
    GREEN = await mediaRefFor(g);
  });

  /** RGB frames of an export. */
  const rgbFrames = (file: string) => {
    const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 });
    const n = raw.length / (320 * 240 * 3);
    return Array.from({ length: n }, (_, i) => raw.subarray(i * 320 * 240 * 3, (i + 1) * 320 * 240 * 3));
  };
  const colourAt = (f: Uint8Array, x: number, y: number) => {
    const i = (y * 320 + x) * 3;
    const [r, g, b] = [f[i], f[i + 1], f[i + 2]];
    return r > 150 && g < 90 && b < 90 ? 'red' : b > 150 && r < 90 && g < 90 ? 'blue' : g > 120 && r < 90 && b < 90 ? 'green' : '?';
  };
  /** What a canvas point should show, from transitionLook (outgoing red|blue, incoming green). */
  const expected = (look: ReturnType<typeof transitionLook>, u: number, v: number) => {
    const inB = (() => {
      const c = look.bFx.clip;
      if (c) return u >= c.x0 && u <= c.x1 && v >= c.y0 && v <= c.y1;
      const bu = u - look.bFx.dx;
      const bv = v - look.bFx.dy;
      return bu >= 0 && bu <= 1 && bv >= 0 && bv <= 1;
    })();
    if (inB) return 'green';
    const au = u - look.a.dx;
    return au < 0.5 ? 'red' : 'blue';
  };

  for (const kind of ['wipeLeft', 'wipeRight', 'wipeUp', 'wipeDown', 'slideLeft', 'slideRight', 'slideUp', 'slideDown'] as const) {
    it(`${kind}: every frame matches the shared look (points 4 px from any edge)`, async () => {
      let p = addMedia({ ...createProject('wipe'), canvas: { width: 320, height: 240, preset: 'custom' } }, [SPLIT, GREEN]);
      p = addClip(p, SPLIT.id)!.project;
      p = addClip(p, GREEN.id)!.project;
      const [a, b] = p.sequence.items.map((i) => i.id);
      p = setClipRange(p, a, 0, 3 * S, 'in');
      p = setClipRange(p, b, 1 * S, 4 * S, 'out');
      p = setTransition(p, a, kind, 1 * S);
      const tr = resolveTransitions(p)[0];
      const s = settings(`tr-${kind}.mp4`);
      const r = await runExport(p, s);
      expect(r.status, JSON.stringify(r).slice(0, 800)).toBe('done');
      const fs = rgbFrames(s.outputPath);
      const bad: string[] = [];
      for (let j = 75; j < 105; j += 3) {
        const look = transitionLook(tr, frameToTicks(j, R30));
        for (let y = 6; y < 240; y += 19) {
          for (let x = 6; x < 320; x += 23) {
            // Skip points within 4 px of an edge (the edge pixel itself is rounded by FFmpeg).
            const near = ['x', 'y'].some((ax) => {
                const u = ax === 'x' ? x / 320 : y / 240;
                const size = ax === 'x' ? 320 : 240;
                const edges = [look.bFx.clip?.[ax === 'x' ? 'x0' : 'y0'], look.bFx.clip?.[ax === 'x' ? 'x1' : 'y1'],
                  (ax === 'x' ? look.bFx.dx : look.bFx.dy), 1 + (ax === 'x' ? look.bFx.dx : look.bFx.dy),
                  (ax === 'x' ? look.a.dx : look.a.dy) + (ax === 'x' ? 0.5 : 0), (ax === 'x' ? look.a.dx : look.a.dy) + 1];
                return edges.some((e) => e !== undefined && Math.abs(u - e) * size < 4);
              });
            if (near) continue;
            const want = expected(look, x / 320, y / 240);
            const got = colourAt(fs[j], x, y);
            if (got !== want) bad.push(`frame ${j} (${x},${y}): ${got} want ${want}`);
          }
        }
      }
      expect(bad.slice(0, 5)).toEqual([]);
    });
  }
});
