/**
 * Transcription pipeline (with the whisper.cpp stand-in) and caption export.
 * Real speech recognition quality is NOT tested here (no model can be downloaded in CI);
 * everything around it is: audio extraction, CLI arguments, output parsing, caption timing
 * through edits, filler removal and burning captions into the export.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runExport } from '../../src/main/export/exportRunner';
import { transcribeFile } from '../../src/main/transcribe/whisper';
import { buildCues, fillerRanges } from '../../src/shared/captions';
import type { CaptionTrack } from '../../src/shared/exportPlan';
import { type MediaRef, createProject } from '../../src/shared/model';
import { addClip, addMedia, moveItem, removeSourceRanges, setCaptions, setTranscript, splitAt, trimEdge } from '../../src/shared/ops';
import { TICKS_PER_SECOND as S, secondsToTicks } from '../../src/shared/time';
import { FIXTURE_DIR, OUTPUT_DIR, ensureDirs, mediaRefFor } from '../helpers/fixtures';

const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const FAKE = path.resolve(__dirname, '../helpers/fake-whisper.mjs');
let SPEECH: MediaRef;
const MODEL = path.join(FIXTURE_DIR, 'ggml-fake.bin');
const WORDS = path.join(FIXTURE_DIR, 'fake-words.json');
const SPOKEN = [
  { text: ' Hello', from: 300, to: 700 }, { text: ' there', from: 700, to: 1000 }, { text: '.', from: 1000, to: 1050 },
  { text: ' Um', from: 1400, to: 1800 }, { text: ',', from: 1800, to: 1820 }, { text: ' this', from: 2000, to: 2200 },
  { text: ' is', from: 2200, to: 2350 }, { text: ' a', from: 2350, to: 2450 }, { text: ' test', from: 2450, to: 2800 },
  { text: ' of', from: 2800, to: 2950 }, { text: ' captions', from: 2950, to: 3500 }, { text: '.', from: 3500, to: 3550 },
];

beforeAll(async () => {
  ensureDirs();
  const f = path.join(FIXTURE_DIR, 'speech.mp4');
  if (!existsSync(f)) {
    // Real speech where FFmpeg has flite (Homebrew's build does not); whisper is faked below, so a
    // tone with pauses at the spoken gaps serves as well.
    const hasFlite = /\sflite\s/.test(execFileSync('ffmpeg', ['-hide_banner', '-filters']).toString());
    const voice = hasFlite
      ? "flite=text='Hello there. Um, this is a test of captions.':voice=slt"
      : "aevalsrc='0.4*sin(2*PI*220*t)*(between(t,0.3,1.05)+between(t,1.4,1.82)+between(t,2,3.55))':s=48000:d=4";
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=4', '-f', 'lavfi', '-i', voice,
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-t', '4', f]);
  }
  writeFileSync(MODEL, Buffer.concat([Buffer.from('lmgg', 'latin1'), Buffer.alloc(2_000_000)]));
  writeFileSync(WORDS, JSON.stringify(SPOKEN));
  process.env.CUTROOM_WHISPER = FAKE;
  process.env.FAKE_WHISPER_WORDS = WORDS;
  SPEECH = await mediaRefFor(f);
});

describe('transcription pipeline', () => {
  it('extracts audio, calls whisper.cpp correctly and parses word timings', async () => {
    const progress: number[] = [];
    const t = await transcribeFile(SPEECH.path, { model: MODEL, language: 'en', modelName: 'fake' }, (f) => progress.push(f));
    expect(t.words.map((w) => w.text)).toEqual(['Hello', 'there.', 'Um,', 'this', 'is', 'a', 'test', 'of', 'captions.']);
    expect(t.words[0].start).toBe(secondsToTicks(0.3));
    expect(t.words[1].end).toBe(secondsToTicks(1.05)); // punctuation merged into the word
    expect(progress[progress.length - 1]).toBe(1);
    expect(progress.some((p) => p > 0.3 && p < 0.9)).toBe(true);
  });

  it('reports a readable error for a bad model file', async () => {
    const bad = path.join(FIXTURE_DIR, 'not-a-model.bin');
    writeFileSync(bad, Buffer.alloc(2_000_000));
    await expect(transcribeFile(SPEECH.path, { model: bad, language: 'en', modelName: 'x' }, () => {})).rejects.toThrow(/No speech model/);
  });
});

describe('captions follow edits', () => {
  async function project() {
    const t = await transcribeFile(SPEECH.path, { model: MODEL, language: 'en', modelName: 'fake' }, () => {});
    let p = addMedia({ ...createProject(), canvas: { width: 640, height: 360, preset: 'custom' } }, [SPEECH]);
    p = setTranscript(p, SPEECH.id, t);
    p = setCaptions(p, (c) => ({ ...c, enabled: true }));
    return addClip(p, SPEECH.id)!.project;
  }

  it('groups words into cues at sentence ends, frame-aligned', async () => {
    const p = await project();
    const cues = buildCues(p);
    expect(cues.map((c) => c.words.map((w) => w.text).join(' '))).toEqual(['Hello there.', 'Um, this is a test of captions.']);
    for (const c of cues) expect((c.start * 30) % S).toBe(0);
  });

  it('trim, split and reorder move captions with their words', async () => {
    let p = await project();
    const id = p.sequence.items[0].id;
    p = trimEdge(p, id, 'start', secondsToTicks(1.2)); // drop "Hello there."
    let cues = buildCues(p);
    expect(cues[0].words[0].text).toBe('Um,');
    expect(cues[0].words[0].start).toBe(secondsToTicks(0.2)); // 1.4 s source − 1.2 s trim
    p = splitAt(p, secondsToTicks(0.75))!.project; // split just before "this" (source 2.0 s)
    const right = p.sequence.items[1] as any;
    p = moveItem(p, right.id, 0); // second half first
    cues = buildCues(p);
    expect(cues[0].words[0].text).toBe('this');
    expect(cues[0].words[0].start).toBe(secondsToTicks(2.0) - right.sourceIn);
  });

  it('filler removal cuts exactly the filler words', async () => {
    const p = await project();
    const ranges = fillerRanges(p.media[0].transcript!.words);
    expect(ranges).toEqual([{ start: secondsToTicks(1.4), end: secondsToTicks(1.82) }]);
    const r = removeSourceRanges(p, p.sequence.items[0].id, ranges);
    expect(r.parts).toBe(2);
    expect(buildCues(r.project).flatMap((c) => c.words.map((w) => w.text))).not.toContain('Um,');
  });
});

describe('caption export', () => {
  function png(file: string, box: string | null, x = 0, y = 0) {
    const inputs = ['-f', 'lavfi', '-i', 'color=c=black@0.0:s=640x360,format=rgba'];
    const graph = box ? `[0]format=rgba[bg];color=c=${box}:s=200x50,format=rgba[b];[bg][b]overlay=${x}:${y}` : '[0]format=rgba';
    ff([...inputs, '-filter_complex', graph, '-frames:v', '1', file]);
    return readFileSync(file).toString('base64');
  }

  it('shows each caption image exactly during its span, at its position, in true colour', async () => {
    let p = addMedia({ ...createProject(), canvas: { width: 640, height: 360, preset: 'custom' }, background: '#000000' }, [SPEECH]);
    p = setCaptions(addClip(p, SPEECH.id)!.project, (c) => ({ ...c, enabled: true }));
    const track: CaptionTrack = {
      width: 640, height: 360,
      blank: png(path.join(OUTPUT_DIR, 'cap-blank.png'), null),
      segments: [
        { start: 0.5, end: 1.5, png: png(path.join(OUTPUT_DIR, 'cap-a.png'), 'white', 100, 250) },
        { start: 2.0, end: 3.0, png: png(path.join(OUTPUT_DIR, 'cap-b.png'), '0xffd23f', 300, 40) },
      ],
    };
    const out = path.join(OUTPUT_DIR, 'captions.mp4');
    const r = await runExport(p, { outputPath: out, width: 640, height: 360, frameRate: { num: 30, den: 1 }, canvasMapping: 'fit', videoBitrateMbps: 6, x264Preset: 'veryfast', audioBitrateKbps: 128 }, { captions: track });
    expect(r.status, JSON.stringify(r).slice(0, 500)).toBe('done');
    const rgbAt = (frame: number, x: number, y: number) => [...execFileSync('ffmpeg', ['-loglevel', 'error', '-i', out, '-vf',
      `select=eq(n\\,${frame}),scale=in_color_matrix=bt709:in_range=tv,format=rgb24,crop=1:1:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-'])];
    const isWhite = (c: number[]) => c.every((v) => v > 235);
    expect(isWhite(rgbAt(30, 200, 275))).toBe(true); // 1.0 s: caption A
    expect(isWhite(rgbAt(10, 200, 275))).toBe(false); // 0.33 s: before A
    expect(isWhite(rgbAt(15, 200, 275))).toBe(true); // 0.5 s: A starts exactly on this frame
    expect(isWhite(rgbAt(14, 200, 275))).toBe(false);
    expect(isWhite(rgbAt(45, 200, 275))).toBe(false); // 1.5 s: A has ended
    const yellow = rgbAt(75, 400, 65); // 2.5 s: caption B
    expect(Math.abs(yellow[0] - 0xff) + Math.abs(yellow[1] - 0xd2) + Math.abs(yellow[2] - 0x3f)).toBeLessThan(18);
  });
});
