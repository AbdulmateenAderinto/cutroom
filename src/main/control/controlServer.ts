/**
 * Local control server for AI assistants ("AI control"). Off by default; the person turns it on.
 *
 * - Listens on 127.0.0.1 only, on a random port.
 * - Every request needs a random bearer token. Port + token are written to
 *   <userData>/control.json with owner-only permissions; the MCP bridge (src/mcp/server.ts) reads it.
 * - Requests carrying an Origin header (i.e. from a web page) are rejected, so a website cannot
 *   drive the editor even if it guessed the port.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { TOOLS_BY_NAME, type ToolDef } from '../../shared/controlTools';

export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

export const CONTROL_FILE = 'control.json';
const MAX_BODY = 1 << 20;

export function textResult(value: unknown, isError = false): ToolResult {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], isError };
}

/** Minimal argument check against the tool's JSON schema (top-level types, required, enums). */
export function validateArgs(tool: ToolDef, args: Record<string, unknown>): string | null {
  const props = tool.inputSchema.properties as Record<string, any>;
  for (const r of tool.inputSchema.required ?? []) if (args[r] === undefined) return `Missing required argument "${r}".`;
  for (const [k, v] of Object.entries(args)) {
    const schema = props[k];
    if (!schema) return `Unknown argument "${k}". Allowed: ${Object.keys(props).join(', ') || 'none'}.`;
    if (v === null || v === undefined || !schema.type) continue;
    const t = Array.isArray(v) ? 'array' : typeof v;
    if (schema.type !== t) return `Argument "${k}" must be ${schema.type}, got ${t}.`;
    if (schema.type === 'number' && !Number.isFinite(v)) return `Argument "${k}" must be a finite number.`;
    if (schema.enum && !schema.enum.includes(v)) return `Argument "${k}" must be one of: ${schema.enum.join(', ')}.`;
  }
  return null;
}

export class ControlServer {
  private server: http.Server | null = null;
  private token = '';
  port = 0;
  calls = 0;

  constructor(
    private dir: string,
    private handle: (tool: ToolDef, args: Record<string, unknown>) => Promise<ToolResult>,
  ) {}

  get running() {
    return this.server !== null;
  }

  get controlFile() {
    return path.join(this.dir, CONTROL_FILE);
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.token = randomBytes(24).toString('hex');
    const server = http.createServer((req, res) => void this.onRequest(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.controlFile, JSON.stringify({ app: 'cutroom', port: this.port, token: this.token, pid: process.pid }), { mode: 0o600 });
    try { chmodSync(this.controlFile, 0o600); } catch {}
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    try { unlinkSync(this.controlFile); } catch {}
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  private send(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.headers.origin) return this.send(res, 403, { error: 'Browser requests are not allowed.' });
    if (req.headers.authorization !== `Bearer ${this.token}`) return this.send(res, 401, { error: 'Bad or missing token.' });
    if (req.method === 'GET' && req.url === '/health') return this.send(res, 200, { app: 'cutroom', ok: true });
    if (req.method !== 'POST' || req.url !== '/tool') return this.send(res, 404, { error: 'Not found.' });
    let body = '';
    let tooBig = false;
    req.on('data', (c: Buffer) => {
      body += c.toString();
      if (body.length > MAX_BODY) tooBig = true;
    });
    req.on('end', async () => {
      if (tooBig) return this.send(res, 413, { error: 'Request too large.' });
      let msg: { name?: string; arguments?: Record<string, unknown> };
      try {
        msg = JSON.parse(body);
      } catch {
        return this.send(res, 400, { error: 'Invalid JSON.' });
      }
      const tool = msg.name ? TOOLS_BY_NAME.get(msg.name) : undefined;
      if (!tool) return this.send(res, 200, textResult(`Unknown tool "${msg.name}".`, true));
      const args = msg.arguments ?? {};
      const bad = validateArgs(tool, args);
      if (bad) return this.send(res, 200, textResult(bad, true));
      this.calls++;
      try {
        this.send(res, 200, await this.handle(tool, args));
      } catch (e) {
        this.send(res, 200, textResult(`Tool "${tool.name}" failed: ${(e as Error).message}`, true));
      }
    });
  }
}
