/**
 * Per-clip colour adjustments: exposure, contrast, saturation, temperature.
 *
 * They combine into one affine transform of gamma-encoded RGB (0..1): out = M·in + o, clamped.
 * The preview applies it with an SVG feColorMatrix (color-interpolation-filters="sRGB", so it
 * works on the same gamma-encoded values) and the export with FFmpeg's colorchannelmixer on RGBA
 * (the alpha column carries the offset). Both use colorTransform() below.
 */
import type { ClipItem } from './model';

export interface ColorAdjust {
  exposure: number; // stops, -2..2 (gain 2^exposure on the encoded values)
  contrast: number; // 0..2, 1 = unchanged (around mid grey)
  saturation: number; // 0..2, 1 = unchanged, 0 = black and white
  temperature: number; // -1 (cooler/bluer) .. 1 (warmer/more orange)
}

export const NEUTRAL: ColorAdjust = { exposure: 0, contrast: 1, saturation: 1, temperature: 0 };
export const COLOR_LIMITS: Record<keyof ColorAdjust, [number, number]> = {
  exposure: [-2, 2],
  contrast: [0, 2],
  saturation: [0, 2],
  temperature: [-1, 1],
};

/** Rec.709 luma weights (the export's output matrix), used to keep brightness when desaturating. */
const LUMA = [0.2126, 0.7152, 0.0722];

export function legalColor(c: Partial<ColorAdjust>): ColorAdjust {
  const out = { ...NEUTRAL };
  for (const k of Object.keys(COLOR_LIMITS) as (keyof ColorAdjust)[]) {
    const v = c[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.round(Math.min(COLOR_LIMITS[k][1], Math.max(COLOR_LIMITS[k][0], v)) * 100) / 100;
  }
  return out;
}

export function isNeutral(c: ColorAdjust | undefined): boolean {
  return !c || (c.exposure === 0 && c.contrast === 1 && c.saturation === 1 && c.temperature === 0);
}

export function clipColor(c: ClipItem): ColorAdjust | undefined {
  return isNeutral(c.color) ? undefined : c.color;
}

/** The combined transform: rows of M (3×3) and the offset o, for values in 0..1. */
export function colorTransform(c: ColorAdjust): { m: number[][]; o: number[] } {
  const gain = Math.pow(2, c.exposure);
  // Temperature: warm raises red and lowers blue (a simple white-balance gain).
  const temp = [1 + 0.12 * c.temperature, 1, 1 - 0.12 * c.temperature];
  // Saturation: mix each channel with luma.
  const s = c.saturation;
  const sat = [0, 1, 2].map((r) => [0, 1, 2].map((col) => (1 - s) * LUMA[col] + (r === col ? s : 0)));
  // M = contrast · Sat · diag(temp) · gain;  o = 0.5 · (1 - contrast)
  const m = sat.map((row) => row.map((v, col) => c.contrast * v * temp[col] * gain));
  const off = 0.5 * (1 - c.contrast);
  return { m, o: [off, off, off] };
}

/** Apply to one RGB colour (0..255), as both preview and export do (for tests). */
export function applyColor(c: ColorAdjust, rgb: number[]): number[] {
  const { m, o } = colorTransform(c);
  return m.map((row, i) => Math.min(255, Math.max(0, (row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2]) / 255 + o[i]) * 255));
}

/** SVG feColorMatrix "values" (4×5, offsets in 0..1). */
export function svgMatrix(c: ColorAdjust): string {
  const { m, o } = colorTransform(c);
  const r = (v: number) => String(Math.round(v * 1e5) / 1e5);
  return [...m.map((row, i) => [...row.map(r), '0', r(o[i])].join(' ')), '0 0 0 1 0'].join(' ');
}

/** FFmpeg colorchannelmixer options for RGBA input with opaque alpha (ra/ga/ba carry the offset). */
export function ffmpegMixer(c: ColorAdjust): string {
  const { m, o } = colorTransform(c);
  const ch = ['r', 'g', 'b'];
  const f = (v: number) => (Math.round(v * 1e6) / 1e6).toString();
  return ch.flatMap((out, i) => [...ch.map((inp, j) => `${out}${inp}=${f(m[i][j])}`), `${out}a=${f(o[i])}`]).join(':');
}
