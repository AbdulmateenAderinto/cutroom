import { describe, expect, it } from 'vitest';
import { BUILTIN_PRESETS, isValidPreset, presetFromSettings, resolvePreset } from '../../src/shared/exportPresets';

const R30 = { num: 30, den: 1 };
const R25 = { num: 25, den: 1 };
const byId = (id: string) => BUILTIN_PRESETS.find((p) => p.id === id)!;

describe('export presets', () => {
  it('1080p keeps the canvas shape: landscape, portrait, square', () => {
    expect(resolvePreset(byId('share1080'), 1920, 1080, R25, 20)).toMatchObject({ width: 1920, height: 1080, frameRate: R30, mbps: 12 });
    expect(resolvePreset(byId('share1080'), 1080, 1920, R25, 20)).toMatchObject({ width: 1080, height: 1920 });
    expect(resolvePreset(byId('share1080'), 3840, 3840, R25, 20)).toMatchObject({ width: 1080, height: 1080, sizeKey: '1080x1080' });
  });

  it('canvas size and project frame rate; CRF presets', () => {
    const r = resolvePreset(byId('master'), 1280, 720, R25, 20);
    expect(r).toMatchObject({ width: 1280, height: 720, frameRate: R25, rateControl: 'crf', crf: 16, x264Preset: 'slow' });
  });

  it('a suggested bitrate follows size and frame rate', () => {
    const r = resolvePreset(byId('hw1080'), 1080, 1920, R30, 20);
    expect(r.encoder).toBe('videotoolbox');
    expect(r.mbps).toBeGreaterThan(4);
  });

  it('saving current settings makes a portable preset', () => {
    const p = presetFromSettings('  Reels  ', { width: 720, height: 1280, frameRate: R30, rateControl: 'bitrate', mbps: 6, crf: 20, x264Preset: 'fast', audioKbps: 160, encoder: 'x264' }, 1080, 1920, R30);
    expect(p).toMatchObject({ name: 'Reels', shortEdge: 720, frameRate: 'project', mbps: 6 });
    expect(isValidPreset(p)).toBe(true);
    // Applied to a landscape canvas it becomes 1280×720.
    expect(resolvePreset(p, 1920, 1080, R25, 20)).toMatchObject({ width: 1280, height: 720, frameRate: R25 });
    expect(isValidPreset({ ...p, encoder: 'nvenc' })).toBe(false);
    expect(isValidPreset(null)).toBe(false);
  });
});
