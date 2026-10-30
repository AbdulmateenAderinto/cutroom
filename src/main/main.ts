/**
 * Electron main process: window, menus, file dialogs, and the bridge to FFmpeg.
 * All heavy work (ffprobe, thumbnails, export) runs in child processes, never on the UI thread.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { BrowserWindow, Menu, type MenuItemConstructorOptions, app, dialog, ipcMain, shell } from 'electron';
import type { MenuAction } from '../preload/api';
import type { ExportSettings } from '../shared/exportPlan';
import { type Project, PROJECT_EXTENSION } from '../shared/model';
import { setupAnalysis } from './analysis/analysisTools';
import { setupAiControl } from './control/aiControl';
import { setupTranscription } from './transcribe/transcribeService';
import { cancelExport, startExport } from './export/exportJobs';
import { encoderAvailability } from './export/encoders';
import { checkFfmpeg, resolveBinaries } from './media/ffbin';
import { SUPPORTED_EXTENSIONS, probeMedia } from './media/probe';
import { thumbnailDataUrl } from './media/thumbnails';
import { waveformPeaks } from './media/waveform';
import { allowMediaPath, handleMediaProtocol, registerSchemePrivileges } from './mediaProtocol';
import { loadProjectFile, saveProjectFile } from './project/projectFiles';
import { RecoveryStore } from './project/recovery';

registerSchemePrivileges();
// Lets automated tests use a throwaway settings folder.
if (process.env.CUTROOM_USER_DATA) app.setPath('userData', process.env.CUTROOM_USER_DATA);

let win: BrowserWindow | null = null;
let dirty = false;
let closing = false;
let autosavedProjectId: string | null = null;
let ai: ReturnType<typeof setupAiControl>;
const recovery = () => new RecoveryStore(path.join(app.getPath('userData'), 'recovery'));

function sendMenu(action: MenuAction) {
  win?.webContents.send('menu', action);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const item = (label: string, action: MenuAction, accelerator?: string): MenuItemConstructorOptions => ({
    label, accelerator, click: () => sendMenu(action),
  });
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        item('New Project', 'new', 'CmdOrCtrl+N'),
        item('Open Project…', 'open', 'CmdOrCtrl+O'),
        { type: 'separator' },
        item('Save', 'save', 'CmdOrCtrl+S'),
        item('Save As…', 'saveAs', 'CmdOrCtrl+Shift+S'),
        { type: 'separator' },
        item('Import Media…', 'import', 'CmdOrCtrl+I'),
        item('Export Video…', 'export', 'CmdOrCtrl+E'),
        ...(isMac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const }]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        // Undo/Redo go to the renderer, which applies them to text fields or to the project.
        item('Undo', 'undo', 'CmdOrCtrl+Z'),
        item('Redo', 'redo', 'CmdOrCtrl+Shift+Z'),
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        item('Split at Playhead', 'split'),
        item('Duplicate Clip', 'duplicate'),
        item('Delete Clip (Close Gap)', 'delete'),
        item('Delete Clip (Leave Gap)', 'deleteLeaveGap'),
      ],
    },
    {
      label: 'View',
      submenu: [
        item('Play / Pause', 'playPause'),
        item('Toggle Snapping', 'toggleSnapping'),
        { type: 'separator' },
        item('Zoom Timeline In', 'zoomIn'),
        item('Zoom Timeline Out', 'zoomOut'),
        item('Fit Timeline to Window', 'zoomFit'),
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' },
      ],
    },
    { label: 'Help', submenu: [item('Keyboard Shortcuts', 'shortcuts')] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: '#16181d',
    title: 'Cutroom',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const devUrl = process.env.CUTROOM_DEV_URL;
  if (devUrl) win.loadURL(devUrl);
  else win.loadFile(path.join(__dirname, '../../renderer/index.html'));

  win.on('close', (e) => {
    if (closing || !dirty) return;
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(win!, {
      type: 'warning',
      buttons: ['Save…', 'Don’t Save', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: 'Save changes to this project before closing?',
      detail: 'If you don’t save, your changes since the last save will be lost.',
    });
    if (choice === 0) win!.webContents.send('app:closeRequested');
    else if (choice === 1) {
      if (autosavedProjectId) recovery().clear(autosavedProjectId); // the user chose to discard
      closing = true;
      win!.close();
    }
  });
  win.on('closed', () => (win = null));
}

function registerIpc() {
  ipcMain.handle('ffmpeg:check', () => checkFfmpeg());

  ipcMain.handle('dialog:importMedia', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Import Media',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Media (video, audio, photos)', extensions: SUPPORTED_EXTENSIONS }],
    });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('media:probe', async (_e, p: string) => {
    const r = await probeMedia(p);
    if (r.ok) allowMediaPath(p);
    return r;
  });

  ipcMain.handle('media:thumbnail', (_e, p: string, at: number) =>
    thumbnailDataUrl(path.join(app.getPath('userData'), 'thumbnails'), p, at),
  );

  ipcMain.handle('media:waveform', (_e, p: string) => waveformPeaks(path.join(app.getPath('userData'), 'waveforms'), p).catch(() => null));

  ipcMain.handle('media:exists', (_e, paths: string[]) => paths.map((p) => existsSync(p)));

  ipcMain.handle('project:save', async (_e, project: Project, filePath: string | null) => {
    let target = filePath;
    if (!target) {
      const r = await dialog.showSaveDialog(win!, {
        title: 'Save Project',
        defaultPath: `${project.name || 'Untitled'}.${PROJECT_EXTENSION}`,
        filters: [{ name: 'Cutroom Project', extensions: [PROJECT_EXTENSION] }],
      });
      if (r.canceled || !r.filePath) return { ok: false, cancelled: true };
      target = r.filePath;
    }
    try {
      saveProjectFile(target, project);
      recovery().clear(project.id);
      return { ok: true, path: target };
    } catch (e) {
      return { ok: false, cancelled: false, error: `Could not save the project: ${(e as Error).message}` };
    }
  });

  ipcMain.handle('project:open', async (_e, filePath?: string) => {
    let target = filePath;
    if (!target) {
      const r = await dialog.showOpenDialog(win!, {
        title: 'Open Project',
        properties: ['openFile'],
        filters: [{ name: 'Cutroom Project', extensions: [PROJECT_EXTENSION] }],
      });
      if (r.canceled || !r.filePaths[0]) return { ok: false, cancelled: true };
      target = r.filePaths[0];
    }
    try {
      const loaded = loadProjectFile(target);
      for (const m of loaded.project.media) if (!loaded.missingMediaIds.includes(m.id)) allowMediaPath(m.path);
      return { ok: true, path: target, ...loaded };
    } catch (e) {
      return { ok: false, cancelled: false, error: (e as Error).message };
    }
  });

  ipcMain.handle('dialog:relink', async (_e, originalName: string) => {
    const r = await dialog.showOpenDialog(win!, {
      title: `Locate “${originalName}”`,
      properties: ['openFile'],
      filters: [{ name: 'Media (video, audio, photos)', extensions: SUPPORTED_EXTENSIONS }],
    });
    return r.canceled ? null : r.filePaths[0] ?? null;
  });

  ipcMain.handle('dialog:exportPath', async (_e, defaultName: string) => {
    const r = await dialog.showSaveDialog(win!, {
      title: 'Export Video',
      defaultPath: defaultName,
      filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
    });
    if (r.canceled || !r.filePath) return null;
    return r.filePath.toLowerCase().endsWith('.mp4') ? r.filePath : `${r.filePath}.mp4`;
  });

  ipcMain.handle('export:start', (_e, project: Project, settings: ExportSettings) =>
    startExport(project, settings, 'user', (p) => win?.webContents.send('export:progress', p), () => ai.renderCaptions(project, settings)),
  );
  ipcMain.handle('export:cancel', () => cancelExport());
  ipcMain.handle('export:encoders', () => encoderAvailability());

  ipcMain.handle('shell:showInFolder', (_e, p: string) => shell.showItemInFolder(p));

  ipcMain.handle('recovery:write', (_e, project: Project, projectPath: string | null) => {
    autosavedProjectId = project.id;
    recovery().write(project, projectPath);
  });
  ipcMain.handle('recovery:clear', (_e, id: string) => recovery().clear(id));
  ipcMain.handle('recovery:list', () => recovery().list());
  ipcMain.handle('recovery:load', (_e, id: string) => {
    const r = recovery().load(id);
    if (!r) return null;
    const missingMediaIds = r.project.media.filter((m) => !existsSync(m.path)).map((m) => m.id);
    for (const m of r.project.media) if (!missingMediaIds.includes(m.id)) allowMediaPath(m.path);
    return { ...r, missingMediaIds };
  });

  ipcMain.on('app:dirty', (_e, d: boolean) => {
    dirty = d;
    win?.setDocumentEdited(d);
  });
  ipcMain.on('app:closeNow', () => {
    closing = true;
    win?.close();
  });
}

app.whenReady().then(() => {
  resolveBinaries(app.isPackaged ? [path.join(process.resourcesPath, 'bin')] : []);
  handleMediaProtocol();
  ai = setupAiControl(() => win);
  registerIpc();
  setupAnalysis(() => ai);
  setupTranscription(() => win, () => ai);
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  cancelExport();
  app.quit(); // single-window app: quit on close, on macOS too
});
