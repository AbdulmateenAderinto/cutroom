import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectFiles, findInFolder } from '../../src/main/media/manage';
import { saveProjectFile } from '../../src/main/project/projectFiles';
import { listVersions, loadVersion, saveVersion, versionsDir } from '../../src/main/project/versions';
import { type MediaRef, createProject } from '../../src/shared/model';
import * as ops from '../../src/shared/ops';
import { addOverlay } from '../../src/shared/overlays';
import { TICKS_PER_SECOND as S } from '../../src/shared/time';

function media(id: string, file: string, seconds = 10): MediaRef {
  return {
    id, name: path.basename(file), path: file, warnings: [],
    info: {
      container: 'mov,mp4', fileSize: 4, duration: seconds * S, videoCodec: 'h264', width: 1920, height: 1080,
      displayWidth: 1920, displayHeight: 1080, rotation: 0, frameRate: { num: 30, den: 1 }, avgFrameRate: { num: 30, den: 1 }, isVFR: false, pixFmt: 'yuv420p',
      colorTransfer: '', isHDR: false, hasAudio: true, audioCodec: 'aac', audioSampleRate: 48000, audioChannels: 2,
    },
  };
}

describe('versions', () => {
  it('saves named snapshots next to the project, lists them newest first and loads them back', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cutroom-ver-'));
    const file = path.join(dir, 'Trip.cutroom');
    const clip = path.join(dir, 'a.mp4');
    writeFileSync(clip, 'fake');
    let p = ops.addMedia(createProject('Trip'), [media('a', clip)]);
    p = ops.addClip(p, 'a')!.project;
    saveProjectFile(file, p);
    const v1 = saveVersion(file, p, 'Rough cut');
    await new Promise((r) => setTimeout(r, 20));
    const p2 = ops.addClip(p, 'a')!.project;
    const v2 = saveVersion(file, p2, 'Two clips / final?');
    expect(path.dirname(v1.file)).toBe(versionsDir(file));
    expect(versionsDir(file)).toBe(path.join(dir, 'Trip versions'));
    expect(v2.name).toMatch(/Two clips - final-$/); // unsafe characters replaced
    const list = listVersions(file);
    expect(list.map((v) => v.file)).toEqual([v2.file, v1.file]);
    const back = loadVersion(file, v1.file);
    expect(back.project.sequence.items.filter((i) => i.kind === 'clip')).toHaveLength(1);
    expect(back.missingMediaIds).toEqual([]); // media found again from the sub-folder
    expect(loadVersion(file, v2.file).project.sequence.items.filter((i) => i.kind === 'clip')).toHaveLength(2);
    // The project file itself is untouched; files outside the versions folder are refused.
    expect(JSON.parse(readFileSync(file, 'utf8')).sequence.items).toHaveLength(1);
    expect(() => loadVersion(file, file)).toThrow(/Not a version/);
    // Same second, same name: a second file, nothing overwritten.
    const a = saveVersion(file, p, 'x');
    const b = saveVersion(file, p, 'x');
    expect(a.file).not.toBe(b.file);
  });
});

describe('media manager', () => {
  it('finds moved files by name in sub-folders, preferring the same size', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cutroom-find-'));
    mkdirSync(path.join(dir, 'x', 'y'), { recursive: true });
    mkdirSync(path.join(dir, 'z'));
    writeFileSync(path.join(dir, 'x', 'y', 'Clip.MP4'), '1234');
    writeFileSync(path.join(dir, 'z', 'Clip.mp4'), '12');
    writeFileSync(path.join(dir, 'z', 'other.mov'), '1');
    mkdirSync(path.join(dir, '.hidden'));
    writeFileSync(path.join(dir, '.hidden', 'gone.mp4'), '1');
    const found = await findInFolder(dir, [{ name: 'clip.mp4', size: 4 }, { name: 'gone.mp4' }, { name: 'nope.mp4' }]);
    expect(found).toEqual({ 'clip.mp4': path.join(dir, 'x', 'y', 'Clip.MP4') });
  });

  it('collects files into one folder without overwriting anything', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cutroom-collect-'));
    mkdirSync(path.join(dir, 'a'));
    mkdirSync(path.join(dir, 'b'));
    mkdirSync(path.join(dir, 'out'));
    writeFileSync(path.join(dir, 'a', 'clip.mp4'), 'A');
    writeFileSync(path.join(dir, 'b', 'clip.mp4'), 'B');
    writeFileSync(path.join(dir, 'out', 'clip.mp4'), 'already there');
    const map = await collectFiles([path.join(dir, 'a', 'clip.mp4'), path.join(dir, 'b', 'clip.mp4'), path.join(dir, 'out', 'clip.mp4')], path.join(dir, 'out'));
    expect(readFileSync(path.join(dir, 'out', 'clip.mp4'), 'utf8')).toBe('already there');
    expect(readFileSync(map[path.join(dir, 'a', 'clip.mp4')], 'utf8')).toBe('A');
    expect(readFileSync(map[path.join(dir, 'b', 'clip.mp4')], 'utf8')).toBe('B');
    expect(new Set(Object.values(map)).size).toBe(3);
    // The originals are still there.
    expect(readFileSync(path.join(dir, 'a', 'clip.mp4'), 'utf8')).toBe('A');
  });

  it('counts uses across tracks and relinks overlays and audio clips too', () => {
    let p = ops.addMedia(createProject(), [media('a', '/m/a.mp4'), media('b', '/m/b.mp4'), media('c', '/m/c.mp4')]);
    p = ops.addClip(p, 'a')!.project;
    const o = addOverlay(p, 'b', 0);
    p = 'error' in o ? p : o.project;
    expect(ops.mediaUses(p)).toEqual({ a: 1, b: 1 });
    expect(ops.unusedMedia(p)).toEqual(['c']);
    const shorter = { ...media('b', '/n/b.mp4', 2).info };
    const q = ops.relinkMedia(p, 'b', '/n/b.mp4', shorter, []);
    const ov = q.overlays![0];
    expect(ov.sourceOut).toBeLessThanOrEqual(2 * S);
    expect(q.media.find((m) => m.id === 'b')!.path).toBe('/n/b.mp4');
  });
});
