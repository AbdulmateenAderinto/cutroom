/**
 * UI test for rotation, title keyframes and the wipe/slide/zoom transitions in the real app:
 * rotate a clip with the Rotation field and the ↻ button, keyframe its rotation, keyframe a
 * title's position and rotation, compare the preview with the export at still and moving frames;
 * then a second clip with a wipe (into the rotated clip), a slide and a zoom, each compared
 * mid-transition; then blur and a circle mask on the second clip (preview vs export).
 *
 * Run: npm run test:e2e   (Linux without a display: xvfb-run -a npm run test:e2e)
 */
import path from 'node:path';
import { TPS, assert, compareFrames, ff, fixture, launch, makeSteps, outputDir } from './harness.mjs';

const out = outputDir('motion');
const userData = path.join(out, 'userdata');
// A 4:3 gradient picture on a 16:9 canvas, so rotated corners are visible.
const src = "nullsrc=s=640x480:r=30:d=4,format=rgb24,geq=r='40+180*X/W':g='200-150*Y/H':b='60+40*T',scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv";
const src2 = "nullsrc=s=640x360:r=30:d=4,format=rgb24,geq=r='230-120*Y/H':g='40+60*T':b='240-200*X/W',scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv";
const clip2 = fixture('motion-grad-16x9.mp4', (f) => ff(['-f', 'lavfi', '-i', src2, '-f', 'lavfi', '-i', 'sine=f=880:d=4', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
  '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-c:a', 'aac', '-shortest', f]));
const clip = fixture('motion-grad-4x3.mp4', (f) => ff(['-f', 'lavfi', '-i', src, '-f', 'lavfi', '-i', 'sine=d=4', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
  '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-c:a', 'aac', '-shortest', f]));

const { step, finish } = makeSteps();
console.log('Cutroom rotation and title keyframes UI test');
const h = await launch({ userData });
const { page } = h;
const field = (section, label) => page.locator(`.inspector section:has(h3:text-is("${section}")) label.field:has(.field-label:text-is("${label}")) input`).first();
const setField = async (section, label, v) => {
  const f = field(section, label);
  await f.fill(String(v));
  await f.press('Enter');
  await page.waitForTimeout(100);
};
const clip0 = async () => (await h.state()).sequence.items[0];

await step('import, add, rotate with the field and the ↻ button', async () => {
  await h.stubOpen([clip]);
  await page.click('button:has-text("Import…")');
  await page.waitForFunction(() => window.__cutroom.store.get().project.media.length === 1);
  await page.click('.media-item >> nth=0 >> button:has-text("Add to timeline")');
  await page.click('.tl-track .clip >> nth=0');
  await setField('Framing', 'Rotation', 20);
  assert((await clip0()).framing.rotation === 20, JSON.stringify((await clip0()).framing));
  await page.click('.inspector button[aria-label="Rotate right"]');
  assert((await clip0()).framing.rotation === 110, JSON.stringify((await clip0()).framing));
  await page.click('.inspector button[aria-label="Rotate left"]');
  await setField('Framing', 'Rotation', 15);
  const tf = await page.evaluate(() => [...document.querySelectorAll('video.stage-video')].find((v) => v.style.display === 'block')?.style.transform);
  assert(tf === 'rotate(15deg)', `preview transform: ${tf}`);
});

await step('keyframe the rotation: 0° at 1 s, 90° at 2 s (on top of the 15° framing)', async () => {
  await h.seekFrame(30);
  await page.click('.inspector button[aria-label="Add Rotate keyframe"]'); // ◆ with the current value (0°)
  await h.seekFrame(60);
  await setField('Animation', 'Rotate', 90);
  const keys = (await clip0()).animation?.keyframes?.rotation;
  assert(keys?.length === 2 && keys[0].at === 1 * TPS && keys[1].value === 90, JSON.stringify(keys));
});

await step('a title with position and rotation keyframes', async () => {
  await page.keyboard.press('Escape');
  await h.seekFrame(0);
  await page.keyboard.press('t');
  const t = (await h.state()).titles[0];
  await page.evaluate((id) => {
    const s = window.__cutroom.store.get();
    window.__cutroom.store.set({ project: { ...s.project, titles: s.project.titles.map((x) => (x.id === id ? { ...x, animIn: 'none', animOut: 'none', duration: 4 * 705_600_000 } : x)) } });
  }, t.id);
  await h.seekFrame(15);
  await setField('Motion (keyframes)', 'Move X', -400);
  await setField('Motion (keyframes)', 'Rotate', -10);
  await h.seekFrame(75);
  await setField('Motion (keyframes)', 'Move X', 300);
  await setField('Motion (keyframes)', 'Rotate', 20);
  const k = (await h.state()).titles[0].keyframes;
  assert(k?.x?.length === 2 && k?.rotation?.length === 2, JSON.stringify(k));
  assert(Math.abs(k.x[0].value * 1920 + 400) < 1 && k.x[0].at === 15 * TPS / 30, JSON.stringify(k.x));
});

await step('preview matches the export at still and moving frames', async () => {
  await page.keyboard.press('Escape');
  await page.addStyleTag({ content: '.toasts { display: none !important; }' });
  const shots = [];
  for (const f of [10, 40, 52, 90]) {
    await h.seekFrame(f);
    await h.previewReady();
    await page.waitForTimeout(400);
    const png = path.join(out, `preview-${f}.png`);
    await page.locator('.stage').screenshot({ path: png });
    shots.push({ f, png });
  }
  const file = path.join(out, 'motion.mp4');
  await h.exportTo(file, { fps: 30 });
  const at = (x) => ['-ss', (x / 30 - 0.005).toFixed(4), '-i', file];
  const control = { 10: 52, 40: 10, 52: 40, 90: 40 }; // a moment with a different angle/position
  for (const { f, png } of shots) {
    const same = compareFrames(['-i', png], at(f), undefined, [48, 27]);
    const near = compareFrames(['-i', png], at(control[f]), undefined, [48, 27]);
    console.log(`      frame ${f}: preview vs export ${same.toFixed(2)} (another moment ${near.toFixed(2)})`);
    assert(same < 8 && same < near * 0.7, `frame ${f}: preview and export differ (${same.toFixed(2)})`);
  }
});

await step('wipe, slide and zoom into a second clip: preview matches the export mid-transition', async () => {
  await h.stubOpen([clip2]);
  await page.click('button:has-text("Import…")');
  await page.waitForFunction(() => window.__cutroom.store.get().project.media.length === 2);
  await page.click('.media-item >> nth=1 >> button:has-text("Add to timeline")');
  // Leave footage past the cut: first clip 0–3 s, second clip from 1 s of its file.
  await page.evaluate(() => {
    const s = window.__cutroom.store.get();
    const [a, b] = s.project.sequence.items;
    window.__cutroom.store.set({ project: { ...s.project, sequence: { items: [{ ...a, sourceOut: 3 * 705_600_000 }, { ...b, sourceIn: 705_600_000 }] } } });
  });
  const at = (file, x) => ['-ss', (x / 30 - 0.005).toFixed(4), '-i', file];
  for (const kind of ['wipeLeft', 'slideUp', 'zoom']) {
    await page.click('.tl-track .clip >> nth=0');
    await page.selectOption('select[aria-label="Transition to next clip"]', kind);
    const tr = (await h.state()).sequence.items[0].transition;
    assert(tr?.kind === kind, JSON.stringify(tr));
    await page.keyboard.press('Escape');
    const shots = [];
    for (const f of [84, 88, 95]) { // inside the default 0.5 s window (frames 83–97)
      await h.seekFrame(f);
      await h.previewReady().catch(async (e) => {
        console.log('previewReady', f, await page.evaluate(() => ({ want: window.__cutroom.engine.mainTarget, vids: [...document.querySelectorAll('video.stage-video')].map((v) => [v.className, v.style.display, v.readyState, v.seeking, v.currentTime]) })));
        throw e;
      });
      await page.waitForFunction(() => {
        const v = document.querySelector('video.transition-video');
        return v && v.style.display === 'block' && v.readyState >= 2 && !v.seeking;
      }, null, { timeout: 10000 }).catch(async (e) => {
        console.log('transition layer', f, await page.evaluate(() => [...document.querySelectorAll('video.stage-video')].map((v) => [v.className, v.style.display, v.readyState, v.seeking, v.currentTime, v.style.clipPath])));
        throw e;
      });
      await page.waitForTimeout(400);
      const png = path.join(out, `${kind}-${f}.png`);
      await page.locator('.stage').screenshot({ path: png });
      shots.push({ f, png });
    }
    const file = path.join(out, `${kind}.mp4`);
    await h.exportTo(file, { fps: 30 });
    for (const { f, png } of shots) {
      const same = compareFrames(['-i', png], at(file, f), undefined, [48, 27]);
      const other = compareFrames(['-i', png], at(file, f === 88 ? 84 : 88), undefined, [48, 27]);
      console.log(`      ${kind} frame ${f}: preview vs export ${same.toFixed(2)} (frame ${f === 88 ? 84 : 88}: ${other.toFixed(2)})`);
      assert(same < 8 && same < other * 0.7, `${kind} frame ${f}: preview and export differ (${same.toFixed(2)})`);
    }
  }
});

await step('blur and a circle mask: preview matches the export', async () => {
  await page.click('.tl-track .clip >> nth=1');
  await page.locator('.inspector input[aria-label="Blur"]').scrollIntoViewIfNeeded();
  await page.locator('.inspector input[aria-label="Blur"]').evaluate((el) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '40');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('.inspector button:has-text("Circle")');
  const fx = (await h.state()).sequence.items[1].effects;
  assert(Math.abs(fx?.blur - 0.02) < 1e-6 && fx?.mask?.shape === 'ellipse', JSON.stringify(fx));
  const style = await page.evaluate(() => {
    const v = [...document.querySelectorAll('video.stage-video')].find((e) => e.style.display === 'block');
    return v ? { mask: v.style.getPropertyValue('mask-image'), filter: v.style.filter } : null;
  });
  assert(style?.mask.startsWith('radial-gradient') && /url/.test(style.filter), JSON.stringify(style));
  await page.keyboard.press('Escape');
  const shots = [];
  for (const f of [105, 115]) {
    await h.seekFrame(f);
    await h.previewReady();
    await page.waitForTimeout(400);
    const png = path.join(out, `effects-${f}.png`);
    await page.locator('.stage').screenshot({ path: png });
    shots.push({ f, png });
  }
  const file = path.join(out, 'effects.mp4');
  await h.exportTo(file, { fps: 30 });
  const at = (x) => ['-ss', (x / 30 - 0.005).toFixed(4), '-i', file];
  for (const { f, png } of shots) {
    const same = compareFrames(['-i', png], at(f), undefined, [48, 27]);
    const other = compareFrames(['-i', png], at(20), undefined, [48, 27]);
    console.log(`      effects frame ${f}: preview vs export ${same.toFixed(2)} (frame 20: ${other.toFixed(2)})`);
    assert(same < 8 && same < other * 0.7, `frame ${f}: preview and export differ (${same.toFixed(2)})`);
  }
});

await h.close();
process.exit(finish());
