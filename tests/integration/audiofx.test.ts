/**
 * Sound effects in export: the EQ changes each frequency by eqResponseDb() (the response of the
 * coefficients the preview's Web Audio nodes use), on a video clip and an audio-track clip; noise
 * reduction lowers background noise while keeping a tone.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runExport } from '../../src/main/export/exportRunner';
import { noiseFloor } from '../../src/main/media/waveform';
import { addAudioClip, setAudioClipFx } from '../../src/shared/audio';
import { eqResponseDb } from '../../src/shared/audioFx';
import { type MediaRef, type Project, createProject } from '../../src/shared/model';
import { addClip, addMedia, setClipAudio, setClipAudioFx } from '../../src/shared/ops';
import { FIXTURE_DIR, OUTPUT_DIR, ensureDirs, mediaRefFor, readAudio, rms } from '../helpers/fixtures';

const FREQS = [60, 300, 1000, 3000, 10000];
let TONES: MediaRef;
let NOISY: MediaRef;

beforeAll(async () => {
  ensureDirs();
  const f = path.join(FIXTURE_DIR, 'fx-tones.mp4');
  if (!existsSync(f)) {
    const sum = FREQS.map((x) => `0.1*sin(2*PI*${x}*t)`).join('+');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=320x240:r=30:d=3',
      '-f', 'lavfi', '-i', `aevalsrc='${sum}':s=48000:d=3:c=stereo`, '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'pcm_s16le', '-shortest', f.replace('.mp4', '.mov')]);
  }
  TONES = await mediaRefFor(f.replace('.mp4', '.mov'));
  const n = path.join(FIXTURE_DIR, 'fx-noisy.mov');
  if (!existsSync(n)) {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=320x240:r=30:d=4',
      '-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*440*t)*lt(mod(t\\,1)\\,0.5)':s=48000:d=4", '-f', 'lavfi', '-i', 'anoisesrc=c=white:a=0.02:d=4:r=48000',
      '-filter_complex', '[1:a][2:a]amix=inputs=2:normalize=0[a]', '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'pcm_s16le', '-shortest', n]);
  }
  NOISY = await mediaRefFor(n);
});

/** Amplitude of one frequency over [t0, t1) seconds (Goertzel). */
function amp(pcm: Float32Array, freq: number, t0: number, t1: number): number {
  const a = Math.floor(t0 * 48000);
  const b = Math.floor(t1 * 48000);
  const c = 2 * Math.cos((2 * Math.PI * freq) / 48000);
  let s1 = 0;
  let s2 = 0;
  for (let i = a; i < b; i++) {
    const s0 = pcm[i] + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return (2 * Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2)) / (b - a);
}
const exp = async (p: Project, name: string) => {
  const outputPath = path.join(OUTPUT_DIR, name);
  const r = await runExport(p, { outputPath, width: 320, height: 240, frameRate: { num: 30, den: 1 }, canvasMapping: 'fit', videoBitrateMbps: 2, x264Preset: 'veryfast', audioBitrateKbps: 320 });
  expect(r.status, JSON.stringify(r).slice(0, 1200)).toBe('done');
  return readAudio(outputPath);
};
const base = (m: MediaRef) => {
  const p = addMedia({ ...createProject('fx'), canvas: { width: 320, height: 240, preset: 'custom' } }, [m]);
  return addClip(p, m.id)!.project;
};

describe('EQ in export', () => {
  const fx = { low: 9, mid: -6, high: 6 };
  let flat: Float32Array;
  beforeAll(async () => {
    flat = await exp(base(TONES), 'fx-flat.mp4');
  });

  it('on a video clip: each tone changes by the shared response (within 0.7 dB)', async () => {
    let p = base(TONES);
    p = setClipAudioFx(p, p.sequence.items[0].id, fx);
    const eq = await exp(p, 'fx-eq-clip.mp4');
    for (const f of FREQS) {
      const got = 20 * Math.log10(amp(eq, f, 0.5, 2.5) / amp(flat, f, 0.5, 2.5));
      expect(Math.abs(got - eqResponseDb({ ...fx, denoise: 0 }, f)), `${f} Hz: ${got.toFixed(2)} dB vs ${eqResponseDb({ ...fx, denoise: 0 }, f).toFixed(2)}`).toBeLessThan(0.7);
    }
  });

  it('on an audio-track clip too', async () => {
    let p = base(TONES);
    p = setClipAudio(p, p.sequence.items[0].id, { muted: true });
    const r = addAudioClip(p, TONES.id, 0)!;
    p = setAudioClipFx(r.project, r.clipId, fx);
    const eq = await exp(p, 'fx-eq-track.mp4');
    for (const f of FREQS) {
      const got = 20 * Math.log10(amp(eq, f, 0.5, 2.5) / amp(flat, f, 0.5, 2.5));
      expect(Math.abs(got - eqResponseDb({ ...fx, denoise: 0 }, f)), `${f} Hz`).toBeLessThan(0.7);
    }
  });
});

describe('noise reduction in export', () => {
  it('lowers the noise in the gaps by > 10 dB and keeps the tone within 1.5 dB', async () => {
    const plain = await exp(base(NOISY), 'fx-noise-off.mp4');
    let p = base(NOISY);
    const nf = await noiseFloor(NOISY.path);
    expect(nf).not.toBeNull();
    expect(Math.abs(nf! - -38.8)).toBeLessThan(3); // the white noise's level (the tone is on half the time)
    p = setClipAudioFx(p, p.sequence.items[0].id, { denoise: 1, noiseFloor: nf! });
    const clean = await exp(p, 'fx-noise-on.mp4');
    const gapBefore = rms(plain, 2.6, 2.95);
    const gapAfter = rms(clean, 2.6, 2.95);
    expect(20 * Math.log10(gapBefore / gapAfter)).toBeGreaterThan(10);
    const toneBefore = amp(plain, 440, 2.1, 2.4);
    const toneAfter = amp(clean, 440, 2.1, 2.4);
    expect(Math.abs(20 * Math.log10(toneAfter / toneBefore))).toBeLessThan(1.5);
  });
});
