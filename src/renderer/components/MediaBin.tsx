import { useState } from 'react';
import { type MediaRef } from '../../shared/model';
import { formatDuration, rateLabel } from '../../shared/time';
import * as A from '../state/actions';
import { store, useStore } from '../state/store';
import { formatBytes } from './controls';

export const MEDIA_DRAG_TYPE = 'application/x-cutroom-media';

function MediaItem({ m }: { m: MediaRef }) {
  const thumb = useStore((s) => s.thumbs[m.id]);
  const missing = useStore((s) => !!s.missing[m.id]);
  const selected = useStore((s) => s.selection?.kind === 'media' && s.selection.id === m.id);
  const previewing = useStore((s) => s.previewMediaId === m.id);
  const uses = useStore((s) => s.project.sequence.items.filter((i) => i.kind === 'clip' && i.mediaId === m.id).length);
  const i = m.info;
  return (
    <div
      className={`media-item${selected ? ' selected' : ''}${missing ? ' missing' : ''}`}
      draggable={!missing}
      onDragStart={(e) => {
        e.dataTransfer.setData(MEDIA_DRAG_TYPE, m.id);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onClick={() => store.set({ selection: { kind: 'media', id: m.id }, previewMediaId: missing ? null : m.id })}
      title={missing ? `Missing: ${m.path}` : `${m.path}\nClick to preview · drag to the timeline`}
    >
      <div className="thumb">
        {thumb ? <img src={thumb} alt="" /> : <div className="thumb-placeholder">{missing ? 'Offline' : '…'}</div>}
        <span className="thumb-duration">{formatDuration(i.duration)}</span>
        {previewing && <span className="thumb-badge">Previewing</span>}
      </div>
      <div className="media-meta">
        <div className="media-name">{m.name}</div>
        <div className="muted small">
          {i.displayWidth}×{i.displayHeight} · {rateLabel(i.frameRate)} fps{i.isVFR ? ' (VFR)' : ''} · {i.videoCodec.toUpperCase()}
          {i.hasAudio ? '' : ' · no audio'}
        </div>
        <div className="muted small">
          {formatBytes(i.fileSize)}
          {uses > 0 && ` · used ${uses}×`}
        </div>
        {m.warnings.length > 0 && (
          <div className="warn-badge" title={m.warnings.join('\n')}>
            ⚠ {m.warnings.length} note{m.warnings.length > 1 ? 's' : ''}
          </div>
        )}
        <div className="media-actions">
          {missing ? (
            <button className="btn tiny warn" onClick={(e) => { e.stopPropagation(); A.relink(m.id); }}>Relink…</button>
          ) : (
            <button className="btn tiny" title="Add to the end of the timeline" onClick={(e) => { e.stopPropagation(); A.addMediaToTimeline(m.id); }}>
              + Add to timeline
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function MediaBin() {
  const media = useStore((s) => s.project.media);
  const importing = useStore((s) => s.importing);
  const [over, setOver] = useState(false);
  return (
    <aside
      className={`panel media-bin${over ? ' drop-over' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        const paths = [...e.dataTransfer.files].map((f) => window.cutroom.pathForFile(f)).filter(Boolean);
        A.importFiles(paths);
      }}
    >
      <header className="panel-head">
        <h2>Media</h2>
        <button className="btn primary small" onClick={A.pickAndImport} title="Import MP4 or MOV files (⌘I)">
          Import…
        </button>
      </header>
      <div className="panel-body">
        {media.length === 0 && importing.length === 0 && (
          <div className="empty">
            <p>No media yet.</p>
            <p className="muted">Click <strong>Import…</strong> or drag MP4/MOV files here.</p>
            <p className="muted small">Supported now: H.264 video in MP4/MOV, with AAC audio. Files stay where they are; Cutroom only references them.</p>
          </div>
        )}
        {media.map((m) => (
          <MediaItem key={m.id} m={m} />
        ))}
        {importing.map((name, i) => (
          <div key={`${name}-${i}`} className="media-item importing">
            <div className="thumb"><div className="thumb-placeholder spinner" /></div>
            <div className="media-meta">
              <div className="media-name">{name}</div>
              <div className="muted small">Inspecting…</div>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
