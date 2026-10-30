/**
 * Photos as clips: EXIF orientation is honoured, colours survive the RGB → BT.709 conversion,
 * transparent PNGs show the background through, and a Ken Burns move follows the shared maths.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runExport } from '../../src/main/export/exportRunner';
import { probeMedia } from '../../src/main/media/probe';
import { evalAnimation } from '../../src/shared/animation';
import type { ExportSettings } from '../../src/shared/exportPlan';
import { type ClipItem, type Project, animateRect, computeClipRect, createProject } from '../../src/shared/model';
import { PHOTO_DEFAULT, addClip, addMedia, setAnimation } from '../../src/shared/ops';
import { frameToTicks } from '../../src/shared/time';
import { FIXTURE_DIR, OUTPUT_DIR, ensureDirs, mediaRefFor } from '../helpers/fixtures';

const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const R30 = { num: 30, den: 1 };
const ORIENTED = path.join(FIXTURE_DIR, 'photo-orient6.jpg');
const ALPHA = path.join(FIXTURE_DIR, 'photo-alpha.png');
const HALVES = path.join(FIXTURE_DIR, 'photo-halves.jpg');

/** Insert an EXIF block with Orientation = 6 ("rotate 90° clockwise to display") after the JPEG SOI. */
function withOrientation6(jpeg: Buffer): Buffer {
  const tiff = Buffer.from([
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // big-endian TIFF header, IFD at 8
    0x00, 0x01, // one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00, // Orientation (SHORT) = 6
    0x00, 0x00, 0x00, 0x00, // no next IFD
  ]);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(body.length + 2);
  return Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1]), len, body, jpeg.subarray(2)]);
}

beforeAll(() => {
  ensureDirs();
  if (!existsSync(ORIENTED)) {
    // Stored 400×200: left half red, right half blue. Displayed upright it is 200×400, red on top.
    const plain = path.join(FIXTURE_DIR, 'photo-plain.jpg');
    ff(['-f', 'lavfi', '-i', 'color=c=0xff0000:s=200x200,format=rgb24', '-f', 'lavfi', '-i', 'color=c=0x0000ff:s=200x200,format=rgb24',
      '-filter_complex', '[0][1]hstack', '-frames:v', '1', '-q:v', '1', plain]);
    writeFileSync(ORIENTED, withOrientation6(readFileSync(plain)));
  }
  if (!existsSync(ALPHA)) {
    // 100×100: left half fully transparent, right half opaque blue.
    ff(['-f', 'lavfi', '-i', 'color=c=0x0000ff:s=100x100', '-vf', "format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(X,50),0,255)'",
      '-frames:v', '1', ALPHA]);
  }
  if (!existsSync(HALVES)) {
    // 400×200: left half black, right half white.
    ff(['-f', 'lavfi', '-i', 'color=c=black:s=200x200', '-f', 'lavfi', '-i', 'color=c=white:s=200x200',
      '-filter_complex', '[0][1]hstack', '-frames:v', '1', '-q:v', '1', HALVES]);
  }
});

const settings = (name: string, width: number, height: number): ExportSettings => ({
  outputPath: path.join(OUTPUT_DIR, name), width, height, frameRate: R30, canvasMapping: 'fit',
  videoBitrateMbps: 4, x264Preset: 'veryfast', audioBitrateKbps: 128,
});

function photoProject(file: string, w: number, h: number, background = '#000000'): Promise<Project> {
  return mediaRefFor(file).then((m) => {
    const p = addMedia({ ...createProject('photo'), canvas: { width: w, height: h, preset: 'custom' }, background }, [m]);
    return addClip(p, m.id)!.project;
  });
}

/** RGB of one pixel of the first frame (decoded as BT.709 limited range). */
function pixel(file: string, x: number, y: number, frame = 0): number[] {
  return [...execFileSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-vf', `select=eq(n\\,${frame}),scale=in_color_matrix=bt709:in_range=tv,format=rgb24,crop=1:1:${x}:${y}`,
    '-frames:v', '1', '-f', 'rawvideo', '-'])];
}
const near = (got: number[], want: number[], tol: number) => got.every((v, i) => Math.abs(v - want[i]) <= tol);

describe('photos', () => {
  it('probes as an image, upright, and becomes a 4 s clip', async () => {
    const r = await probeMedia(ORIENTED);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.info.kind).toBe('image');
    expect([r.info.displayWidth, r.info.displayHeight]).toEqual([200, 400]);
    const p = await photoProject(ORIENTED, 200, 400);
    const c = p.sequence.items[0] as ClipItem;
    expect(c.sourceOut - c.sourceIn).toBe(PHOTO_DEFAULT);
  });

  it('exports upright (EXIF orientation) with the right colours and length', async () => {
    const p = await photoProject(ORIENTED, 200, 400);
    const s = settings('photo-orient.mp4', 200, 400);
    const r = await runExport(p, s);
    expect(r.status, JSON.stringify(r).slice(0, 600)).toBe('done');
    const top = pixel(s.outputPath, 100, 100);
    const bottom = pixel(s.outputPath, 100, 300);
    expect(near(top, [255, 0, 0], 16), `top ${top}`).toBe(true);
    expect(near(bottom, [0, 0, 255], 16), `bottom ${bottom}`).toBe(true);
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v', '-show_streams', '-of', 'json', s.outputPath]).toString());
    expect(Number(probe.streams[0].nb_read_frames)).toBe(120);
    expect(probe.streams[0].color_space).toBe('bt709');
  });

  it('transparent PNG: the background colour shows through', async () => {
    const p = await photoProject(ALPHA, 320, 180, '#00ff00');
    const s = settings('photo-alpha.mp4', 320, 180);
    const r = await runExport(p, s);
    expect(r.status, JSON.stringify(r).slice(0, 600)).toBe('done');
    // Fit: the 100×100 photo becomes 180×180 at x = 70. Left half transparent, right half blue.
    const clear = pixel(s.outputPath, 110, 90);
    const blue = pixel(s.outputPath, 200, 90);
    const pad = pixel(s.outputPath, 20, 90);
    expect(near(clear, [0, 255, 0], 16), `transparent part ${clear}`).toBe(true);
    expect(near(blue, [0, 0, 255], 16), `opaque part ${blue}`).toBe(true);
    expect(near(pad, [0, 255, 0], 16), `padding ${pad}`).toBe(true);
  });

  it('Ken Burns pan follows evalAnimation frame by frame', async () => {
    let p = await photoProject(HALVES, 320, 160);
    const id = p.sequence.items[0].id;
    p = setAnimation(p, id, (a) => ({ ...a, motion: { preset: 'panRight', amount: 0.8 } }));
    const s = settings('photo-kenburns.mp4', 320, 160);
    const r = await runExport(p, s);
    expect(r.status, JSON.stringify(r).slice(0, 600)).toBe('done');
    const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', s.outputPath, '-vf', 'format=gray,crop=iw:1:0:80', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 });
    const clip = p.sequence.items[0] as ClipItem;
    const base = computeClipRect(400, 200, 320, 160, clip.framing);
    const dur = clip.sourceOut - clip.sourceIn;
    let worst = 0;
    const edges: number[] = [];
    for (let j = 0; j * 320 + 320 <= raw.length; j++) {
      const row = raw.subarray(j * 320, j * 320 + 320);
      const st = evalAnimation(clip.animation, frameToTicks(j, R30), dur, clip.sourceIn);
      const want = animateRect(base, st, 320, 160);
      const edge = row.findIndex((v) => v > 128); // black → white boundary of the photo
      edges.push(edge);
      worst = Math.max(worst, Math.abs(edge - (want.x + want.w / 2)));
    }
    expect(edges.length).toBe(120);
    expect(Math.abs(edges[119] - edges[0])).toBeGreaterThan(10); // it really moves
    expect(worst).toBeLessThanOrEqual(2);
  });
});
