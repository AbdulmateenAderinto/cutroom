import { describe, expect, it } from 'vitest';
import { NEUTRAL, applyColor, colorTransform, ffmpegMixer, isNeutral, legalColor, svgMatrix } from '../../src/shared/color';
import { type ClipItem, type MediaRef, createProject } from '../../src/shared/model';
import * as ops from '../../src/shared/ops';
import { parseProject, serializeProject } from '../../src/shared/serialize';
import { TICKS_PER_SECOND as S } from '../../src/shared/time';

const R30 = { num: 30, den: 1 };
const media: MediaRef = {
  id: 'm', name: 'm', path: '/m', warnings: [],
  info: {
    container: '', fileSize: 1, duration: 4 * S, videoCodec: 'h264', width: 640, height: 360, displayWidth: 640, displayHeight: 360, rotation: 0,
    frameRate: R30, avgFrameRate: R30, isVFR: false, pixFmt: 'yuv420p', colorTransfer: '', isHDR: false, hasAudio: true, audioCodec: 'aac', audioSampleRate: 48000, audioChannels: 2,
  },
};

describe('colour adjustments', () => {
  it('neutral is the identity', () => {
    expect(applyColor(NEUTRAL, [12, 128, 250])).toEqual([12, 128, 250]);
    const { m, o } = colorTransform(NEUTRAL);
    expect(m).toEqual([[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
    expect(o).toEqual([0, 0, 0]);
  });

  it('exposure doubles per stop and clips; contrast pivots on mid grey', () => {
    expect(applyColor({ ...NEUTRAL, exposure: 1 }, [50, 100, 200]).map(Math.round)).toEqual([100, 200, 255]);
    expect(applyColor({ ...NEUTRAL, contrast: 2 }, [127.5, 100, 200]).map(Math.round)).toEqual([128, 73, 255]);
    expect(applyColor({ ...NEUTRAL, contrast: 0 }, [0, 100, 255]).map(Math.round)).toEqual([128, 128, 128]);
  });

  it('saturation 0 gives grey with the Rec.709 luma; temperature warms red and cools blue', () => {
    const g = applyColor({ ...NEUTRAL, saturation: 0 }, [255, 0, 0]);
    expect(g[0]).toBeCloseTo(255 * 0.2126, 6);
    expect(g[1]).toBeCloseTo(g[0], 9);
    const w = applyColor({ ...NEUTRAL, temperature: 1 }, [100, 100, 100]);
    expect(w[0]).toBeGreaterThan(100);
    expect(w[2]).toBeLessThan(100);
  });

  it('SVG and FFmpeg strings carry the same numbers', () => {
    const c = { exposure: 0.5, contrast: 1.2, saturation: 0.7, temperature: -0.4 };
    const { m, o } = colorTransform(c);
    const svg = svgMatrix(c).split(' ').map(Number);
    expect(svg.length).toBe(20);
    expect(svg[0]).toBeCloseTo(m[0][0], 4);
    expect(svg[4]).toBeCloseTo(o[0], 4);
    expect(svg.slice(15)).toEqual([0, 0, 0, 1, 0]);
    const ff = Object.fromEntries(ffmpegMixer(c).split(':').map((kv) => kv.split('=')));
    expect(Number(ff.gb)).toBeCloseTo(m[1][2], 5);
    expect(Number(ff.ba)).toBeCloseTo(o[2], 5);
  });

  it('values are clamped and rounded; neutral settings are removed from the clip', () => {
    expect(legalColor({ exposure: 9, saturation: -1, contrast: 1.234 })).toEqual({ exposure: 2, contrast: 1.23, saturation: 0, temperature: 0 });
    let p = ops.addClip(ops.addMedia(createProject(), [media]), 'm')!.project;
    const id = p.sequence.items[0].id;
    p = ops.setColor(p, id, { saturation: 0 });
    expect((p.sequence.items[0] as ClipItem).color).toEqual({ ...NEUTRAL, saturation: 0 });
    expect((parseProject(serializeProject(p)).sequence.items[0] as ClipItem).color).toEqual({ ...NEUTRAL, saturation: 0 });
    p = ops.setColor(p, id, { saturation: 1 });
    expect(p.sequence.items[0]).not.toHaveProperty('color');
    expect(isNeutral(undefined)).toBe(true);
  });
});
