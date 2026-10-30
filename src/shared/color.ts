/**
 * Per-clip colour: exposure, contrast, saturation, temperature, hue, lightness, then curves.
 *
 * The sliders combine into one affine transform of gamma-encoded RGB (0..1): out = M·in + o,
 * clamped. The preview applies it with an SVG feColorMatrix (color-interpolation-filters="sRGB",
 * so it works on the same gamma-encoded values) and the export with FFmpeg's colorchannelmixer on
 * RGBA (the alpha column carries the offset). Both use colorTransform() below.
 *
 * Curves come after the matrix: a master curve and one per channel, smoothed with a monotone cubic
 * (no overshoot) into one 256-entry table per channel (curveTables). The preview uses the tables in
 * an SVG feComponentTransfer, the export gives FFmpeg's curves filter all 256 points, so neither
 * side interpolates differently.
 */
import type { ClipItem } from './model';

export type CurvePoint = [number, number]; // x, y in 0..1
export interface ColorCurves {
  master?: CurvePoint[];
  r?: CurvePoint[];
  g?: CurvePoint[];
  b?: CurvePoint[];
}
export const CURVE_CHANNELS: (keyof ColorCurves)[] = ['master', 'r', 'g', 'b'];

export interface ColorAdjust {
  exposure: number; // stops, -2..2 (gain 2^exposure on the encoded values)
  contrast: number; // 0..2, 1 = unchanged (around mid grey)
  saturation: number; // 0..2, 1 = unchanged, 0 = black and white
  temperature: number; // -1 (cooler/bluer) .. 1 (warmer/more orange)
  hue: number; // degrees, -180..180 (rotates every colour around the colour wheel)
  lightness: number; // -0.5..0.5, added to every channel (lifts or lowers the whole picture)
  curves?: ColorCurves;
}

export const NEUTRAL: ColorAdjust = { exposure: 0, contrast: 1, saturation: 1, temperature: 0, hue: 0, lightness: 0 };
export type Slider = Exclude<keyof ColorAdjust, 'curves'>;
export const COLOR_LIMITS: Record<Slider, [number, number]> = {
  exposure: [-2, 2],
  contrast: [0, 2],
  saturation: [0, 2],
  temperature: [-1, 1],
  hue: [-180, 180],
  lightness: [-0.5, 0.5],
};
const SLIDERS = Object.keys(COLOR_LIMITS) as Slider[];

/** Curve points: inside 0..1, sorted, one per x, at most 16; null when it is the straight line. */
export function legalCurve(pts: CurvePoint[] | undefined): CurvePoint[] | null {
  if (!Array.isArray(pts)) return null;
  const clean = pts
    .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map(([x, y]) => [Math.round(Math.min(1, Math.max(0, x)) * 1000) / 1000, Math.round(Math.min(1, Math.max(0, y)) * 1000) / 1000] as CurvePoint)
    .sort((a, b) => a[0] - b[0])
    .filter((p, i, a) => i === 0 || p[0] !== a[i - 1][0])
    .slice(0, 16);
  if (!clean.length || clean.every(([x, y]) => x === y)) return null;
  return clean;
}

/** Rec.709 luma weights (the export's output matrix), used to keep brightness when desaturating. */
const LUMA = [0.2126, 0.7152, 0.0722];

export function legalColor(c: Partial<ColorAdjust>): ColorAdjust {
  const out: ColorAdjust = { ...NEUTRAL };
  for (const k of SLIDERS) {
    const v = c[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.round(Math.min(COLOR_LIMITS[k][1], Math.max(COLOR_LIMITS[k][0], v)) * 100) / 100;
  }
  const curves: ColorCurves = {};
  for (const ch of CURVE_CHANNELS) {
    const pts = legalCurve(c.curves?.[ch]);
    if (pts) curves[ch] = pts;
  }
  if (Object.keys(curves).length) out.curves = curves;
  return out;
}

const sliders = (c: Partial<ColorAdjust>): ColorAdjust => ({ ...NEUTRAL, ...c }); // older projects lack hue/lightness

export function isNeutral(c: ColorAdjust | undefined): boolean {
  if (!c) return true;
  const s = sliders(c);
  return SLIDERS.every((k) => s[k] === NEUTRAL[k]) && !hasCurves(c);
}

export function hasCurves(c: ColorAdjust | undefined): boolean {
  return !!c?.curves && CURVE_CHANNELS.some((ch) => (c.curves?.[ch]?.length ?? 0) > 0);
}

export function clipColor(c: ClipItem): ColorAdjust | undefined {
  return isNeutral(c.color) ? undefined : c.color;
}

/** The combined transform: rows of M (3×3) and the offset o, for values in 0..1. */
export function colorTransform(c0: ColorAdjust): { m: number[][]; o: number[] } {
  const c = sliders(c0);
  const gain = Math.pow(2, c.exposure);
  // Temperature: warm raises red and lowers blue (a simple white-balance gain).
  const temp = [1 + 0.12 * c.temperature, 1, 1 - 0.12 * c.temperature];
  // Saturation: mix each channel with luma.
  const s = c.saturation;
  const sat = [0, 1, 2].map((r) => [0, 1, 2].map((col) => (1 - s) * LUMA[col] + (r === col ? s : 0)));
  // Hue: the SVG / CSS hue-rotate matrix (keeps luma, turns colours around the wheel).
  const a = (c.hue * Math.PI) / 180;
  const cs = Math.cos(a);
  const sn = Math.sin(a);
  const hue = [
    [0.213 + cs * 0.787 - sn * 0.213, 0.715 - cs * 0.715 - sn * 0.715, 0.072 - cs * 0.072 + sn * 0.928],
    [0.213 - cs * 0.213 + sn * 0.143, 0.715 + cs * 0.285 + sn * 0.14, 0.072 - cs * 0.072 - sn * 0.283],
    [0.213 - cs * 0.213 - sn * 0.787, 0.715 - cs * 0.715 + sn * 0.715, 0.072 + cs * 0.928 + sn * 0.072],
  ];
  const mul = (x: number[][], y: number[][]) => x.map((row) => [0, 1, 2].map((j) => row[0] * y[0][j] + row[1] * y[1][j] + row[2] * y[2][j]));
  // M = contrast · Sat · Hue · diag(temp) · gain;  o = 0.5 · (1 − contrast) + lightness
  const sh = mul(sat, hue);
  const m = sh.map((row) => row.map((v, col) => c.contrast * v * temp[col] * gain));
  const off = 0.5 * (1 - c.contrast) + c.lightness;
  return { m, o: [off, off, off] };
}

/** Monotone cubic (Fritsch–Carlson) through the points, with (0,0)/(1,1) added if no point is at an end. */
function curveFn(pts: CurvePoint[]): (x: number) => number {
  const p = [...pts];
  if (p[0][0] > 0) p.unshift([0, 0]);
  if (p[p.length - 1][0] < 1) p.push([1, 1]);
  const n = p.length;
  const d = p.slice(0, -1).map(([x, y], i) => (p[i + 1][1] - y) / (p[i + 1][0] - x));
  const t = p.map((_, i) => (i === 0 ? d[0] : i === n - 1 ? d[n - 2] : d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2));
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const al = t[i] / d[i];
    const be = t[i + 1] / d[i];
    const h = Math.hypot(al, be);
    if (h > 3) {
      t[i] = (3 * al * d[i]) / h;
      t[i + 1] = (3 * be * d[i]) / h;
    }
  }
  return (x) => {
    let i = 0;
    while (i < n - 2 && x > p[i + 1][0]) i++;
    const [x0, y0] = p[i];
    const [x1, y1] = p[i + 1];
    const hh = x1 - x0;
    const s = Math.min(1, Math.max(0, (x - x0) / hh));
    const h00 = 2 * s ** 3 - 3 * s ** 2 + 1;
    const h10 = s ** 3 - 2 * s ** 2 + s;
    const h01 = -2 * s ** 3 + 3 * s ** 2;
    const h11 = s ** 3 - s ** 2;
    return Math.min(1, Math.max(0, h00 * y0 + h10 * hh * t[i] + h01 * y1 + h11 * hh * t[i + 1]));
  };
}

/** One 256-entry table per channel (input i/255 → output 0..1): the channel curve after the master curve. */
export function curveTables(c: ColorAdjust): { r: number[]; g: number[]; b: number[] } | null {
  if (!hasCurves(c)) return null;
  const master = c.curves!.master?.length ? curveFn(c.curves!.master) : (x: number) => x;
  const table = (ch: 'r' | 'g' | 'b') => {
    const f = c.curves![ch]?.length ? curveFn(c.curves![ch]!) : (x: number) => x;
    return Array.from({ length: 256 }, (_, i) => Math.round(f(master(i / 255)) * 255) / 255);
  };
  return { r: table('r'), g: table('g'), b: table('b') };
}

/** SVG feFuncR/G/B "tableValues". */
export function svgCurveTables(c: ColorAdjust): { r: string; g: string; b: string } | null {
  const t = curveTables(c);
  if (!t) return null;
  const s = (v: number[]) => v.map((x) => String(Math.round(x * 1e5) / 1e5)).join(' ');
  return { r: s(t.r), g: s(t.g), b: s(t.b) };
}

/** FFmpeg curves filter with every one of the 256 table points (no interpolation of its own). */
export function ffmpegCurves(c: ColorAdjust): string | null {
  const t = curveTables(c);
  if (!t) return null;
  // FFmpeg needs int(x·255) to rise at every point, so x is rounded up (never just below i/255).
  const pts = (v: number[]) => v.map((y, i) => `${(Math.ceil((i / 255) * 1e6) / 1e6).toFixed(6)}/${y.toFixed(6)}`).join(' ');
  return `curves=r='${pts(t.r)}':g='${pts(t.g)}':b='${pts(t.b)}'`;
}

/** Apply to one RGB colour (0..255), as both preview and export do (for tests). */
export function applyColor(c: ColorAdjust, rgb: number[]): number[] {
  const { m, o } = colorTransform(c);
  const lin = m.map((row, i) => Math.min(255, Math.max(0, (row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2]) / 255 + o[i]) * 255));
  const t = curveTables(c);
  if (!t) return lin;
  // Curves work on the 8-bit result of the matrix (as in the export), interpolated like the preview.
  return lin.map((v, i) => {
    const tab = [t.r, t.g, t.b][i];
    const x = Math.min(255, Math.max(0, v));
    const k = Math.min(254, Math.floor(x));
    return (tab[k] + (tab[k + 1] - tab[k]) * (x - k)) * 255;
  });
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
