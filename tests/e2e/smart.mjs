/**
 * UI test for Smart tools, speech-to-text and captions, in the real app.
 * The speech engine is the whisper.cpp stand-in (tests/helpers/fake-whisper.mjs): real
 * recognition quality is not tested here, everything around it is.
 *
 * Run: npm run test:e2e   (Linux without a display: xvfb-run -a npm run test:e2e)
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { FAKE_WHISPER, assert, compareFrames, fakeModel, ff, fixture, launch, makeSteps, outputDir } from './harness.mjs';

const out = outputDir('smart');
const userData = path.join(out, 'userdata');
fakeModel(path.join(userData, 'models', 'ggml-base.en.bin'));
const wordsFile = path.join(out, 'words.json');
writeFileSync(wordsFile, JSON.stringify([
  { text: ' Hello', from: 200, to: 600 }, { text: ' everyone', from: 600, to: 1100 }, { text: '.', from: 1100, to: 1150 },
  { text: ' Um', from: 1300, to: 1700 }, { text: ',', from: 1700, to: 1720 }, { text: ' welcome', from: 1750, to: 1950 },
  { text: ' This', from: 3100, to: 3400 }, { text: ' is', from: 3400, to: 3600 }, { text: ' Cutroom', from: 3600, to: 4200 }, { text: '.', from: 4200, to: 4250 },
  { text: ' Thanks', from: 6100, to: 6600 }, { text: ' for', from: 6600, to: 6800 }, { text: ' watching', from: 6800, to: 7500 }, { text: '.', from: 7500, to: 7550 },
]));
// Tone ("speech") 0–2 s, pause 2–3 s, tone 3–5 s, pause 5–6 s, tone 6–8 s.
const talk = fixture('talk 640x360.mp4', (f) => ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=8', '-f', 'lavfi',
  '-i', "aevalsrc='0.5*sin(2*PI*300*t)*(lt(t,2)+between(t,3,5)+gte(t,6))':s=48000:d=8",
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f]));

const { step, finish } = makeSteps();
console.log('Cutroom Smart tools / speech / captions UI test');
const h = await launch({ userData, env: { CUTROOM_WHISPER: FAKE_WHISPER, FAKE_WHISPER_WORDS: wordsFile } });
const { page } = h;
let n = 0;
const snap = (label) => page.screenshot({ path: path.join(out, `${String(++n).padStart(2, '0')}-${label}.png`) });

await step('import and select a clip', async () => {
  await h.stubOpen([talk]);
  await page.click('button:has-text("Import…")');
  await page.waitForFunction(() => window.__cutroom.store.get().project.media.length === 1);
  await page.click('.media-item >> button:has-text("Add to timeline")');
  await page.click('.tl-track .clip >> nth=0');
  await page.waitForSelector('text=Smart tools');
});

await step('Find pauses → review on the timeline → Remove pauses (one undo step)', async () => {
  await page.click('button:has-text("Find pauses")');
  await page.waitForSelector('.review-zone');
  assert((await page.locator('.review-zone').count()) === 2, `review zones: ${await page.locator('.review-zone').count()}`);
  await snap('pauses-review');
  await page.click('button:has-text("Remove pauses")');
  const p = await h.state();
  const dur = p.sequence.items.reduce((s, c) => s + c.sourceOut - c.sourceIn, 0) / 705_600_000;
  assert(p.sequence.items.length === 3 && dur > 5.9 && dur < 6.7, `after removal: ${p.sequence.items.length} clips, ${dur}s`);
  await page.click('button:has-text("Undo")');
  assert((await h.state()).sequence.items.length === 1, 'undo did not restore the clip');
});

await step('Speech setup dialog shows the engine and installed model', async () => {
  await page.click('.tl-track .clip >> nth=0');
  await page.click('button:has-text("Set up…")');
  await page.waitForSelector('text=Speech-to-text setup');
  assert(await page.locator('text=/✓ Found/').isVisible(), 'engine not found');
  assert(await page.locator('.model-row.on >> text=Installed').isVisible(), 'model not shown as installed');
  assert(await page.locator('text=/✓ Ready/').isVisible(), 'not ready');
  await snap('speech-setup');
  await page.click('.modal button:has-text("Done")');
});

await step('Transcribe (local engine) and add captions', async () => {
  await page.click('button:has-text("Transcribe")');
  await page.waitForSelector('text=/✓ Transcript \\(\\d+ words\\)/', { timeout: 30000 });
  const words = (await h.state()).media[0].transcript.words.map((w) => w.text);
  assert(words.join(' ') === 'Hello everyone. Um, welcome This is Cutroom. Thanks for watching.', words.join(' '));
  await page.click('button:has-text("Add captions")');
  assert((await h.state()).captions?.enabled, 'captions not enabled');
  await h.seekFrame(105); // 3.5 s: "This is Cutroom."
  await page.waitForSelector('.caption-layer');
  await snap('captions-preview');
});

await step('edit caption text from the clip panel', async () => {
  await page.click('summary:has-text("Caption text in this clip")');
  const input = page.locator('.cue-row input').nth(1);
  const before = await input.inputValue();
  assert(before.startsWith('Um,'), `second line was "${before}"`);
  await input.fill('Welcome to the show');
  await input.press('Enter');
  const words = (await h.state()).media[0].transcript.words.map((w) => w.text).join(' ');
  assert(words.includes('Welcome to the show') && !words.includes('Um,'), words);
  await page.click('button:has-text("Undo")');
});

await step('Find filler words → Remove filler words', async () => {
  await page.click('.tl-track .clip >> nth=0');
  await page.click('button:has-text("Find filler words")');
  await page.waitForSelector('.review-zone');
  assert((await page.locator('.review-zone').count()) === 1, 'expected one filler word');
  await page.click('button:has-text("Remove filler words")');
  const p = await h.state();
  const desc = p.sequence.items.map((c) => `${(c.sourceIn / 705600000).toFixed(2)}-${(c.sourceOut / 705600000).toFixed(2)}`).join(', ');
  const hist = await page.evaluate(() => window.__cutroom.store.get().past.map((x) => x.sequence.items.length).join(','));
  assert(p.sequence.items.length === 2, `clips after filler removal: ${desc}; history clip counts: ${hist}`);
});

await step('caption style: box look, highlighted words, ALL CAPS', async () => {
  await page.evaluate(() => window.__cutroom.store.set({ selection: null }));
  await page.click('.inspector .segmented button:has-text("Box")');
  await page.check('label:has-text("ALL CAPS") input');
  const c = (await h.state()).captions;
  assert(c.look === 'box' && c.uppercase && c.highlight, JSON.stringify(c));
  await snap('caption-style');
});

await step('captioned preview matches the export (two moments)', async () => {
  const frames = [100, 190]; // in "This is Cutroom." and "Thanks for watching." (after the ~0.4 s filler cut)
  const shots = [];
  for (const f of frames) {
    await h.seekFrame(f);
    await h.previewReady();
    await page.waitForTimeout(300);
    const png = path.join(out, `cap-preview-${f}.png`);
    await page.locator('.stage').screenshot({ path: png });
    shots.push(png);
  }
  const video = path.join(out, 'captions.mp4');
  await h.exportTo(video, { fps: 30 });
  // The test pattern has per-frame random noise, so compare (a) the caption band closely and
  // (b) the whole frame against the same export frame vs. a few frames away.
  // Just around the caption. The preview draws text at the on-screen stage size and the export at
  // the output size, so glyph edges rasterise differently; compare on a coarse 24×8 grid.
  const band = [0.34, 0.72, 0.32, 0.12];
  const grid = [24, 8];
  const at = (f) => ['-ss', (f / 30).toFixed(4), '-i', video];
  const res = frames.map((f, i) => ({
    f,
    caption: compareFrames(['-i', shots[i]], at(f), band, grid),
    captionOther: compareFrames(['-i', shots[i]], at(frames[1 - i]), band, grid),
    whole: compareFrames(['-i', shots[i]], at(f)),
    neighbour: Math.min(compareFrames(['-i', shots[i]], at(f - 4)), compareFrames(['-i', shots[i]], at(f + 4))),
  }));
  console.log(`      captioned preview vs export: ${res.map((r) => `frame ${r.f}: caption band ${r.caption.toFixed(2)} (other line ${r.captionOther.toFixed(2)}), whole ${r.whole.toFixed(2)} (±4 frames ${r.neighbour.toFixed(2)})`).join('; ')}`);
  for (const r of res) {
    // Same layout; the export is sharper (drawn at 1920×1080 vs. the on-screen preview size), so
    // allow some edge difference but require a different caption line to score far worse.
    assert(r.caption < 10 && r.captionOther > r.caption * 2.5, `frame ${r.f}: caption band ${r.caption.toFixed(2)} vs other line ${r.captionOther.toFixed(2)}`);
    assert(r.whole < r.neighbour, `frame ${r.f}: whole frame matches a neighbouring frame better`);
  }
  ff(['-ss', (frames[0] / 30).toFixed(4), '-i', video, '-frames:v', '1', path.join(out, 'cap-export-100.png')]);
});

await h.close();
process.exit(finish());
