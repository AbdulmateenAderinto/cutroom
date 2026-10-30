/**
 * UI test for transitions in the real app: trim two clips to leave footage past the cut, add a
 * crossfade, check the preview mixes them (and plays the other clip during the window), compare
 * preview and export through the window, then a dip to black, and the "not enough footage" note.
 *
 * Run: npm run test:e2e   (Linux without a display: xvfb-run -a npm run test:e2e)
 */
import path from 'node:path';
import { assert, compareFrames, ff, fixture, launch, makeSteps, outputDir } from './harness.mjs';

const out = outputDir('transitions');
const userData = path.join(out, 'userdata');
const grey = (name, rgb, freq) => fixture(name, (f) => ff(['-f', 'lavfi', '-i', `color=c=${rgb}:s=640x360:r=30:d=4`, '-f', 'lavfi', '-i', `sine=f=${freq}:d=4`,
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f]));
const dark = grey('tr-dark.mp4', '0x303030', 440);
const light = grey('tr-light.mp4', '0xd0d0d0', 880);

const { step, finish } = makeSteps();
console.log('Cutroom transitions UI test');
const h = await launch({ userData });
const { page } = h;
const items = async () => (await h.state()).sequence.items;
const setField = async (label, value) => {
  const f = page.locator(`.inspector label:has-text("${label}") input`).first();
  await f.fill(value);
  await f.press('Enter');
};
/** Mean brightness (0–255) of the middle of the preview stage, from a screenshot. */
const shots = {};
const shoot = async (name, frame) => {
  await h.seekFrame(frame);
  await h.previewReady();
  await page.waitForTimeout(300);
  const png = path.join(out, `preview-${name}.png`);
  await page.locator('.stage').screenshot({ path: png });
  shots[name] = { png, frame };
};

await step('import two clips; trim them so there is footage past the cut', async () => {
  await h.stubOpen([dark, light]);
  await page.click('button:has-text("Import…")');
  await page.waitForFunction(() => window.__cutroom.store.get().project.media.length === 2);
  await page.click('.media-item >> nth=0 >> button:has-text("Add to timeline")');
  await page.click('.media-item >> nth=1 >> button:has-text("Add to timeline")');
  await page.click('.tl-track .clip >> nth=0');
  await setField('Source out', '3');
  await page.click('.tl-track .clip >> nth=1');
  await setField('Source in', '1');
  const [a, b] = await items();
  assert(a.sourceOut === 3 * 705_600_000 && b.sourceIn === 705_600_000, JSON.stringify([a.sourceOut, b.sourceIn]));
});

await step('add a 1 s crossfade from the first clip; marker on the timeline', async () => {
  await page.click('.tl-track .clip >> nth=0');
  await page.selectOption('select[aria-label="Transition to next clip"]', 'crossfade');
  await setField('Length', '1');
  const [a] = await items();
  assert(a.transition?.kind === 'crossfade' && a.transition.duration === 705_600_000, JSON.stringify(a.transition));
  assert(await page.locator('.tr-mark.crossfade').isVisible(), 'transition marker missing');
  assert(await page.locator('text=Centred on the cut').isVisible(), 'inspector note missing');
  assert((await page.evaluate(() => window.__cutroom.engine.duration)) === 6 * 705_600_000, 'timeline length changed');
});

await step('preview mixes both clips through the window (other clip in the transition layer)', async () => {
  await page.keyboard.press('Escape');
  for (const [name, f] of [['before', 70], ['quarter', 82], ['middle', 90], ['three-quarter', 97], ['after', 110]]) await shoot(name, f);
  const layer = await page.evaluate(() => {
    const v = document.querySelector('video.transition-video');
    return { shown: v.style.display, opacity: v.style.opacity };
  });
  assert(layer.shown === 'none', 'transition layer should be hidden after the window');
  await h.seekFrame(90);
  await page.waitForTimeout(300);
  const mid = await page.evaluate(() => {
    const v = document.querySelector('video.transition-video');
    return { shown: v.style.display, opacity: Number(v.style.opacity), z: v.style.zIndex };
  });
  assert(mid.shown === 'block' && mid.z === '0', `at the cut the outgoing clip is under the incoming one: ${JSON.stringify(mid)}`);
});

await step('playing through the crossfade plays the other clip too', async () => {
  await h.seekFrame(66);
  await page.click('button:has-text("▶ Play")');
  await page.waitForFunction(() => window.__cutroom.playhead.get().time > 2.7 * 705_600_000);
  const during = await page.evaluate(() => {
    const v = document.querySelector('video.transition-video');
    return { shown: v.style.display, paused: v.paused, opacity: Number(v.style.opacity) };
  });
  await page.waitForFunction(() => window.__cutroom.playhead.get().time > 3.7 * 705_600_000);
  const after = await page.evaluate(() => document.querySelector('video.transition-video').style.display);
  await page.click('button:has-text("Pause")');
  assert(during.shown === 'block' && !during.paused && during.opacity > 0 && during.opacity < 1, `during: ${JSON.stringify(during)}`);
  assert(after === 'none', 'transition layer still shown after the window');
});

await step('preview matches the export through the crossfade', async () => {
  const file = path.join(out, 'crossfade.mp4');
  await h.exportTo(file, { fps: 30 });
  const at = (f) => ['-ss', (f / 30 - 0.005).toFixed(4), '-i', file];
  const mid = [0.3, 0.3, 0.4, 0.4];
  for (const [name, { png, frame }] of Object.entries(shots)) {
    const same = compareFrames(['-i', png], at(frame), mid, [8, 8]);
    const far = Math.min(compareFrames(['-i', png], at(frame - 8), mid, [8, 8]), compareFrames(['-i', png], at(frame + 8), mid, [8, 8]));
    console.log(`      ${name} (frame ${frame}): preview vs export ${same.toFixed(2)} (8 frames away ${far.toFixed(2)})`);
    assert(same < 6, `${name}: preview and export differ by ${same.toFixed(2)}`);
    if (name !== 'before' && name !== 'after') assert(same < far, `${name}: not closer to its own export frame`);
  }
});

await step('dip to black: black at the cut in preview and export', async () => {
  await page.click('.tl-track .clip >> nth=0');
  await page.selectOption('select[aria-label="Transition to next clip"]', 'dipBlack');
  await page.keyboard.press('Escape');
  await shoot('dip', 90);
  const dip = await page.evaluate(() => Number(document.querySelector('.stage-dip').style.opacity));
  assert(dip === 1, `colour layer opacity at the cut: ${dip}`);
  const file = path.join(out, 'dip.mp4');
  await h.exportTo(file, { fps: 30 });
  const d = compareFrames(['-i', shots.dip.png], ['-ss', (90 / 30 - 0.005).toFixed(4), '-i', file], [0.3, 0.3, 0.4, 0.4], [8, 8]);
  assert(d < 6, `dip preview vs export ${d}`);
});

await step('a crossfade with no footage past the cut explains why it is not shown', async () => {
  await page.click('.tl-track .clip >> nth=0');
  await page.selectOption('select[aria-label="Transition to next clip"]', 'crossfade');
  await setField('Source out', '4');
  assert(await page.locator('.inspector .warn-text:has-text("needs footage after this clip")').isVisible(), 'missing explanation');
  assert((await page.locator('.tr-mark').count()) === 0, 'marker shown for an inactive transition');
});

await h.close();
process.exit(finish());
