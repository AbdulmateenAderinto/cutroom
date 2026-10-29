import { mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProjectFile, saveProjectFile } from '../../src/main/project/projectFiles';
import { buildExportPlan, outputSizeOptions } from '../../src/shared/exportPlan';
import { type MediaRef, type Project, computeClipRect, createProject, layoutSequence, toManualFraming } from '../../src/shared/model';
import * as ops from '../../src/shared/ops';
import { parseProject, serializeProject } from '../../src/shared/serialize';
import {
  TICKS_PER_SECOND as S, formatTimecode, frameDuration, frameToTicks, parseTimecode, snapToFrame, ticksToFrame, ticksToSamples,
} from '../../src/shared/time';

const NTSC = { num: 30000, den: 1001 };
const R30 = { num: 30, den: 1 };

function media(id: string, seconds: number, rate = R30, w = 1920, h = 1080): MediaRef {
  return {
    id, name: `${id}.mp4`, path: `/media/${id}.mp4`, warnings: [],
    info: {
      container: 'mov,mp4', fileSize: 1, duration: Math.round(seconds * S), videoCodec: 'h264', width: w, height: h,
      displayWidth: w, displayHeight: h, rotation: 0, frameRate: rate, avgFrameRate: rate, isVFR: false, pixFmt: 'yuv420p',
      colorTransfer: '', isHDR: false, hasAudio: true, audioCodec: 'aac', audioSampleRate: 48000, audioChannels: 2,
    },
  };
}

function project3(): Project {
  let p = ops.addMedia(createProject(), [media('a', 10), media('b', 5), media('c', 7.5, NTSC)]);
  for (const id of ['a', 'b', 'c']) p = ops.addClip(p, id)!.project;
  return p;
}

describe('timebase', () => {
  it('represents common frame and sample rates exactly', () => {
    for (const r of [{ num: 24000, den: 1001 }, { num: 24, den: 1 }, { num: 25, den: 1 }, NTSC, R30, { num: 60000, den: 1001 }]) {
      expect(Number.isInteger((S * r.den) / r.num)).toBe(true);
    }
    expect(S % 48000).toBe(0);
    expect(S % 44100).toBe(0);
  });

  it('does not drift over long durations at 29.97', () => {
    const tenHoursFrames = 30000 * 36 * 10; // ~10 h at 29.97
    const t = frameToTicks(tenHoursFrames, NTSC);
    expect(ticksToFrame(t, NTSC)).toBe(tenHoursFrames);
    expect(t).toBe(tenHoursFrames * frameDuration(NTSC)); // exact integer multiple
  });

  it('formats and parses timecode (wall-clock seconds + frame)', () => {
    expect(formatTimecode(frameToTicks(45, R30), R30)).toBe('00:00:01:15');
    expect(parseTimecode('00:00:01:15', R30)).toBe(frameToTicks(45, R30));
    expect(parseTimecode('1.5', R30)).toBe(frameToTicks(45, R30));
    expect(parseTimecode('45f', R30)).toBe(frameToTicks(45, R30));
    expect(parseTimecode('nonsense', R30)).toBeNull();
    // round-trip every frame of a minute at 29.97
    for (let f = 0; f < 1800; f += 7) {
      const t = frameToTicks(f, NTSC);
      expect(parseTimecode(formatTimecode(t, NTSC), NTSC)).toBe(t);
    }
  });

  it('converts ticks to audio samples', () => {
    expect(ticksToSamples(S, 48000)).toBe(48000);
    expect(ticksToSamples(frameDuration(NTSC), 48000)).toBe(1602); // 1601.6 rounded
  });
});

describe('editing operations', () => {
  it('lays out clips back to back and keeps source and timeline time separate', () => {
    const p = project3();
    const lay = layoutSequence(p);
    expect(lay.items.map((l) => l.start / S)).toEqual([0, 10, 15]);
    // c is 7.5 s of 29.97 footage; duration floors to whole project (30 fps) frames
    expect((lay.items[2].end - lay.items[2].start) % frameDuration(R30)).toBe(0);
  });

  it('splits at a frame boundary with contiguous source ranges', () => {
    const p = project3();
    const r = ops.splitAt(p, Math.round(3.3 * S))!; // snapped to frame 99
    const [l, rt] = r.project.sequence.items as any[];
    expect(l.sourceOut).toBe(frameToTicks(99, R30));
    expect(rt.sourceIn).toBe(l.sourceOut);
    expect(rt.sourceOut).toBe(10 * S);
    expect(layoutSequence(r.project).duration).toBe(layoutSequence(p).duration);
  });

  it('refuses to split on an edge', () => {
    expect(ops.splitAt(project3(), 10 * S)).toBeNull();
    expect(ops.splitAt(project3(), 0)).toBeNull();
  });

  it('trims with clamping: not before 0, not past the media end, at least one frame', () => {
    let p = project3();
    const id = p.sequence.items[0].id;
    p = ops.trimEdge(p, id, 'start', -5 * S);
    expect((p.sequence.items[0] as any).sourceIn).toBe(0);
    p = ops.trimEdge(p, id, 'end', 5 * S);
    expect((p.sequence.items[0] as any).sourceOut).toBe(10 * S);
    p = ops.trimEdge(p, id, 'end', -20 * S);
    const c = p.sequence.items[0] as any;
    expect(c.sourceOut - c.sourceIn).toBe(frameDuration(R30));
  });

  it('trimming the start keeps the out point and ripples later clips', () => {
    let p = project3();
    const [a] = p.sequence.items;
    p = ops.trimEdge(p, a.id, 'start', 2 * S);
    const c = p.sequence.items[0] as any;
    expect([c.sourceIn, c.sourceOut]).toEqual([2 * S, 10 * S]);
    expect(layoutSequence(p).items[1].start).toBe(8 * S);
  });

  it('snaps in-points of 29.97 media to the source frame grid', () => {
    let p = project3();
    const cid = p.sequence.items[2].id;
    p = ops.setClipRange(p, cid, Math.round(1.234 * S), 5 * S, 'out');
    const c = p.sequence.items[2] as any;
    expect(c.sourceIn % frameDuration(NTSC)).toBe(0);
    expect((c.sourceOut - c.sourceIn) % frameDuration(R30)).toBe(0);
  });

  it('deletes with close-gap and leave-gap, merging and trimming gaps', () => {
    const p = project3();
    const [a, b, c] = p.sequence.items;
    const closed = ops.deleteItem(p, b.id, 'close-gap');
    expect(closed.sequence.items.map((i) => i.id)).toEqual([a.id, c.id]);
    let gapped = ops.deleteItem(p, b.id, 'leave-gap');
    expect(gapped.sequence.items.map((i) => i.kind)).toEqual(['clip', 'gap', 'clip']);
    expect(layoutSequence(gapped).duration).toBe(layoutSequence(p).duration);
    gapped = ops.deleteItem(gapped, a.id, 'leave-gap');
    expect(gapped.sequence.items.map((i) => i.kind)).toEqual(['gap', 'clip']); // merged
    gapped = ops.deleteItem(gapped, c.id, 'leave-gap');
    expect(gapped.sequence.items).toEqual([]); // trailing gaps removed
  });

  it('reorders and duplicates', () => {
    const p = project3();
    const [a, b, c] = p.sequence.items.map((i) => i.id);
    expect(ops.moveItem(p, c, 0).sequence.items.map((i) => i.id)).toEqual([c, a, b]);
    expect(ops.moveItem(p, a, 3).sequence.items.map((i) => i.id)).toEqual([b, c, a]);
    expect(ops.moveItem(p, a, 1).sequence.items.map((i) => i.id)).toEqual([a, b, c]);
    const d = ops.duplicateItem(p, b)!;
    expect(d.project.sequence.items.map((i) => i.id)).toEqual([a, b, d.newId, c]);
  });

  it('never mutates the input project (undo safety)', () => {
    const p = project3();
    const snapshot = JSON.stringify(p);
    const id = p.sequence.items[0].id;
    ops.splitAt(p, S);
    ops.trimEdge(p, id, 'start', S);
    ops.moveItem(p, id, 3);
    ops.deleteItem(p, id, 'leave-gap');
    ops.setFraming(p, id, { mode: 'fill', scale: 1, x: 0, y: 0 });
    ops.setFrameRate(p, NTSC);
    expect(JSON.stringify(p)).toBe(snapshot);
  });

  it('re-snaps durations when the project frame rate changes', () => {
    const p = ops.setFrameRate(project3(), { num: 25, den: 1 });
    for (const l of layoutSequence(p).items) expect((l.end - l.start) % frameDuration({ num: 25, den: 1 })).toBe(0);
  });
});

describe('framing', () => {
  it('fit letterboxes, fill crops, never stretches', () => {
    const fit = computeClipRect(1920, 1080, 1080, 1920, { mode: 'fit', scale: 1, x: 0, y: 0 });
    expect(fit.w).toBeCloseTo(1080);
    expect(fit.h).toBeCloseTo(607.5);
    expect(fit.y).toBeCloseTo((1920 - 607.5) / 2);
    const fill = computeClipRect(1920, 1080, 1080, 1920, { mode: 'fill', scale: 1, x: 0, y: 0 });
    expect(fill.h).toBeCloseTo(1920);
    expect(fill.w / fill.h).toBeCloseTo(1920 / 1080);
  });

  it('switching to manual reproduces the current look', () => {
    const fill = { mode: 'fill' as const, scale: 1, x: 0, y: 0 };
    const m = toManualFraming(1920, 1080, 1080, 1920, fill);
    expect(computeClipRect(1920, 1080, 1080, 1920, m)).toEqual(computeClipRect(1920, 1080, 1080, 1920, fill));
  });

  it('manual offsets are relative to the canvas, so they survive canvas changes proportionally', () => {
    const f = { mode: 'manual' as const, scale: 0.5, x: 0.25, y: 0 };
    const a = computeClipRect(1000, 1000, 1000, 1000, f);
    const b = computeClipRect(1000, 1000, 2000, 2000, f);
    expect(b.x).toBeCloseTo(a.x * 2);
  });
});

describe('export plan', () => {
  it('passes file paths as separate arguments, untouched', () => {
    let p = ops.addMedia(createProject(), [{ ...media('a', 2), path: `/tmp/it's a "file"; rm -rf ~ $(x).mp4` }]);
    p = ops.addClip(p, 'a')!.project;
    const plan = buildExportPlan(p, { outputPath: '/o.mp4', width: 1920, height: 1080, frameRate: R30, canvasMapping: 'fit', videoBitrateMbps: 8, x264Preset: 'fast', audioBitrateKbps: 192 }, '/o.mp4.partial', (m) => m.path);
    expect(plan.args).toContain(`/tmp/it's a "file"; rm -rf ~ $(x).mp4`);
    expect(plan.args[plan.args.length - 1]).toBe('/o.mp4.partial');
    expect(plan.totalFrames).toBe(60);
  });

  it('segment frame counts sum to the rounded total (no cumulative drift)', () => {
    let p = ops.addMedia(createProject(), [media('a', 100)]);
    p = ops.addClip(p, 'a')!.project;
    for (let i = 1; i < 40; i++) p = ops.splitAt(p, Math.round(i * 2.37 * S))?.project ?? p;
    const plan = buildExportPlan(p, { outputPath: '', width: 640, height: 360, frameRate: NTSC, canvasMapping: 'fit', videoBitrateMbps: 2, x264Preset: 'fast', audioBitrateKbps: 128 }, 'x', (m) => m.path);
    expect(plan.totalFrames).toBe(ticksToFrame(layoutSequence(p).duration, NTSC, 'round'));
  });

  it('crop regions always stay inside the source frame (randomised framings)', () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const sizes = [[1280, 720], [720, 1280], [1920, 1080], [720, 720], [3840, 2160], [641, 359]];
    for (let n = 0; n < 2000; n++) {
      const [sw, sh] = sizes[Math.floor(rand() * sizes.length)];
      const rotation = rand() < 0.3 ? 90 : 0;
      const m = media('a', 2, R30, sw, sh);
      if (rotation) Object.assign(m.info, { rotation, displayWidth: sh, displayHeight: sw });
      const [cw, ch] = sizes[Math.floor(rand() * sizes.length)].map((v) => v + (v % 2));
      let p = ops.addMedia({ ...createProject(), canvas: { width: cw, height: ch, preset: 'custom' } }, [m]);
      p = ops.addClip(p, 'a')!.project;
      const mode = (['fit', 'fill', 'manual'] as const)[Math.floor(rand() * 3)];
      p = ops.setFraming(p, p.sequence.items[0].id, { mode, scale: 0.2 + rand() * 4, x: rand() * 1.6 - 0.8, y: rand() * 1.6 - 0.8 });
      const [ow, oh] = sizes[Math.floor(rand() * sizes.length)].map((v) => v + (v % 2));
      const plan = buildExportPlan(p, { outputPath: '', width: ow, height: oh, frameRate: R30, canvasMapping: rand() < 0.5 ? 'fit' : 'fill', videoBitrateMbps: 2, x264Preset: 'fast', audioBitrateKbps: 128 }, 'x', (mm) => mm.path);
      const graph = plan.args[plan.args.indexOf('-filter_complex') + 1];
      const c = /crop=w=([\d.]+):h=([\d.]+):x=([\d.]+):y=([\d.]+)/.exec(graph);
      if (!c) continue;
      const [w, h, x, y] = c.slice(1).map(Number);
      const fw = rotation ? sh : sw;
      const fh = rotation ? sw : sh;
      expect(w >= 1 && h >= 1 && x >= 0 && y >= 0).toBe(true);
      expect(x + w).toBeLessThanOrEqual(fw);
      expect(y + h).toBeLessThanOrEqual(fh);
    }
  });

  it('offers output sizes that keep the canvas aspect ratio', () => {
    const opts = outputSizeOptions(1080, 1920);
    expect(opts.find((o) => o.label.startsWith('720p'))).toMatchObject({ width: 720, height: 1280 });
    for (const o of opts) expect(o.width % 2 + (o.height % 2)).toBe(0);
  });
});

describe('project files', () => {
  it('round-trips through save and load, with relative media paths', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cutroom-'));
    const mediaPath = path.join(dir, 'clip.mp4');
    writeFileSync(mediaPath, 'x');
    let p = ops.addMedia(createProject('Trip'), [{ ...media('a', 5), path: mediaPath }]);
    p = ops.addClip(p, 'a')!.project;
    p = ops.splitAt(p, 2 * S)!.project;
    p = ops.setFraming(p, p.sequence.items[1].id, { mode: 'manual', scale: 1.3, x: 0.1, y: -0.2 });
    const file = path.join(dir, 'Trip.cutroom');
    saveProjectFile(file, p);
    const loaded = loadProjectFile(file);
    expect(loaded.missingMediaIds).toEqual([]);
    expect(loaded.project.sequence).toEqual(p.sequence);
    expect(loaded.project.media[0].relativePath).toBe('clip.mp4');
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('reports missing media and finds moved media via the relative path', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cutroom-'));
    let p = ops.addMedia(createProject(), [{ ...media('a', 5), path: '/gone/clip.mp4', relativePath: 'clip.mp4' }]);
    const file = path.join(dir, 'p.cutroom');
    writeFileSync(file, serializeProject(p));
    expect(loadProjectFile(file).missingMediaIds).toEqual(['a']);
    writeFileSync(path.join(dir, 'clip.mp4'), 'x');
    const found = loadProjectFile(file);
    expect(found.missingMediaIds).toEqual([]);
    expect(found.project.media[0].path).toBe(path.join(dir, 'clip.mp4'));
    unlinkSync(path.join(dir, 'clip.mp4'));
  });

  it('rejects damaged, foreign and newer-format files with readable messages', () => {
    expect(() => parseProject('{not json')).toThrow(/not valid JSON/);
    expect(() => parseProject('{"hello":1}')).toThrow(/not a Cutroom project/);
    const newer = JSON.parse(serializeProject(createProject()));
    newer.version = 99;
    expect(() => parseProject(JSON.stringify(newer))).toThrow(/newer version/);
    const bad = JSON.parse(serializeProject(project3()));
    bad.sequence.items[0].sourceOut = -1;
    expect(() => parseProject(JSON.stringify(bad))).toThrow(/bad in\/out/);
  });

  it('a failed save leaves the previous file intact', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cutroom-'));
    const file = path.join(dir, 'p.cutroom');
    saveProjectFile(file, createProject('first'));
    const bad = createProject('second') as any;
    bad.circular = bad; // JSON.stringify throws before anything is written
    expect(() => saveProjectFile(file, bad)).toThrow();
    expect(JSON.parse(readFileSync(file, 'utf8')).name).toBe('first');
  });
});

describe('snapToFrame', () => {
  it('rounds to the nearest frame start', () => {
    expect(snapToFrame(Math.round(0.049 * S), R30)).toBe(frameToTicks(1, R30));
    expect(snapToFrame(Math.round(0.049 * S), R30, 'floor')).toBe(frameToTicks(1, R30));
    expect(snapToFrame(Math.round(0.01 * S), R30)).toBe(0);
  });
});
