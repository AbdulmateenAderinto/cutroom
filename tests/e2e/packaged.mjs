/**
 * Smoke test of the PACKAGED app (electron-builder output, code inside app.asar): it starts, finds
 * FFmpeg, and the MCP bridge runs from inside app.asar with the command the AI settings show.
 *
 * Run after `npm run dist:dir` (Linux or macOS; CUTROOM_PACKAGED_APP overrides the app path).
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { _electron as electron } from 'playwright';
import { assert, makeSteps, root } from './harness.mjs';

const defaultExe =
  process.platform === 'darwin'
    ? path.join(root, `dist/mac${process.arch === 'arm64' ? '-arm64' : ''}/Cutroom.app/Contents/MacOS/Cutroom`)
    : path.join(root, 'dist/linux-unpacked/cutroom');
const exe = process.env.CUTROOM_PACKAGED_APP ?? defaultExe;
if (!existsSync(exe)) {
  console.error(`Packaged app not found at ${exe}. Run: npm run dist:dir`);
  process.exit(1);
}
const userData = path.join(root, 'tests/.output/packaged/userdata');
rmSync(userData, { recursive: true, force: true });
mkdirSync(userData, { recursive: true });

const { step, finish } = makeSteps();
console.log(`Cutroom packaged app test (${path.relative(root, exe)})`);
const app = await electron.launch({ executablePath: exe, args: ['--no-sandbox'], env: { ...process.env, CUTROOM_USER_DATA: userData, CUTROOM_AI_CONTROL: '1' } });
const page = await app.firstWindow();
let setup;

await step('the packaged app starts and finds FFmpeg', async () => {
  await page.waitForSelector('.topbar', { timeout: 20000 });
  await page.waitForFunction(() => window.__cutroom.store.get().ffmpeg !== null);
  const ff = await page.evaluate(() => window.__cutroom.store.get().ffmpeg);
  assert(ff.ok, JSON.stringify(ff));
  const packaged = await app.evaluate(({ app: a }) => a.isPackaged);
  assert(packaged, 'app.isPackaged should be true');
});

await step('AI settings give a bridge command pointing inside app.asar', async () => {
  setup = (await page.evaluate(() => window.cutroom.aiStatus())).setup;
  assert(setup.args.some((a) => a.includes('app.asar')), JSON.stringify(setup.args));
});

await step('the MCP bridge runs from inside app.asar and lists the tools', async () => {
  const client = new Client({ name: 'packaged-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: setup.command, args: setup.args, env: { ...process.env, ...setup.env }, stderr: 'inherit' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert(tools.length >= 40, `${tools.length} tools`);
  const r = await client.callTool({ name: 'get_project', arguments: {} });
  assert(!r.isError && r.content[0].text.includes('"canvas"'), r.content[0].text.slice(0, 200));
  await client.close();
});

await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
process.exit(finish());
