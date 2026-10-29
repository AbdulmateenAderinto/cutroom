#!/usr/bin/env node
/**
 * Test stand-in for whisper.cpp's `whisper-cli` (real models cannot be downloaded in CI).
 * It checks the arguments Cutroom passes, validates the model header and the WAV format,
 * prints progress like whisper.cpp, and writes whisper.cpp's JSON output format (-oj) with
 * word-level segments (-ml 1 -sow), taking the words from $FAKE_WHISPER_WORDS:
 *   [{ "text": " Hello", "from": 0, "to": 320 }, ...]   (milliseconds; leading space = new word)
 */
import { openSync, readFileSync, readSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const get = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const fail = (msg) => {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(2);
};
const model = get('-m');
const wav = get('-f');
const prefix = get('-of');
if (!model || !wav || !prefix) fail('missing -m, -f or -of');
if (!args.includes('-oj') || get('-ml') !== '1' || !args.includes('-sow')) fail('expected -oj -ml 1 -sow');
const head = Buffer.alloc(4);
readSync(openSync(model, 'r'), head, 0, 4, 0);
if (head.toString('latin1') !== 'lmgg') fail('failed to load model (bad magic)');
const w = readFileSync(wav);
if (w.toString('latin1', 0, 4) !== 'RIFF' || w.readUInt16LE(22) !== 1 || w.readUInt32LE(24) !== 16000 || w.readUInt16LE(34) !== 16) {
  fail('input must be 16 kHz mono 16-bit WAV');
}
const words = JSON.parse(readFileSync(process.env.FAKE_WHISPER_WORDS, 'utf8'));
for (const p of [0, 25, 50, 75, 100]) process.stderr.write(`whisper_print_progress_callback: progress = ${p}%\n`);
const ts = (ms) => {
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor(ms / 60000) % 60).padStart(2, '0');
  const s = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
  return `${h}:${m}:${s},${String(ms % 1000).padStart(3, '0')}`;
};
const out = {
  systeminfo: 'fake', model: { type: 'base' }, params: { language: get('-l') ?? 'en' }, result: { language: 'en' },
  transcription: [
    { timestamps: { from: ts(0), to: ts(0) }, offsets: { from: 0, to: 0 }, text: ' [BLANK_AUDIO]' },
    ...words.map((x) => ({ timestamps: { from: ts(x.from), to: ts(x.to) }, offsets: { from: x.from, to: x.to }, text: x.text })),
  ],
};
writeFileSync(`${prefix}.json`, JSON.stringify(out));
