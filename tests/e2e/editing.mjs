/**
 * UI test for the editing tools added in Phase 1: markers (M, the ruler, the inspector, ↑/↓,
 * chapters in the export), multi-select (⌘-click, Shift-click, ⌘A; delete, copy/paste), and
 * detaching a clip's sound for an L-cut.
 *
 * Run: npm run test:e2e   (Linux without a display: xvfb-run -a npm run test:e2e)
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { TPS, assert, ff, fixture, launch, makeSteps, outputDir } from './harness.mjs';

const out = outputDir('editing');
const userData = path.join(out, 'userdata');
const clip = (name, f0) => fixture(name, (f) => ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=4', '-f', 'lavfi', '-i', `sine=f=${f0}:d=4`,
  '-c:v', 'libx264', '-preset', 'veryfast', '-g', '15', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f]));
const a = clip('keys-a.mp4', 440);
const b = clip('keys-b.mp4', 880);

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const { step, finish } = makeSteps();
console.log('Cutroom editing tools UI test');
const h = await launch({ userData });
const { page } = h;
const time = () => page.evaluate(() => window.__cutroom.playhead.get().time / 705_600_000);
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
});

await step('markers: M adds one at the playhead, rename and recolour it, drag it, ↑/↓ stop at it', async () => {
  await h.seekFrame(45);
  await key('m');
  let ms = (await h.state()).markers ?? [];
  assert(ms.length === 1 && ms[0].time === 1.5 * TPS, JSON.stringify(ms));
  assert(await page.locator('.inspector h2:has-text("Marker")').isVisible(), 'marker inspector not shown');
  await page.fill('input[aria-label="Marker name"]', 'Big moment');
  await page.keyboard.press('Enter');
  await page.click('button[aria-label="Red"]');
  ms = (await h.state()).markers;
  assert(ms[0].label === 'Big moment' && ms[0].color === 'red', JSON.stringify(ms));
  assert((await page.locator('.tl-marker-label').textContent()) === 'Big moment', 'label not on the ruler');
  await page.click('button:has-text("+ Marker")'); // same frame: selects the existing marker
  assert(((await h.state()).markers ?? []).length === 1, 'a second marker on the same frame');
  // Drag the flag 1 s later (snapping off so it lands where dropped).
  await page.evaluate(() => window.__cutroom.store.set({ snapping: false }));
  const box = await page.locator('.tl-marker').boundingBox();
  const pps = await page.evaluate(() => window.__cutroom.store.get().pxPerSecond);
  await page.mouse.move(box.x + 5, box.y + 6);
  await page.mouse.down();
  await page.mouse.move(box.x + 5 + pps, box.y + 6, { steps: 5 });
  await page.mouse.up();
  const t = (await h.state()).markers[0].time / TPS;
  assert(Math.abs(t - 2.5) < 0.1, `dragged to ${t}`);
  await page.evaluate(() => window.__cutroom.store.set({ snapping: true }));
  await page.keyboard.press('Escape');
  await h.seekFrame(0);
  await key('ArrowDown');
  assert(Math.abs((await time()) - t) < 1e-6, `↓ went to ${await time()}, marker at ${t}`);
  await key('ArrowDown');
  assert(Math.abs((await time()) - 4) < 1e-6, `next ↓ should reach the cut at 4 s: ${await time()}`);
  await page.screenshot({ path: path.join(out, 'markers.png') });
});

await step('export with chapters from the markers', async () => {
  const file = path.join(out, 'chapters.mp4');
  await h.exportTo(file);
  const c = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_chapters', '-of', 'json', file]).toString()).chapters;
  assert(c.length === 2 && c[1].tags.title === 'Big moment', JSON.stringify(c));
});

await step('Delete removes the selected marker; undo brings it back', async () => {
  await page.click('.tl-marker');
  await key('Delete');
  assert(((await h.state()).markers ?? []).length === 0, 'not deleted');
  assert((await h.state()).sequence.items.length === 2, 'a clip was deleted too');
  await page.click('button:has-text("Undo")');
  assert(((await h.state()).markers ?? []).length === 1, 'undo did not restore it');
});

await step('multi-select: ⌘-click, Shift-click, ⌘A; copy/paste and delete act on all of them', async () => {
  await page.keyboard.press('Escape');
  const ids = (await h.state()).sequence.items.map((i) => i.id);
  await page.click('.tl-track .clip >> nth=0');
  await page.click('.tl-track .clip >> nth=1', { modifiers: [MOD] });
  let sel = await page.evaluate(() => window.__cutroom.store.get().selection);
  assert(sel?.kind === 'items' && sel.ids.length === 2, JSON.stringify(sel));
  assert(await page.locator('.inspector h3:has-text("2 items selected")').isVisible(), 'multi inspector missing');
  assert(await page.locator('.tl-track .clip.selected').count() === 2, 'both clips should be highlighted');
  await page.click('.tl-track .clip >> nth=1', { modifiers: [MOD] }); // toggle off
  sel = await page.evaluate(() => window.__cutroom.store.get().selection);
  assert(sel?.kind === 'item' && sel.id === ids[0], JSON.stringify(sel));
  await page.click('.tl-track .clip >> nth=1', { modifiers: ['Shift'] });
  sel = await page.evaluate(() => window.__cutroom.store.get().selection);
  assert(sel?.kind === 'items' && sel.ids.length === 2, `shift-click: ${JSON.stringify(sel)}`);
  await page.keyboard.press('Escape');
  await key(`${MOD}+a`);
  sel = await page.evaluate(() => window.__cutroom.store.get().selection);
  assert(sel?.kind === 'items' && sel.ids.length === 2, `select all: ${JSON.stringify(sel)}`);
  await key(`${MOD}+c`);
  await h.seekFrame(8 * 30 - 1); // the last frame: paste after both clips
  await page.evaluate(() => window.__cutroom.engine.seek(8 * 705_600_000));
  await key(`${MOD}+v`);
  let items = (await h.state()).sequence.items;
  assert(items.length === 4 && items[2].mediaId === items[0].mediaId && items[3].mediaId === items[1].mediaId, JSON.stringify(items.map((i) => i.mediaId)));
  await page.click('button:has-text("Undo")');
  await key(`${MOD}+a`);
  await key('Delete');
  assert((await h.state()).sequence.items.length === 0, 'delete of a multiple selection failed');
  await page.click('button:has-text("Undo")');
  items = (await h.state()).sequence.items;
  assert(items.length === 2 && items[0].id === ids[0], 'undo did not restore both clips');
});

await step('detach audio, then extend the sound past the cut (L-cut)', async () => {
  await page.click('.tl-track .clip >> nth=0');
  await page.click('.inspector button:has-text("Detach audio")');
  const s = await h.state();
  const ac = s.audioTracks?.[0]?.clips[0];
  assert(s.sequence.items[0].muted === true, 'the clip should be muted');
  assert(ac && ac.start === 0 && ac.sourceIn === 0 && ac.sourceOut === 4 * TPS, JSON.stringify(ac));
  const sel = await page.evaluate(() => window.__cutroom.store.get().selection);
  assert(sel?.kind === 'audio' && sel.id === ac.id, 'the new audio clip should be selected');
  // Drag the sound's right edge 0.5 s past the cut.
  await page.evaluate(() => window.__cutroom.store.set({ snapping: false }));
  const box = await page.locator('.aclip >> nth=0 >> .trim-handle.right').boundingBox();
  const pps = await page.evaluate(() => window.__cutroom.store.get().pxPerSecond);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 0.5 * pps, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  const ext = (await h.state()).audioTracks[0].clips[0];
  assert(Math.abs(ext.sourceOut / TPS - 4) < 0.02, `the file has only 4 s of sound: ${ext.sourceOut / TPS}`);
  // Trim the picture instead: the sound keeps running past the new cut.
  await h.seekFrame(90);
  await page.click('.tl-track .clip >> nth=0');
  await key('w');
  const st = await h.state();
  assert(st.sequence.items[0].sourceOut === 3 * TPS && st.audioTracks[0].clips[0].sourceOut === 4 * TPS, 'L-cut: picture 3 s, sound 4 s');
  await page.evaluate(() => window.__cutroom.store.set({ snapping: true }));
  await page.screenshot({ path: path.join(out, 'lcut.png') });
});

await h.close();
process.exit(finish());
