/**
 * Sound effects on a clip (video clips' sound and audio-track clips): a 3-band EQ and noise
 * reduction.
 *
 * EQ: low shelf (120 Hz), mid peak (1 kHz, Q 0.7) and high shelf (6 kHz), ±12 dB. The preview uses
 * Web Audio BiquadFilterNodes; the export uses FFmpeg's biquad filter with the coefficients the Web
 * Audio specification defines for those nodes (eqCoefficients), so both filter identically.
 *
 * Noise reduction: FFmpeg's FFT denoiser (afftdn), in the export only — the browser has nothing
 * equivalent, so the preview plays the original sound. "Listen to the export sound" renders a few
 * seconds through the export to hear it.
 */
export interface AudioFx {
  low: number; // dB, −12..12
  mid: number;
  high: number;
  denoise: number; // 0 (off) .. 1 (strong)
  /** The recording's background level (dBFS), measured when noise reduction is turned on. */
  noiseFloor?: number;
}
export const NO_FX: AudioFx = { low: 0, mid: 0, high: 0, denoise: 0 };
export const EQ_BANDS = [
  { key: 'low' as const, label: 'Low', type: 'lowshelf' as const, freq: 120, q: 0 },
  { key: 'mid' as const, label: 'Mid', type: 'peaking' as const, freq: 1000, q: 0.7 },
  { key: 'high' as const, label: 'High', type: 'highshelf' as const, freq: 6000, q: 0 },
];

export function legalFx(f: Partial<AudioFx> | undefined): AudioFx | undefined {
  if (!f) return undefined;
  const c = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(hi, Math.max(lo, v)) * 10) / 10 : 0);
  const out: AudioFx = { low: c(f.low, -12, 12), mid: c(f.mid, -12, 12), high: c(f.high, -12, 12), denoise: Math.round(c(f.denoise, 0, 1) * 10) / 10 };
  if (out.denoise && typeof f.noiseFloor === 'number' && Number.isFinite(f.noiseFloor)) out.noiseFloor = c(f.noiseFloor, -80, -20);
  return out.low || out.mid || out.high || out.denoise ? out : undefined;
}

/** Biquad coefficients of one EQ band at sample rate sr, as the Web Audio spec computes them. */
export function eqCoefficients(type: 'lowshelf' | 'peaking' | 'highshelf', f0: number, gainDb: number, q: number, sr: number) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f0) / sr;
  const cs = Math.cos(w0);
  const sn = Math.sin(w0);
  if (type === 'peaking') {
    const alpha = sn / (2 * q);
    return { b0: 1 + alpha * A, b1: -2 * cs, b2: 1 - alpha * A, a0: 1 + alpha / A, a1: -2 * cs, a2: 1 - alpha / A };
  }
  // Shelves with slope S = 1 (the Web Audio definition): alpha = sin(w0)/2 · √2.
  const alpha = (sn / 2) * Math.SQRT2;
  const sA = 2 * Math.sqrt(A) * alpha;
  if (type === 'lowshelf') {
    return {
      b0: A * (A + 1 - (A - 1) * cs + sA), b1: 2 * A * (A - 1 - (A + 1) * cs), b2: A * (A + 1 - (A - 1) * cs - sA),
      a0: A + 1 + (A - 1) * cs + sA, a1: -2 * (A - 1 + (A + 1) * cs), a2: A + 1 + (A - 1) * cs - sA,
    };
  }
  return {
    b0: A * (A + 1 + (A - 1) * cs + sA), b1: -2 * A * (A - 1 + (A + 1) * cs), b2: A * (A + 1 + (A - 1) * cs - sA),
    a0: A + 1 - (A - 1) * cs + sA, a1: 2 * (A - 1 - (A + 1) * cs), a2: A + 1 - (A - 1) * cs - sA,
  };
}

/** Gain (dB) of the EQ at frequency f — the product of the three biquads' responses. */
export function eqResponseDb(fx: AudioFx, f: number, sr = 48000): number {
  const w = (2 * Math.PI * f) / sr;
  let db = 0;
  for (const b of EQ_BANDS) {
    const g = fx[b.key];
    if (!g) continue;
    const c = eqCoefficients(b.type, b.freq, g, b.q, sr);
    const mag = (x0: number, x1: number, x2: number) => Math.hypot(x0 + x1 * Math.cos(w) + x2 * Math.cos(2 * w), x1 * Math.sin(w) + x2 * Math.sin(2 * w));
    db += 20 * Math.log10(mag(c.b0, c.b1, c.b2) / mag(c.a0, c.a1, c.a2));
  }
  return db;
}

/** FFmpeg filters for the export (empty when nothing is set), each followed by a comma. */
export function ffmpegAudioFx(fx: AudioFx | undefined, sr: number): string {
  if (!fx) return '';
  const f = (v: number) => (Math.round(v * 1e9) / 1e9).toString();
  let out = '';
  // Noise reduction first (on the original sound), then EQ. afftdn needs the background level
  // (measured per recording, see noiseFloor); without it, it assumes −50 dB.
  if (fx.denoise > 0) out += `afftdn=nr=${Math.round(6 + 34 * fx.denoise)}:nf=${Math.round(fx.noiseFloor ?? -50)},`;
  for (const b of EQ_BANDS) {
    const g = fx[b.key];
    if (!g) continue;
    const c = eqCoefficients(b.type, b.freq, g, b.q, sr);
    out += `biquad=b0=${f(c.b0)}:b1=${f(c.b1)}:b2=${f(c.b2)}:a0=${f(c.a0)}:a1=${f(c.a1)}:a2=${f(c.a2)},`;
  }
  return out;
}
