/**
 * UI test for Phase 4: the media manager (remove unused, relink missing files from a folder,
 * collect files), project versions (save, restore, undo), proxy mode (the preview plays a
 * 960×540 copy of 1080p footage and still matches the export, which reads the original) and the
 * export queue (two queued exports, one in parallel parts, rendered from the timeline as it was
 * when queued while editing continues).
 *
 * Run: npm run test:e2e   (Linux without a display: xvfb-run -a npm run test:e2e)
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { assert, compareFrames, ff, fixture, launch, makeSteps, outputDir } from './harness.mjs';

const out = outputDir('manage');
const userData = path.join(out, 'userdata');
const grad = (s, r, g, b) => `nullsrc=s=${s}:r=30:d=4,format=rgb24,geq=r='${r}':g='${g}':b='${b}',scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv`;
const clip = (name, size, src, f0) => fixture(name, (f) => ff(['-f', 'lavfi', '-i', grad(size, ...src), '-f', 'lavfi', '-i', `sine=f=${f0}:d=4`,
  '-c:v', 'libx264', '-preset', 'veryfast', '-g', '15', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
  '-c:a', 'aac', '-shortest', f]));
const big = clip('mg-big.mp4', '1920x1080', ['40+50*T', '60+120*X/W', '200-150*Y/H'], 440);
const small = clip('mg-small.mp4', '1920x1080', ['220-150*X/W', '30+50*T', '60+100*Y/H'], 880);
const spare = clip('mg-spare.mp4', '640x360', ['128', '128', '50*T'], 660);
// Work on copies so files can be moved.
const src = path.join(out, 'src');
rmSync(src, { recursive: true, force: true });
rmSync(path.join(out, 'elsewhere'), { recursive: true, force: true });
rmSync(path.join(out, 'collected'), { recursive: true, force: true });
mkdirSync(src, { recursive: true });
for (const f of [big, small, spare]) cpSync(f, path.join(src, path.basename(f)));
const projectFile = path.join(out, 'Manage test.cutroom');
rmSync(projectFile, { force: true });
rmSync(path.join(out, 'Manage test versions'), { recursive: true, force: true });

const { step, finish } = makeSteps();
console.log('Cutroom media manager, versions, proxy mode and export queue UI test');
const h = await launch({ userData });
const { page } = h;
const st = () => page.evaluate(() => window.__cutroom.store.get());
const clips = async () => (await h.state()).sequence.items.filter((i) => i.kind === 'clip').length;
const dur = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());

await step('import three files, add two to the timeline, save the project', async () => {
  await h.stubOpen(['mg-big.mp4', 'mg-small.mp4', 'mg-spare.mp4'].map((n) => path.join(src, n)));
  await page.click('button:has-text("Import…")');
  await page.waitForFunction(() => window.__cutroom.store.get().project.media.length === 3);
  await page.click('.media-item >> nth=0 >> button:has-text("Add to timeline")');
  await page.click('.media-item >> nth=1 >> button:has-text("Add to timeline")');
  await page.keyboard.press('Escape');
  await h.stubSave(projectFile);
  await page.click('.topbar button:has-text("Save")');
  await page.waitForFunction(() => window.__cutroom.store.get().projectPath !== null);
  assert(existsSync(projectFile), 'project not saved');
});

await step('media manager: uses per file, remove the unused one (files on disk untouched)', async () => {
  await page.click('button:has-text("Manage…")');
  await page.waitForSelector('.modal.media-manager');
  assert(await page.locator('.modal.media-manager >> text=1 unused').isVisible(), 'unused count not shown');
  await page.click('.modal.media-manager button:has-text("Remove unused (1)")');
  const s = await st();
  assert(s.project.media.length === 2 && !s.project.media.some((m) => m.name === 'mg-spare.mp4'), JSON.stringify(s.project.media.map((m) => m.name)));
  assert(existsSync(path.join(src, 'mg-spare.mp4')), 'the file on disk was touched');
  await page.click('.modal.media-manager button[aria-label="Close"]');
  await page.click('.topbar button:has-text("Save")');
});

await step('relink: move the files, reopen (missing), relink both from a folder in one go', async () => {
  const dest = path.join(out, 'elsewhere', 'deep', 'er');
  mkdirSync(dest, { recursive: true });
  for (const n of ['mg-big.mp4', 'mg-small.mp4']) renameSync(path.join(src, n), path.join(dest, n));
  await h.stubOpen([projectFile]);
  await page.click('.topbar button:has-text("Open…")');
  await page.waitForFunction(() => Object.values(window.__cutroom.store.get().missing).filter(Boolean).length === 2);
  await page.click('button:has-text("Manage…")');
  assert(await page.locator('.modal.media-manager >> text=2 missing').isVisible(), 'missing count not shown');
  await h.stubOpen([path.join(out, 'elsewhere')]);
  await page.click('.modal.media-manager button:has-text("Relink missing from a folder…")');
  await page.waitForFunction(() => !Object.values(window.__cutroom.store.get().missing).some(Boolean));
  const s = await st();
  assert(s.project.media.every((m) => m.path.startsWith(dest)), JSON.stringify(s.project.media.map((m) => m.path)));
  await page.click('.modal.media-manager button[aria-label="Close"]');
  await h.seekFrame(150);
  await h.previewReady();
});

await step('collect files into a folder: copies used, originals kept, preview plays them', async () => {
  const coll = path.join(out, 'collected');
  mkdirSync(coll, { recursive: true });
  await page.click('button:has-text("Manage…")');
  await h.stubOpen([coll]);
  await page.click('.modal.media-manager button:has-text("Collect files into a folder…")');
  await page.waitForFunction((c) => window.__cutroom.store.get().project.media.every((m) => m.path.startsWith(c)), coll);
  assert(readdirSync(coll).sort().join() === 'mg-big.mp4,mg-small.mp4', readdirSync(coll).join());
  assert(existsSync(path.join(out, 'elsewhere', 'deep', 'er', 'mg-big.mp4')), 'original removed');
  await page.click('.modal.media-manager button[aria-label="Close"]');
  await h.seekFrame(60);
  await h.previewReady();
  const src0 = await page.evaluate(() => [...document.querySelectorAll('video.stage-video')].find((e) => e.style.display === 'block')?.src ?? '');
  assert(decodeURIComponent(src0).includes('collected'), src0);
  await page.click('.topbar button:has-text("Save")');
});

await step('versions: save one, change the edit, restore it, undo the restore', async () => {
  await page.click('.topbar button:has-text("Versions…")');
  await page.fill('input[aria-label="Version name"]', 'Two clips');
  await page.click('.modal.versions button:has-text("Save version")');
  await page.waitForSelector('.modal.versions td:has-text("Two clips")');
  const dir = path.join(out, 'Manage test versions');
  assert(readdirSync(dir).some((f) => f.endsWith('Two clips.cutroom')), readdirSync(dir).join());
  await page.click('.modal.versions button[aria-label="Close"]');
  // Change the edit: delete the first clip.
  await h.seekFrame(30);
  await page.click('.timeline .clip >> nth=0');
  await page.keyboard.press('Delete');
  await page.waitForFunction(() => window.__cutroom.store.get().project.sequence.items.filter((i) => i.kind === 'clip').length === 1);
  await page.click('.topbar button:has-text("Versions…")');
  await page.click('.modal.versions tr:has-text("Two clips") button:has-text("Restore")');
  await page.waitForFunction(() => window.__cutroom.store.get().project.sequence.items.filter((i) => i.kind === 'clip').length === 2);
  const s = await st();
  assert(s.projectPath === projectFile && s.dialog === null, `${s.projectPath} ${s.dialog}`);
  await page.click('.topbar button:has-text("Undo")');
  assert((await clips()) === 1, 'undo did not bring back the edit before restoring');
  await page.click('.topbar button:has-text("Redo")');
  assert((await clips()) === 2, 'redo');
});

let shots = [];
await step('proxy mode: the preview plays a 960×540 copy, and matches the export of the originals', async () => {
  await page.click('button:has-text("Proxy off")');
  await page.waitForFunction(() => {
    const s = window.__cutroom.store.get();
    return s.project.media.every((m) => s.proxies[`low:${m.id}`]?.status === 'ready');
  }, null, { timeout: 120000 });
  const s = await st();
  const low = s.proxies[`low:${s.project.media[0].id}`].path;
  const size = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', low]).toString().trim();
  assert(size === '960,540', size);
  assert(await page.locator('button:has-text("Proxy on")').isVisible(), 'toggle label');
  for (const f of [40, 165]) {
    await h.seekFrame(f);
    await h.previewReady();
    const vsrc = await page.evaluate(() => [...document.querySelectorAll('video.stage-video')].find((e) => e.style.display === 'block')?.src ?? '');
    assert(decodeURIComponent(vsrc).includes(path.basename(path.dirname(low))) && !decodeURIComponent(vsrc).includes('collected'), `preview is not the proxy: ${vsrc}`);
    await page.waitForTimeout(300);
    const png = path.join(out, `proxy-${f}.png`);
    await page.locator('.stage').screenshot({ path: png });
    shots.push({ f, png });
  }
  const file = path.join(out, 'proxy-export.mp4');
  await h.exportTo(file, { fps: 30 });
  const wh = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim();
  assert(wh === '1920,1080', `export used ${wh}`);
  const at = (x) => ['-ss', (x / 30 - 0.005).toFixed(4), '-i', file];
  for (const { f, png } of shots) {
    const same = compareFrames(['-i', png], at(f), undefined, [32, 18]);
    const other = compareFrames(['-i', png], at(f > 120 ? f - 120 : f + 120), undefined, [32, 18]);
    console.log(`    frame ${f}: preview vs export ${same.toFixed(2)}, vs the other clip ${other.toFixed(2)}`);
    assert(same < 6 && other > 2 * same, `frame ${f}: ${same.toFixed(2)} / ${other.toFixed(2)}`);
  }
  await page.click('button:has-text("Proxy on")');
  assert(!(await st()).proxyMode, 'proxy mode still on');
});

await step('export queue: two exports (one in parallel parts) render after each other from the timeline as queued', async () => {
  const q1 = path.join(out, 'queue-1.mp4');
  const q2 = path.join(out, 'queue-2.mp4');
  rmSync(q1, { force: true });
  rmSync(q2, { force: true });
  const queue = async (file, parallel) => {
    await page.click('.topbar button:has-text("Export…")');
    await page.waitForSelector('.modal.export');
    await h.stubSave(file);
    await page.click('.modal.export button:has-text("Choose…")');
    await page.selectOption('select[aria-label="Output frame rate"]', '30');
    if ((await page.isChecked('input[aria-label="Render in parallel parts"]')) !== parallel) await page.click('input[aria-label="Render in parallel parts"]');
    await page.click('.modal.export button:has-text("Add to queue")');
  };
  await queue(q1, true);
  await queue(q2, false);
  // The same file again is refused.
  await queue(q2, false);
  assert(await page.locator('.modal.export').isVisible(), 'a duplicate was queued');
  assert((await st()).exportQueue.length === 2, 'queue length');
  await page.click('.modal.export button:has-text("Cancel")');
  // Keep editing while the queue runs: the queued exports keep the 8 s timeline.
  await h.seekFrame(30);
  await page.click('.timeline .clip >> nth=0');
  await page.keyboard.press('Delete');
  assert((await clips()) === 1, 'edit during the queue');
  await page.click('.topbar button:has-text("Queue")');
  await page.waitForSelector('.modal.queue');
  await page.waitForFunction(() => window.__cutroom.store.get().exportQueue.every((q) => q.status === 'done' || q.status === 'failed'), null, { timeout: 240000 });
  const s = await st();
  assert(s.exportQueue.every((q) => q.status === 'done'), JSON.stringify(s.exportQueue.map((q) => q.result)).slice(0, 800));
  for (const f of [q1, q2]) assert(Math.abs(dur(f) - 8) < 0.1, `${path.basename(f)}: ${dur(f)} s`);
  assert(s.exportQueue[0].settings.parallel === true, 'first was not parallel');
  // The parallel one has the same frames as the one-pass one (both H.264, so compare decoded pictures).
  for (const f of [20, 130, 200]) {
    const d = compareFrames(['-ss', (f / 30).toFixed(3), '-i', q1], ['-ss', (f / 30).toFixed(3), '-i', q2]);
    assert(d < 2, `frame ${f}: parallel vs one-pass ${d.toFixed(2)}`);
  }
  assert(await page.locator('.modal.queue >> text=Done ✓').count() === 2, 'queue dialog');
  await page.screenshot({ path: path.join(out, 'queue.png') });
  await page.click('.modal.queue button:has-text("Clear finished")');
  assert((await st()).exportQueue.length === 0, 'clear finished');
  await page.click('.modal.queue button:has-text("Close")');
});

await h.close();
finish();
