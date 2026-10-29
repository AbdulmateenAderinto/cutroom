/**
 * MCP end-to-end test: launches Cutroom with AI control on, connects the official MCP client to
 * the cutroom-mcp bridge exactly like Claude Desktop would (stdio, Electron-as-Node), and drives
 * an edit through tools. Verifies results in the app's state and in the exported file.
 *
 * Run: npm run test:mcp   (Linux without a display: xvfb-run -a npm run test:mcp)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import electronPath from 'electron';
import { _electron as electron } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'tests/.output/mcp');
const fixtures = path.join(root, 'tests/.fixtures/e2e');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
mkdirSync(fixtures, { recursive: true });
const userData = path.join(out, 'userdata');

const ff = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
function fixture(name, w, h, seconds, freq) {
  const file = path.join(fixtures, name);
  if (!existsSync(file)) {
    ff(['-f', 'lavfi', '-i', `testsrc2=s=${w}x${h}:r=30:d=${seconds}`, '-f', 'lavfi', '-i', `sine=f=${freq}:r=48000:d=${seconds}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
  }
  return file;
}
const A = fixture('mcp landscape.mp4', 1280, 720, 6, 440);
const B = fixture('mcp portrait.mp4', 720, 1280, 5, 660);

const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`  ✗ ${name}\n      ${String(e?.message ?? e).split('\n').join('\n      ')}`);
  }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

console.log('Cutroom MCP test');
const app = await electron.launch({
  executablePath: electronPath,
  args: ['--no-sandbox', root],
  env: { ...process.env, CUTROOM_USER_DATA: userData, CUTROOM_AI_CONTROL: '1' },
});
const page = await app.firstWindow();
page.on('dialog', (d) => d.accept());
await page.waitForSelector('.topbar');
const controlFile = path.join(userData, 'control.json');
for (let i = 0; i < 50 && !existsSync(controlFile); i++) await new Promise((r) => setTimeout(r, 100));

const client = new Client({ name: 'cutroom-test', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: electronPath,
  args: [path.join(root, 'build/main/mcp/server.js')],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CUTROOM_USER_DATA: userData },
  stderr: 'inherit',
});
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${name} → ${text}`);
  let json = null;
  try { json = JSON.parse(r.content.find((c) => c.type === 'text')?.text ?? 'null'); } catch {}
  return { json, text, content: r.content };
};
const appState = () => page.evaluate(() => window.__cutroom.store.get().project);

await step('security: control server rejects missing token and browser origins', async () => {
  assert(existsSync(controlFile), 'control.json not written');
  const { port, token } = JSON.parse(readFileSync(controlFile, 'utf8'));
  const req = (headers) => new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, path: '/health', headers }, (res) => resolve(res.statusCode));
    r.end();
  });
  assert((await req({})) === 401, 'no token should be 401');
  assert((await req({ Authorization: 'Bearer wrong' })) === 401, 'wrong token should be 401');
  assert((await req({ Authorization: `Bearer ${token}`, Origin: 'https://evil.example' })) === 403, 'browser origin should be 403');
  assert((await req({ Authorization: `Bearer ${token}` })) === 200, 'valid token should be 200');
});

await step('MCP client connects and lists tools', async () => {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ['get_project', 'build_timeline', 'set_animation', 'set_keyframe', 'get_frame', 'export_video']) assert(names.includes(n), `missing ${n}`);
  assert(client.getInstructions()?.includes('get_project'), 'server instructions missing');
});

let mediaA, mediaB;
await step('import_media + get_project', async () => {
  const r = await call('import_media', { paths: [A, B, '/nope/missing.mp4'] });
  assert(r.json.imported.length === 2, r.text);
  assert(r.text.includes('Not imported'), 'missing-file error not reported');
  const p = (await call('get_project')).json;
  [mediaA, mediaB] = p.media.map((m) => m.id);
  assert(p.media[0].duration_s > 5.9 && p.media[1].size === '720x1280', JSON.stringify(p.media));
  assert((await appState()).media.length === 2, 'app state not updated');
});

await step('get_contact_sheet and get_frame return images', async () => {
  const sheet = await call('get_contact_sheet', { media_id: mediaA, count: 6 });
  const img = sheet.content.find((c) => c.type === 'image');
  assert(img && img.mimeType === 'image/jpeg' && img.data.length > 1000, 'no contact sheet image');
  const fr = await call('get_frame', { media_id: mediaB, source_time: 1 });
  assert(fr.content.some((c) => c.type === 'image'), 'no media frame');
});

await step('build_timeline (one undo step) with framing and animations', async () => {
  await call('set_canvas', { preset: '9:16', background: '#102030' });
  await call('build_timeline', {
    clips: [
      { media_id: mediaA, source_in: 1, source_out: 3, framing: { mode: 'fill' }, in_animation: { preset: 'fade', duration: 0.4 } },
      { media_id: mediaB, source_in: 0.5, source_out: 2.5 },
      { media_id: mediaA, source_in: 4, source_out: 5.5, out_animation: { preset: 'zoom', duration: 0.5 } },
    ],
  });
  const p = await appState();
  assert(p.sequence.items.length === 3 && p.canvas.height === 1920 && p.background === '#102030', 'timeline/canvas not applied');
  assert(p.sequence.items[0].framing.mode === 'fill' && p.sequence.items[0].animation.in.preset === 'fade', 'clip settings missing');
  const past = await page.evaluate(() => window.__cutroom.store.get().past.length);
  await page.evaluate(() => window.__cutroom.store.get()); // noop
  assert(past >= 1, 'no undo history');
});

await step('edit tools: split, keyframe, move, framing, audio; undo/redo', async () => {
  const before = (await call('get_project')).json.timeline.length;
  const s = await call('split_at', { time: 1 });
  assert(s.json.left_id && s.json.right_id, s.text);
  const tl = (await call('get_project')).json.timeline;
  assert(tl.length === before + 1, 'split did not add a clip');
  await call('set_keyframe', { clip_id: tl[1].id, property: 'scale', time: tl[1].start_s + 0.1, value: 1.3, easing: 'easeOut' });
  await call('set_animation', { clip_id: tl[2].id, motion: { preset: 'kenBurnsIn', amount: 0.8 } });
  await call('set_framing', { clip_id: tl[2].id, framing: { mode: 'manual', scale: 1.2, x: 0.1, y: 0 } });
  await call('set_clip_audio', { clip_id: tl[3].id, volume: 0.5 });
  await call('move_clip', { clip_id: tl[3].id, position: 0 });
  let p = (await call('get_project')).json;
  assert(p.timeline[0].id === tl[3].id && p.timeline[0].volume === 0.5, 'move/audio failed');
  const keyed = p.timeline.find((c) => c.id === tl[1].id);
  const kf = keyed.animation.keyframes.scale;
  // Keyframes follow their clip: after the move, the key is still 0.1 s into the clip.
  assert(kf.length === 1 && Math.abs(kf[0].time_s - (keyed.start_s + 0.1)) < 0.05, `keyframe time ${JSON.stringify(kf)} vs clip start ${keyed.start_s}`);
  await call('undo');
  p = (await call('get_project')).json;
  assert(p.timeline[0].id !== tl[3].id, 'undo did not revert the move');
  await call('redo');
  p = (await call('get_project')).json;
  assert(p.timeline[0].id === tl[3].id, 'redo failed');
});

await step('bad input gives readable tool errors, not crashes', async () => {
  const r1 = await client.callTool({ name: 'delete_clip', arguments: { clip_id: 'nope' } });
  assert(r1.isError && r1.content[0].text.includes('No timeline item'), r1.content[0].text);
  const r2 = await client.callTool({ name: 'set_framing', arguments: { clip_id: 'x', framing: { mode: 'weird' } } });
  assert(r2.isError, 'bad framing accepted');
  const r3 = await client.callTool({ name: 'split_at', arguments: { time: 'soon' } });
  assert(r3.isError && r3.content[0].text.includes('must be number'), r3.content[0].text);
  const r4 = await client.callTool({ name: 'export_video', arguments: { path: 'relative.mp4' } });
  assert(r4.isError && r4.content[0].text.includes('absolute'), r4.content[0].text);
});

await step('get_frame on the timeline shows what the export will (canvas colour + framing)', async () => {
  const r = await call('get_frame', { time: 0.05 });
  const img = r.content.find((c) => c.type === 'image');
  assert(img, 'no image');
  const file = path.join(out, 'timeline-frame.jpg');
  (await import('node:fs')).writeFileSync(file, Buffer.from(img.data, 'base64'));
  const dims = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim().split(',').map(Number);
  assert(Math.abs(dims[0] / dims[1] - 9 / 16) < 0.02, `captured aspect ${dims}`);
});

await step('export_video via MCP, poll status, verify the file', async () => {
  const target = path.join(out, 'ai export.mp4');
  const r = await call('export_video', { path: target, width: 540, height: 960, frame_rate: 30, bitrate_mbps: 2 });
  assert(r.json.started, r.text);
  let st;
  for (let i = 0; i < 240; i++) {
    st = (await call('get_export_status')).json;
    if (st.status !== 'running') break;
    await new Promise((res) => setTimeout(res, 500));
  }
  assert(st.status === 'done', JSON.stringify(st));
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', target]).toString());
  const v = probe.streams.find((s) => s.codec_type === 'video');
  assert(v.width === 540 && v.height === 960 && v.codec_name === 'h264', `${v.width}x${v.height}`);
  const p = (await call('get_project')).json;
  assert(Math.abs(Number(probe.format.duration) - p.duration_s) < 0.1, `duration ${probe.format.duration} vs ${p.duration_s}`);
  const again = await client.callTool({ name: 'export_video', arguments: { path: target } });
  assert(again.isError && again.content[0].text.includes('already exists'), 'overwrite protection missing');
  await page.screenshot({ path: path.join(out, 'after-mcp.png') });
});

await step('turning AI control off disconnects the bridge', async () => {
  await page.evaluate(() => window.cutroom.setAiEnabled(false));
  const r = await client.callTool({ name: 'get_project', arguments: {} });
  assert(r.isError && r.content[0].text.includes('not reachable'), r.content[0].text);
  assert(!existsSync(controlFile), 'control.json not removed');
});

await client.close().catch(() => {});
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed.`);
process.exit(failed.length ? 1 : 0);
