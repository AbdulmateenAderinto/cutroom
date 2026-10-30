/**
 * UI test for the editing tools added in Phase 1: markers (M, the ruler, the inspector, ↑/↓,
 * chapters in the export), multi-select (⌘-click, Shift-click, ⌘A; delete, copy/paste), and
 * detaching a clip's sound for an L-cut, a speed ramp (preview vs export, playback rates), a
 * freeze frame and a reversed clip (both: preview vs export).
 *
 * Run: npm run test:e2e   (Linux without a display: xvfb-run -a npm run test:e2e)
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { TPS, assert, compareFrames, ff, fixture, launch, makeSteps, outputDir } from './harness.mjs';

const out = outputDir('editing');
const userData = path.join(out, 'userdata');
// Smooth gradients that change steadily over time: preview and export frames are easy to tell apart
// (a frame 12 later is clearly different) and there are no hard edges to rescale differently.
const grad = (r, g, b) => `nullsrc=s=640x360:r=30:d=4,format=rgb24,geq=r='${r}':g='${g}':b='${b}',scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv`;
const clip = (name, src, f0) => fixture(name, (f) => ff(['-f', 'lavfi', '-i', src, '-f', 'lavfi', '-i', `sine=f=${f0}:d=4`,
  '-c:v', 'libx264', '-preset', 'veryfast', '-g', '15', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
  '-c:a', 'aac', '-shortest', f]));
const a = clip('edit-a.mp4', grad('40+50*T', '60+120*X/W', '200-150*Y/H'), 440);
const b = clip('edit-b.mp4', grad('220-150*X/W', '30+50*T', '60+100*Y/H'), 880);

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

await step('speed ramp: “Ease into slow motion” makes 8 parts; playback changes rate; preview matches export', async () => {
  await page.click('.tl-track .clip >> nth=1');
  await page.click('.inspector button:has-text("Ease into slow motion")');
  const items = (await h.state()).sequence.items;
  const speeds = items.slice(1).map((c) => c.speed ?? 1);
  assert(items.length === 9 && speeds[0] === 1 && speeds[7] === 0.25, JSON.stringify(speeds));
  const sel = await page.evaluate(() => window.__cutroom.store.get().selection);
  assert(sel?.kind === 'items' && sel.ids.length === 8, 'the parts should be selected');
  // Play from inside the ramp: the element's rate follows the parts.
  await page.keyboard.press('Escape');
  const lay = await page.evaluate(() => {
    const p = window.__cutroom.store.get().project;
    let t = 0;
    return p.sequence.items.map((i) => {
      const d = Math.round((i.sourceOut - i.sourceIn) / (i.speed ?? 1));
      const r = { start: t / 705_600_000, end: (t + d) / 705_600_000, speed: i.speed ?? 1 };
      t += d;
      return r;
    });
  });
  await page.evaluate((t) => window.__cutroom.engine.seek(Math.round(t * 705_600_000)), lay[5].start + 0.05);
  await page.click('button:has-text("Play")');
  const rates = new Set();
  const end = Date.now() + 2500;
  while (Date.now() < end) {
    rates.add(await page.evaluate(() => [...document.querySelectorAll('video.stage-video')].find((v) => v.style.display === 'block')?.playbackRate));
    await page.waitForTimeout(100);
  }
  await page.click('button:has-text("Pause")');
  assert([0.57, 0.46, 0.36].some((r) => rates.has(r)) && rates.size >= 2, `rates seen: ${[...rates].join(', ')}`);
  // Preview vs export inside the slow part.
  await page.addStyleTag({ content: '.toasts { display: none !important; }' });
  const shots = [];
  for (const t of [lay[2].start + 0.1, lay[7].start + 0.2, lay[8].start + 0.5]) {
    const f = Math.round(t * 30);
    await h.seekFrame(f);
    await h.previewReady();
    await page.waitForTimeout(300);
    const png = path.join(out, `ramp-${f}.png`);
    await page.locator('.stage').screenshot({ path: png });
    shots.push({ f, png });
  }
  const file = path.join(out, 'ramp.mp4');
  await h.exportTo(file, { fps: 30 });
  for (const { f, png } of shots) {
    const at = (x) => ['-ss', (x / 30 - 0.005).toFixed(4), '-i', file];
    const same = compareFrames(['-i', png], at(f), undefined, [32, 18]);
    // Control: 45 frames earlier (in the slow parts only a few source frames away).
    const other = compareFrames(['-i', png], at(f - 45), undefined, [32, 18]);
    console.log(`      frame ${f}: preview vs export ${same.toFixed(2)} (45 frames earlier ${other.toFixed(2)})`);
    assert(same < 8 && same < other * 0.7, `frame ${f}: preview and export differ (${same.toFixed(2)})`);
  }
});

/** Screenshot the preview at frame f (after it has settled). */
async function shot(name, f, image = false) {
  await h.seekFrame(f);
  if (image) await page.waitForFunction(() => document.querySelector('img.stage-video')?.style.display === 'block' && document.querySelector('img.stage-video').complete);
  else await h.previewReady();
  await page.waitForTimeout(400);
  const png = path.join(out, `${name}-${f}.png`);
  await page.locator('.stage').screenshot({ path: png });
  return { f, png };
}
function matches(file, shots, control) {
  const at = (x) => ['-ss', (x / 30 - 0.005).toFixed(4), '-i', file];
  for (const { f, png } of shots) {
    const same = compareFrames(['-i', png], at(f), undefined, [32, 18]);
    const other = compareFrames(['-i', png], at(control(f)), undefined, [32, 18]);
    console.log(`      frame ${f}: preview vs export ${same.toFixed(2)} (frame ${control(f)}: ${other.toFixed(2)})`);
    assert(same < 8 && same < other * 0.7, `frame ${f}: preview and export differ (${same.toFixed(2)})`);
  }
}

await step('freeze frame (⇧F): a 2 s still of the frame at the playhead; preview matches export', async () => {
  await page.keyboard.press('Escape');
  await h.seekFrame(45);
  const before = (await h.state()).sequence.items.length;
  await key('Shift+F');
  await page.waitForFunction((n) => window.__cutroom.store.get().project.sequence.items.length === n + 2, before, { timeout: 20000 });
  const s = await h.state();
  const still = s.sequence.items[1];
  const m = s.media.find((x) => x.id === still.mediaId);
  assert(m.info.kind === 'image' && m.derived?.kind === 'freeze' && still.sourceOut === 2 * TPS, JSON.stringify({ still, derived: m.derived }));
  await page.keyboard.press('Escape');
  const shots = [await shot('freeze', 50, true), await shot('freeze', 100, true)];
  const file = path.join(out, 'freeze.mp4');
  await h.exportTo(file, { fps: 30 });
  matches(file, shots, () => 20);
  // The still is the frame at the cut: export frames 44 (before), 45 (still) and 106 (after) agree.
  const same = compareFrames(['-ss', (45 / 30 - 0.005).toFixed(4), '-i', file], ['-ss', (106 / 30 - 0.005).toFixed(4), '-i', file], undefined, [32, 18]);
  assert(same < 2, `the still differs from the frame after it: ${same.toFixed(2)}`);
});

await step('reverse a clip: a reversed copy is made and used; preview matches export; “Play forwards again”', async () => {
  await page.click('.tl-track .clip >> nth=0');
  const before = (await h.state()).sequence.items[0];
  await page.click('.inspector button:has-text("Reverse")');
  await page.waitForFunction((id) => {
    const s = window.__cutroom.store.get();
    return s.working.length === 0 && s.project.sequence.items[0].mediaId !== id;
  }, before.mediaId, { timeout: 60000 });
  const s = await h.state();
  const rev = s.media.find((x) => x.id === s.sequence.items[0].mediaId);
  assert(rev.derived?.kind === 'reverse' && rev.derived.sourceIn === before.sourceIn && rev.derived.sourceOut === before.sourceOut, JSON.stringify(rev.derived));
  await page.keyboard.press('Escape');
  const shots = [await shot('reversed', 5), await shot('reversed', 40)];
  const file = path.join(out, 'reversed.mp4');
  await h.exportTo(file, { fps: 30 });
  matches(file, shots, (f) => 44 - f); // the same moment played forwards would be here
  await page.click('.tl-track .clip >> nth=0');
  await page.click('.inspector button:has-text("Play forwards again")');
  const back = (await h.state()).sequence.items[0];
  assert(back.mediaId === before.mediaId && back.sourceIn === before.sourceIn && back.sourceOut === before.sourceOut, JSON.stringify(back));
});

await h.close();
process.exit(finish());
