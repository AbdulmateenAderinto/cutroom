/**
 * End-to-end UI test: launches the real Electron app and drives the milestone workflow with
 * Playwright — import 3 files → preview → add → trim → split → delete → reorder → undo/redo →
 * canvas presets → framing → playback across cuts → save → reopen → relink → export (verified
 * with ffprobe). Native file dialogs are stubbed; everything else goes through the UI.
 *
 * Run: npm run test:e2e   (on Linux without a display: xvfb-run -a npm run test:e2e)
 * Screenshots are written to tests/.output/e2e/.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { _electron as electron } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'tests/.output/e2e');
const fixtures = path.join(root, 'tests/.fixtures/e2e');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
mkdirSync(fixtures, { recursive: true });

const ff = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
function fixture(name, w, h, rate, seconds, freq) {
  const file = path.join(fixtures, name);
  if (!existsSync(file)) {
    ff(['-f', 'lavfi', '-i', `testsrc2=s=${w}x${h}:r=${rate}:d=${seconds}`, '-f', 'lavfi', '-i', `sine=f=${freq}:r=48000:d=${seconds}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-g', '30', '-c:a', 'aac', '-shortest', file]);
  }
  return file;
}
// Names with spaces and quotes check that paths are never pasted into a shell string.
const files = [
  fixture('landscape 720p.mp4', 1280, 720, 30, 5, 440),
  fixture("phone portrait 'B'.mp4", 720, 1280, 30, 4, 660),
  fixture('square (ntsc) clip.mov', 720, 720, '30000/1001', 4, 880),
];

const results = [];
let shot = 0;
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: String(e?.message ?? e) });
    console.log(`  ✗ ${name}\n      ${String(e?.message ?? e).split('\n').join('\n      ')}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const userData = path.join(out, 'userdata');
const app = await electron.launch({
  executablePath: electronPath,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', root],
  env: { ...process.env, CUTROOM_USER_DATA: userData },
});
const page = await app.firstWindow();
await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
page.on('dialog', (d) => d.accept()); // confirm() prompts such as “discard unsaved changes?”
await page.waitForSelector('.topbar');
const snap = async (label) => page.screenshot({ path: path.join(out, `${String(++shot).padStart(2, '0')}-${label}.png`) });
const state = () => page.evaluate(() => {
  const s = window.__cutroom.store.get();
  return { project: s.project, selection: s.selection, missing: s.missing, dirty: s.project !== s.savedProject };
});
const stubOpen = (paths) => app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: p }); }, paths);
const stubSave = (p) => app.evaluate(({ dialog }, fp) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: fp }); }, p);
const clipBoxes = () => page.$$eval('.tl-track .clip', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cls: e.className }; }));
const TPS = 705_600_000;
async function waitForExport() {
  await page.waitForSelector('text=/Export complete and verified|Export failed/', { timeout: 120000 });
  if (await page.locator('text=Export failed').isVisible()) {
    const msg = await page.locator('.modal.export .modal-body p').first().textContent();
    await page.click('.modal.export button:has-text("Close")');
    throw new Error(`export failed: ${msg}`);
  }
}

console.log('Cutroom UI smoke test');

await step('app starts and FFmpeg is detected', async () => {
  await page.waitForFunction(() => window.__cutroom.store.get().ffmpeg !== null);
  const ok = await page.evaluate(() => window.__cutroom.store.get().ffmpeg.ok);
  assert(ok, 'ffmpeg not ok');
  assert(await page.locator('text=Your timeline is empty').isVisible(), 'empty state missing');
  await snap('empty');
});

await step('import three files with the Import button', async () => {
  await stubOpen(files);
  await page.click('button:has-text("Import…")');
  await page.waitForFunction(() => window.__cutroom.store.get().project.media.length === 3, null, { timeout: 20000 });
  await page.waitForFunction(() => Object.keys(window.__cutroom.store.get().thumbs).length === 3, null, { timeout: 20000 });
  const names = await page.$$eval('.media-name', (els) => els.map((e) => e.textContent));
  assert(names.join('|') === files.map((f) => path.basename(f)).join('|'), `media order: ${names}`);
  await snap('imported');
});

await step('preview a source file (plays, picture advances)', async () => {
  await page.click('.media-item >> nth=0');
  await page.waitForSelector('text=Source:');
  await page.click('button:has-text("▶ Play")');
  await page.waitForTimeout(1200);
  const t = await page.evaluate(() => window.__cutroom.playhead.get().time);
  await page.click('button:has-text("Pause")');
  assert(t > 0.5 * TPS, `source playhead only reached ${t / TPS}s`);
  // After pausing, the preview snaps to an exact frame (a short seek); wait for it to finish.
  await page.waitForFunction(() => [...document.querySelectorAll('video')].some((e) => e.style.display === 'block' && e.readyState >= 2 && !e.seeking), null, { timeout: 5000 });
  const v = await page.evaluate(() => { const el = [...document.querySelectorAll('video')].find((e) => e.style.display === 'block'); return el ? { w: el.videoWidth, rs: el.readyState, err: el.error?.code ?? null } : null; });
  assert(v && v.w === 1280 && v.rs >= 2, `video element: ${JSON.stringify(v)}`);
  await snap('source-preview');
  await page.click('button:has-text("Back to timeline")');
});

await step('add all three to the timeline', async () => {
  for (let i = 0; i < 3; i++) await page.click(`.media-item >> nth=${i} >> button:has-text("Add to timeline")`);
  const s = await state();
  assert(s.project.sequence.items.length === 3, 'expected 3 clips');
  const total = s.project.sequence.items.reduce((a, c) => a + (c.sourceOut - c.sourceIn), 0) / TPS;
  assert(Math.abs(total - 13) < 0.1, `total ${total}`);
  await page.click('button:has-text("Fit")');
  await snap('three-clips');
});

await step('trim the end of clip 1 by dragging its right edge', async () => {
  const [c1] = await clipBoxes();
  const before = (await state()).project.sequence.items[0];
  await page.mouse.move(c1.x + c1.w - 3, c1.y + c1.h / 2);
  await page.mouse.down();
  await page.mouse.move(c1.x + c1.w - 60, c1.y + c1.h / 2, { steps: 6 });
  await page.mouse.up();
  const after = (await state()).project.sequence.items[0];
  assert(after.sourceOut < before.sourceOut && after.sourceIn === before.sourceIn, 'end trim did not apply');
  const frames = ((after.sourceOut - after.sourceIn) * 30) / TPS;
  assert(Math.abs(frames - Math.round(frames)) < 1e-6, `duration not frame aligned: ${frames}`);
});

await step('trim the start of clip 2 by dragging its left edge', async () => {
  const boxes = await clipBoxes();
  const c2 = boxes[1];
  const before = (await state()).project.sequence.items[1];
  await page.mouse.move(c2.x + 3, c2.y + c2.h / 2);
  await page.mouse.down();
  await page.mouse.move(c2.x + 40, c2.y + c2.h / 2, { steps: 6 });
  await snap('trimming-start');
  await page.mouse.up();
  const after = (await state()).project.sequence.items[1];
  assert(after.sourceIn > before.sourceIn && after.sourceOut === before.sourceOut, `start trim: ${JSON.stringify([before.sourceIn, after.sourceIn, before.sourceOut, after.sourceOut])}`);
});

await step('exact numeric trim in the Clip panel (source in = 00:00:00:15)', async () => {
  await page.click('.tl-track .clip >> nth=0');
  const input = page.locator('.inspector label:has-text("Source in") input');
  await input.fill('00:00:00:15');
  await input.press('Enter');
  const c = (await state()).project.sequence.items[0];
  assert(c.sourceIn === 15 * TPS / 30, `sourceIn ${c.sourceIn / TPS}`);
  await page.click('.inspector label:has-text("Duration") button[title="One frame later"]');
  const c2 = (await state()).project.sequence.items[0];
  assert(c2.sourceOut - c2.sourceIn === c.sourceOut - c.sourceIn + TPS / 30, '+1f did not add a frame');
  await snap('clip-inspector');
});

await step('split at the playhead with the toolbar button', async () => {
  const items = (await state()).project.sequence.items;
  const d0 = items[0].sourceOut - items[0].sourceIn;
  await page.evaluate((t) => window.__cutroom.engine.seek(t), Math.round(d0 / 2 / (TPS / 30)) * (TPS / 30));
  await page.click('.tl-toolbar button:has-text("Split")');
  const after = (await state()).project.sequence.items;
  assert(after.length === 4, `items after split: ${after.length}`);
  assert(after[0].sourceOut === after[1].sourceIn, 'split halves are not contiguous in source time');
});

await step('delete (close gap) and delete (leave gap)', async () => {
  await page.click('.tl-track .clip >> nth=1');
  await page.click('.tl-toolbar button:has-text("Delete, leave gap")');
  let kinds = (await state()).project.sequence.items.map((i) => i.kind);
  assert(kinds.join() === 'clip,gap,clip,clip', kinds.join());
  await snap('gap');
  await page.click('.tl-track .clip.gap');
  await page.keyboard.press('Delete');
  kinds = (await state()).project.sequence.items.map((i) => i.kind);
  assert(kinds.join() === 'clip,clip,clip', kinds.join());
});

await step('reorder by dragging a clip', async () => {
  const before = (await state()).project.sequence.items.map((i) => i.id);
  const boxes = await clipBoxes();
  const last = boxes[2];
  await page.mouse.move(last.x + last.w / 2, last.y + last.h / 2);
  await page.mouse.down();
  await page.mouse.move(boxes[0].x + 5, last.y + last.h / 2, { steps: 10 });
  await snap('reordering');
  await page.mouse.up();
  const after = (await state()).project.sequence.items.map((i) => i.id);
  assert(after[0] === before[2], `order ${after}`);
});

await step('undo and redo', async () => {
  const s0 = (await state()).project.sequence.items.map((i) => i.id).join();
  await page.click('button:has-text("Undo")');
  const s1 = (await state()).project.sequence.items.map((i) => i.id).join();
  assert(s1 !== s0, 'undo did nothing');
  await page.click('button:has-text("Redo")');
  const s2 = (await state()).project.sequence.items.map((i) => i.id).join();
  assert(s2 === s0, 'redo did not restore');
});

await step('duplicate', async () => {
  await page.click('.tl-track .clip >> nth=0');
  await page.click('.tl-toolbar button:has-text("Duplicate")');
  const items = (await state()).project.sequence.items;
  assert(items.length === 4 && items[1].mediaId === items[0].mediaId, 'duplicate failed');
  await page.click('button:has-text("Undo")');
});

await step('canvas presets: 9:16, 1:1, 4:5, custom, match source, 16:9', async () => {
  const sel = page.locator('.topbar select[aria-label="Canvas preset"]');
  for (const [preset, w, h] of [['9:16', 1080, 1920], ['1:1', 1080, 1080], ['4:5', 1080, 1350]]) {
    await sel.selectOption(preset);
    const c = (await state()).project.canvas;
    assert(c.width === w && c.height === h, `${preset}: ${c.width}x${c.height}`);
    if (preset === '9:16') await snap('canvas-portrait');
  }
  const wIn = page.locator('.topbar input[aria-label="Canvas width"]');
  await wIn.fill('1001');
  await wIn.press('Enter');
  let c = (await state()).project.canvas;
  assert(c.preset === 'custom' && c.width === 1002, `custom: ${JSON.stringify(c)}`);
  await page.click('.tl-track .clip >> nth=0');
  await sel.selectOption('match');
  c = (await state()).project.canvas;
  assert(c.preset === 'match' && c.width > 0, `match: ${JSON.stringify(c)}`);
  await sel.selectOption('16:9');
});

await step('framing: Fill, then Manual by dragging in the preview', async () => {
  await page.locator('.topbar select[aria-label="Canvas preset"]').selectOption('9:16');
  // select the portrait clip? use the first clip (landscape) — fit shows bars in a portrait canvas
  await page.evaluate(() => window.__cutroom.engine.seek(5 * 705_600_000 / 30));
  const clipUnder = await page.evaluate(() => {
    const s = window.__cutroom.store.get();
    let t = 0; const now = window.__cutroom.playhead.get().time;
    for (const it of s.project.sequence.items) { const d = it.kind === 'clip' ? it.sourceOut - it.sourceIn : it.duration; if (now >= t && now < t + d) return it.id; t += d; }
    return null;
  });
  await page.evaluate((id) => window.__cutroom.store.set({ selection: { kind: 'item', id } }), clipUnder);
  await snap('fit-in-portrait');
  await page.click('.inspector .segmented button:has-text("Fill")');
  let f = (await state()).project.sequence.items.find((i) => i.id === clipUnder).framing;
  assert(f.mode === 'fill', 'fill not set');
  await snap('fill-in-portrait');
  const box = await page.locator('.frame-overlay').boundingBox();
  const stage = await page.locator('.stage').boundingBox();
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
  await page.mouse.down();
  await page.mouse.move(stage.x + stage.width / 2 + 40, stage.y + stage.height / 2 + 30, { steps: 5 });
  await page.mouse.up();
  f = (await state()).project.sequence.items.find((i) => i.id === clipUnder).framing;
  assert(f.mode === 'manual' && f.x > 0 && f.y > 0, `manual framing ${JSON.stringify(f)}`);
  assert(box, 'no frame overlay');
  const scaleIn = page.locator('.inspector label:has-text("Scale") input');
  await scaleIn.fill('150');
  await scaleIn.press('Enter');
  f = (await state()).project.sequence.items.find((i) => i.id === clipUnder).framing;
  assert(Math.abs(f.scale - 1.5) < 1e-9, `scale ${f.scale}`);
  await snap('manual-framing');
});

await step('timeline playback crosses cuts and keeps the media clock', async () => {
  const items = (await state()).project.sequence.items;
  const firstEnd = items[0].sourceOut - items[0].sourceIn;
  await page.evaluate((t) => window.__cutroom.engine.seek(t), firstEnd - Math.round(0.5 * TPS));
  await page.keyboard.press('Space');
  await page.waitForTimeout(1500);
  const info = await page.evaluate(() => {
    const t = window.__cutroom.playhead.get().time;
    const playing = window.__cutroom.playhead.get().playing;
    const el = [...document.querySelectorAll('video')].find((e) => e.style.display === 'block');
    return { t, playing, src: el ? decodeURIComponent(el.src) : null, ct: el?.currentTime ?? null, paused: el?.paused };
  });
  await page.keyboard.press('Space');
  assert(info.playing, 'stopped playing');
  assert(info.t > firstEnd + 0.4 * TPS, `playhead ${info.t / TPS}s did not pass the cut at ${firstEnd / TPS}s`);
  const second = items[1];
  const media = (await state()).project.media.find((m) => m.id === second.mediaId);
  assert(info.src && info.src.endsWith(media.path), `active video is not clip 2's file: ${info.src}`);
  const expectedSource = (second.sourceIn + (info.t - firstEnd)) / TPS;
  assert(Math.abs(info.ct - expectedSource) < 0.1, `media time ${info.ct} vs timeline-derived ${expectedSource}`);
});

const projectFile = path.join(out, 'My Project.cutroom');
await step('save project', async () => {
  await stubSave(projectFile);
  await page.click('.topbar button:has-text("Save")');
  await page.waitForFunction(() => window.__cutroom.store.get().projectPath !== null);
  const saved = JSON.parse(readFileSync(projectFile, 'utf8'));
  assert(saved.format === 'cutroom-project' && saved.version === 5, 'bad header');
  assert(saved.sequence.items.length === 3 && saved.media.every((m) => m.relativePath), 'bad content');
  assert(!(await state()).dirty, 'still dirty after save');
});

await step('new project, then reopen the saved project (round trip)', async () => {
  const before = (await state()).project;
  await page.click('.topbar button:has-text("New")');
  assert((await state()).project.sequence.items.length === 0, 'new project not empty');
  await stubOpen([projectFile]);
  await page.click('.topbar button:has-text("Open…")');
  await page.waitForFunction(() => window.__cutroom.store.get().project.sequence.items.length === 3);
  const after = (await state()).project;
  const strip = (p) => JSON.stringify({ ...p, media: p.media.map(({ relativePath, ...m }) => m) });
  assert(strip(after) === strip({ ...before, name: after.name }), 'reopened project differs');
  await snap('reopened');
});

await step('missing media is reported and can be relinked', async () => {
  const moved = files[1].replace('.mp4', ' (moved).mp4');
  renameSync(files[1], moved);
  try {
    await page.click('.topbar button:has-text("New")');
    await stubOpen([projectFile]);
    await page.click('.topbar button:has-text("Open…")');
    await page.waitForFunction(() => Object.values(window.__cutroom.store.get().missing).some(Boolean));
    await snap('missing-media');
    await stubOpen([moved]);
    await page.click('.media-item.missing >> button:has-text("Relink…")');
    await page.waitForFunction(() => !Object.values(window.__cutroom.store.get().missing).some(Boolean));
    const m = (await state()).project.media.find((x) => x.path === moved);
    assert(m, 'relinked path not stored');
  } finally {
    renameSync(moved, files[1]);
  }
  // Point the project back at the original file name for the export step.
  await page.click('.topbar button:has-text("New")');
  await stubOpen([projectFile]);
  await page.click('.topbar button:has-text("Open…")');
  await page.waitForFunction(() => window.__cutroom.store.get().project.sequence.items.length === 3);
});

const exportFile = path.join(out, 'export test.mp4');
await step('export MP4 with chosen resolution, frame rate and bitrate', async () => {
  await page.click('.topbar button:has-text("Export…")');
  await page.waitForSelector('.modal.export');
  await stubSave(exportFile);
  await page.click('.modal.export button:has-text("Choose…")');
  await page.selectOption('select[aria-label="Output resolution"]', { label: '720p (720×1280)' });
  await page.selectOption('select[aria-label="Output frame rate"]', '25');
  await page.fill('input[aria-label="Target video bitrate in megabits per second"]', '3');
  await snap('export-dialog');
  await page.click('.modal.export button:has-text("Export")');
  await waitForExport();
  await snap('export-done');
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', exportFile]).toString());
  const v = probe.streams.find((s) => s.codec_type === 'video');
  const a = probe.streams.find((s) => s.codec_type === 'audio');
  assert(v.codec_name === 'h264' && v.width === 720 && v.height === 1280 && v.r_frame_rate === '25/1', JSON.stringify([v.codec_name, v.width, v.height, v.r_frame_rate]));
  assert(a.codec_name === 'aac' && a.sample_rate === '48000', 'audio');
  const items = (await state()).project.sequence.items;
  const dur = items.reduce((s, c) => s + (c.sourceOut - c.sourceIn), 0) / TPS;
  assert(Math.abs(Number(probe.format.duration) - dur) < 0.1, `duration ${probe.format.duration} vs ${dur}`);
  assert(!existsSync(exportFile + '.partial'), 'partial left behind');
  await page.click('.modal.export button:has-text("Close")');
});

await step('export with different aspect requires an explicit fit/fill choice', async () => {
  await page.click('.topbar button:has-text("Export…")');
  await page.selectOption('select[aria-label="Output resolution"]', 'custom');
  await page.fill('input[aria-label="Output width"]', '1920');
  await page.fill('input[aria-label="Output height"]', '1080');
  await page.locator('input[aria-label="Output height"]').blur();
  await stubSave(path.join(out, 'aspect.mp4'));
  await page.click('.modal.export button:has-text("Choose…")');
  assert(await page.locator('text=Choose how the canvas fits').isVisible(), 'no explicit mapping prompt');
  assert(await page.locator('.modal.export button:has-text("Export")').isDisabled(), 'export enabled without a choice');
  await page.click('text=Fit — show the whole canvas');
  assert(await page.locator('.modal.export button:has-text("Export")').isEnabled(), 'export still disabled');
  await snap('export-aspect-choice');
  await page.click('.modal.export button:has-text("Cancel")');
});

await step('cancel a running export leaves no file', async () => {
  const cancelFile = path.join(out, 'cancelled.mp4');
  await page.click('.topbar button:has-text("Export…")');
  await stubSave(cancelFile);
  await page.click('.modal.export button:has-text("Choose…")');
  await page.click('summary:has-text("Advanced")');
  await page.selectOption('select[aria-label="Encoder speed preset"]', 'slow');
  await page.click('.modal.export button:has-text("Export")');
  await page.waitForSelector('button:has-text("Cancel export")');
  await page.waitForTimeout(400);
  await page.click('button:has-text("Cancel export")');
  await page.waitForSelector('text=Export cancelled', { timeout: 20000 });
  assert(!existsSync(cancelFile) && !existsSync(cancelFile + '.partial'), 'files left after cancel');
  await snap('export-cancelled');
  await page.click('.modal.export button:has-text("Close")');
});

await step('preview matches export (rotated clip, manual framing, padding colour)', async () => {
  // Rotated phone-style file: left half dark, right half bright, with 90° rotation metadata.
  const base = path.join(fixtures, 'halves.mp4');
  const rotated = path.join(fixtures, 'rotated phone.mp4');
  if (!existsSync(rotated)) {
    ff(['-f', 'lavfi', '-i', 'nullsrc=s=640x360:r=30:d=2,format=yuv420p,geq=lum=if(lt(X\\,320)\\,40\\,210):cb=if(lt(Y\\,90)\\,200\\,128):cr=128',
      '-f', 'lavfi', '-i', 'sine=d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', base]);
    ff(['-display_rotation', '90', '-i', base, '-c', 'copy', rotated]);
  }
  await page.click('.topbar button:has-text("New")');
  await stubOpen([rotated]);
  await page.click('button:has-text("Import…")');
  await page.waitForFunction(() => window.__cutroom.store.get().project.media.length === 1);
  await page.click('.media-item >> button:has-text("Add to timeline")');
  await page.locator('.topbar select[aria-label="Canvas preset"]').selectOption('1:1');
  await page.evaluate(() => window.__cutroom.store.set({ selection: null }));
  await page.locator('.inspector input[type="color"]').evaluate((el) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, '#ff0000');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('.tl-track .clip >> nth=0');
  await page.click('.inspector .segmented button:has-text("Manual")');
  for (const [label, value] of [['Scale', '70'], ['X offset', '180'], ['Y offset', '-90']]) {
    const input = page.locator(`.inspector label:has-text("${label}") input`).first();
    await input.fill(value);
    await input.press('Enter');
  }
  const v = await page.evaluate(() => { const el = document.querySelectorAll('video')[0]; return [el.videoWidth, el.videoHeight]; });
  await page.evaluate(() => window.__cutroom.engine.seek(15 * 705_600_000 / 30));
  await page.evaluate(() => window.__cutroom.store.set({ selection: null })); // hide the selection outline
  await page.waitForFunction(() => [...document.querySelectorAll('video')].some((e) => e.style.display === 'block' && e.readyState >= 2 && !e.seeking));
  await page.waitForTimeout(300);
  const previewPng = path.join(out, 'compare-preview.png');
  await page.locator('.stage').screenshot({ path: previewPng });
  await snap('rotated-manual');

  const exported = path.join(out, 'compare.mp4');
  await page.click('.topbar button:has-text("Export…")');
  await stubSave(exported);
  await page.click('.modal.export button:has-text("Choose…")');
  await page.click('.modal.export button:has-text("Export")');
  await waitForExport();
  await page.click('.modal.export button:has-text("Close")');

  // Compare at 64×64 (removes sub-pixel/scaling noise), mean absolute RGB difference 0..255.
  const raw = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args, '-vf', 'scale=64:64:flags=area,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-']);
  const a = raw(['-i', previewPng]);
  const b = raw(['-i', exported, '-ss', '0.5']);
  const fitRef = raw(['-i', base, '-ss', '0.5']); // the same footage without rotation/framing, as a sanity reference
  const mad = (x, y) => x.reduce((s, val, i) => s + Math.abs(val - y[i]), 0) / x.length;
  const diff = mad(a, b);
  const control = mad(a, fitRef);
  console.log(`      preview vs export: ${diff.toFixed(2)} / 255 (control, unframed source: ${control.toFixed(2)}); video element ${v[0]}×${v[1]}`);
  assert(diff < 6, `preview and export differ (mean abs diff ${diff.toFixed(2)})`);
  assert(control > 30, 'comparison is not sensitive enough');
});

await step('animation: presets and keyframes via the UI; animated preview matches export', async () => {
  // Continues with the rotated, manually framed clip from the previous step (2 s long, red background).
  await page.click('.tl-track .clip >> nth=0');
  await page.selectOption('select[aria-label="In animation"]', 'zoom');
  await page.selectOption('select[aria-label="Motion over the whole clip"]', 'panRight');
  await page.evaluate(() => window.__cutroom.engine.seek(30 * 705_600_000 / 30));
  const setField = async (label, value) => {
    const input = page.locator(`.inspector .kf-row label:has-text("${label}") input`);
    await input.fill(value);
    await input.press('Enter');
  };
  await setField('Move X', '-120');
  await page.evaluate(() => window.__cutroom.engine.seek(50 * 705_600_000 / 30));
  await setField('Move X', '60');
  await setField('Opacity', '70');
  const anim = await page.evaluate(() => window.__cutroom.store.get().project.sequence.items[0].animation);
  assert(anim.in?.preset === 'zoom' && anim.motion?.preset === 'panRight', `presets ${JSON.stringify(anim)}`);
  assert(anim.keyframes.x.length === 2 && anim.keyframes.opacity.length === 1, `keyframes ${JSON.stringify(anim.keyframes)}`);
  assert((await page.locator('.tl-track .kf-mark').count()) === 2, 'keyframe markers missing on the timeline');
  assert((await page.locator('.tl-track .anim-zone.in').count()) === 1, 'in-animation zone missing on the timeline');
  await snap('animation-panel');

  const frames = [9, 40];
  const shots = [];
  for (const f of frames) {
    await page.evaluate((fr) => window.__cutroom.engine.seek(fr * 705_600_000 / 30), f);
    await page.evaluate(() => window.__cutroom.store.set({ selection: null }));
    await page.waitForFunction(() => [...document.querySelectorAll('video')].some((e) => e.style.display === 'block' && e.readyState >= 2 && !e.seeking));
    await page.waitForTimeout(300);
    const png = path.join(out, `anim-preview-${f}.png`);
    await page.locator('.stage').screenshot({ path: png });
    shots.push(png);
  }
  const exported = path.join(out, 'anim.mp4');
  await page.click('.topbar button:has-text("Export…")');
  await stubSave(exported);
  await page.click('.modal.export button:has-text("Choose…")');
  // The dialog remembers the previous export's settings; compare at the project's own rate.
  await page.selectOption('select[aria-label="Output frame rate"]', '30');
  await page.fill('input[aria-label="Target video bitrate in megabits per second"]', '12');
  await page.click('.modal.export button:has-text("Export")');
  await waitForExport();
  await page.click('.modal.export button:has-text("Close")');
  const raw = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args, '-vf', 'scale=64:64:flags=area,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-']);
  const mad = (x, y) => x.reduce((s, val, i) => s + Math.abs(val - y[i]), 0) / x.length;
  const results = frames.map((f, i) => {
    const a = raw(['-i', shots[i]]);
    const b = raw(['-ss', (f / 30 - 0.005).toFixed(4), '-i', exported]);
    const other = raw(['-ss', (frames[1 - i] / 30).toFixed(4), '-i', exported]); // a different moment, as a control
    return { f, diff: mad(a, b), control: mad(a, other) };
  });
  console.log(`      animated preview vs export: ${results.map((r) => `frame ${r.f}: ${r.diff.toFixed(2)} (control ${r.control.toFixed(2)})`).join(', ')}`);
  for (const r of results) {
    assert(r.diff < 6, `frame ${r.f} differs (${r.diff.toFixed(2)})`);
    assert(r.control > r.diff * 3, `frame ${r.f}: comparison not discriminating`);
  }
});

await step('keyboard shortcuts dialog', async () => {
  await page.click('button:has-text("Shortcuts")');
  await page.waitForSelector('text=Keyboard shortcuts');
  await snap('shortcuts');
  await page.keyboard.press('Escape');
});

// The project has unsaved changes, so a normal close would (correctly) show the native
// “Save changes?” prompt. Exit directly instead.
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed. Screenshots: ${path.relative(root, out)}`);
process.exit(failed.length ? 1 : 0);
