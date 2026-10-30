import { describe, expect, it } from 'vitest';
import { NEUTRAL, applyColor, colorTransform, curveTables, ffmpegCurves, isNeutral, legalColor, legalCurve, svgCurveTables } from '../../src/shared/color';

describe('hue, lightness and curves', () => {
  it('hue 0 and lightness 0 are neutral; hue keeps greys grey', () => {
    expect(isNeutral({ ...NEUTRAL })).toBe(true);
    const { m } = colorTransform({ ...NEUTRAL, hue: 0 });
    expect(m.map((r) => r.map((v) => Math.round(v * 1e6) / 1e6))).toEqual([[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
    const grey = applyColor({ ...NEUTRAL, hue: 120 }, [100, 100, 100]);
    grey.forEach((v) => expect(v).toBeCloseTo(100, 0));
    expect(applyColor({ ...NEUTRAL, lightness: 0.1 }, [100, 100, 100])[0]).toBeCloseTo(125.5, 1);
  });

  it('older projects without hue/lightness still work', () => {
    const old = { exposure: 0.5, contrast: 1, saturation: 1, temperature: 0 } as never;
    expect(isNeutral(old)).toBe(false);
    expect(Number.isFinite(colorTransform(old).m[0][0])).toBe(true);
  });

  it('curves are monotone, pass through their points, and identity curves are dropped', () => {
    const c = legalColor({ curves: { master: [[0.25, 0.15], [0.75, 0.85]] } });
    const t = curveTables(c)!;
    expect(t.r[0]).toBe(0);
    expect(t.r[255]).toBe(1);
    expect(Math.abs(t.r[Math.round(0.25 * 255)] - 0.15)).toBeLessThan(0.01);
    for (let i = 1; i < 256; i++) expect(t.r[i]).toBeGreaterThanOrEqual(t.r[i - 1]);
    expect(legalCurve([[0.5, 0.5]])).toBeNull();
    expect(legalColor({ curves: { r: [[0.3, 0.3]] } }).curves).toBeUndefined();
    expect(legalCurve([[2, -1], [0.5, 0.6], [0.5, 0.7]])).toEqual([[0.5, 0.6], [1, 0]]);
  });

  it('preview tables and the FFmpeg curves points come from the same table', () => {
    const c = legalColor({ curves: { g: [[0.4, 0.6]] } });
    const t = curveTables(c)!;
    const svg = svgCurveTables(c)!;
    expect(svg.g.split(' ').map(Number).map((v, i) => Math.abs(v - t.g[i]) < 1e-4).every(Boolean)).toBe(true);
    const ff = ffmpegCurves(c)!;
    expect(ff.match(/\//g)!.length).toBe(3 * 256);
    expect(svg.r.split(' ').map(Number).every((v, i) => Math.abs(v - i / 255) < 1e-4)).toBe(true); // identity
  });
});
