/**
 * Picture effects on a clip: blur and a mask (an ellipse or a rectangle with a soft edge).
 *
 * Both are defined on the picture itself (fractions of its width/height), so they move, scale and
 * rotate with it.
 *  - Blur: Gaussian, standard deviation = blur × picture width. Preview: SVG feGaussianBlur
 *    (edgeMode duplicate) on the element; export: FFmpeg gblur on the decoded picture.
 *  - Mask: outside the shape the clip is transparent (main track: the background shows; overlay:
 *    the tracks below). The soft edge is a linear ramp of `feather` (fraction of the shape's size)
 *    inside the shape's border: for an ellipse along its normalized radius d (1 at the border),
 *    alpha = clamp((1 − d) / feather); for a rectangle the horizontal and vertical ramps multiply.
 *    Preview: CSS mask-image gradients with the same ramps; export: the same formula in FFmpeg geq.
 */
export interface ClipMask {
  shape: 'ellipse' | 'rect';
  /** Centre and size, as fractions of the picture (0..1). */
  x: number;
  y: number;
  w: number;
  h: number;
  feather: number; // 0 (hard) .. 0.5
  invert?: boolean; // keep the outside instead
}
export interface ClipEffects {
  blur?: number; // 0..0.05 (σ as a fraction of the picture width)
  mask?: ClipMask;
}

export const MAX_BLUR = 0.05;

export function legalEffects(e: ClipEffects | undefined): ClipEffects | undefined {
  if (!e) return undefined;
  const c = (v: unknown, lo: number, hi: number, def: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);
  const out: ClipEffects = {};
  const blur = Math.round(c(e.blur, 0, MAX_BLUR, 0) * 10000) / 10000;
  if (blur > 0) out.blur = blur;
  if (e.mask && (e.mask.shape === 'ellipse' || e.mask.shape === 'rect')) {
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    out.mask = {
      shape: e.mask.shape,
      x: r3(c(e.mask.x, -0.5, 1.5, 0.5)),
      y: r3(c(e.mask.y, -0.5, 1.5, 0.5)),
      w: r3(c(e.mask.w, 0.01, 2, 0.6)),
      h: r3(c(e.mask.h, 0.01, 2, 0.6)),
      feather: r3(c(e.mask.feather, 0, 0.5, 0.05)),
      // Inverting is offered for ellipses (a rectangle's soft corners can't be inverted with CSS masks).
      ...(e.mask.invert && e.mask.shape === 'ellipse' ? { invert: true } : {}),
    };
  }
  return Object.keys(out).length ? out : undefined;
}

/** Alpha (0..1) of the mask at a point (u, v) of the picture (fractions). */
export function maskAlpha(m: ClipMask, u: number, v: number): number {
  const f = Math.max(1e-6, m.feather);
  let a: number;
  if (m.shape === 'ellipse') {
    const d = Math.hypot((u - m.x) / (m.w / 2), (v - m.y) / (m.h / 2));
    a = m.feather > 0 ? Math.min(1, Math.max(0, (1 - d) / f)) : d <= 1 ? 1 : 0;
  } else {
    const ax = Math.min(1, Math.max(0, (m.w / 2 - Math.abs(u - m.x)) / (m.w / 2) / f));
    const ay = Math.min(1, Math.max(0, (m.h / 2 - Math.abs(v - m.y)) / (m.h / 2) / f));
    a = m.feather > 0 ? ax * ay : Math.abs(u - m.x) <= m.w / 2 && Math.abs(v - m.y) <= m.h / 2 ? 1 : 0;
  }
  return m.invert ? 1 - a : a;
}

/** FFmpeg geq alpha expression (0..255) for a picture of size W×H — maskAlpha() in FFmpeg terms. */
export function ffmpegMaskAlpha(m: ClipMask): string {
  const f = Math.max(1e-6, m.feather);
  const n = (v: number) => (Math.round(v * 1e6) / 1e6).toString();
  // Pixel centres ((X+0.5)/W), as CSS gradients are evaluated.
  const U = `((X+0.5)/W-${n(m.x)})`;
  const V = `((Y+0.5)/H-${n(m.y)})`;
  let a: string;
  if (m.shape === 'ellipse') {
    const d = `hypot(${U}/${n(m.w / 2)},${V}/${n(m.h / 2)})`;
    a = m.feather > 0 ? `clip((1-${d})/${n(f)},0,1)` : `lte(${d},1)`;
  } else {
    const ax = `clip((${n(m.w / 2)}-abs(${U}))/${n(m.w / 2)}/${n(f)},0,1)`;
    const ay = `clip((${n(m.h / 2)}-abs(${V}))/${n(m.h / 2)}/${n(f)},0,1)`;
    a = m.feather > 0 ? `${ax}*${ay}` : `lte(abs(${U}),${n(m.w / 2)})*lte(abs(${V}),${n(m.h / 2)})`;
  }
  return m.invert ? `255*(1-${a})` : `255*${a}`;
}

/** CSS mask-image (+ mask-composite) for the preview element: the same ramps as maskAlpha(). */
export function cssMask(m: ClipMask): { image: string; composite: string } {
  const pct = (v: number) => `${(v * 100).toFixed(3)}%`;
  const inside = m.invert ? 'transparent' : 'black';
  const outside = m.invert ? 'black' : 'transparent';
  const f = Math.min(1, m.feather);
  if (m.shape === 'ellipse') {
    // Radial gradient: its ray length is the ellipse's half-axes, so the stop at 100% is the border.
    return {
      image: `radial-gradient(${pct(m.w / 2)} ${pct(m.h / 2)} at ${pct(m.x)} ${pct(m.y)}, ${inside} ${pct(1 - f)}, ${outside} 100%)`,
      composite: '',
    };
  }
  const x0 = m.x - m.w / 2;
  const x1 = m.x + m.w / 2;
  const y0 = m.y - m.h / 2;
  const y1 = m.y + m.h / 2;
  const fx = (m.w / 2) * f;
  const fy = (m.h / 2) * f;
  const ramp = (dir: string, a0: number, a1: number, ff: number) =>
    `linear-gradient(${dir}, transparent ${pct(a0)}, black ${pct(a0 + ff)}, black ${pct(a1 - ff)}, transparent ${pct(a1)})`;
  return { image: `${ramp('to right', x0, x1, fx)}, ${ramp('to bottom', y0, y1, fy)}`, composite: 'intersect' };
}
