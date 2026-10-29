import { useEffect, useState } from 'react';
import type { AiControlStatus } from '../../preload/api';
import { CONTROL_TOOLS } from '../../shared/controlTools';
import { store } from '../state/store';
import { Disclosure } from './controls';

function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn tiny"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? 'Copied ✓' : label}
    </button>
  );
}

export function AiControlDialog() {
  const [st, setSt] = useState<AiControlStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    window.cutroom.aiStatus().then(setSt);
  }, []);
  const close = () => store.set({ dialog: null });
  const toggle = async () => {
    if (!st) return;
    setBusy(true);
    setSt(await window.cutroom.setAiEnabled(!st.enabled));
    setBusy(false);
  };
  const tools = CONTROL_TOOLS.map((t) => t.name);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal" role="dialog" aria-label="AI control">
        <header className="modal-head">
          <h2>AI control (MCP)</h2>
          <button className="btn ghost tiny" onClick={close} aria-label="Close">✕</button>
        </header>
        <div className="modal-body">
          <p>
            Let Claude edit with you: it can look at your footage and timeline, cut, trim, frame, animate and export —
            using the same tools you do. Every AI edit is one undo step (⌘Z) and appears live.
          </p>
          <label className="check" style={{ margin: '10px 0' }}>
            <input type="checkbox" checked={!!st?.enabled} disabled={!st || busy} onChange={toggle} aria-label="Enable AI control" />
            <strong>Allow AI assistants to control Cutroom</strong>
            <span className="muted small">{st ? (st.running ? `· running · ${st.calls} requests` : '· off') : ''}</span>
          </label>
          {st?.error && <div className="banner warn small">{st.error}</div>}
          <p className="muted small">
            Only programs on this Mac that can read your Cutroom settings folder can connect (local-only server with a secret key).
            Frames and transcripts are sent to Claude only when it asks for them in your conversation.
          </p>

          {st && (
            <>
              <h3 style={{ marginTop: 14 }}>Connect Claude Desktop</h3>
              <ol className="steps small">
                <li>Claude Desktop → Settings → Developer → <em>Edit Config</em> (opens <span className="mono">claude_desktop_config.json</span>).</li>
                <li>Add this <span className="mono">cutroom</span> entry inside <span className="mono">mcpServers</span>, save, and restart Claude Desktop.</li>
              </ol>
              <div className="code">{st.setup.desktopConfig}</div>
              <div className="row gap" style={{ marginTop: 6 }}>
                <Copy text={st.setup.desktopConfig} label="Copy config" />
              </div>

              <h3 style={{ marginTop: 14 }}>Connect Claude Code</h3>
              <div className="code">{st.setup.claudeCodeCommand}</div>
              <div className="row gap" style={{ marginTop: 6 }}>
                <Copy text={st.setup.claudeCodeCommand} label="Copy command" />
              </div>

              <Disclosure title="Things to ask">
                <ul className="steps small">
                  <li>“Look at my clips and make a 30-second vertical highlight with fast cuts.”</li>
                  <li>“Remove the silences from interview.mov, then add captions.”</li>
                  <li>“Give every clip a quick fade in and a slow zoom.”</li>
                  <li>“Show me the frame at 12 seconds — is the subject centred? Fix the framing.”</li>
                  <li>“Export a 1080×1920 MP4 at 8 Mb/s to my Desktop.”</li>
                </ul>
              </Disclosure>
              <Disclosure title={`Available tools (${tools.length})`}>
                <ul className="tool-list">{tools.map((t) => <li key={t}>{t}</li>)}</ul>
              </Disclosure>
              <p className="muted small">
                The bridge runs with Cutroom’s own runtime (<span className="mono">ELECTRON_RUN_AS_NODE</span>), so Node.js does not need to be installed.
                If you move the Cutroom folder, copy the config again.
              </p>
            </>
          )}
        </div>
        <footer className="modal-actions">
          <button className="btn primary" onClick={close}>Done</button>
        </footer>
      </div>
    </div>
  );
}
