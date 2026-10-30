/**
 * UI test for audio tracks in the real app: import MP3 music, add it, see its waveform, drag it,
 * set fades/volume, turn on ducking, play (checks the preview audio graph) and export (measures
 * the music level in the file).
 *
 * Run: npm run test:e2e   (Linux without a display: xvfb-run -a npm run test:e2e)
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { assert, ff, fixture, launch, makeSteps, outputDir } from './harness.mjs';

const out = outputDir('audio');
const userData = path.join(out, 'userdata');
// Video with "speech" (300 Hz) at 0–2 s and 3–5 s; music is a steady 1 kHz tone as MP3.
const talk = fixture('audio-talk.mp4', (f) => ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=6', '-f', 'lavfi',
  '-i', "aevalsrc='0.3*sin(2*PI*300*t)*(lt(t,2)+between(t,3,5))':s=48000:d=6", '-c:v', 'libx264', '-preset', 'veryfast',
  '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f]));
const song = fixture('song 1k.mp3', (f) => ff(['-f', 'lavfi', '-i', "aevalsrc='0.25*sin(2*PI*1000*t)':s=44100:d=12", '-c:a', 'libmp3lame', '-b:a', '192k', f]));

const { step, finish } = makeSteps();
console.log('Cutroom audio tracks UI test');
const h = await launch({ userData });
const { page } = h;
let n = 0;
const snap = (label) => page.screenshot({ path: path.join(out, `${String(++n).padStart(2, '0')}-${label}.png`) });
const clip = async () => (await h.state()).audioTracks?.[0]?.clips?.[0];

await step('import a video and an MP3', async () => {
  await h.stubOpen([talk, song]);
  await page.click('button:has-text("Import…")');
  await page.waitForFunction(() => window.__cutroom.store.get().project.media.length === 2);
  assert(await page.locator('.media-item .audio-thumb').isVisible(), 'audio item not shown as audio');
  assert(await page.locator('text=/Audio · MP3/').isVisible(), 'audio metadata missing');
});

await step('add both: video to the video track, music to an audio track with a waveform', async () => {
  await page.click('.media-item >> nth=0 >> button:has-text("Add to timeline")');
  await h.seekFrame(0);
  await page.click('.media-item >> nth=1 >> button:has-text("Add to timeline")');
  await page.waitForSelector('.aclip');
  const p = await h.state();
  assert(p.sequence.items.length === 1 && p.audioTracks.length === 1 && p.audioTracks[0].name === 'Music', JSON.stringify(p.audioTracks?.map((t) => t.name)));
  await page.waitForFunction(() => {
    const c = document.querySelector('.aclip canvas.waveform');
    if (!c || !c.width) return false;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) lit++;
    return lit > 100;
  }, null, { timeout: 15000 });
  assert(await page.locator('.tl-past-end').isVisible(), 'past-the-end shading missing (song is longer than the video)');
  await snap('audio-track');
});

await step('drag the music clip and its fade-in handle', async () => {
  const box = await page.locator('.aclip').boundingBox();
  await page.mouse.move(box.x + box.width / 3, box.y + box.height - 8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 3 + 40, box.y + box.height - 8, { steps: 5 });
  await page.mouse.up();
  const moved = await clip();
  assert(moved.start > 0, `start ${moved.start}`);
  await page.click('.aclip');
  const handle = await page.locator('.aclip .fade-handle.in').boundingBox();
  await page.mouse.move(handle.x + 5, handle.y + 5);
  await page.mouse.down();
  await page.mouse.move(handle.x + 45, handle.y + 5, { steps: 5 });
  await page.mouse.up();
  assert((await clip()).fadeIn > 0, 'fade-in not set');
  await page.click('button:has-text("Undo")');
  await page.click('button:has-text("Undo")');
  const back = await clip();
  assert(back.start === 0 && back.fadeIn === 0, `undo: ${JSON.stringify(back)}`);
});

await step('clip panel: volume 150 % and a 1 s fade-out', async () => {
  await page.click('.aclip');
  await page.waitForSelector('text=Audio clip');
  await page.locator('input[aria-label="Clip volume"]').evaluate((el) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, '150');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const fo = page.locator('.inspector label:has-text("Fade out") input');
  await fo.fill('1');
  await fo.press('Enter');
  const c = await clip();
  assert(Math.abs(c.volume - 1.5) < 1e-9 && c.fadeOut === 705_600_000, JSON.stringify(c));
});

await step('turn on "Lower under speech" (analyses the video locally)', async () => {
  await page.click('input[aria-label="Lower under speech"]');
  await page.waitForFunction(() => window.__cutroom.store.get().project.audioTracks[0].duck === true, null, { timeout: 20000 });
  const p = await h.state();
  assert(p.media[0].speech?.length === 2, `speech ranges: ${JSON.stringify(p.media[0].speech)}`);
  await snap('ducking');
});

await step('preview plays the music in sync, ducked under speech', async () => {
  await h.seekFrame(15); // 0.5 s: speech
  await page.keyboard.press('Escape');
  await page.click('button:has-text("▶ Play")');
  await page.waitForTimeout(1000);
  const dbg = await page.evaluate(() => ({ a: window.__cutroom.audioDebug(), t: window.__cutroom.playhead.get().time / 705_600_000 }));
  await page.click('button:has-text("Pause")');
  const m = dbg.a.music[0];
  assert(m && m.playing, `music not playing: ${JSON.stringify(dbg.a)}`);
  assert(Math.abs(m.time - dbg.t) < 0.15, `music at ${m.time}s, timeline ${dbg.t}s`);
  assert(Math.abs(m.gain - 1.5) < 0.01, `clip gain ${m.gain}`);
  const tg = dbg.a.tracks[0].gain;
  assert(tg < 0.3, `track gain during speech should be ducked (-14 dB ≈ 0.2), got ${tg}`);
});

await step('export: music is boosted and ducked under speech', async () => {
  const file = path.join(out, 'with-music.mp4');
  await h.exportTo(file, { fps: 30 });
  const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { maxBuffer: 1 << 26 });
  const pcm = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  const amp = (t0, t1) => {
    const a = Math.floor(t0 * 48000), b = Math.floor(t1 * 48000);
    const coeff = 2 * Math.cos((2 * Math.PI * 1000) / 48000);
    let s1 = 0, s2 = 0;
    for (let i = a; i < b; i++) { const s0 = pcm[i] + coeff * s1 - s2; s2 = s1; s1 = s0; }
    return (2 * Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2)) / (b - a);
  };
  const full = 0.25 * 1.5;
  const ducked = full * Math.pow(10, -14 / 20);
  const a1 = amp(0.9, 1.1); // speech → ducked
  const a2 = amp(2.6, 2.75); // pause → full
  console.log(`      music level: during speech ${a1.toFixed(3)} (expect ≈ ${ducked.toFixed(3)}), in the pause ${a2.toFixed(3)} (expect ≈ ${full.toFixed(3)})`);
  assert(Math.abs(a1 - ducked) < 0.02, 'not ducked during speech');
  assert(Math.abs(a2 - full) < 0.03, 'not at full level in the pause');
});

await h.close();
process.exit(finish());
