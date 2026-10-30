import { store } from '../state/store';

export function ShortcutsDialog() {
  const m = window.cutroom.platform === 'darwin' ? '⌘' : 'Ctrl+';
  const rows: [string, string][] = [
    ['Space', 'Play / pause'],
    ['← / →', 'Previous / next frame (Shift: 10 frames)'],
    ['Home / End', 'Go to start / end'],
    ['S or ' + m + 'B', 'Split clip at playhead'],
    ['Delete', 'Delete selected clip and close the gap'],
    ['Shift+Delete', 'Delete selected clip, leave a gap'],
    [m + 'D', 'Duplicate selected clip'],
    [m + 'Z / ' + m + '⇧Z', 'Undo / redo'],
    ['T', 'Add a title at the playhead'],
    ['N', 'Toggle snapping (hold Alt while dragging to bypass)'],
    ['+ / −', 'Zoom timeline (or ' + m + ' + scroll wheel)'],
    [m + 'I', 'Import media'],
    [m + 'S / ' + m + '⇧S', 'Save / save as'],
    [m + 'O', 'Open project'],
    [m + 'E', 'Export'],
    ['Esc', 'Deselect / back to timeline preview'],
  ];
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && store.set({ dialog: null })}>
      <div className="modal small" role="dialog" aria-label="Keyboard shortcuts">
        <header className="modal-head">
          <h2>Keyboard shortcuts</h2>
          <button className="btn ghost tiny" onClick={() => store.set({ dialog: null })} aria-label="Close">✕</button>
        </header>
        <p className="muted small">Every action is also available with the mouse: toolbar buttons, the Edit menu and the clip panel.</p>
        <table className="shortcuts">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}><td><kbd>{k}</kbd></td><td>{v}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
