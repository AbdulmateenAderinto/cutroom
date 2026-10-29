/**
 * Wires AI control together: the on/off setting, the control server, forwarding editing tools to
 * the window, capturing preview frames, and the setup information shown in the app.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type BrowserWindow, app, ipcMain } from 'electron';
import type { ToolDef } from '../../shared/controlTools';
import { allowMediaPath } from '../mediaProtocol';
import { ControlServer, type ToolResult, textResult } from './controlServer';
import { type MainToolDeps, runMainTool } from './mainTools';

export interface AiControlStatus {
  enabled: boolean;
  running: boolean;
  calls: number;
  error: string | null;
  setup: { command: string; args: string[]; env: Record<string, string>; desktopConfig: string; claudeCodeCommand: string };
}

const RENDERER_TIMEOUT_MS = 30_000;
let pending = new Map<number, { resolve: (r: ToolResult) => void; timer: NodeJS.Timeout }>();
let seq = 0;
let server: ControlServer | null = null;
let lastError: string | null = null;
const extraTools = new Map<string, (args: Record<string, unknown>) => Promise<ToolResult>>();

/** Lets other modules (analysis, transcription) add main-side tools. */
export function registerMainTool(name: string, fn: (args: any) => Promise<ToolResult>) {
  extraTools.set(name, fn);
}

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings(): { aiControl?: boolean } {
  try {
    return JSON.parse(readFileSync(settingsFile(), 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(s: { aiControl?: boolean }) {
  mkdirSync(path.dirname(settingsFile()), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify({ ...readSettings(), ...s }, null, 2));
}

function setupInfo(): AiControlStatus['setup'] {
  // The bridge runs on Cutroom's own Electron binary in Node mode, so Node.js need not be installed.
  const serverJs = path.join(__dirname, '../../mcp/server.js');
  const env = { ELECTRON_RUN_AS_NODE: '1', CUTROOM_USER_DATA: app.getPath('userData') };
  const command = process.execPath;
  const desktopConfig = JSON.stringify({ mcpServers: { cutroom: { command, args: [serverJs], env } } }, null, 2);
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const claudeCodeCommand = `claude mcp add cutroom ${Object.entries(env).map(([k, v]) => `-e ${k}=${q(v)}`).join(' ')} -- ${q(command)} ${q(serverJs)}`;
  return { command, args: [serverJs], env, desktopConfig, claudeCodeCommand };
}

export function setupAiControl(getWin: () => BrowserWindow | null) {
  const callRenderer = (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    const win = getWin();
    if (!win) return Promise.resolve(textResult('The Cutroom window is not open.', true));
    const id = ++seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(textResult('The editor did not respond in time.', true));
      }, RENDERER_TIMEOUT_MS);
      pending.set(id, { resolve, timer });
      win.webContents.send('control:request', { id, name, args });
    });
  };

  ipcMain.on('control:response', (_e, msg: { id: number; result: ToolResult }) => {
    const p = pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(msg.id);
    p.resolve(msg.result);
  });

  const captureStage = async (time: number): Promise<string | null> => {
    const win = getWin();
    if (!win || win.isMinimized()) return null;
    const r = await callRenderer('__prepare_frame', { time });
    if (r.isError) return null;
    try {
      const rect = JSON.parse((r.content[0] as { text: string }).text);
      const img = await win.webContents.capturePage(rect);
      if (img.isEmpty()) return null;
      const size = img.getSize();
      const scaled = size.width > 1024 || size.height > 1024 ? img.resize(size.width >= size.height ? { width: 1024 } : { height: 1024 }) : img;
      return scaled.toJPEG(85).toString('base64');
    } finally {
      await callRenderer('__end_capture', {});
    }
  };

  const deps: MainToolDeps = {
    callRenderer,
    captureStage,
    allowMediaPath,
    notify: (text) => getWin()?.webContents.send('ai:notify', text),
    extra: extraTools,
  };

  const handle = async (tool: ToolDef, args: Record<string, unknown>): Promise<ToolResult> =>
    tool.runs === 'renderer' ? callRenderer(tool.name, args) : runMainTool(tool, args, deps);

  const start = async () => {
    server ??= new ControlServer(app.getPath('userData'), handle);
    try {
      await server.start();
      lastError = null;
    } catch (e) {
      lastError = `Could not start AI control: ${(e as Error).message}`;
    }
  };

  const status = (): AiControlStatus => ({
    enabled: !!readSettings().aiControl,
    running: !!server?.running,
    calls: server?.calls ?? 0,
    error: lastError,
    setup: setupInfo(),
  });

  ipcMain.handle('ai:status', () => status());
  ipcMain.handle('ai:setEnabled', async (_e, enabled: boolean) => {
    writeSettings({ aiControl: enabled });
    if (enabled) await start();
    else await server?.stop();
    return status();
  });

  if (readSettings().aiControl || process.env.CUTROOM_AI_CONTROL === '1') void start();
  app.on('will-quit', () => void server?.stop());
  return { stop: () => server?.stop() };
}

/** For tests: is the control file present (server announced)? */
export function controlFileExists() {
  return existsSync(path.join(app.getPath('userData'), 'control.json'));
}
