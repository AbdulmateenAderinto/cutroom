import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { CutroomApi } from './api';

const on = <T>(channel: string, cb: (v: T) => void) => {
  const listener = (_e: unknown, v: T) => cb(v);
  ipcRenderer.on(channel, listener);
  return () => void ipcRenderer.removeListener(channel, listener);
};

const api: CutroomApi = {
  platform: process.platform,
  checkFfmpeg: () => ipcRenderer.invoke('ffmpeg:check'),
  pickMediaFiles: () => ipcRenderer.invoke('dialog:importMedia'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  probeMedia: (path) => ipcRenderer.invoke('media:probe', path),
  thumbnail: (path, at) => ipcRenderer.invoke('media:thumbnail', path, at),
  filesExist: (paths) => ipcRenderer.invoke('media:exists', paths),
  mediaUrl: (path) => `cutroom-media://file/${encodeURIComponent(path)}`,
  saveProject: (project, path) => ipcRenderer.invoke('project:save', project, path),
  openProject: (path) => ipcRenderer.invoke('project:open', path),
  pickRelinkFile: (name) => ipcRenderer.invoke('dialog:relink', name),
  chooseExportPath: (name) => ipcRenderer.invoke('dialog:exportPath', name),
  startExport: (project, settings) => ipcRenderer.invoke('export:start', project, settings),
  cancelExport: () => ipcRenderer.invoke('export:cancel'),
  onExportProgress: (cb) => on('export:progress', cb),
  showInFolder: (path) => ipcRenderer.invoke('shell:showInFolder', path),
  writeRecovery: (project, projectPath) => ipcRenderer.invoke('recovery:write', project, projectPath),
  clearRecovery: (id) => ipcRenderer.invoke('recovery:clear', id),
  listRecovery: () => ipcRenderer.invoke('recovery:list'),
  loadRecovery: (id) => ipcRenderer.invoke('recovery:load', id),
  setDirty: (dirty) => ipcRenderer.send('app:dirty', dirty),
  onMenu: (cb) => on('menu', cb),
  onCloseRequested: (cb) => on('app:closeRequested', cb),
  closeNow: () => ipcRenderer.send('app:closeNow'),
  detectSilence: (path, durationSec, opts) => ipcRenderer.invoke('analysis:silence', path, durationSec, opts),
  detectScenes: (path, threshold) => ipcRenderer.invoke('analysis:scenes', path, threshold),
  whisperStatus: () => ipcRenderer.invoke('whisper:status'),
  whisperSetOptions: (o) => ipcRenderer.invoke('whisper:setOptions', o),
  whisperDownload: (id) => ipcRenderer.invoke('whisper:download', id),
  whisperCancelDownload: () => ipcRenderer.invoke('whisper:cancelDownload'),
  whisperChooseModel: () => ipcRenderer.invoke('whisper:chooseModel'),
  transcribe: (mediaId, path) => ipcRenderer.invoke('whisper:transcribe', mediaId, path),
  cancelTranscribe: (path) => ipcRenderer.invoke('whisper:cancel', path),
  onWhisperProgress: (cb) => on('whisper:progress', cb),
  onDownloadProgress: (cb) => on('whisper:downloadProgress', cb),
  aiStatus: () => ipcRenderer.invoke('ai:status'),
  setAiEnabled: (enabled) => ipcRenderer.invoke('ai:setEnabled', enabled),
  onControlRequest: (cb) => on('control:request', cb),
  respondControl: (id, result) => ipcRenderer.send('control:response', { id, result }),
  onAiNotify: (cb) => on('ai:notify', cb),
};

contextBridge.exposeInMainWorld('cutroom', api);
