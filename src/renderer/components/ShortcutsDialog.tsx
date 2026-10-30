import { useState } from 'react';
import { SHORTCUTS, keyLabel } from '../shortcuts';
import { store } from '../state/store';

const GROUPS = ['Playback', 'Navigate', 'Edit', 'Timeline', 'File'] as const;

export function ShortcutsDialog() {
  const [q, setQ] = useState('');
  const match = (label: string, keys: string) => !q || `${label} ${keys}`.toLowerCase().includes(q.toLowerCase());
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && store.set({ dialog: null })}>
      <div className="modal shortcuts-modal" role="dialog" aria-label="Keyboard shortcuts">
        <header className="modal-head">
          <h2>Keyboard shortcuts</h2>
          <button className="btn ghost tiny" onClick={() => store.set({ dialog: null })} aria-label="Close">✕</button>
        </header>
        <div className="modal-body">
          <input className="input" autoFocus placeholder="Search shortcuts" aria-label="Search shortcuts" value={q} onChange={(e) => setQ(e.target.value)} />
          <p className="muted small">Shortcuts work when you are not typing in a field. Every action is also in the menus or on screen.</p>
          <div className="shortcut-groups">
            {GROUPS.map((g) => {
              const rows = SHORTCUTS.filter((s) => s.group === g).map((s) => ({ s, keys: s.keys.map(keyLabel) })).filter(({ s, keys }) => match(s.label, keys.join(' ')));
              if (!rows.length) return null;
              return (
                <section key={g}>
                  <h3>{g}</h3>
                  <table className="shortcuts">
                    <tbody>
                      {rows.map(({ s, keys }) => (
                        <tr key={s.label}>
                          <td>{keys.map((k) => <kbd key={k}>{k}</kbd>)}</td>
                          <td>{s.label}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
