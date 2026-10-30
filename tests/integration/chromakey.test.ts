/**
 * Chroma key: a red square on a green screen, keyed and laid over a blue clip, exports as a red
 * square on blue (soft edge between); the WebM preview copy has the same transparency.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runExport } from '../../src/main/export/exportRunner';
import { makeProxy } from '../../src/main/media/proxy';
import { type MediaRef, createProject } from '../../src/shared/model';
import { addClip, addMedia } from '../../src/shared/ops';
import { addOverlay } from '../../src/shared/overlays';
import { FIXTURE_DIR, OUTPUT_DIR, ensureDirs, mediaRefFor } from '../helpers/fixtures';

let GREEN: MediaRef;
let BLUE: MediaRef;
const make = (name: string, src: string) => {
  const f = path.join(FIXTURE_DIR, name);
  if (!existsSync(f)) {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `${src},format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv`,
      '-f', 'lavfi', '-i', 'sine=d=2', '-t', '2', '-c:v', 'libx264', '-crf', '4', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-c:a', 'aac', '-shortest', f]);
  }
  return f;
};
beforeAll(async () => {
  ensureDirs();
  GREEN = await mediaRefFor(make('greenscreen.mp4', 'color=c=0x10d020:s=320x240:r=30:d=2[g];color=c=0xe02020:s=120x100:r=30:d=2[r];[g][r]overlay=x=100:y=70,scale=out_color_matrix=bt709'));
  BLUE = await mediaRefFor(make('blue-320.mp4', 'color=c=0x2040e0:s=320x240:r=30:d=2,scale=out_color_matrix=bt709'));
});

const rgb = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args, '-vf', 'select=eq(n\\,10),scale=in_color_matrix=bt709,format=rgba', '-frames:v', '1', '-f', 'rawvideo', '-']);
const px = (b: Buffer, x: number, y: number) => [0, 1, 2, 3].map((k) => b[(y * 320 + x) * 4 + k]);

describe('chroma key', () => {
  const key = { color: '#10d020', similarity: 0.25, blend: 0.05 };

  it('export: the keyed overlay shows the clip below where the screen was', async () => {
    let p = addMedia({ ...createProject('ck'), canvas: { width: 320, height: 240, preset: 'custom' } }, [BLUE, { ...GREEN, input: { key } }]);
    p = addClip(p, BLUE.id)!.project;
    p = addOverlay(p, GREEN.id, 0, { corner: 'full' })!.project;
    const out = path.join(OUTPUT_DIR, 'chromakey.mp4');
    const r = await runExport(p, { outputPath: out, width: 320, height: 240, frameRate: { num: 30, den: 1 }, canvasMapping: 'fit', videoBitrateMbps: 8, x264Preset: 'veryfast', audioBitrateKbps: 128 });
    expect(r.status, JSON.stringify(r).slice(0, 1200)).toBe('done');
    const f = rgb(['-i', out]);
    const red = px(f, 160, 120);
    const blue = px(f, 30, 30);
    expect(red[0]).toBeGreaterThan(180);
    expect(red[2]).toBeLessThan(70);
    expect(blue[2]).toBeGreaterThan(180);
    expect(blue[1]).toBeLessThan(110); // no green left
  });

  it('the preview copy is WebM with alpha: transparent screen, opaque square', async () => {
    const m = { ...GREEN, input: { key } };
    const copy = await makeProxy(mkdtempSync(path.join(os.tmpdir(), 'cutroom-key-')), m.path, m.info, undefined, m.input);
    expect(copy.endsWith('.webm')).toBe(true);
    // libvpx-vp9 decoder reads the alpha channel.
    const f = rgb(['-c:v', 'libvpx-vp9', '-i', copy]);
    expect(px(f, 30, 30)[3]).toBeLessThan(20);
    expect(px(f, 160, 120)[3]).toBeGreaterThan(235);
    expect(px(f, 160, 120)[0]).toBeGreaterThan(180);
  });
});
