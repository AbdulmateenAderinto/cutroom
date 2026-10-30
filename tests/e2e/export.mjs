/**
 * UI test for export options in the real app: mark a range with I / O, export it with constant
 * quality (CRF), presets (apply, save, survive a restart of the dialog, delete), and the hardware
 * encoder being offered only where it works.
 *
 * Run: npm run test:e2e   (Linux without a display: xvfb-run -a npm run test:e2e)
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { TPS, assert, compareFrames, ff, fixture, launch, makeSteps, outputDir } from './harness.mjs';

const out = outputDir('export');
const userData = path.join(out, 'userdata');
const video = fixture('export-src.mp4', (f) => ff(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=4', '-f', 'lavfi', '-i', 'sine=d=4',
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f]));

const { step, finish } = makeSteps();
console.log('Cutroom export options UI test');
const h = await launch({ userData });
const { page } = h;
let n = 0;
const snap = (label) => page.screenshot({ path: path.join(out, `${String(++n).padStart(2, '0')}-${label}.png`) });
const openExport = async () => {
  await page.click('.topbar button:has-text("Export…")');
  await page.waitForSelector('.modal.export');
};
const closeExport = () => page.click('.modal.export button:has-text("Cancel")');

await step('import and add a 4 s clip', async () => {
  await h.stubOpen([video]);
  await page.click('button:has-text("Import…")');
  await page.waitForFunction(() => window.__cutroom.store.get().project.media.length === 1);
  await page.click('.media-item >> nth=0 >> button:has-text("Add to timeline")');
});

await step('I and O mark a range (1 s – 2.5 s), shown on the ruler and toolbar', async () => {
  await page.keyboard.press('Escape');
  await h.seekFrame(30);
  await page.keyboard.press('i');
  await h.seekFrame(75);
  await page.keyboard.press('o');
  const m = await page.evaluate(() => window.__cutroom.store.get().marks);
  assert(m.in === 1 * TPS && m.out === 2.5 * TPS, JSON.stringify(m));
  assert(await page.locator('.tl-range').isVisible(), 'range not shown on the ruler');
  assert(await page.locator('.tl-toolbar .chip:has-text("Range")').isVisible(), 'range chip missing');
  await snap('range');
});

await step('export dialog: marked range selected; hardware encoder offered only if it works', async () => {
  await openExport();
  assert(await page.locator('.modal.export input[name="range"] >> nth=1').isChecked(), 'marked range should be preselected');
  assert(await page.locator('text=/Duration.*0:01.*\\(45 frames\\)/').isVisible(), 'duration should be the range (45 frames)');
  const hw = await page.evaluate(() => window.cutroom.encoders());
  const disabled = await page.locator('select[aria-label="Video encoder"] option[value="videotoolbox"]').isDisabled();
  assert(disabled === !hw.videotoolbox, `VideoToolbox option disabled=${disabled}, available=${hw.videotoolbox}`);
  if (!hw.videotoolbox) assert(await page.locator(`.modal.export >> text=${hw.reason.slice(0, 30)}`).isVisible(), 'reason not shown');
  console.log(`      hardware encoder here: ${hw.videotoolbox ? 'available' : `not available (${hw.reason})`}`);
});

await step('constant quality (CRF 24) export of the range: 45 frames, starting at timeline frame 30', async () => {
  const file = path.join(out, 'range-crf.mp4');
  await h.stubSave(file);
  await page.click('.modal.export button:has-text("Choose…")');
  await page.check('.modal.export input[name="rc"] >> nth=1');
  await page.locator('input[aria-label="Constant quality CRF"]').fill('24');
  assert(await page.locator('text=Constant quality: the size depends on the content').isVisible(), 'CRF size note missing');
  await snap('dialog-crf');
  await page.click('.modal.export button:has-text("Export")');
  await page.waitForSelector('text=/Export complete and verified|Export failed/', { timeout: 120000 });
  assert(await page.locator('text=CRF 24').isVisible(), 'result should mention CRF 24');
  await page.click('.modal.export button:has-text("Close")');
  const frames = Number(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file]).toString().trim());
  assert(frames === 45, `frames ${frames}`);
  // The first exported frame is source frame 30 (testsrc2 shows a running timer), not 29 or 31.
  const at = (f) => ['-ss', (f / 30 - 0.005).toFixed(4), '-i', video];
  const d30 = compareFrames(['-i', file], at(30));
  const d29 = compareFrames(['-i', file], at(29));
  const d31 = compareFrames(['-i', file], at(31));
  console.log(`      first frame vs source 30: ${d30.toFixed(2)} (29: ${d29.toFixed(2)}, 31: ${d31.toFixed(2)})`);
  assert(d30 < d29 && d30 < d31, 'first frame is not source frame 30');
});

await step('presets: apply a built-in, save your own, it survives reopening, delete it', async () => {
  await openExport();
  await page.selectOption('select[aria-label="Export preset"]', 'small720');
  assert((await page.inputValue('select[aria-label="Output resolution"]')) === '1280x720', 'preset did not set 720p');
  assert((await page.inputValue('input[aria-label="Target video bitrate in megabits per second"]')) === '4', 'preset bitrate');
  await page.selectOption('select[aria-label="Output resolution"]', { index: 0 });
  assert((await page.inputValue('select[aria-label="Export preset"]')) === '', 'changing a setting should switch to Custom settings');
  await page.click('.modal.export button:has-text("Save as preset…")');
  await page.fill('input[aria-label="Preset name"]', 'My master');
  await page.keyboard.press('Enter');
  await closeExport();
  await openExport();
  const opts = await page.locator('select[aria-label="Export preset"] optgroup[label="Saved"] option').allTextContents();
  assert(opts.includes('My master'), `saved presets: ${opts}`);
  await page.selectOption('select[aria-label="Export preset"]', { label: 'My master' });
  await page.click('.modal.export button:has-text("Delete preset")');
  assert((await page.locator('select[aria-label="Export preset"] optgroup[label="Saved"]').count()) === 0, 'preset not deleted');
  await closeExport();
});

await step('Alt+X clears the range; the dialog then exports the whole timeline', async () => {
  await page.keyboard.press('Alt+x');
  assert(!(await page.locator('.tl-range').isVisible()), 'range still shown');
  await openExport();
  assert(await page.locator('.modal.export input[name="range"] >> nth=0').isChecked(), 'whole timeline should be selected');
  assert(await page.locator('.modal.export input[name="range"] >> nth=1').isDisabled(), 'marked range should be disabled');
  await closeExport();
});

await h.close();
process.exit(finish());
