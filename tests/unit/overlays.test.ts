import { describe, expect, it } from 'vitest';
import { buildExportPlan } from '../../src/shared/exportPlan';
import { type MediaRef, PROJECT_VERSION, type Project, computeClipRect, createProject } from '../../src/shared/model';
import { addClip, addMedia, removeMedia, setColor, setFraming, setSpeed, setTransition } from '../../src/shared/ops';
import {
  addOverlay, clipLayout, deleteOverlay, duplicateOverlay, findOverlay, moveOverlay, overlayEnd, overlaysAt, pasteOverlay, pipFraming,
  splitOverlay, trimOverlay,
} from '../../src/shared/overlays';
import { parseProject, serializeProject } from '../../src/shared/serialize';
import { TICKS_PER_SECOND as S } from '../../src/shared/time';

const R30 = { num: 30, den: 1 };
function media(id: string, seconds: number, kind: 'video' | 'audio' | 'image' = 'video', w = 640, h = 360): MediaRef {
  return {
    id, name: id, path: `/m/${id}`, warnings: [],
    info: {
      kind, container: '', fileSize: 1, duration: seconds * S, videoCodec: kind === 'audio' ? '' : 'h264', width: w, height: h,
      displayWidth: kind === 'audio' ? 0 : w, displayHeight: kind === 'audio' ? 0 : h, rotation: 0, frameRate: R30, avgFrameRate: R30,
      isVFR: false, pixFmt: '', colorTransfer: '', isHDR: false, hasAudio: kind !== 'image', audioCodec: 'aac', audioSampleRate: 48000, audioChannels: 2,
    },
  };
}
function proj(): Project {
  const p = addMedia({ ...createProject(), canvas: { width: 1920, height: 1080, preset: 'custom' } }, [media('main', 20), media('cam', 6), media('logo', 1, 'image', 400, 400), media('song', 30, 'audio')]);
  return addClip(p, 'main')!.project;
}
const add = (p: Project, m: string, at: number, opts = {}) => addOverlay(p, m, at * S, opts)!;

describe('overlay tracks', () => {
  it('adds a whole file as picture-in-picture in the bottom-right corner, 35% of Fit size', () => {
    const r = add(proj(), 'cam', 2);
    const o = findOverlay(r.project, r.id)!;
    expect(o.start).toBe(2 * S);
    expect(overlayEnd(o)).toBe(8 * S);
    expect(o.row).toBe(0);
    const rect = computeClipRect(640, 360, 1920, 1080, o.framing);
    expect(rect.w).toBeCloseTo(0.35 * 1920, 3);
    expect(1920 - (rect.x + rect.w)).toBeCloseTo(0.04 * 1080, 3); // margin of 4% of the short side
    expect(1080 - (rect.y + rect.h)).toBeCloseTo(0.04 * 1080, 3);
    // Photos default to 4 s; sound files are refused.
    const logo = add(proj(), 'logo', 0);
    expect(overlayEnd(findOverlay(logo.project, logo.id)!)).toBe(4 * S);
    expect(addOverlay(proj(), 'song', 0)).toBeNull();
  });

  it('every PiP corner stays inside the canvas with the same margin', () => {
    for (const c of ['topLeft', 'topRight', 'bottomLeft', 'bottomRight', 'center'] as const) {
      const r = computeClipRect(640, 360, 1920, 1080, pipFraming(640, 360, 1920, 1080, c, 0.5));
      expect(r.x).toBeGreaterThanOrEqual(43.19);
      expect(r.y).toBeGreaterThanOrEqual(43.19);
      expect(r.x + r.w).toBeLessThanOrEqual(1920 - 43.19);
      expect(r.y + r.h).toBeLessThanOrEqual(1080 - 43.19);
    }
    expect(pipFraming(640, 360, 1920, 1080, 'full').mode).toBe('fit');
  });

  it('a second overlapping overlay goes on the next track; rows never overlap', () => {
    let p = add(proj(), 'cam', 2).project;
    const r = add(p, 'cam', 4);
    p = r.project;
    expect(findOverlay(p, r.id)!.row).toBe(1);
    // Asked for row 0: moved to the first free time there.
    const r2 = add(p, 'logo', 3, { row: 0 });
    expect(findOverlay(r2.project, r2.id)!.start).toBe(8 * S);
    expect(overlaysAt(r2.project, 5 * S).map((o) => o.row)).toEqual([0, 1]); // lowest first
  });

  it('move lands in free space; trim keeps the other edge; split and duplicate', () => {
    let p = add(proj(), 'cam', 0).project;
    const a = p.overlays![0].id;
    p = add(p, 'cam', 10, { row: 0 }).project;
    const b = p.overlays![1].id;
    expect(findOverlay(moveOverlay(p, b, 3 * S), b)!.start).toBe(6 * S); // after a
    // Trim the start of b by +1 s: starts later, uses later footage, end unchanged.
    let q = trimOverlay(p, b, 'start', 1 * S);
    expect(findOverlay(q, b)).toMatchObject({ start: 11 * S, sourceIn: 1 * S, sourceOut: 6 * S });
    // Can't extend a's end into b, nor past the file.
    q = trimOverlay(p, a, 'end', 10 * S);
    expect(overlayEnd(findOverlay(q, a)!)).toBe(6 * S);
    q = trimOverlay(trimOverlay(p, a, 'end', -2 * S), a, 'end', 1 * S);
    expect(overlayEnd(findOverlay(q, a)!)).toBe(5 * S);
    const sp = splitOverlay(p, a, 2 * S)!;
    expect(findOverlay(sp.project, a)!.sourceOut).toBe(2 * S);
    expect(findOverlay(sp.project, sp.rightId)).toMatchObject({ start: 2 * S, sourceIn: 2 * S, sourceOut: 6 * S });
    const d = duplicateOverlay(p, a)!;
    expect(findOverlay(d.project, d.id)!.start).toBe(16 * S); // first free spot after a on row 0
    expect(deleteOverlay(p, a).overlays!.length).toBe(1);
  });

  it('paste keeps the row when free, else uses a free row', () => {
    const p = add(proj(), 'cam', 0).project;
    const o = p.overlays![0];
    const later = pasteOverlay(p, o, 10 * S)!;
    expect(findOverlay(later.project, later.id)?.row).toBe(0);
    const r = pasteOverlay(p, o, 2 * S)!;
    expect(findOverlay(r.project, r.id)).toMatchObject({ row: 1, start: 2 * S });
  });

  it('clip edits (framing, speed, colour) work on overlays; overlap-making changes are refused', () => {
    let p = add(proj(), 'cam', 0).project;
    const a = p.overlays![0].id;
    p = add(p, 'cam', 6, { row: 0 }).project;
    let q = setFraming(p, a, { mode: 'fill', scale: 1, x: 0, y: 0 });
    expect(findOverlay(q, a)!.framing.mode).toBe('fill');
    q = setColor(q, a, { exposure: 0.5 });
    expect(findOverlay(q, a)!.color?.exposure).toBe(0.5);
    q = setSpeed(p, a, 2); // shorter: fine
    expect(overlayEnd(findOverlay(q, a)!)).toBe(3 * S);
    q = setSpeed(p, a, 0.5); // longer: would overlap the next overlay → refused
    expect(findOverlay(q, a)!.speed ?? 1).toBe(1);
    expect(findOverlay(setTransition(p, a, 'crossfade', S), a)!).not.toHaveProperty('transition');
    expect(clipLayout(p, a)).toMatchObject({ start: 0, end: 6 * S });
    expect(p.sequence.items.length).toBe(1); // the main track is untouched
  });

  it('removing media removes its overlays; saved and reopened intact (v6)', () => {
    const p = add(proj(), 'cam', 1).project;
    expect(removeMedia(p, 'cam').overlays).toEqual([]);
    const back = parseProject(serializeProject(p));
    expect(back.version).toBe(PROJECT_VERSION);
    expect(back.overlays).toEqual(p.overlays);
    const bad = JSON.parse(serializeProject(p));
    bad.overlays[0].mediaId = 'nope';
    expect(() => parseProject(JSON.stringify(bad))).toThrow();
  });

  it('export plan: each overlay is rendered on a transparent layer and laid over the main track', () => {
    let p = add(proj(), 'cam', 1).project;
    p = add(p, 'logo', 2).project;
    const plan = buildExportPlan(p, {
      outputPath: '/o.mp4', width: 1920, height: 1080, frameRate: R30, canvasMapping: 'fit', videoBitrateMbps: 8, x264Preset: 'veryfast', audioBitrateKbps: 192,
    }, '/o.mp4', (m) => m.path);
    const graph = plan.args[plan.args.indexOf('-filter_complex') + 1];
    expect(graph).toContain('color=c=black@0');
    expect(graph.match(/overlay=x=0:y=0:eof_action=pass/g)?.length).toBe(2);
    expect(graph).toMatch(/setpts=PTS-STARTPTS\+1\.000000\/TB/);
    expect(graph).toMatch(/adelay=delays=48000S/); // the video overlay's sound starts at 1 s
    expect(plan.totalFrames).toBe(600); // the main track sets the length
  });
});

describe('media input (LUT name check)', () => {
  it('a project whose LUT file name is not a hash is refused (it goes into an FFmpeg filter graph)', () => {
    const p = proj();
    const ok = { ...p, media: p.media.map((m, i) => (i === 0 ? { ...m, input: { lut: { file: 'a'.repeat(40) + '.cube', name: 'x.cube', source: '/x.cube' } } } : m)) };
    expect(() => parseProject(serializeProject(ok))).not.toThrow();
    const bad = { ...p, media: p.media.map((m, i) => (i === 0 ? { ...m, input: { lut: { file: "x.cube,drawtext=text='hi'", name: 'x', source: '/x' } } } : m)) };
    expect(() => parseProject(serializeProject(bad))).toThrow(/LUT/);
  });
});
