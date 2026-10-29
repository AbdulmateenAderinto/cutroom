/**
 * Timebase.
 *
 * All times in the project model are integer "ticks" of 1/705,600,000 s (a "flick").
 * 705,600,000 is divisible by every common frame rate (23.976, 24, 25, 29.97, 30, 48, 50,
 * 59.94, 60, 120 — including the NTSC x/1001 rates) and every common audio sample rate
 * (44.1k, 48k, 96k), so frame and sample boundaries are exact integers. Storing integers
 * means repeated trims/splits never accumulate floating-point error.
 *
 * Frame rates are rationals (e.g. 30000/1001), never floats.
 * Multiplications that could exceed 2^53 go through BigInt.
 */

export type Ticks = number;

export const TICKS_PER_SECOND = 705_600_000;

export interface Rational {
  num: number;
  den: number;
}

export const COMMON_FRAME_RATES: { label: string; rate: Rational }[] = [
  { label: '23.976', rate: { num: 24000, den: 1001 } },
  { label: '24', rate: { num: 24, den: 1 } },
  { label: '25', rate: { num: 25, den: 1 } },
  { label: '29.97', rate: { num: 30000, den: 1001 } },
  { label: '30', rate: { num: 30, den: 1 } },
  { label: '50', rate: { num: 50, den: 1 } },
  { label: '59.94', rate: { num: 60000, den: 1001 } },
  { label: '60', rate: { num: 60, den: 1 } },
];

export function rateToFloat(r: Rational): number {
  return r.num / r.den;
}

export function rateLabel(r: Rational): string {
  const known = COMMON_FRAME_RATES.find((c) => c.rate.num * r.den === r.num * c.rate.den);
  if (known) return known.label;
  return (Math.round(rateToFloat(r) * 1000) / 1000).toString();
}

export function sameRate(a: Rational, b: Rational): boolean {
  return a.num * b.den === b.num * a.den;
}

/** Parse ffprobe-style "30000/1001" (or "25") into a reduced rational. Returns null for 0/0 etc. */
export function parseRational(s: string | undefined | null): Rational | null {
  if (!s) return null;
  const [n, d = '1'] = s.split('/');
  const num = Number(n);
  const den = Number(d);
  if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0) return null;
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
}

function gcd(a: number, b: number): number {
  a = Math.abs(Math.round(a));
  b = Math.abs(Math.round(b));
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

const TPS = BigInt(TICKS_PER_SECOND);

/** Integer division of BigInts with rounding mode. Inputs assumed non-negative denominators. */
function divRound(n: bigint, d: bigint, mode: 'floor' | 'round' | 'ceil'): bigint {
  const neg = n < 0n;
  const a = neg ? -n : n;
  let q = a / d;
  const r = a % d;
  if (mode === 'round') {
    if (r * 2n >= d) q += 1n;
    return neg ? -q : q;
  }
  if (r !== 0n) {
    if (mode === 'ceil' && !neg) q += 1n;
    if (mode === 'floor' && neg) q += 1n;
  }
  return neg ? -q : q;
}

export function secondsToTicks(seconds: number): Ticks {
  return Math.round(seconds * TICKS_PER_SECOND);
}

export function ticksToSeconds(t: Ticks): number {
  return t / TICKS_PER_SECOND;
}

/** Index of the frame (on the grid of `rate` starting at 0) that contains time t. */
export function ticksToFrame(t: Ticks, rate: Rational, mode: 'floor' | 'round' | 'ceil' = 'floor'): number {
  return Number(divRound(BigInt(Math.round(t)) * BigInt(rate.num), TPS * BigInt(rate.den), mode));
}

/** Start time of frame `frame`. Exact for all common rates; rounded to the nearest tick otherwise. */
export function frameToTicks(frame: number, rate: Rational): Ticks {
  return Number(divRound(BigInt(Math.round(frame)) * BigInt(rate.den) * TPS, BigInt(rate.num), 'round'));
}

export function frameDuration(rate: Rational): Ticks {
  return frameToTicks(1, rate);
}

/** Snap a time to the nearest frame boundary of `rate`. */
export function snapToFrame(t: Ticks, rate: Rational, mode: 'floor' | 'round' | 'ceil' = 'round'): Ticks {
  return frameToTicks(ticksToFrame(t, rate, mode), rate);
}

/** Number of audio samples before time t (rounded), at an integer sample rate. */
export function ticksToSamples(t: Ticks, sampleRate: number): number {
  return Number(divRound(BigInt(Math.round(t)) * BigInt(sampleRate), TPS, 'round'));
}

/**
 * Display format: HH:MM:SS:FF where HH:MM:SS is real elapsed time and FF is the frame
 * index within that second. For fractional rates (29.97) this is NOT SMPTE drop-frame
 * timecode — it always agrees with wall-clock seconds, which is easier to read and parse.
 */
export function formatTimecode(t: Ticks, rate: Rational): string {
  const sign = t < 0 ? '-' : '';
  t = Math.abs(t);
  const wholeSeconds = Math.floor(t / TICKS_PER_SECOND);
  const secondStart = wholeSeconds * TICKS_PER_SECOND;
  const ff = ticksToFrame(t, rate, 'floor') - ticksToFrame(secondStart, rate, 'ceil');
  const h = Math.floor(wholeSeconds / 3600);
  const m = Math.floor((wholeSeconds % 3600) / 60);
  const s = wholeSeconds % 60;
  const pad = (n: number) => String(Math.max(0, n)).padStart(2, '0');
  return `${sign}${pad(h)}:${pad(m)}:${pad(s)}:${pad(ff)}`;
}

/** Short human format for durations, e.g. "1:05.2" or "12.0s". */
export function formatDuration(t: Ticks): string {
  const s = t / TICKS_PER_SECOND;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(1).padStart(4, '0')}`;
}

/**
 * Parse user input into ticks, snapped to a frame of `rate`. Accepts:
 *   "HH:MM:SS:FF", "MM:SS:FF", "SS:FF" (same meaning as formatTimecode),
 *   "12.5" or "12.5s" (seconds), "90f" (frames).
 */
export function parseTimecode(input: string, rate: Rational): Ticks | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (/^\d+f$/.test(s)) return frameToTicks(Number(s.slice(0, -1)), rate);
  if (/^\d+(\.\d+)?s?$/.test(s)) return snapToFrame(secondsToTicks(parseFloat(s)), rate);
  const parts = s.split(':');
  if (parts.length < 2 || parts.length > 4 || parts.some((p) => !/^\d+$/.test(p))) return null;
  const nums = parts.map(Number);
  const ff = nums.pop()!;
  let seconds = 0;
  for (const n of nums) seconds = seconds * 60 + n;
  const base = seconds * TICKS_PER_SECOND;
  const frame = ticksToFrame(base, rate, 'ceil') + ff;
  return frameToTicks(frame, rate);
}
