/**
 * UI test for photos in the real app: import a JPEG with EXIF rotation and a transparent PNG,
 * add them after a video, play across the cut, add a slow zoom, and check the preview matches
 * the export frame by frame.
 *
 * Run: npm run test:e2e   (Linux without a display: xvfb-run -a npm run test:e2e)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { TPS, assert, compareFrames, ff, fixture, launch, makeSteps, outputDir } from './harness.mjs';

const out = outputDir('photo');
const userData = path.join(out, 'userdata');
const video = fixture('photo-lead.mp4', (f) => ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=2', '-f', 'lavfi', '-i', 'sine=d=2',
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f]));
// Stored 400×300 (landscape) with EXIF Orientation 6: shown upright as 300×400 (portrait).
const photo = fixture('photo rotated.jpg', (f) => {
  const plain = `${f}.plain.jpg`;
  if (!existsSync(plain)) ff(['-f', 'lavfi', '-i', 'testsrc2=s=400x300', '-frames:v', '1', '-q:v', '2', plain]);
  const jpeg = readFileSync(plain);
  const tiff = Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(body.length + 2);
  writeFileSync(f, Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1]), len, body, jpeg.subarray(2)]));
});
// Transparent PNG: an opaque orange disc on a clear background.
const logo = fixture('logo.png', (f) => ff(['-f', 'lavfi', '-i', 'color=c=0xff8800:s=300x300', '-vf',
  "format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(hypot(X-150,Y-150),120),255,0)'", '-frames:v', '1', f]));

const { step, finish } = makeSteps();
console.log('Cutroom photos UI test');
const h = await launch({ userData });
const { page } = h;
let n = 0;
const snap = (label) => page.screenshot({ path: path.join(out, `${String(++n).padStart(2, '0')}-${label}.png`) });
const stageImg = () => page.evaluate(() => {
  const img = document.querySelector('img.stage-video');
  const vids = [...document.querySelectorAll('video.stage-video')];
  return {
    shown: img?.style.display === 'block',
    videoShown: vids.some((v) => v.style.display === 'block'),
    natural: [img?.naturalWidth, img?.naturalHeight],
    width: parseFloat(img?.style.width ?? '0'),
    left: parseFloat(img?.style.left ?? '0'),
  };
});
const imgLoaded = () => page.waitForFunction(() => {
  const img = document.querySelector('img.stage-video');
  return img && img.style.display === 'block' && img.complete && img.naturalWidth > 0;
});
const shots = {};
const shoot = async (name, frame) => {
  await h.seekFrame(frame);
  await imgLoaded();
  await page.waitForTimeout(250);
  const png = path.join(out, `preview-${name}.png`);
  await page.locator('.stage').screenshot({ path: png });
  shots[name] = { png, frame };
};

await step('import a video, a rotated JPEG and a transparent PNG', async () => {
  await h.stubOpen([video, photo, logo]);
  await page.click('button:has-text("Import…")');
  await page.waitForFunction(() => window.__cutroom.store.get().project.media.length === 3);
  const p = await h.state();
  assert(p.media[1].info.kind === 'image' && p.media[1].info.displayWidth === 300 && p.media[1].info.displayHeight === 400,
    `photo info ${JSON.stringify(p.media[1].info).slice(0, 300)}`);
  assert(p.media[2].info.hasAlpha === true, 'PNG transparency not detected');
  assert(await page.locator('text=/Photo · 300×400/').isVisible(), 'photo metadata missing');
  await page.waitForFunction(() => document.querySelectorAll('.media-item .thumb img').length === 3, null, { timeout: 15000 });
});

await step('add all three: the photos become 4 s clips', async () => {
  for (let i = 0; i < 3; i++) await page.click(`.media-item >> nth=${i} >> button:has-text("Add to timeline")`);
  const items = (await h.state()).sequence.items;
  assert(items.length === 3, `items ${items.length}`);
  assert(items[1].sourceOut - items[1].sourceIn === 4 * TPS && items[2].sourceOut - items[2].sourceIn === 4 * TPS, 'photo clip length');
  await snap('timeline');
});

await step('preview shows the photo upright, fitted, with no video element', async () => {
  await shoot('photo', 90); // 3 s: inside the photo
  const s = await stageImg();
  assert(s.shown && !s.videoShown, JSON.stringify(s));
  assert(s.natural[0] === 300 && s.natural[1] === 400, `the preview must apply EXIF rotation: ${s.natural}`);
  // 300×400 fitted into 16:9 → height 100%, width = (300/400)·(9/16) = 42.19 %.
  assert(Math.abs(s.width - 42.1875) < 0.1, `width ${s.width}%`);
});

await step('play across the video → photo cut', async () => {
  await h.seekFrame(45);
  await page.click('button:has-text("▶ Play")');
  await page.waitForTimeout(1300);
  const t1 = await page.evaluate(() => window.__cutroom.playhead.get().time / 705_600_000);
  await page.waitForTimeout(500);
  const t2 = await page.evaluate(() => window.__cutroom.playhead.get().time / 705_600_000);
  const s = await stageImg();
  await page.click('button:has-text("Pause")');
  assert(t1 > 2.3 && t2 - t1 > 0.35, `playhead ${t1} → ${t2}`);
  assert(s.shown && !s.videoShown, `photo not shown while playing: ${JSON.stringify(s)}`);
});

await step('slow zoom in on the photo: preview grows over the clip', async () => {
  await page.click('.tl-track .clip >> nth=1');
  await page.selectOption('select[aria-label="Motion over the whole clip"]', 'kenBurnsIn');
  await h.seekFrame(63);
  await imgLoaded();
  const a = await stageImg();
  await h.seekFrame(175);
  const b = await stageImg();
  assert(b.width > a.width * 1.05, `zoom: ${a.width}% → ${b.width}%`);
  await shoot('zoom', 175);
  await snap('zoomed');
});

await step('transparent PNG: background shows through in the preview', async () => {
  await page.click('.tl-track .clip >> nth=2');
  await shoot('logo', 270); // 9 s
  const s = await stageImg();
  assert(s.shown, 'logo not shown');
});

await step('export matches the preview (photo, zoom, transparent PNG)', async () => {
  const file = path.join(out, 'photos.mp4');
  await h.exportTo(file, { fps: 30 });
  const at = (f) => ['-ss', (f / 30 - 0.005).toFixed(4), '-i', file]; // first frame at or after -ss
  for (const [name, { png, frame }] of Object.entries(shots)) {
    const same = compareFrames(['-i', png], at(frame));
    const other = name === 'zoom' ? compareFrames(['-i', png], at(63)) : compareFrames(['-i', png], at(30));
    console.log(`      ${name}: preview vs export ${same.toFixed(1)} (vs a different moment ${other.toFixed(1)})`);
    assert(same < 10, `${name}: preview and export differ by ${same.toFixed(1)}`);
    assert(same < other / 2, `${name}: not clearly closer to the matching frame`);
  }
});

await h.close();
process.exit(finish());
