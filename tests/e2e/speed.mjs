/**
 * UI test for speed changes in the real app: speed buttons and field, the timeline length and
 * label, the preview showing the right source frame and playing at the speed, and preview vs export.
 *
 * Run: npm run test:e2e   (Linux without a display: xvfb-run -a npm run test:e2e)
 */
import path from 'node:path';
import { TPS, assert, compareFrames, ff, fixture, launch, makeSteps, outputDir } from './harness.mjs';

const out = outputDir('speed');
const userData = path.join(out, 'userdata');
const video = fixture('speed-src.mp4', (f) => ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=4', '-f', 'lavfi', '-i', 'sine=d=4',
  '-c:v', 'libx264', '-preset', 'veryfast', '-g', '15', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f]));

const { step, finish } = makeSteps();
console.log('Cutroom speed UI test');
const h = await launch({ userData });
const { page } = h;
const clip = async () => (await h.state()).sequence.items[0];
const videoState = () => page.evaluate(() => {
  const v = [...document.querySelectorAll('video.stage-video')].find((e) => e.style.display === 'block');
  return v && { t: v.currentTime, rate: v.playbackRate };
});

await step('import, add, select the clip', async () => {
  await h.stubOpen([video]);
  await page.click('button:has-text("Import…")');
  await page.waitForFunction(() => window.__cutroom.store.get().project.media.length === 1);
  await page.click('.media-item >> nth=0 >> button:has-text("Add to timeline")');
  await page.click('.tl-track .clip >> nth=0');
  await page.waitForSelector('.inspector h3:has-text("Speed"), .inspector :text("Speed")');
});

await step('2× halves the clip on the timeline and labels it', async () => {
  await page.click('.inspector [aria-label="Speed presets"] button:has-text("2×")');
  const c = await clip();
  assert(c.speed === 2 && c.sourceOut === 4 * TPS, JSON.stringify(c));
  const dur = await page.evaluate(() => window.__cutroom.engine.duration);
  assert(dur === 2 * TPS, `timeline ${dur / TPS}s`);
  assert(await page.locator('.tl-track .clip-name:has-text("2× ·")').isVisible(), 'speed label missing');
});

await step('preview at timeline 1 s shows source 2 s; plays at 2×', async () => {
  await h.seekFrame(30);
  await h.previewReady();
  const v = await videoState();
  assert(Math.abs(v.t - 2.0) < 0.02, `video at ${v.t}s, expected ≈ 2.0`);
  await h.seekFrame(0);
  await page.click('button:has-text("▶ Play")');
  await page.waitForTimeout(600);
  const p = await videoState();
  const tl = await page.evaluate(() => window.__cutroom.playhead.get().time / 705_600_000);
  await page.click('button:has-text("Pause")');
  assert(p.rate === 2, `playbackRate ${p.rate}`);
  assert(Math.abs(p.t - 2 * tl) < 0.15, `source ${p.t}s vs 2 × timeline ${tl}s`);
});

await step('type 0.5 in the Speed field: slow motion, 8 s long; undo returns to 2×', async () => {
  const f = page.locator('.inspector label:has-text("Speed") input');
  await f.fill('0.5');
  await f.press('Enter');
  assert((await clip()).speed === 0.5, 'speed not 0.5');
  assert((await page.evaluate(() => window.__cutroom.engine.duration)) === 8 * TPS, 'timeline not 8 s');
  await page.click('button:has-text("Undo")');
  assert((await clip()).speed === 2, 'undo did not restore 2×');
});

await step('preview matches the export at 2×', async () => {
  const shots = [];
  for (const f of [15, 40]) {
    await h.seekFrame(f);
    // Wait until the visible video really shows source time 2·f/30 (not a frame from before the seek).
    await page.waitForFunction((want) => {
      const v = [...document.querySelectorAll('video.stage-video')].find((e) => e.style.display === 'block');
      return v && !v.seeking && v.readyState >= 2 && Math.abs(v.currentTime - want) < 0.03;
    }, (2 * f) / 30);
    await page.waitForTimeout(300);
    const png = path.join(out, `preview-${f}.png`);
    await page.locator('.stage').screenshot({ path: png });
    shots.push({ f, png });
  }
  const file = path.join(out, 'speed.mp4');
  await h.exportTo(file, { fps: 30 });
  const at = (f) => ['-ss', (f / 30 - 0.005).toFixed(4), '-i', file];
  for (const { f, png } of shots) {
    const same = compareFrames(['-i', png], at(f));
    const near = Math.min(compareFrames(['-i', png], at(f - 3)), compareFrames(['-i', png], at(f + 3)));
    console.log(`      frame ${f}: preview vs export ${same.toFixed(2)} (3 frames away ${near.toFixed(2)})`);
    assert(same < near, `frame ${f}: the export frame is not the closest match`);
  }
});

await h.close();
process.exit(finish());
