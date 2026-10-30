/** Markers exported as chapters (MP4 and MOV), shifted for a range export; none copied from sources. */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runExport } from '../../src/main/export/exportRunner';
import { addMarker } from '../../src/shared/markers';
import { type MediaRef, type Project, createProject } from '../../src/shared/model';
import { addClip, addMedia } from '../../src/shared/ops';
import { TICKS_PER_SECOND as S } from '../../src/shared/time';
import { OUTPUT_DIR, ensureDirs, makeCoded, mediaRefFor } from '../helpers/fixtures';

let M: MediaRef;
beforeAll(async () => {
  ensureDirs();
  M = await mediaRefFor(makeCoded({ name: 'A_320x240_30', width: 320, height: 240, fps: 30, seconds: 4, cb: 60, freq: 440 }));
});

function project(): Project {
  let p = addMedia({ ...createProject('mk'), canvas: { width: 320, height: 240, preset: 'custom' } }, [M]);
  p = addClip(p, M.id)!.project;
  p = addMarker(p, 1 * S, { label: 'One' }).project;
  return addMarker(p, 2.5 * S, { label: 'Two' }).project;
}
const chapters = (file: string) =>
  (JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_chapters', '-of', 'json', file]).toString()).chapters as { start_time: string; end_time: string; tags?: { title?: string } }[])
    .map((c) => ({ start: Number(c.start_time), end: Number(c.end_time), title: c.tags?.title }));
const exp = async (name: string, over: Record<string, unknown>) => {
  const outputPath = path.join(OUTPUT_DIR, name);
  const r = await runExport(project(), { outputPath, width: 320, height: 240, frameRate: { num: 30, den: 1 }, canvasMapping: 'fit', videoBitrateMbps: 4, x264Preset: 'veryfast', audioBitrateKbps: 128, ...over });
  expect(r.status, JSON.stringify(r).slice(0, 800)).toBe('done');
  return outputPath;
};

describe('markers as chapters', () => {
  it('MP4: a lead-in chapter, then one per marker, ending at the video end', async () => {
    const c = chapters(await exp('mk-chapters.mp4', { chapters: true }));
    expect(c.map((x) => x.title)).toEqual(['Start', 'One', 'Two']);
    expect(c.map((x) => x.start)).toEqual([0, 1, 2.5]);
    expect(c[2].end).toBeCloseTo(4, 2);
  });

  it('MOV (ProRes) carries them too', async () => {
    const c = chapters(await exp('mk-chapters.mov', { chapters: true, codec: 'prores' }));
    expect(c.map((x) => x.title)).toEqual(['Start', 'One', 'Two']);
  });

  it('range export: chapters relative to the range start', async () => {
    const c = chapters(await exp('mk-range.mp4', { chapters: true, range: { start: 1 * S, end: 3 * S } }));
    expect(c.map((x) => [x.title, x.start])).toEqual([['One', 0], ['Two', 1.5]]);
    expect(c[1].end).toBeCloseTo(2, 2);
  });

  it('chapters off: none in the file', async () => {
    expect(chapters(await exp('mk-none.mp4', {}))).toEqual([]);
  });
});
