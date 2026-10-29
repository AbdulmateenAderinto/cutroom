/**
 * Transcription setup + jobs, exposed to the UI (IPC) and to AI control (MCP tools).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type BrowserWindow, app, dialog, ipcMain } from 'electron';
import { findMedia, type Transcript } from '../../shared/model';
import { registerMainTool } from '../control/aiControl';
import { type ToolResult, textResult } from '../control/controlServer';
import { getProjectRaw, type MainToolDeps } from '../control/mainTools';
import { MODELS, downloadModel, findWhisper, isWhisperModel, modelPath, transcribeFile } from './whisper';

interface WhisperSettings {
  whisperModel?: string;
  whisperModelPath?: string;
  whisperLanguage?: string;
}

export interface WhisperStatus {
  binary: string | null;
  models: { id: string; label: string; sizeMB: number; installed: boolean }[];
  selected: string;
  customPath: string | null;
  language: string;
  ready: boolean;
  modelFile: string | null;
}

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const modelsDir = () => path.join(app.getPath('userData'), 'models');

function read(): WhisperSettings {
  try {
    return JSON.parse(readFileSync(settingsFile(), 'utf8'));
  } catch {
    return {};
  }
}
function write(s: WhisperSettings) {
  mkdirSync(path.dirname(settingsFile()), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify({ ...read(), ...s }, null, 2));
}

export function whisperStatus(): WhisperStatus {
  const s = read();
  const selected = s.whisperModel ?? 'base.en';
  const custom = s.whisperModelPath && isWhisperModel(s.whisperModelPath) ? s.whisperModelPath : null;
  const modelFile = custom ?? (isWhisperModel(modelPath(modelsDir(), selected)) ? modelPath(modelsDir(), selected) : null);
  const binary = findWhisper();
  return {
    binary,
    models: MODELS.map((m) => ({ id: m.id, label: m.label, sizeMB: m.sizeMB, installed: isWhisperModel(modelPath(modelsDir(), m.id)) })),
    selected,
    customPath: custom,
    language: s.whisperLanguage ?? 'auto',
    ready: !!binary && !!modelFile,
    modelFile,
  };
}

const jobs = new Map<string, { promise: Promise<Transcript>; progress: number; controller: AbortController }>();

/** Start (or join) the transcription of a file. */
export function transcribe(mediaPath: string, onProgress?: (f: number) => void): { promise: Promise<Transcript>; progress: () => number } {
  let job = jobs.get(mediaPath);
  if (!job) {
    const st = whisperStatus();
    const controller = new AbortController();
    const j = { progress: 0, controller, promise: null as unknown as Promise<Transcript> };
    j.promise = transcribeFile(
      mediaPath,
      { model: st.modelFile ?? '', language: st.language, modelName: st.customPath ? path.basename(st.customPath) : st.selected },
      (f) => {
        j.progress = f;
        onProgress?.(f);
      },
      controller.signal,
    ).finally(() => jobs.delete(mediaPath));
    jobs.set(mediaPath, j);
    job = j;
  }
  const current = job;
  return { promise: current.promise, progress: () => current.progress };
}

export function setupTranscription(getWin: () => BrowserWindow | null, deps: () => Pick<MainToolDeps, 'callRenderer'>) {
  let download: AbortController | null = null;
  const send = (ch: string, v: unknown) => getWin()?.webContents.send(ch, v);

  ipcMain.handle('whisper:status', () => whisperStatus());
  ipcMain.handle('whisper:setOptions', (_e, o: { model?: string; language?: string }) => {
    write({ whisperModel: o.model ?? read().whisperModel, whisperLanguage: o.language ?? read().whisperLanguage, ...(o.model ? { whisperModelPath: undefined } : {}) });
    return whisperStatus();
  });
  ipcMain.handle('whisper:download', async (_e, id: string) => {
    if (download) return { ok: false, error: 'A download is already running.' };
    download = new AbortController();
    try {
      await downloadModel(modelsDir(), id, (f) => send('whisper:downloadProgress', { id, fraction: f }), download.signal);
      write({ whisperModel: id, whisperModelPath: undefined });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: download.signal.aborted ? 'Download cancelled.' : (e as Error).message };
    } finally {
      download = null;
    }
  });
  ipcMain.handle('whisper:cancelDownload', () => download?.abort());
  ipcMain.handle('whisper:chooseModel', async () => {
    const win = getWin();
    const r = await dialog.showOpenDialog(win!, { title: 'Choose a whisper.cpp model (.bin)', properties: ['openFile'], filters: [{ name: 'whisper.cpp model', extensions: ['bin'] }] });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    if (!isWhisperModel(r.filePaths[0])) return { ok: false, error: 'That file is not a whisper.cpp (ggml) model.' };
    write({ whisperModelPath: r.filePaths[0] });
    return { ok: true };
  });
  ipcMain.handle('whisper:transcribe', async (_e, mediaId: string, mediaPath: string) => {
    try {
      const t = await transcribe(mediaPath, (f) => send('whisper:progress', { mediaId, fraction: f })).promise;
      return { ok: true, transcript: t };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
  ipcMain.handle('whisper:cancel', (_e, mediaPath: string) => jobs.get(mediaPath)?.controller.abort());

  // ---- MCP tools ----
  registerMainTool('transcribe', async (a): Promise<ToolResult> => {
    const st = whisperStatus();
    if (!st.binary) return textResult('whisper.cpp is not installed. Ask the user to run "brew install whisper-cpp".', true);
    if (!st.ready) return textResult('No speech model is set up. Ask the user to open Smart tools → Transcribe → Set up and download a model (one-time, ~142 MB).', true);
    const project = await getProjectRaw(deps() as MainToolDeps);
    const m = findMedia(project, a.media_id);
    if (!m) return textResult(`No media with id ${a.media_id}.`, true);
    if (m.transcript && !a.redo) return textResult({ status: 'done', media: m.name, words: m.transcript.words.length, note: 'Already transcribed; use get_transcript. Pass redo=true to transcribe again.' });
    const job = transcribe(m.path, (f) => send('whisper:progress', { mediaId: m.id, fraction: f }));
    const timeout = new Promise<'pending'>((r) => setTimeout(() => r('pending'), 90_000));
    const done = await Promise.race([job.promise.then((t) => t), timeout]).catch((e: Error) => e);
    if (done instanceof Error) return textResult(`Transcription failed: ${done.message}`, true);
    if (done === 'pending') return textResult({ status: 'running', media: m.name, percent: Math.round(job.progress() * 100), next: 'Call transcribe again with the same media_id to keep waiting.' });
    await deps().callRenderer('__set_transcript', { media_id: m.id, transcript: done });
    return textResult({ status: 'done', media: m.name, words: done.words.length, language: done.language, next: 'Use get_transcript to read it.' });
  });
}
