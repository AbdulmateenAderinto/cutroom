/**
 * UI test for overlay tracks (picture-in-picture) in the real app: add a PiP from the Media panel,
 * see its V2 row, drag and resize it in the preview, use a position preset, move it on the
 * timeline, play (the overlay video follows the timeline), then check the preview matches the
 * export at several frames; then a green-screen clip keyed over the main track (preview copy with
 * transparency vs export).
 *
 * Run: npm run test:e2e   (Linux without a display: xvfb-run -a npm run test:e2e)
 */
import path from 'node:path';
import { TPS, assert, compareFrames, ff, fixture, launch, makeSteps, outputDir } from './harness.mjs';

const out = outputDir('overlays');
const userData = path.join(out, 'userdata');
// Smooth gradients that change over time (frames easy to tell apart, no hard edges to blur).
const grad = (r, g, b) => `nullsrc=s=1280x720:r=30:d=6,format=rgb24,geq=r='${r}':g='${g}':b='${b}',scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv`;
const enc = (src, freq) => (f) => ff(['-f', 'lavfi', '-i', src, '-f', 'lavfi', '-i', `sine=f=${freq}:d=6`, '-c:v', 'libx264', '-preset', 'veryfast', '-g', '15', '-pix_fmt', 'yuv420p',
  '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-c:a', 'aac', '-shortest', f]);
const main = fixture('ov-main.mp4', enc(grad('40+60*X/W', '40+60*Y/H', '60+20*T'), 440));
const cam = fixture('ov-cam.mp4', enc(grad('200+40*X/W', '80+30*T', '255*Y/H'), 880));
// A red disc moving on a green screen.
const screen = fixture('ov-greenscreen.mp4', (f) => ff(['-f', 'lavfi', '-i',
  "color=c=0x10d020:s=1280x720:r=30:d=6,format=rgb24,geq=r='if(lt(hypot(X-400-60*T\\,Y-360)\\,150)\\,224\\,16)':g='if(lt(hypot(X-400-60*T\\,Y-360)\\,150)\\,40\\,208)':b='if(lt(hypot(X-400-60*T\\,Y-360)\\,150)\\,40\\,32)',scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv",
  '-f', 'lavfi', '-i', 'sine=f=660:d=6', '-c:v', 'libx264', '-crf', '8', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-c:a', 'aac', '-shortest', f]));

const { step, finish } = makeSteps();
console.log('Cutroom overlay tracks (picture-in-picture) UI test');
const h = await launch({ userData });
const { page } = h;
const ov = async () => (await h.state()).overlays?.[0];
const overlayReady = () => page.waitForFunction(() => {
  const v = document.querySelector('.stage-overlays video');
  return v && v.style.display === 'block' && v.readyState >= 2 && !v.seeking;
});

await step('import two clips; add one to the timeline and the other as PiP at 1 s', async () => {
  await h.stubOpen([main, cam]);
  await page.click('button:has-text("Import…")');
  await page.waitForFunction(() => window.__cutroom.store.get().project.media.length === 2);
  await page.click('.media-item >> nth=0 >> button:has-text("Add to timeline")');
  await h.seekFrame(30);
  await page.click('.media-item >> nth=1 >> button:has-text("PiP")');
  const o = await ov();
  assert(o && o.start === 1 * TPS && o.row === 0 && o.framing.mode === 'manual', JSON.stringify(o));
  const sel = await page.evaluate(() => window.__cutroom.store.get().selection);
  assert(sel?.kind === 'overlay' && sel.id === o.id, 'the new overlay should be selected');
  assert(await page.locator('.tl-ov-row .ovclip').count() === 1, 'no V2 row on the timeline');
  assert(await page.locator('.inspector h2:has-text("Overlay clip")').isVisible(), 'overlay inspector not shown');
  await overlayReady();
  await page.screenshot({ path: path.join(out, 'added.png') });
});

await step('drag the PiP in the preview, resize it with the corner handle, then use “Top left”', async () => {
  const before = (await ov()).framing;
  const box = await page.locator('.frame-overlay').boundingBox();
  assert(box, 'framing handles not shown for the selected overlay');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2 - 60, { steps: 6 });
  await page.mouse.up();
  const moved = (await ov()).framing;
  assert(moved.x < before.x - 0.05 && moved.y < before.y - 0.05, `not moved: ${JSON.stringify([before, moved])}`);
  const hb = await page.locator('.frame-handle').boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + 60, hb.y + 40, { steps: 6 });
  await page.mouse.up();
  const bigger = (await ov()).framing;
  assert(bigger.scale > moved.scale * 1.1, `not resized: ${moved.scale} → ${bigger.scale}`);
  await page.click('.inspector button:has-text("Top left")');
  const tl = (await ov()).framing;
  assert(tl.x < 0 && tl.y < 0 && Math.abs(tl.scale - Math.min(1, bigger.scale)) < 1e-9, JSON.stringify(tl));
  // The main clip under the PiP is unchanged.
  const mainClip = (await h.state()).sequence.items[0];
  assert(mainClip.framing.mode === 'fit', 'main clip framing changed');
});

await step('drag the overlay on the timeline: it moves later', async () => {
  const b = await page.locator('.ovclip').boundingBox();
  const pps = await page.evaluate(() => window.__cutroom.store.get().pxPerSecond);
  await page.mouse.move(b.x + 20, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 20 + 0.5 * pps, b.y + b.height / 2, { steps: 5 });
  await page.mouse.up();
  const o = await ov();
  assert(Math.abs(o.start / TPS - 1.5) < 0.1, `start ${o.start / TPS}`);
  // Put it back at exactly 1 s with the inspector field (frame-exact for the comparison below).
  await page.evaluate(() => {
    const s = window.__cutroom.store.get();
    window.__cutroom.store.set({ project: { ...s.project, overlays: s.project.overlays.map((x) => ({ ...x, start: 705_600_000 })) } });
  });
});

await step('playback: the overlay video plays in step with the timeline', async () => {
  await h.seekFrame(20);
  await page.keyboard.press('Escape');
  await page.click('button:has-text("Play")');
  await page.waitForTimeout(1500);
  const r = await page.evaluate(() => ({ t: window.__cutroom.playhead.get().time / 705_600_000, ov: window.__cutroom.engine.overlayDebug }));
  await page.click('button:has-text("Pause")');
  const o = r.ov[0];
  assert(o?.shown && o.playing, JSON.stringify(r));
  const want = r.t - 1; // source time = timeline time − start (source in = 0)
  assert(Math.abs(o.time - want) < 0.15, `overlay at ${o.time.toFixed(3)} s, expected ${want.toFixed(3)} s`);
});

const shots = [];
await step('preview frames before, during and after scrubbing', async () => {
  await page.addStyleTag({ content: '.toasts { display: none !important; }' });
  await page.keyboard.press('Escape');
  for (const f of [15, 45, 100]) {
    await h.seekFrame(f);
    await h.previewReady();
    if (f >= 30) await overlayReady();
    await page.waitForTimeout(400);
    const png = path.join(out, `preview-${f}.png`);
    await page.locator('.stage').screenshot({ path: png });
    shots.push({ f, png });
  }
  const shown = await page.evaluate(() => window.__cutroom.engine.overlayDebug.filter((x) => x.shown).length);
  assert(shown === 1, 'overlay should be shown at frame 100');
});

await step('the export matches the preview (with and without the PiP)', async () => {
  const file = path.join(out, 'overlays.mp4');
  await h.exportTo(file, { fps: 30 });
  const at = (f) => ['-ss', (f / 30 - 0.005).toFixed(4), '-i', file];
  const grid = [32, 18];
  for (const { f, png } of shots) {
    const same = compareFrames(['-i', png], at(f), undefined, grid);
    const other = compareFrames(['-i', png], at(f === 15 ? 45 : 15), undefined, grid);
    console.log(`      frame ${f}: preview vs export ${same.toFixed(2)} (with/without the PiP ${other.toFixed(2)})`);
    assert(same < 5 && same < other * 0.6, `frame ${f}: preview and export differ (${same.toFixed(2)})`);
  }
});

await step('undo removes the edits; delete removes the overlay', async () => {
  await page.click('.ovclip');
  await page.keyboard.press('Delete');
  assert(((await h.state()).overlays ?? []).length === 0, 'delete did not remove the overlay');
  assert(await page.locator('.stage-overlays video').count() === 0, 'overlay element left in the preview');
  await page.click('button:has-text("Undo")');
  assert(((await h.state()).overlays ?? []).length === 1, 'undo did not bring it back');
});

await step('green screen: key the colour out of a full-frame overlay; the preview copy matches the export', async () => {
  await page.keyboard.press('Escape');
  await h.stubOpen([screen]);
  await page.click('button:has-text("Import…")');
  await page.waitForFunction(() => window.__cutroom.store.get().project.media.length === 3);
  await page.evaluate(() => window.__cutroom.store.set((st) => ({ project: { ...st.project, overlays: [] } })));
  await h.seekFrame(0);
  await page.click('.media-item >> nth=2 >> button:has-text("PiP")');
  await page.click('.inspector button:has-text("Full frame")');
  await page.click('.media-item >> nth=2');
  await page.click('.inspector input[aria-label="Key out a colour"]');
  await page.fill('.inspector input[aria-label="Key colour"]', '#10d020');
  const m = (await h.state()).media[2];
  assert(m.input?.key?.color === '#10d020', JSON.stringify(m.input));
  await page.waitForFunction(() => Object.values(window.__cutroom.store.get().proxies).some((p) => p.status === 'ready' && p.source.includes('key:#10d020')), null, { timeout: 90000 });
  // Back to the timeline (clicking the media item opened its source preview; Esc would go to the colour field).
  await page.evaluate(() => window.__cutroom.store.set({ previewMediaId: null, selection: null }));
  const shots = [];
  for (const f of [20, 75]) {
    await h.seekFrame(f);
    await h.previewReady();
    await page.waitForFunction(() => {
      const v = document.querySelector('.stage-overlays video');
      return v && v.style.display === 'block' && v.readyState >= 2 && !v.seeking && v.src.includes('.webm');
    }, null, { timeout: 20000 }).catch(async (e) => {
      console.log(await page.evaluate(() => ({ els: [...document.querySelectorAll('.stage-overlays > *')].map((v) => [v.tagName, v.style.display, v.readyState, v.seeking, v.src.slice(-60), v.error?.message]), dbg: window.__cutroom.engine.overlayDebug, proxies: window.__cutroom.store.get().proxies })));
      throw e;
    });
    await page.waitForTimeout(500);
    const png = path.join(out, `key-${f}.png`);
    await page.locator('.stage').screenshot({ path: png });
    shots.push({ f, png });
  }
  const file = path.join(out, 'key.mp4');
  await h.exportTo(file, { fps: 30 });
  const at = (x) => ['-ss', (x / 30 - 0.005).toFixed(4), '-i', file];
  for (const { f, png } of shots) {
    const same = compareFrames(['-i', png], at(f), undefined, [32, 18]);
    const other = compareFrames(['-i', png], at(f === 20 ? 75 : 20), undefined, [32, 18]);
    console.log(`      keyed frame ${f}: preview vs export ${same.toFixed(2)} (other moment ${other.toFixed(2)})`);
    assert(same < 8 && same < other * 0.7, `frame ${f}: preview and export differ (${same.toFixed(2)})`);
  }
});

await h.close();
process.exit(finish());
