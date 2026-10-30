import { useEffect, useState } from 'react';
import type { MenuAction, RecoveryEntry } from '../preload/api';
import { AiControlDialog } from './components/AiControlDialog';
import { ExportDialog } from './components/ExportDialog';
import { installControlBridge } from './control/rendererTools';
import { Inspector } from './components/Inspector';
import { MediaBin } from './components/MediaBin';
import { PreviewPanel } from './components/PreviewPanel';
import { ShortcutsDialog } from './components/ShortcutsDialog';
import { SpeechSetupDialog } from './components/SpeechSetupDialog';
import { Timeline } from './components/Timeline';
import { Toasts } from './components/Toasts';
import { TopBar } from './components/TopBar';
import { audioDebug } from './preview/audio';
import { engine } from './preview/engine';
import * as A from './state/actions';
import { installClipboardHandlers, runShortcut } from './shortcuts';
import { playhead } from './state/playhead';
import { isDirty, store, useStore } from './state/store';

const AUTOSAVE_MS = 20_000;

function runAction(action: MenuAction) {
  const s = store.get();
  if (s.dialog && action !== 'shortcuts') return; // a modal is open
  switch (action) {
    case 'new': return A.newProject();
    case 'open': return void A.openProject();
    case 'save': return void A.saveProject();
    case 'saveAs': return void A.saveProject(true);
    case 'import': return void A.pickAndImport();
    case 'export': return store.set({ dialog: 'export' });
    case 'undo': return A.doUndo();
    case 'redo': return A.doRedo();
    case 'split': return A.splitAtPlayhead();
    case 'delete': return A.deleteSelected('close-gap');
    case 'deleteLeaveGap': return A.deleteSelected('leave-gap');
    case 'duplicate': return A.duplicateSelected();
    case 'playPause': return engine.toggle();
    case 'toggleSnapping': return store.set({ snapping: !s.snapping });
    case 'zoomIn': return A.zoomBy(1.25);
    case 'zoomOut': return A.zoomBy(0.8);
    case 'zoomFit': return A.zoomToFit(document.querySelector('.tl-scroll')?.clientWidth ?? 1000);
    case 'shortcuts': return store.set({ dialog: s.dialog === 'shortcuts' ? null : 'shortcuts' });
    case 'playBackward': return engine.shuttleBackward();
    case 'pause': return engine.pause();
    case 'playForward': return engine.shuttleForward();
    case 'prevEdit': return A.jumpToEdit(-1);
    case 'nextEdit': return A.jumpToEdit(1);
    case 'trimStart': return A.trimToPlayhead('start');
    case 'trimEnd': return A.trimToPlayhead('end');
    case 'selectAtPlayhead': return A.selectAtPlayhead();
    case 'moveEarlier': return A.moveSelected(-1);
    case 'moveLater': return A.moveSelected(1);
    case 'addTitle': return A.addTitleAction();
    case 'addMarker': return A.addMarkerAction();
    case 'markIn': return A.markIn();
    case 'markOut': return A.markOut();
    case 'clearMarks': return A.clearMarks();
  }
}

function onKeyDown(e: KeyboardEvent) {
  // Esc closes a dialog even while typing in one of its fields.
  if (store.get().dialog) {
    // (not while an export is running: it must be cancelled with its button)
    if (e.key === 'Escape' && !document.querySelector('.modal.export [role="progressbar"]')) store.set({ dialog: null });
    return;
  }
  const t = e.target as HTMLElement;
  if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return;
  if (runShortcut(e)) e.preventDefault();
}

export function App() {
  const dialog = useStore((s) => s.dialog);
  const ffmpeg = useStore((s) => s.ffmpeg);
  const [recovery, setRecovery] = useState<RecoveryEntry[]>([]);

  useEffect(() => {
    const api = window.cutroom;
    api.checkFfmpeg().then((f) => store.set({ ffmpeg: f }));
    api.listRecovery().then(setRecovery);
    const offMenu = api.onMenu(runAction);
    installClipboardHandlers();
    // Preview copies: start them whenever media is added, opened or relinked.
    const offProxy = api.onProxyProgress(({ path, fraction }) => A.proxyProgress(path, fraction));
    let lastMedia = store.get().project.media;
    let lastMissing = store.get().missing;
    A.ensureProxies();
    const offMediaWatch = store.subscribe(() => {
      const st = store.get();
      if (st.project.media === lastMedia && st.missing === lastMissing) return;
      lastMedia = st.project.media;
      lastMissing = st.missing;
      A.ensureProxies();
    });
    const offClose = api.onCloseRequested(async () => {
      if (await A.saveProject()) api.closeNow();
    });
    window.addEventListener('keydown', onKeyDown);
    const offControl = installControlBridge();

    // Tell the main process about unsaved changes (window close prompt, macOS title-bar dot).
    let lastDirty = false;
    const offStore = store.subscribe(() => {
      const d = isDirty(store.get());
      if (d !== lastDirty) api.setDirty((lastDirty = d));
    });
    // Autosave for crash recovery (separate from the project file; cleared on save).
    const timer = setInterval(() => {
      const s = store.get();
      if (isDirty(s) && (s.project.media.length || s.project.sequence.items.length)) {
        api.writeRecovery(s.project, s.projectPath).catch(() => {});
      }
    }, AUTOSAVE_MS);
    return () => {
      offMenu();
      offClose();
      offControl();
      offStore();
      offProxy();
      offMediaWatch();
      clearInterval(timer);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return (
    <div className="app">
      <TopBar />
      {ffmpeg && !ffmpeg.ok && (
        <div className="banner error" role="alert">
          <strong>FFmpeg problem:</strong> {ffmpeg.message}
        </div>
      )}
      <div className="workspace">
        <MediaBin />
        <PreviewPanel />
        <Inspector />
      </div>
      <Timeline />
      {dialog === 'export' && <ExportDialog />}
      {dialog === 'shortcuts' && <ShortcutsDialog />}
      {dialog === 'ai' && <AiControlDialog />}
      {dialog === 'speech' && <SpeechSetupDialog />}
      {recovery.length > 0 && (
        <div className="modal-backdrop">
          <div className="modal small" role="dialog" aria-label="Recover unsaved work">
            <h2>Recover unsaved work?</h2>
            <p className="muted">Cutroom did not close normally last time. These projects had unsaved changes:</p>
            {recovery.map((r) => (
              <div key={r.projectId} className="recovery-row">
                <div>
                  <strong>{r.projectName}</strong>
                  <div className="muted small">
                    Autosaved {new Date(r.savedAt).toLocaleString()} {r.projectPath ? `· ${r.projectPath}` : '· never saved'}
                  </div>
                </div>
                <div className="row gap">
                  <button className="btn primary" onClick={() => { A.recover(r.projectId); setRecovery([]); }}>Recover</button>
                  <button className="btn" onClick={() => { window.cutroom.clearRecovery(r.projectId); setRecovery((x) => x.filter((y) => y.projectId !== r.projectId)); }}>
                    Discard
                  </button>
                </div>
              </div>
            ))}
            <div className="modal-actions">
              <button className="btn" onClick={() => setRecovery([])}>Decide later</button>
            </div>
          </div>
        </div>
      )}
      <Toasts />
    </div>
  );
}

// Expose a small hook for automated UI tests (no effect on normal use).
(window as any).__cutroom = { store, playhead, engine, actions: A, audioDebug };
