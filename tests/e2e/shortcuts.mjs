/**
 * UI test for keyboard shortcuts in the real app: jump between cuts, trim to playhead, select,
 * move, copy/cut/paste, J/K/L shuttle, title, fit, the shortcuts dialog, and that shortcuts don't
 * fire while typing in a field.
 *
 * Run: npm run test:e2e   (Linux without a display: xvfb-run -a npm run test:e2e)
 */
import path from 'node:path';
import { TPS, assert, ff, fixture, launch, makeSteps, outputDir } from './harness.mjs';

const out = outputDir('shortcuts');
const userData = path.join(out, 'userdata');
const clip = (name, f0) => fixture(name, (f) => ff(['-f', 'lavfi', '-i', `testsrc2=s=640x360:r=30:d=4`, '-f', 'lavfi', '-i', `sine=f=${f0}:d=4`,
  '-c:v', 'libx264', '-preset', 'veryfast', '-g', '15', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f]));
const a = clip('keys-a.mp4', 440);
const b = clip('keys-b.mp4', 880);
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const { step, finish } = makeSteps();
console.log('Cutroom keyboard shortcuts UI test');
const h = await launch({ userData });
const { page } = h;
const items = async () => (await h.state()).sequence.items;
const time = () => page.evaluate(() => window.__cutroom.playhead.get().time / 705_600_000);
const sel = () => page.evaluate(() => window.__cutroom.store.get().selection);
const key = async (k) => {
  await page.keyboard.press(k);
  await page.waitForTimeout(80);
};

await step('import and add two 4 s clips', async () => {
  await h.stubOpen([a, b]);
  await page.click('button:has-text("Import…")');
  await page.waitForFunction(() => window.__cutroom.store.get().project.media.length === 2);
  await page.click('.media-item >> nth=0 >> button:has-text("Add to timeline")');
  await page.click('.media-item >> nth=1 >> button:has-text("Add to timeline")');
  await page.keyboard.press('Escape');
  await h.seekFrame(0);
});

await step('↓ / ↑ jump to the next / previous cut', async () => {
  await key('ArrowDown');
  assert(Math.abs((await time()) - 4) < 1e-6, `at ${await time()}`);
  await key('ArrowDown');
  assert(Math.abs((await time()) - 8 + 1 / 30) < 1e-6, `end: ${await time()}`);
  await key('ArrowUp');
  await key('ArrowUp');
  assert((await time()) === 0, `back at ${await time()}`);
});

await step('Q trims the clip start to the playhead, W the end', async () => {
  await h.seekFrame(30);
  await key('q');
  let [c] = await items();
  assert(c.sourceIn === 1 * TPS && c.sourceOut === 4 * TPS, `after Q: ${c.sourceIn / TPS}–${c.sourceOut / TPS}`);
  assert((await time()) === 0, 'playhead should stay on the same picture (now at the clip start)');
  await h.seekFrame(60);
  await key('w');
  [c] = await items();
  assert(c.sourceOut === 3 * TPS, `after W: out ${c.sourceOut / TPS}`);
});

await step('X selects the clip under the playhead; ⌥→ / ⌥← move it', async () => {
  await h.seekFrame(10);
  await key('x');
  const first = (await items())[0].id;
  assert((await sel())?.id === first, 'X did not select the clip');
  await key('Alt+ArrowRight');
  assert((await items())[1].id === first, 'clip did not move later');
  await key('Alt+ArrowLeft');
  assert((await items())[0].id === first, 'clip did not move back');
});

await step(`${MOD}+C / ${MOD}+V paste at the playhead (splitting the clip there); undo; ${MOD}+X`, async () => {
  const [c1, c2] = await items();
  await key('x'); // select c1 (playhead is inside it)
  await key(`${MOD}+c`);
  await h.seekFrame(60 + 30); // 3 s: 1 s into the second clip
  await key(`${MOD}+v`);
  let it = await items();
  assert(it.length === 4 && it[2].mediaId === c1.mediaId && it[1].mediaId === c2.mediaId && it[3].mediaId === c2.mediaId, JSON.stringify(it.map((x) => x.mediaId)));
  assert((await sel())?.id === it[2].id, 'pasted clip should be selected');
  await page.click('button:has-text("Undo")');
  it = await items();
  assert(it.length === 2, `undo: ${it.length} items`);
  await h.seekFrame(10);
  await key('x');
  await key(`${MOD}+x`);
  it = await items();
  assert(it.length === 1 && it[0].id === c2.id, 'cut did not remove the clip');
  await h.seekFrame(0);
  await key(`${MOD}+v`);
  it = await items();
  assert(it.length === 2 && it[0].mediaId === c1.mediaId, 'paste at the start failed');
});

await step('L plays, L again 2×, K pauses, J plays backward', async () => {
  await h.seekFrame(15);
  await key('l');
  assert((await page.evaluate(() => window.__cutroom.engine.shuttleSpeed)) === 1, 'L should play at 1×');
  await key('l');
  await page.waitForTimeout(300);
  const rate = await page.evaluate(() => [...document.querySelectorAll('video.stage-video')].find((v) => v.style.display === 'block')?.playbackRate);
  assert((await page.evaluate(() => window.__cutroom.engine.shuttleSpeed)) === 2 && rate === 2, `2×: rate ${rate}`);
  await key('k');
  assert((await page.evaluate(() => window.__cutroom.engine.shuttleSpeed)) === 0, 'K should pause');
  const t0 = await time();
  await key('j');
  await page.waitForTimeout(600);
  const t1 = await time();
  assert((await page.evaluate(() => window.__cutroom.engine.shuttleSpeed)) === -1, 'J should play backward');
  await key('k');
  assert(t1 < t0 - 0.3, `backward: ${t0} → ${t1}`);
});

await step('T adds a title; ⇧Z fits the timeline; ? opens the searchable shortcut list', async () => {
  await key('t');
  assert(((await h.state()).titles ?? []).length === 1, 'no title');
  await page.keyboard.press('Escape');
  await page.click('.inspector h2');
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__cutroom.store.set({ pxPerSecond: 400 }));
  await key('Shift+z');
  const pps = await page.evaluate(() => window.__cutroom.store.get().pxPerSecond);
  assert(pps < 400, `fit did not zoom out (${pps})`);
  await key('Shift+?');
  await page.waitForSelector('[aria-label="Keyboard shortcuts"]');
  await page.fill('input[aria-label="Search shortcuts"]', 'trim');
  const rows = await page.locator('.shortcuts tr').allTextContents();
  assert(rows.length === 2 && rows.every((r) => /Trim/.test(r)), JSON.stringify(rows));
  await page.screenshot({ path: path.join(out, 'shortcuts-dialog.png') });
  await page.keyboard.press('Escape');
});

await step('typing in a field does not trigger shortcuts', async () => {
  await page.click('.tclip');
  const box = page.locator('textarea[aria-label="Title text"]');
  await box.fill('');
  await box.type('quick wax');
  const it = await items();
  assert((await box.inputValue()) === 'quick wax', 'text not typed');
  assert(it.length === 2 && it[0].sourceIn === (await items())[0].sourceIn, 'a shortcut fired while typing');
  assert((await page.evaluate(() => window.__cutroom.engine.shuttleSpeed)) === 0, 'K/L fired while typing');
});

await h.close();
process.exit(finish());
