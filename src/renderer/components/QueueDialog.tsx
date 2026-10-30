/**
 * The export queue: what is waiting, rendering and finished, with cancel / remove / show file.
 */
import { cancelQueued, clearFinished } from '../state/exportQueue';
import { store, useStore } from '../state/store';
import { formatBytes } from './controls';

const STATUS: Record<string, string> = { waiting: 'Waiting', running: 'Exporting', done: 'Done ✓', failed: 'Failed', cancelled: 'Cancelled' };

export function QueueDialog() {
  const queue = useStore((s) => s.exportQueue);
  const close = () => store.set({ dialog: null });
  const finder = window.cutroom.platform === 'darwin' ? 'Finder' : 'folder';
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal queue" role="dialog" aria-label="Export queue">
        <header className="modal-head">
          <h2>Export queue</h2>
          <button className="btn ghost tiny" onClick={close} aria-label="Close">✕</button>
        </header>
        <div className="modal-body">
          {queue.length === 0 ? (
            <p className="muted">Nothing queued. In the Export dialog, “Add to queue” renders an export after the others while you keep editing.</p>
          ) : (
            <table className="media-table">
              <tbody>
                {queue.map((q) => {
                  const name = q.settings.outputPath.split(/[\\/]/).pop();
                  const f = q.progress?.fraction ?? 0;
                  return (
                    <tr key={q.id} data-status={q.status}>
                      <td title={q.settings.outputPath}>
                        {name}
                        <div className="muted small">
                          {q.settings.width}×{q.settings.height} · {(q.settings.codec ?? 'h264').toUpperCase()}
                          {q.settings.range ? ' · range' : ''}
                          {q.settings.parallel ? ' · parallel' : ''}
                        </div>
                      </td>
                      <td className="queue-status">
                        {q.status === 'running' ? (
                          <div className="progress small" role="progressbar" aria-valuenow={Math.round(f * 100)}>
                            <div className="progress-bar" style={{ width: `${f * 100}%` }} />
                          </div>
                        ) : (
                          <span className={q.status === 'failed' ? 'err' : q.status === 'done' ? 'ok' : 'muted'} title={q.result?.status === 'failed' ? q.result.message : undefined}>
                            {STATUS[q.status]}
                          </span>
                        )}
                        {q.result?.status === 'done' && <div className="muted small">{formatBytes(q.result.output.sizeBytes)}</div>}
                        {q.result?.status === 'failed' && <div className="err small">{q.result.message}</div>}
                      </td>
                      <td>
                        {(q.status === 'running' || q.status === 'waiting') && (
                          <button className="btn tiny" onClick={() => cancelQueued(q.id)}>{q.status === 'running' ? 'Cancel' : 'Remove'}</button>
                        )}
                        {q.result?.status === 'done' && (
                          <button className="btn tiny" onClick={() => q.result?.status === 'done' && window.cutroom.showInFolder(q.result.output.path)}>Show in {finder}</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <p className="muted small">Each export uses the timeline as it was when it was queued. Files are written as “.partial” and renamed only when complete and verified.</p>
        </div>
        <footer className="modal-actions">
          <button className="btn" disabled={!queue.some((q) => q.status !== 'waiting' && q.status !== 'running')} onClick={clearFinished}>Clear finished</button>
          <button className="btn primary" onClick={close}>Close</button>
        </footer>
      </div>
    </div>
  );
}
