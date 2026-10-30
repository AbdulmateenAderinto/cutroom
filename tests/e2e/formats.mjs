/**
 * UI test for file formats in the real app: import ProRes (.mov), H.264 in .mkv, AIFF and TIFF,
 * see the "Preparing" progress and the stage message while preview copies are made, then check
 * the preview shows the same picture as the export (which reads the originals).
 *
 * Run: npm run test:e2e   (Linux without a display: xvfb-run -a npm run test:e2e)
 */
import path from 'node:path';
import { assert, compareFrames, ff, fixture, launch, makeSteps, outputDir } from './harness.mjs';

const out = outputDir('formats');
const userData = path.join(out, 'userdata');
// Smooth gradients whose blue changes over time: frames are easy to tell apart, and there are no
// hard edges for the stage-size vs output-size rescaling to blur differently.
const grad = (b) => `nullsrc=s=1280x720:r=30:d=3,format=rgb24,geq=r='255*X/W':g='255*Y/H':b='${b}',scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv`;
const src = grad('30+70*T');
const prores = fixture('fmt-ui-prores.mov', (f) => ff(['-f', 'lavfi', '-i', src,
  '-f', 'lavfi', '-i', 'sine=f=440:d=3', '-c:v', 'prores_ks', '-profile:v', '2', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-c:a', 'pcm_s16le', '-shortest', f]));
const mkv = fixture('fmt-ui.mkv', (f) => ff(['-f', 'lavfi', '-i', grad('230-70*T'), '-f', 'lavfi', '-i', 'sine=f=660:d=3', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-c:a', 'libopus', '-shortest', f]));
const aiff = fixture('fmt-ui.aiff', (f) => ff(['-f', 'lavfi', '-i', 'sine=f=880:d=6', '-c:a', 'pcm_s16be', f]));
const tiff = fixture('fmt-ui.tiff', (f) => ff(['-f', 'lavfi', '-i', "nullsrc=s=800x450,format=rgb24,geq=r='255-255*X/W':g='128':b='255*Y/H'", '-frames:v', '1', f]));

const { step, finish } = makeSteps();
console.log('Cutroom file formats UI test');
const h = await launch({ userData });
const { page } = h;
const state = () => page.evaluate(() => window.__cutroom.store.get());

await step('import ProRes .mov, H.264 .mkv, AIFF and TIFF: all accepted, preview copies are made', async () => {
  await h.stubOpen([prores, mkv, aiff, tiff]);
  await page.click('button:has-text("Import…")');
  await page.waitForFunction(() => window.__cutroom.store.get().project.media.length === 4, null, { timeout: 20000 });
  const s = await state();
  const modes = s.project.media.map((m) => m.info.preview ?? 'native');
  assert(JSON.stringify(modes) === JSON.stringify(['transcode', 'remux', 'audio', 'image']), JSON.stringify(modes));
  await page.waitForFunction(() => Object.values(window.__cutroom.store.get().proxies).filter((p) => p.status === 'ready').length === 4, null, { timeout: 60000 });
  await page.screenshot({ path: path.join(out, 'imported.png') });
});

await step('add everything; the preview shows the ProRes clip, the MKV and the TIFF', async () => {
  for (let i = 0; i < 4; i++) await page.click(`.media-item >> nth=${i} >> button:has-text("Add to timeline")`);
  const s = await state();
  assert(s.project.sequence.items.length === 3 && (s.project.audioTracks?.[0]?.clips.length ?? 0) === 1, 'video, mkv, photo on the video track; AIFF on an audio track');
  await page.keyboard.press('Escape');
});

const shots = [];
await step('preview frames (from the preview copies)', async () => {
  await page.addStyleTag({ content: '.toasts { display: none !important; }' }); // keep notifications out of the screenshots
  for (const [name, f] of [['prores', 20], ['mkv', 110], ['tiff', 200]]) {
    await h.seekFrame(f);
    if (name === 'tiff') await page.waitForFunction(() => document.querySelector('img.stage-video')?.style.display === 'block' && document.querySelector('img.stage-video').complete);
    else await h.previewReady();
    await page.waitForTimeout(400);
    const png = path.join(out, `preview-${name}.png`);
    await page.locator('.stage').screenshot({ path: png });
    shots.push({ name, f, png });
  }
  const msg = await page.locator('.stage-message').count();
  assert(msg === 0, 'a "preparing" or offline message is still shown');
});

await step('the export (from the originals) matches the preview', async () => {
  const file = path.join(out, 'formats.mp4');
  await h.exportTo(file, { fps: 30 });
  const at = (f) => ['-ss', (f / 30 - 0.005).toFixed(4), '-i', file];
  for (const { name, f, png } of shots) {
    // Coarse grid: the pattern's fine detail is rescaled differently at the stage and output sizes.
    const grid = [32, 18];
    const same = compareFrames(['-i', png], at(f), undefined, grid);
    const other = compareFrames(['-i', png], at(name === 'tiff' ? 20 : f + 45), undefined, grid); // a different picture
    console.log(`      ${name}: preview vs export ${same.toFixed(2)} (a different picture ${other.toFixed(2)})`);
    assert(same < 6 && same < other * 0.7, `${name}: preview and export differ (${same.toFixed(2)})`);
  }
});

await h.close();
process.exit(finish());
