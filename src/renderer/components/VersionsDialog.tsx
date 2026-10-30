/**
 * Versions: save a named snapshot of the project next to it, see earlier ones, and restore one
 * (it replaces the current edit as one undo step; the version file is not changed).
 */
import { useEffect, useState } from 'react';
import * as A from '../state/actions';
import { store, useStore } from '../state/store';

export function VersionsDialog() {
  const projectPath = useStore((s) => s.projectPath);
  const [label, setLabel] = useState('');
  const [list, setList] = useState<{ file: string; name: string; savedAt: number }[]>([]);
  const refresh = () => void (projectPath ? window.cutroom.listVersions(projectPath).then(setList) : setList([]));
  useEffect(refresh, [projectPath]);
  const close = () => store.set({ dialog: null });
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal versions" role="dialog" aria-label="Versions">
        <header className="modal-head">
          <h2>Versions</h2>
          <button className="btn ghost tiny" onClick={close} aria-label="Close">✕</button>
        </header>
        <div className="modal-body">
          {!projectPath ? (
            <p className="muted">Save the project first: versions are kept next to the project file.</p>
          ) : (
            <>
              <div className="row gap">
                <input
                  className="input"
                  aria-label="Version name"
                  placeholder="Name (e.g. “Before colour”)"
                  value={label}
                  maxLength={80}
                  onChange={(e) => setLabel(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') void A.saveVersion(label).then(() => (setLabel(''), refresh()));
                  }}
                />
                <button className="btn primary small" onClick={() => void A.saveVersion(label).then(() => (setLabel(''), refresh()))}>Save version</button>
              </div>
              <p className="muted small">Kept in “{projectPath.split(/[\\/]/).pop()?.replace(/\.cutroom$/, '')} versions” next to the project. Restoring replaces what is in the window (Undo brings it back).</p>
              {list.length === 0 ? (
                <p className="muted small">No versions yet.</p>
              ) : (
                <table className="media-table">
                  <tbody>
                    {list.map((v) => (
                      <tr key={v.file}>
                        <td>{v.name}</td>
                        <td className="muted small">{new Date(v.savedAt).toLocaleString()}</td>
                        <td><button className="btn tiny" onClick={() => void A.restoreVersion(v.file, v.name)}>Restore</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
