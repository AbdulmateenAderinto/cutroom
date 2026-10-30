/**
 * UI test for titles in the real app: add a title, edit its text, apply a style, drag it in the
 * preview, add a second one on another row, and check the preview matches the export, including
 * frames in the middle of an animation.
 *
 * Run: npm run test:e2e   (Linux without a display: xvfb-run -a npm run test:e2e)
 */
import path from 'node:path';
import { TPS, assert, compareFrames, ff, fixture, launch, makeSteps, outputDir } from './harness.mjs';

const out = outputDir('titles');
const userData = path.join(out, 'userdata');
// A plain dark picture with soft vertical bands, so the text is what differs between frames.
const video = fixture('titles-bg.mp4', (f) => ff(['-f', 'lavfi', '-i', "color=c=0x203048:s=1280x720:r=30:d=5,geq=lum='60+20*sin(X/90)':cb=140:cr=120",
  '-f', 'lavfi', '-i', 'sine=d=5', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f]));

const { step, finish } = makeSteps();
console.log('Cutroom titles UI test');
const h = await launch({ userData });
const { page } = h;
let n = 0;
const snap = (label) => page.screenshot({ path: path.join(out, `${String(++n).padStart(2, '0')}-${label}.png`) });
const titles = async () => (await h.state()).titles ?? [];
const shots = [];
const shoot = async (name, frame) => {
  await h.seekFrame(frame);
  await h.previewReady();
  await page.waitForTimeout(250);
  const png = path.join(out, `preview-${name}.png`);
  await page.locator('.stage').screenshot({ path: png });
  shots.push({ name, png, frame });
};

await step('import a video and add it', async () => {
  await h.stubOpen([video]);
  await page.click('button:has-text("Import…")');
  await page.waitForFunction(() => window.__cutroom.store.get().project.media.length === 1);
  await page.click('.media-item >> nth=0 >> button:has-text("Add to timeline")');
  await h.seekFrame(0);
});

await step('“+ Text” adds a 3 s title at the playhead, on a text row', async () => {
  await page.click('.tl-toolbar button:has-text("+ Text")');
  const t = await titles();
  assert(t.length === 1 && t[0].start === 0 && t[0].duration === 3 * TPS && t[0].row === 0, JSON.stringify(t));
  assert(await page.locator('.tclip').isVisible(), 'title block missing on the timeline');
  assert(await page.locator('.inspector h2:has-text("Title")').isVisible(), 'title inspector not shown');
});

await step('edit the text (two lines) and apply the Lower third style', async () => {
  const box = page.locator('textarea[aria-label="Title text"]');
  await box.fill('Ada Lovelace\nFirst programmer');
  await box.press('Meta+Enter').catch(() => {});
  await page.click('.inspector h2'); // blur applies
  await page.click('.inspector button:has-text("Lower third")');
  const [t] = await titles();
  assert(t.text === 'Ada Lovelace\nFirst programmer', JSON.stringify(t.text));
  assert(t.style.look === 'box' && t.style.align === 'left', JSON.stringify(t.style));
  await page.click('.inspector button[role="radio"]:has-text("Outline")');
  await page.click('.inspector button[role="radio"]:has-text("Box")');
  await snap('lower-third');
});

await step('drag the title in the preview; undo restores it', async () => {
  await h.seekFrame(45);
  const before = (await titles())[0].style;
  const hit = await page.locator('.title-hit').boundingBox();
  const stage = await page.locator('.stage').boundingBox();
  await page.mouse.move(hit.x + hit.width / 2, hit.y + hit.height / 2);
  await page.mouse.down();
  await page.mouse.move(hit.x + hit.width / 2 + stage.width * 0.1, hit.y + hit.height / 2 - stage.height * 0.2, { steps: 6 });
  await page.mouse.up();
  const after = (await titles())[0].style;
  assert(Math.abs(after.x - before.x - 0.1) < 0.01 && Math.abs(after.y - before.y + 0.2) < 0.01, `moved ${before.x},${before.y} → ${after.x},${after.y}`);
  await page.click('button:has-text("Undo")');
  const back = (await titles())[0].style;
  assert(back.x === before.x && back.y === before.y, 'undo did not restore the position');
});

await step('second title (T key) at 1.5 s goes on a second row', async () => {
  await h.seekFrame(45);
  await page.keyboard.press('Escape');
  await page.keyboard.press('t');
  const t = await titles();
  assert(t.length === 2 && t[1].row === 1 && t[1].start === 1.5 * TPS, JSON.stringify(t.map((x) => [x.row, x.start])));
  assert((await page.locator('.tl-text-row').count()) === 2, 'two text rows expected');
  await page.locator('textarea[aria-label="Title text"]').fill('CHAPTER ONE');
  await page.click('.inspector h2');
  await page.selectOption('select[aria-label="Title animation in"]', 'pop');
  await page.selectOption('select[aria-label="Font"]', 'serif');
  await snap('two-titles');
});

await step('preview matches the export (static, mid-animation, two titles)', async () => {
  await page.keyboard.press('Escape');
  await shoot('static', 30); // 1 s: lower third fully in
  await shoot('rising', 4); // lower third mid "rise"
  await shoot('popping', 49); // 1.63 s: chapter title mid "pop", both visible
  await shoot('both', 75); // 2.5 s: both fully in
  const file = path.join(out, 'titles.mp4');
  await h.exportTo(file, { fps: 30 });
  // Accurate input seeking returns the first frame at or after -ss: seek just before frame f's time.
  const at = (f) => ['-ss', (f / 30 - 0.005).toFixed(4), '-i', file];
  // Compare inside each title's region (the rest of the frame is the same video in both).
  const regions = { lower: [0.02, 0.7, 0.3, 0.24], chapter: [0.25, 0.38, 0.5, 0.24] };
  const grid = [24, 12]; // coarse: glyph edges rasterise differently at the stage size and the output size
  for (const s of shots) {
    for (const [name, crop] of Object.entries(regions)) {
      if (name === 'chapter' && s.frame < 45) continue;
      const same = compareFrames(['-i', s.png], at(s.frame), crop, grid);
      const none = compareFrames(['-i', s.png], at(140), crop, grid); // 4.67 s: no titles
      const near = Math.max(compareFrames(['-i', s.png], at(s.frame - 2), crop, grid), compareFrames(['-i', s.png], at(s.frame + 2), crop, grid));
      console.log(`      ${s.name}/${name}: preview vs export ${same.toFixed(2)} (2 frames away ${near.toFixed(2)}, no titles ${none.toFixed(2)})`);
      // Mid-rise the title is only partly faded in, so "no titles" is close; macOS anti-aliasing
      // (≈ 2.9 vs 7.8 there) needs the looser ratio. Timing is checked against `near` below.
      assert(same < none / (s.name === 'rising' ? 2.5 : 3), `${s.name}/${name}: preview and export differ (${same.toFixed(2)} vs ${none.toFixed(2)})`);
      if (s.name === 'rising') assert(same < near, `${s.name}/${name}: the export frame is not the closest match`);
    }
  }
  // Mid-animation frames must differ from the settled frames in both preview and export.
  const animDiff = compareFrames(at(4), at(30), regions.lower, grid);
  assert(animDiff > 0.5, `the rise animation is not visible in the export (${animDiff.toFixed(2)})`);
});

await step('save and reopen keeps the titles', async () => {
  const file = path.join(out, 'with-titles.cutroom');
  await h.stubSave(file);
  await page.click('.topbar button:has-text("Save")');
  await page.waitForFunction(() => window.__cutroom.store.get().projectPath);
  const before = await titles();
  await h.stubOpen([file]);
  await page.click('.topbar button:has-text("Open…")');
  await page.waitForTimeout(800);
  const after = await titles();
  assert(JSON.stringify(after) === JSON.stringify(before), 'titles changed after reopening');
});

await h.close();
process.exit(finish());
