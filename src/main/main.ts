/**
 * Electron main process: window, menus, file dialogs, and the bridge to FFmpeg.
 * All heavy work (ffprobe, thumbnails, export) runs in child processes, never on the UI thread.
 */
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { BrowserWindow, Menu, type MenuItemConstructorOptions, app, dialog, ipcMain, shell } from 'electron';
import type { MenuAction } from '../preload/api';
import type { ExportSettings } from '../shared/exportPlan';
import { type MediaInfo, type MediaInput, type Project, PROJECT_EXTENSION } from '../shared/model';
import { setupAnalysis } from './analysis/analysisTools';
import { setupAiControl } from './control/aiControl';
import { setupTranscription } from './transcribe/transcribeService';
import { cancelExport, startExport } from './export/exportJobs';
import { runExport } from './export/exportRunner';
import { encoderAvailability } from './export/encoders';
import { checkFfmpeg, resolveBinaries } from './media/ffbin';
import { SUPPORTED_EXTENSIONS, probeMedia } from './media/probe';
import { makeProxy } from './media/proxy';
import { setConvertDir } from './media/heic';
import { makeFreezeFrame, makeReversed } from './media/derived';
import { importLut, setLutDir } from './media/luts';
import { thumbnailDataUrl } from './media/thumbnails';
import { noiseFloor, waveformPeaks } from './media/waveform';
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
  // Single keys (S, J, Q, ↑…) are handled by the window so they don't fire while typing in a
  // field; the menu only shows them.
  const shown = (label: string, action: MenuAction, accelerator: string): MenuItemConstructorOptions => ({
    label, accelerator, registerAccelerator: false, click: () => sendMenu(action),
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
        shown('Split at Playhead', 'split', 'S'),
        shown('Trim Start to Playhead', 'trimStart', 'Q'),
        shown('Trim End to Playhead', 'trimEnd', 'W'),
        shown('Select Clip at Playhead', 'selectAtPlayhead', 'X'),
        shown('Duplicate Clip', 'duplicate', 'CmdOrCtrl+D'),
        shown('Move Clip Earlier', 'moveEarlier', 'Alt+Left'),
        shown('Move Clip Later', 'moveLater', 'Alt+Right'),
        shown('Delete Clip (Close Gap)', 'delete', 'Backspace'),
        shown('Delete Clip (Leave Gap)', 'deleteLeaveGap', 'Shift+Backspace'),
        { type: 'separator' },
        shown('Add Title', 'addTitle', 'T'),
        shown('Add Marker', 'addMarker', 'M'),
        shown('Mark Range Start', 'markIn', 'I'),
        shown('Mark Range End', 'markOut', 'O'),
        shown('Clear Range', 'clearMarks', 'Alt+X'),
      ],
    },
    {
      label: 'Playback',
      submenu: [
        shown('Play / Pause', 'playPause', 'Space'),
        shown('Play Backward', 'playBackward', 'J'),
        shown('Pause', 'pause', 'K'),
        shown('Play Forward (Faster)', 'playForward', 'L'),
        { type: 'separator' },
        shown('Previous Cut or Marker', 'prevEdit', 'Up'),
        shown('Next Cut or Marker', 'nextEdit', 'Down'),
      ],
    },
    {
      label: 'View',
      submenu: [
        shown('Toggle Snapping', 'toggleSnapping', 'N'),
        { type: 'separator' },
        shown('Zoom Timeline In', 'zoomIn', '='),
        shown('Zoom Timeline Out', 'zoomOut', '-'),
        shown('Fit Timeline to Window', 'zoomFit', 'Shift+Z'),
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' },
      ],
    },
    { label: 'Help', submenu: [shown('Keyboard Shortcuts', 'shortcuts', 'Shift+/')] },
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

  ipcMain.handle('media:proxy', (e, p: string, info: MediaInfo, input?: MediaInput) =>
    makeProxy(path.join(app.getPath('userData'), 'proxies'), p, info, (fraction) => e.sender.send('media:proxyProgress', { path: p, fraction }), input)
      .then((out) => {
        allowMediaPath(out);
        return { ok: true as const, path: out };
      })
      .catch((err) => ({ ok: false as const, error: (err as Error).message })),
  );

  // Freeze frames and reversed clips: next to the project file when it has been saved (so they
  // travel with it), otherwise in the app's data folder.
  const derivedDir = (projectPath: string | null) =>
    projectPath ? path.join(path.dirname(projectPath), 'Cutroom Media') : path.join(app.getPath('userData'), 'derived');
  const wrap = (job: Promise<string>) =>
    job.then((out) => ({ ok: true as const, path: out })).catch((err) => ({ ok: false as const, error: (err as Error).message }));
  ipcMain.handle('media:freeze', (_e, p: string, info: MediaInfo, at: number, projectPath: string | null) =>
    wrap(makeFreezeFrame(derivedDir(projectPath), p, info, at)),
  );
  ipcMain.handle('media:reverse', (e, p: string, info: MediaInfo, sourceIn: number, sourceOut: number, projectPath: string | null) =>
    wrap(makeReversed(derivedDir(projectPath), p, info, sourceIn, sourceOut, (fraction) => e.sender.send('media:reverseProgress', { path: p, fraction }))),
  );

  ipcMain.handle('media:noiseFloor', (_e, p: string) => noiseFloor(p));
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

  ipcMain.handle('dialog:lut', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Choose a LUT (.cube)',
      properties: ['openFile'],
      filters: [{ name: '3D LUT', extensions: ['cube'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    try {
      return { ok: true as const, lut: importLut(r.filePaths[0]) };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  });

  ipcMain.handle('lut:import', (_e, file: string) => {
    if (typeof file !== 'string' || !path.isAbsolute(file) || !existsSync(file)) return { ok: false as const, error: 'Give the absolute path of an existing .cube file.' };
    try {
      return { ok: true as const, lut: importLut(file) };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  });

  ipcMain.handle('dialog:exportPath', async (_e, defaultName: string) => {
    const r = await dialog.showSaveDialog(win!, {
      title: 'Export Video',
      defaultPath: defaultName,
      filters: defaultName.toLowerCase().endsWith('.mov')
        ? [{ name: 'QuickTime Movie', extensions: ['mov'] }, { name: 'MP4 Video', extensions: ['mp4'] }]
        : [{ name: 'MP4 Video', extensions: ['mp4'] }, { name: 'QuickTime Movie', extensions: ['mov'] }],
    });
    if (r.canceled || !r.filePath) return null;
    if (/\.(mp4|mov)$/i.test(r.filePath)) return r.filePath;
    return `${r.filePath}${defaultName.toLowerCase().endsWith('.mov') ? '.mov' : '.mp4'}`;
  });

  ipcMain.handle('export:start', (_e, project: Project, settings: ExportSettings) =>
    startExport(project, settings, 'user', (p) => win?.webContents.send('export:progress', p), () => ai.renderCaptions(project, settings)),
  );
  ipcMain.handle('export:cancel', () => cancelExport());
  // A few seconds rendered by the export (small picture), to hear export-only sound processing.
  ipcMain.handle('export:audition', async (_e, project: Project, start: number, seconds: number) => {
    const dir = path.join(app.getPath('userData'), 'audition');
    mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `listen-${Date.now()}.mp4`);
    const w = 160;
    const h = 2 * Math.max(1, Math.round((w * project.canvas.height) / project.canvas.width / 2));
    const r = await runExport(project, {
      outputPath: out, width: w, height: h, frameRate: project.frameRate, canvasMapping: 'fit', videoBitrateMbps: 0.3, x264Preset: 'veryfast',
      audioBitrateKbps: 256, range: { start, end: start + Math.round(seconds * 705_600_000) },
    });
    if (r.status !== 'done') return { ok: false as const, error: r.status === 'failed' ? r.message : 'cancelled' };
    allowMediaPath(out);
    return { ok: true as const, path: out };
  });
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
  setConvertDir(path.join(app.getPath('userData'), 'converted'));
  setLutDir(path.join(app.getPath('userData'), 'luts'));
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
