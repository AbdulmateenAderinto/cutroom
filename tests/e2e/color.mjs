/**
 * UI test for colour adjustments in the real app: the sliders, live preview (SVG filter), undo,
 * reset, the preview's colours matching the export's for several settings, and curves (drag a
 * point in the editor, presets; preview vs export), a LUT on the media file, and an HDR file that
 * is tone-mapped by default (both: preview copy vs export).
 *
 * Run: npm run test:e2e   (Linux without a display: xvfb-run -a npm run test:e2e)
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { assert, ff, fixture, hasFilter, launch, makeSteps, outputDir } from './harness.mjs';

const out = outputDir('color');
const userData = path.join(out, 'userdata');
// Four flat patches (orange, teal, mid grey, dark red) so colours can be read back exactly.
const patches = ['0xe68c28', '0x28a096', '0x808080', '0x6e1e1e'];
const quad = patches.map((c, i) => `color=c=${c}:s=320x180:r=30:d=3[p${i}]`).join(';') + ';[p0][p1]hstack[t];[p2][p3]hstack[b];[t][b]vstack,format=yuv420p';
// The same patches as HDR10 (PQ, BT.2020, SDR white at the 203-nit reference white), 10-bit ProRes.
const quadRgb = patches.map((c, i) => `color=c=${c}:s=320x180:r=30:d=3[p${i}]`).join(';') + ';[p0][p1]hstack[t];[p2][p3]hstack[b];[t][b]vstack';
// Making the HDR fixture and tone mapping both need zscale (Homebrew's ffmpeg-full).
const HAS_ZSCALE = hasFilter('zscale');
const hdr = HAS_ZSCALE && fixture('color-quad-pq.mov', (f) => ff(['-f', 'lavfi', '-i', `${quadRgb},format=gbrpf32le,zscale=tin=bt709:pin=bt709:min=bt709:rin=full:t=smpte2084:p=bt2020:m=bt2020nc:r=tv:npl=203,format=yuv422p10le`,
  '-t', '3', '-c:v', 'prores_ks', '-profile:v', '3', '-color_trc', 'smpte2084', '-color_primaries', 'bt2020', '-colorspace', 'bt2020nc', f]));
// A 2×2×2 LUT swapping red and blue.
const lut = path.join(out, 'swap red-blue.cube');
const lutRows = [];
for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) lutRows.push(`${b} ${g} ${r}`);
writeFileSync(lut, `LUT_3D_SIZE 2\n${lutRows.join('\n')}\n`);
const video = fixture('color-quad.mp4', (f) => ff(['-f', 'lavfi', '-i', quad, '-f', 'lavfi', '-i', 'sine=d=3', '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f]));

const { step, finish } = makeSteps();
console.log('Cutroom colour adjustments UI test');
const h = await launch({ userData });
const { page } = h;
const clip = async () => (await h.state()).sequence.items[0];
const setSlider = (label, value) => page.locator(`.inspector input[aria-label="${label}"]`).evaluate((el, v) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(el, String(v));
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, value);
/** Average RGB of the middle of each quadrant of an image or video frame (8×8 area each). */
const quadrants = (args) => {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args, '-frames:v', '1', '-vf', 'scale=32:18:flags=area,format=rgb24', '-f', 'rawvideo', '-']);
  return [[8, 4], [24, 4], [8, 13], [24, 13]].map(([x, y]) => [0, 1, 2].map((k) => raw[(y * 32 + x) * 3 + k]));
};
const settingsList = [
  ['neutral', {}],
  ['vivid-warm', { Saturation: 1.6, Temperature: 0.8 }],
  ['dark-contrasty', { Exposure: -0.5, Contrast: 1.4 }],
  ['black-and-white', { Saturation: 0 }],
  ['hue-lightness', { Hue: 60, Lightness: 0.08 }],
];

await step('import, add and select the clip; Colour section shows neutral', async () => {
  await h.stubOpen([video]);
  await page.click('button:has-text("Import…")');
  await page.waitForFunction(() => window.__cutroom.store.get().project.media.length === 1);
  await page.click('.media-item >> nth=0 >> button:has-text("Add to timeline")');
  await page.click('.tl-track .clip >> nth=0');
  assert(await page.locator('.inspector h3:has-text("Colour")').isVisible(), 'Colour section missing');
  assert(!(await clip()).color, 'clip should start neutral');
});

await step('sliders change the clip and the preview filter; undo and Reset', async () => {
  await setSlider('Saturation', 0.4);
  assert((await clip()).color?.saturation === 0.4, JSON.stringify((await clip()).color));
  const filter = await page.evaluate(() => [...document.querySelectorAll('video.stage-video')].find((v) => v.style.display === 'block')?.style.filter);
  assert(/url\("#cutroom-cf\d+"\)/.test(filter), `preview filter: ${filter}`);
  await page.click('button:has-text("Undo")');
  assert(!(await clip()).color, 'undo did not restore neutral');
  await setSlider('Exposure', 1);
  await page.click('.inspector button:has-text("Reset")');
  assert(!(await clip()).color, 'Reset did not restore neutral');
});

await step('preview colours match the export for four settings', async () => {
  const shots = [];
  for (const [name, values] of settingsList) {
    await page.click('.tl-track .clip >> nth=0');
    if (await page.locator('.inspector button:has-text("Reset")').isVisible()) await page.click('.inspector button:has-text("Reset")');
    for (const [label, v] of Object.entries(values)) await setSlider(label, v);
    await page.keyboard.press('Escape');
    await h.seekFrame(30);
    await h.previewReady();
    await page.waitForTimeout(300);
    const png = path.join(out, `preview-${name}.png`);
    await page.locator('.stage').screenshot({ path: png });
    const file = path.join(out, `${name}.mp4`);
    await h.exportTo(file, { fps: 30 });
    shots.push({ name, png, file });
  }
  let worst = 0;
  for (const { name, png, file } of shots) {
    const a = quadrants(['-i', png]);
    const b = quadrants(['-ss', '0.995', '-i', file]);
    const err = Math.max(...a.flatMap((rgb, i) => rgb.map((v, k) => Math.abs(v - b[i][k]))));
    worst = Math.max(worst, err);
    console.log(`      ${name}: preview ${JSON.stringify(a)} export ${JSON.stringify(b)} (max diff ${err})`);
  }
  assert(worst <= 8, `preview and export colours differ by up to ${worst}`);
  // And the settings really do something (black-and-white is grey in the export).
  const bw = quadrants(['-ss', '0.995', '-i', shots[3].file]);
  assert(bw.every(([r, g, b]) => Math.abs(r - g) < 4 && Math.abs(g - b) < 4), `black-and-white not grey: ${JSON.stringify(bw)}`);
});

await step('curves: drag a point in the editor; presets; preview colours match the export', async () => {
  await page.click('.tl-track .clip >> nth=0');
  if (await page.locator('.inspector button:has-text("Reset")').isVisible()) await page.click('.inspector button:has-text("Reset")');
  // Click on the master curve at x = 0.5 and drag the new point up to y ≈ 0.7.
  await page.locator('svg.curves-box').scrollIntoViewIfNeeded();
  const box = await page.locator('svg.curves-box').boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.3, { steps: 5 });
  await page.mouse.up();
  let c = (await clip()).color;
  const pt = c?.curves?.master?.[0];
  assert(pt && Math.abs(pt[0] - 0.5) < 0.03 && Math.abs(pt[1] - 0.7) < 0.03, `curve point: ${JSON.stringify(c ?? null)}`);
  await page.click('button:has-text("Undo")');
  assert(!(await clip()).color?.curves, 'undo should remove the dragged point in one step');
  await page.click('.inspector .segmented button:has-text("Blue")');
  await page.click('.inspector button:has-text("Teal & orange")');
  c = (await clip()).color;
  assert(c?.curves?.r && c?.curves?.b, JSON.stringify(c));
  await setSlider('Hue', -20);
  const filter = await page.evaluate(() => {
    const v = [...document.querySelectorAll('video.stage-video')].find((e) => e.style.display === 'block');
    const id = /#([\w-]+)/.exec(v.style.filter)?.[1];
    const f = document.getElementById(id);
    return [...f.querySelectorAll('feFuncR, feFuncG, feFuncB')].map((x) => (x.getAttribute('tableValues') ?? '').split(' ').map(Number));
  });
  // Red and blue are curved; green's table is the straight line.
  const mid = (t) => t[77]; // x = 0.3: red → 0.26, blue → 0.36 in this preset
  assert(filter.length === 3 && filter.every((t) => t.length === 256), `tables: ${filter.map((t) => t.length)}`);
  assert(Math.abs(mid(filter[1]) - 77 / 255) < 0.002 && Math.abs(mid(filter[0]) - 0.26) < 0.01 && Math.abs(mid(filter[2]) - 0.36) < 0.01, `mid values ${filter.map(mid)}`);
  await page.keyboard.press('Escape');
  await h.seekFrame(30);
  await h.previewReady();
  await page.waitForTimeout(300);
  const png = path.join(out, 'preview-curves.png');
  await page.locator('.stage').screenshot({ path: png });
  const file = path.join(out, 'curves.mp4');
  await h.exportTo(file, { fps: 30 });
  const a = quadrants(['-i', png]);
  const b = quadrants(['-ss', '0.995', '-i', file]);
  const err = Math.max(...a.flatMap((rgb, i) => rgb.map((v, k) => Math.abs(v - b[i][k]))));
  console.log(`      curves: preview ${JSON.stringify(a)} export ${JSON.stringify(b)} (max diff ${err})`);
  assert(err <= 8, `preview and export colours differ by up to ${err}`);
});

/** Preview (stage screenshot) vs export colours of the clip at 1 s. */
async function previewVsExport(name) {
  await page.keyboard.press('Escape');
  await h.seekFrame(30);
  await h.previewReady();
  await page.waitForTimeout(300);
  const png = path.join(out, `preview-${name}.png`);
  await page.locator('.stage').screenshot({ path: png });
  const file = path.join(out, `${name}.mp4`);
  await h.exportTo(file, { fps: 30 });
  const a = quadrants(['-i', png]);
  const b = quadrants(['-ss', '0.995', '-i', file]);
  const err = Math.max(...a.flatMap((rgb, i) => rgb.map((v, k) => Math.abs(v - b[i][k]))));
  console.log(`      ${name}: preview ${JSON.stringify(a)} export ${JSON.stringify(b)} (max diff ${err})`);
  assert(err <= 8, `${name}: preview and export colours differ by up to ${err}`);
  return b;
}

await step('a LUT on the media file: the preview copy and the export both swap red and blue', async () => {
  await page.click('.tl-track .clip >> nth=0');
  if (await page.locator('.inspector button:has-text("Reset")').isVisible()) await page.click('.inspector button:has-text("Reset")');
  await page.click('.media-item >> nth=0');
  await h.stubOpen([lut]);
  await page.click('.inspector button:has-text("Choose .cube…")');
  await page.waitForFunction(() => window.__cutroom.store.get().project.media[0].input?.lut);
  const m = (await h.state()).media[0];
  assert(/^[0-9a-f]{40}\.cube$/.test(m.input.lut.file) && m.input.lut.name === 'swap red-blue.cube', JSON.stringify(m.input));
  await page.waitForFunction(() => Object.values(window.__cutroom.store.get().proxies).some((p) => p.status === 'ready' && p.source.includes('#lut:')), null, { timeout: 30000 });
  const b = await previewVsExport('lut');
  // Orange (230,140,40) comes out blue-ish.
  assert(b[0][2] > 200 && b[0][0] < 70, `LUT not applied: ${JSON.stringify(b[0])}`);
  await page.click('.media-item >> nth=0');
  await page.click('.inspector button:text-is("Remove")'); // the LUT's Remove (not "Remove from project")
  assert((await h.state()).media.length === 1 && !(await h.state()).media[0].input, 'LUT not removed');
});

if (!HAS_ZSCALE) console.log('  - skipped: HDR tone mapping (this FFmpeg has no zscale; brew install ffmpeg-full)');
else await step('an HDR file is tone-mapped by default; preview copy matches the export', async () => {
  await h.stubOpen([hdr]);
  await page.click('button:has-text("Import…")');
  await page.waitForFunction(() => window.__cutroom.store.get().project.media.length === 2);
  const m = (await h.state()).media[1];
  assert(m.info.isHDR && m.input?.toneMap === true, JSON.stringify({ hdr: m.info.isHDR, input: m.input }));
  // Replace the timeline with the HDR clip.
  await page.evaluate(() => window.__cutroom.store.set((s) => ({ project: { ...s.project, sequence: { items: [] } } })));
  await page.click('.media-item >> nth=1 >> button:has-text("Add to timeline")');
  await page.waitForFunction(() => Object.values(window.__cutroom.store.get().proxies).some((p) => p.status === 'ready' && p.source.includes('#tm1')), null, { timeout: 60000 });
  const b = await previewVsExport('hdr');
  // Close to the SDR patches (orange, teal, mid grey, dark red), not washed out.
  assert(b[0][0] > 190 && b[0][2] < 70 && Math.abs(b[2][0] - 128) < 25, `tone mapping: ${JSON.stringify(b)}`);
  await page.click('.media-item >> nth=1');
  assert(await page.locator('.inspector input[aria-label="Tone-map HDR to SDR"]').isChecked(), 'checkbox should be on');
});

await h.close();
process.exit(finish());
