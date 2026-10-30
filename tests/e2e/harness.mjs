/** Shared helpers for the Electron UI tests. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { _electron as electron } from 'playwright';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const fixtures = path.join(root, 'tests/.fixtures/e2e');
export const TPS = 705_600_000;
export const FAKE_WHISPER = path.join(root, 'tests/helpers/fake-whisper.mjs');

export const ff = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

export function fixture(name, make) {
  mkdirSync(fixtures, { recursive: true });
  const file = path.join(fixtures, name);
  if (!existsSync(file)) make(file);
  return file;
}

export function outputDir(name) {
  const out = path.join(root, 'tests/.output', name);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  return out;
}

/** A file that passes the whisper.cpp model header check (for the stand-in engine). */
export function fakeModel(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.concat([Buffer.from('lmgg', 'latin1'), Buffer.alloc(2_000_000)]));
}

export function makeSteps() {
  const results = [];
  const step = async (name, fn) => {
    try {
      await fn();
      results.push({ name, ok: true });
      console.log(`  ✓ ${name}`);
    } catch (e) {
      results.push({ name, ok: false });
      console.log(`  ✗ ${name}\n      ${String(e?.message ?? e).split('\n').join('\n      ')}`);
    }
  };
  const finish = () => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} steps passed.`);
    return failed.length ? 1 : 0;
  };
  return { step, finish };
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

export async function launch({ userData, env = {}, extraArgs = [] }) {
  const app = await electron.launch({
    executablePath: electronPath,
    // Screenshots are compared with FFmpeg's decode of the export, so render without the Mac's
    // colour management: sRGB output (not the display's P3 profile) and software video decoding
    // (macOS hardware decoding applies the BT.709 → display gamma change QuickTime also applies).
    args: ['--no-sandbox', '--force-color-profile=srgb', '--disable-accelerated-video-decode', ...extraArgs, root],
    env: { ...process.env, CUTROOM_USER_DATA: userData, ...env },
  });
  const page = await app.firstWindow();
  page.on('dialog', (d) => d.accept());
  await page.waitForSelector('.topbar');
  await page.waitForFunction(() => window.__cutroom.store.get().ffmpeg !== null);
  return {
    app,
    page,
    stubOpen: (paths) => app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: p }); }, paths),
    stubSave: (p) => app.evaluate(({ dialog }, fp) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: fp }); }, p),
    state: () => page.evaluate(() => window.__cutroom.store.get().project),
    seekFrame: (f, fps = 30) => page.evaluate(([fr, r]) => window.__cutroom.engine.seek(Math.round((fr * 705_600_000) / r)), [f, fps]),
    /**
     * The visible main-track video shows the frame the engine asked for and has presented it
     * (under load, painting can lag behind a seek).
     */
    async previewReady() {
      await page.waitForFunction(() => {
        const want = window.__cutroom.engine.mainTarget;
        return [...document.querySelectorAll('video.stage-video')].some((e) =>
          e.style.display === 'block' && e.readyState >= 2 && !e.seeking && (want === null || Math.abs(e.currentTime - want) < 0.02));
      });
      await page.evaluate(() => new Promise((done) => {
        const v = [...document.querySelectorAll('video.stage-video')].find((e) => e.style.display === 'block');
        if (!v) return done();
        v.requestVideoFrameCallback(() => done());
        setTimeout(done, 500); // the frame may already have been presented before we asked
      }));
    },
    async exportTo(file, { fps } = {}) {
      await page.click('.topbar button:has-text("Export…")');
      await page.waitForSelector('.modal.export');
      await this.stubSave(file);
      await page.click('.modal.export button:has-text("Choose…")');
      if (fps) await page.selectOption('select[aria-label="Output frame rate"]', String(fps));
      await page.fill('input[aria-label="Target video bitrate in megabits per second"]', '10');
      await page.click('.modal.export button:has-text("Export")');
      await page.waitForSelector('text=/Export complete and verified|Export failed/', { timeout: 120000 });
      const failed = await page.locator('text=Export failed').isVisible();
      const msg = failed ? await page.locator('.modal.export .modal-body p').first().textContent() : '';
      await page.click('.modal.export button:has-text("Close")');
      if (failed) throw new Error(`export failed: ${msg}`);
    },
    close: () => app.evaluate(({ app: a }) => a.exit(0)).catch(() => {}),
  };
}

/**
 * Mean absolute RGB difference (0..255) between two images/videos at 64×64.
 * crop = [x, y, w, h] as fractions of the frame compares only that region.
 */
export function compareFrames(a, b, crop, grid = [64, 64]) {
  const c = crop ? `crop=iw*${crop[2]}:ih*${crop[3]}:iw*${crop[0]}:ih*${crop[1]},` : '';
  const raw = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args, '-vf', `${c}scale=${grid[0]}:${grid[1]}:flags=area,format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', '-']);
  const x = raw(a);
  const y = raw(b);
  return x.reduce((s, v, i) => s + Math.abs(v - y[i]), 0) / x.length;
}
