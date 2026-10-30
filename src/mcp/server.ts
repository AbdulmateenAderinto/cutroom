/**
 * cutroom-mcp: a stdio MCP server that lets Claude Desktop / Claude Code drive a running Cutroom.
 *
 * It holds no editing logic. It lists the tools from src/shared/controlTools.ts and forwards each
 * call to the app's local control server (port + token from <userData>/control.json).
 *
 * Run with Node, or with Cutroom's own Electron binary: ELECTRON_RUN_AS_NODE=1 <electron> server.js
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CONTROL_TOOLS } from '../shared/controlTools';

const INSTRUCTIONS = `Cutroom is a desktop video editor running on the user's computer. You edit the project that is open in its window; the user sees every change live and can undo any of your edits with ⌘Z.

How to work:
1. Call get_project first (and again after edits) to see media ids, clip ids and timing.
2. Understand footage before cutting: get_contact_sheet (overview grid), get_frame (a single frame), get_transcript / detect_silence / detect_scenes when available.
3. Prefer build_timeline for rough cuts (one undoable step), then refine with set_clip_range, split_at, move_clip, set_framing, set_animation, set_keyframe.
4. Check your work with get_frame at a few timeline times before exporting.
5. Times are seconds (snapped to frames). Source times are positions inside a media file; timeline times are positions in the edit.
6. Only export when the user asks. export_video returns at once; poll get_export_status. For several exports (e.g. 16:9 and 9:16 versions) use queue_export and get_export_queue.
7. Before a big restructure of an existing edit, offer to save_version first so the user can go back (restore_version).`;

function userDataDir(): string {
  if (process.env.CUTROOM_USER_DATA) return process.env.CUTROOM_USER_DATA;
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'cutroom');
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'cutroom');
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'cutroom');
}

const NOT_RUNNING =
  'Cutroom is not reachable. Ask the user to open Cutroom and turn on "AI control" in the top bar (it is off by default).';

interface CallResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  isError?: boolean;
}

function callApp(name: string, args: unknown): Promise<CallResult> {
  let info: { port: number; token: string };
  try {
    info = JSON.parse(readFileSync(path.join(userDataDir(), 'control.json'), 'utf8'));
  } catch {
    return Promise.resolve({ content: [{ type: 'text', text: NOT_RUNNING }], isError: true });
  }
  const body = JSON.stringify({ name, arguments: args ?? {} });
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1', port: info.port, path: '/tool', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${info.token}` },
        timeout: 120_000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode !== 200) resolve({ content: [{ type: 'text', text: parsed.error ?? `HTTP ${res.statusCode}` }], isError: true });
            else resolve(parsed);
          } catch {
            resolve({ content: [{ type: 'text', text: 'Cutroom returned an unreadable response.' }], isError: true });
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ content: [{ type: 'text', text: NOT_RUNNING }], isError: true }));
    req.end(body);
  });
}

async function main() {
  const server = new Server({ name: 'cutroom', version: '0.2.0' }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: CONTROL_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => (await callApp(req.params.name, req.params.arguments)) as any);
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  process.stderr.write(`cutroom-mcp failed to start: ${e?.stack ?? e}\n`);
  process.exit(1);
});
