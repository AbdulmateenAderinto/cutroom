/**
 * Media manager: every file in the project with where it is used, its size and whether it is
 * missing; relink missing files from a folder, remove unused ones, collect everything into a folder.
 */
import { useEffect } from 'react';
import { mediaUses, unusedMedia } from '../../shared/ops';
import { formatDuration } from '../../shared/time';
import * as A from '../state/actions';
import { store, useStore } from '../state/store';
import { formatBytes } from './controls';

export function MediaManager() {
  const project = useStore((s) => s.project);
  const missing = useStore((s) => s.missing);
  const collecting = useStore((s) => s.working.includes('collect'));
  const uses = mediaUses(project);
  const unused = new Set(unusedMedia(project));
  const nMissing = project.media.filter((m) => missing[m.id]).length;
  const total = project.media.reduce((n, m) => n + (m.info.fileSize || 0), 0);
  const close = () => store.set({ dialog: null });
  useEffect(() => void A.refreshMissing(), []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal media-manager" role="dialog" aria-label="Media manager">
        <header className="modal-head">
          <h2>Media</h2>
          <button className="btn ghost tiny" onClick={close} aria-label="Close">✕</button>
        </header>
        <div className="modal-body">
          <p className="muted small">
            {project.media.length} file{project.media.length === 1 ? '' : 's'}, {formatBytes(total)}
            {nMissing ? ` · ${nMissing} missing` : ''}{unused.size ? ` · ${unused.size} unused` : ''}. Files on disk are never changed or deleted here.
          </p>
          <div className="row gap wrap">
            <button className="btn small" disabled={!nMissing} onClick={() => void A.relinkFromFolder()} title="Search a folder (and its sub-folders) for the missing files by name">
              Relink missing from a folder…
            </button>
            <button className="btn small" disabled={!unused.size} onClick={() => A.removeUnusedMedia()}>Remove unused ({unused.size})</button>
            <button className="btn small" disabled={collecting} onClick={() => void A.collectMedia()} title="Copy every file into one folder and use the copies (to move or archive the project)">
              {collecting ? 'Copying…' : 'Collect files into a folder…'}
            </button>
          </div>
          <table className="media-table">
            <thead>
              <tr><th>File</th><th>Kind</th><th>Length</th><th>Size</th><th>Used</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {project.media.map((m) => (
                <tr key={m.id} className={missing[m.id] ? 'missing' : ''}>
                  <td title={m.path}>
                    <div className="mm-name">{m.name}</div>
                    <div className="muted small mm-path">{m.path}</div>
                  </td>
                  <td>{m.derived ? { freeze: 'freeze frame', reverse: 'reversed', stabilize: 'stabilized' }[m.derived.kind] : m.info.kind}</td>
                  <td className="mono small">{m.info.kind === 'image' ? '—' : formatDuration(m.info.duration)}</td>
                  <td className="mono small">{formatBytes(m.info.fileSize || 0)}</td>
                  <td>{uses[m.id] ?? 0}×{unused.has(m.id) ? <span className="muted small"> (unused)</span> : null}</td>
                  <td>{missing[m.id] ? <span className="warn-text">missing</span> : 'ok'}</td>
                  <td className="row gap">
                    {missing[m.id]
                      ? <button className="btn tiny warn" onClick={() => void A.relink(m.id)}>Relink…</button>
                      : <button className="btn tiny" onClick={() => void window.cutroom.showInFolder(m.path)}>Show</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
