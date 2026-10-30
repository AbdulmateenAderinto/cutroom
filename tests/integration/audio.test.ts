/**
 * Audio tracks in export: placement (sample-accurate), volume (incl. > 100%), fades and ducking,
 * measured on the exported audio with a Goertzel filter at the music's frequency.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { detectSilence } from '../../src/main/analysis/analyze';
import { runExport } from '../../src/main/export/exportRunner';
import { addAudioClip, duckGainAt, setAudioClip, setAudioTrack, setSpeech, soundFromSilence, speechIntervals } from '../../src/shared/audio';
import { type MediaRef, type Project, createProject } from '../../src/shared/model';
import { addClip, addMedia } from '../../src/shared/ops';
import { TICKS_PER_SECOND as S, secondsToTicks } from '../../src/shared/time';
import { FIXTURE_DIR, OUTPUT_DIR, ensureDirs, mediaRefFor, readAudio } from '../helpers/fixtures';

const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
let QUIET: MediaRef; // video with silent audio
let TALK: MediaRef; // video with "speech" (300 Hz) at 0–2 s, 3–5 s
let MUSIC: MediaRef; // 1 kHz tone, amplitude 0.25, lossless

beforeAll(async () => {
  ensureDirs();
  const quiet = path.join(FIXTURE_DIR, 'quiet6.mp4');
  if (!existsSync(quiet)) ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=6', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '6', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', quiet]);
  const talk = path.join(FIXTURE_DIR, 'talk6.mp4');
  if (!existsSync(talk)) ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=6', '-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*300*t)*(lt(t,2)+between(t,3,5))':s=48000:d=6", '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', talk]);
  const music = path.join(FIXTURE_DIR, 'music1k.wav');
  if (!existsSync(music)) ff(['-f', 'lavfi', '-i', "aevalsrc='0.25*sin(2*PI*1000*t)':s=48000:d=10", '-c:a', 'pcm_s16le', music]);
  QUIET = await mediaRefFor(quiet);
  TALK = await mediaRefFor(talk);
  MUSIC = await mediaRefFor(music);
});

/** Amplitude of a pure tone at `freq` in [t0, t1) via the Goertzel algorithm. */
function toneAmp(pcm: Float32Array, freq: number, t0: number, t1: number, sr = 48000) {
  const a = Math.floor(t0 * sr);
  const b = Math.floor(t1 * sr);
  const k = (2 * Math.PI * freq) / sr;
  const coeff = 2 * Math.cos(k);
  let s1 = 0;
  let s2 = 0;
  for (let i = a; i < b; i++) {
    const s0 = pcm[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return (2 * Math.sqrt(power)) / (b - a);
}

async function exportProject(p: Project, name: string) {
  const out = path.join(OUTPUT_DIR, name);
  const r = await runExport(p, { outputPath: out, width: 320, height: 180, frameRate: { num: 30, den: 1 }, canvasMapping: 'fit', videoBitrateMbps: 2, x264Preset: 'veryfast', audioBitrateKbps: 256 });
  expect(r.status, JSON.stringify(r).slice(0, 800)).toBe('done');
  return readAudio(out); // mono mix of the stereo output (identical channels → same amplitude)
}

function base(video: MediaRef): Project {
  let p = addMedia({ ...createProject(), canvas: { width: 320, height: 180, preset: 'custom' } }, [video, MUSIC]);
  return addClip(p, video.id)!.project;
}

describe('audio tracks in export', () => {
  it('places music sample-accurately with volume and linear fades', async () => {
    let p = base(QUIET);
    const r = addAudioClip(p, MUSIC.id, 1 * S)!;
    p = r.project;
    // Use 0.5 s … 3.5 s of the music, at 50 %, fade in 0.5 s, fade out 1 s.
    p = { ...p, audioTracks: p.audioTracks!.map((t) => ({ ...t, clips: t.clips.map((c) => ({ ...c, sourceIn: S / 2, sourceOut: 3.5 * S })) })) };
    p = setAudioClip(p, r.clipId, { volume: 0.5, fadeIn: S / 2, fadeOut: S });
    const pcm = await exportProject(p, 'music-fades.mp4');
    const A = 0.25 * 0.5;
    const amp = (t0: number, t1: number) => toneAmp(pcm, 1000, t0, t1);
    expect(amp(0.2, 0.9)).toBeLessThan(0.002); // before the clip
    expect(amp(1.24, 1.26)).toBeGreaterThan(A * 0.4); // mid fade-in ≈ 50 %
    expect(amp(1.24, 1.26)).toBeLessThan(A * 0.6);
    expect(amp(1.8, 2.8)).toBeCloseTo(A, 2); // full level
    expect(amp(3.49, 3.51) / A).toBeCloseTo(0.5, 1); // mid fade-out
    expect(amp(4.2, 5.5)).toBeLessThan(0.002); // after the clip
    // Onset: the first clearly non-silent sample is at 1.000 s (±1 ms; fade-in starts at 0).
    let first = -1;
    for (let i = 0; i < pcm.length; i++) if (Math.abs(pcm[i]) > 0.002) { first = i; break; }
    expect(Math.abs(first / 48000 - 1.0)).toBeLessThan(0.02);
  });

  it('volume above 100 % boosts (not clipped at this level)', async () => {
    let p = base(QUIET);
    const r = addAudioClip(p, MUSIC.id, 0)!;
    p = setAudioClip(r.project, r.clipId, { volume: 1.6 });
    const pcm = await exportProject(p, 'music-boost.mp4');
    expect(toneAmp(pcm, 1000, 1, 3) / 0.25).toBeCloseTo(1.6, 1);
  });

  it('ducks the music under speech, following the shared envelope', async () => {
    let p = base(TALK);
    const silence = await detectSilence(TALK.path, 6, { minDuration: 0.3 });
    p = setSpeech(p, TALK.id, soundFromSilence(silence.map((x) => ({ start: secondsToTicks(x.start), end: secondsToTicks(x.end) })), TALK.info.duration));
    const r = addAudioClip(p, MUSIC.id, 0)!;
    p = setAudioTrack(r.project, r.trackId, { duck: true, duckDb: -14 });
    const pcm = await exportProject(p, 'music-duck.mp4');
    const intervals = speechIntervals(p);
    const expected = (t: number) => 0.25 * duckGainAt(intervals, secondsToTicks(t), -14);
    for (const t of [1.0, 2.62, 4.0, 5.7]) {
      const got = toneAmp(pcm, 1000, t - 0.05, t + 0.05);
      expect(Math.abs(got - expected(t)) / 0.25, `at ${t}s: got ${got.toFixed(4)}, expected ${expected(t).toFixed(4)}`).toBeLessThan(0.04);
    }
    expect(expected(1.0)).toBeCloseTo(0.25 * Math.pow(10, -14 / 20), 3); // ducked during speech
    expect(expected(2.62)).toBeCloseTo(0.25, 3); // back up in the 1 s pause
    // Speech itself is untouched by the music track's ducking.
    expect(toneAmp(pcm, 300, 0.5, 1.5)).toBeGreaterThan(0.25);
  });
});
