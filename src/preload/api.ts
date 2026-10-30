/**
 * The bridge between the UI (renderer) and the main process. Types only — shared by preload.ts
 * (implementation) and the renderer (window.cutroom).
 */
import type { ExportSettings } from '../shared/exportPlan';
import type { MediaInfo, MediaInput, Project, Transcript } from '../shared/model';

export type ProbeResult = { ok: true; info: MediaInfo; warnings: string[] } | { ok: false; error: string };

export interface FfmpegStatus {
  ok: boolean;
  ffmpeg: string | null;
  ffprobe: string | null;
  version: string | null;
  hasLibx264: boolean;
  hasAac: boolean;
  message: string | null;
}

export interface ExportProgress {
  fraction: number;
  outTimeSeconds: number;
  speed: string | null;
}

export type ExportResult =
  | {
      status: 'done';
      output: {
        path: string;
        sizeBytes: number;
        durationSeconds: number;
        width: number;
        height: number;
        videoCodec: string;
        frameRate: string;
        videoBitrateMbps: number | null;
        audioCodec: string | null;
        audioSampleRate: number | null;
      };
    }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string; details: string };

export type SaveResult = { ok: true; path: string } | { ok: false; cancelled: boolean; error?: string };
export type OpenResult =
  | { ok: true; path: string; project: Project; missingMediaIds: string[] }
  | { ok: false; cancelled: boolean; error?: string };

export interface RecoveryEntry {
  projectId: string;
  projectName: string;
  projectPath: string | null;
  savedAt: string;
}

export type MenuAction =
  | 'new' | 'open' | 'save' | 'saveAs' | 'import' | 'export'
  | 'undo' | 'redo' | 'split' | 'delete' | 'deleteLeaveGap' | 'duplicate'
  | 'playPause' | 'toggleSnapping' | 'zoomIn' | 'zoomOut' | 'zoomFit' | 'shortcuts'
  | 'playBackward' | 'pause' | 'playForward' | 'prevEdit' | 'nextEdit' | 'trimStart' | 'trimEnd'
  | 'selectAtPlayhead' | 'moveEarlier' | 'moveLater' | 'addTitle' | 'addMarker' | 'markIn' | 'markOut' | 'clearMarks';

export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

export interface AiControlStatus {
  enabled: boolean;
  running: boolean;
  calls: number;
  error: string | null;
  setup: { command: string; args: string[]; env: Record<string, string>; desktopConfig: string; claudeCodeCommand: string };
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

export interface CutroomApi {
  platform: string;
  checkFfmpeg(): Promise<FfmpegStatus>;
  pickMediaFiles(): Promise<string[]>;
  pathForFile(file: File): string;
  probeMedia(path: string): Promise<ProbeResult>;
  thumbnail(path: string, atSeconds: number): Promise<string | null>;
  filesExist(paths: string[]): Promise<boolean[]>;
  /** 100 peaks per second (0..255), or null if the file has no readable audio. */
  waveform(path: string): Promise<Uint8Array | null>;
  /** Save a voice-over recording (WebM from MediaRecorder) as WAV next to the project. */
  saveRecording(bytes: Uint8Array, projectPath: string | null): Promise<{ ok: true; path: string } | { ok: false; error: string }>;
  /** Ask the system for the microphone (macOS); true elsewhere. */
  micAccess(): Promise<boolean>;
  /** Background noise level of a file's sound (dBFS), for noise reduction. */
  noiseFloor(path: string): Promise<number | null>;
  mediaUrl(path: string): string;
  saveProject(project: Project, path: string | null): Promise<SaveResult>;
  openProject(path?: string): Promise<OpenResult>;
  /** Named snapshots of a saved project ("<name> versions/" next to it). */
  saveVersion(projectPath: string, project: Project, label: string): Promise<{ ok: true; file: string; name: string } | { ok: false; error: string }>;
  listVersions(projectPath: string): Promise<{ file: string; name: string; savedAt: number }[]>;
  loadVersion(projectPath: string, file: string): Promise<{ ok: true; project: Project; missingMediaIds: string[] } | { ok: false; error: string }>;
  pickRelinkFile(originalName: string): Promise<string | null>;
  pickFolder(title: string): Promise<string | null>;
  /** Files with these names under a folder (same size preferred): name → path. */
  findInFolder(folder: string, wanted: { name: string; size?: number }[]): Promise<Record<string, string>>;
  /** Copy files into a folder (never overwriting): old path → new path. */
  collectFiles(files: string[], folder: string): Promise<{ ok: true; map: Record<string, string> } | { ok: false; error: string }>;
  chooseExportPath(defaultName: string): Promise<string | null>;
  startExport(project: Project, settings: ExportSettings): Promise<ExportResult>;
  cancelExport(): Promise<void>;
  /** Render `seconds` of the timeline from `start` (ticks) through the export, to listen to. */
  audition(project: Project, start: number, seconds: number): Promise<{ ok: true; path: string } | { ok: false; error: string }>;
  /** Make (or reuse) the preview copy of a file the preview can't play directly. */
  /** `low`: the smaller proxy-mode copy (video only). */
  makeProxy(path: string, info: MediaInfo, input?: MediaInput, low?: boolean): Promise<{ ok: true; path: string } | { ok: false; error: string }>;
  /** Pick a .cube LUT; it is checked and copied into the app's LUT folder. null = cancelled. */
  pickLut(): Promise<{ ok: true; lut: NonNullable<MediaInput['lut']> } | { ok: false; error: string } | null>;
  /** Check and copy a .cube LUT given by path (for AI control). */
  importLut(path: string): Promise<{ ok: true; lut: NonNullable<MediaInput['lut']> } | { ok: false; error: string }>;
  onProxyProgress(cb: (p: { path: string; fraction: number; low: boolean }) => void): () => void;
  /** Save the source frame shown at `at` (source ticks) as a PNG (next to the project if saved). */
  freezeFrame(path: string, info: MediaInfo, at: number, projectPath: string | null): Promise<{ ok: true; path: string } | { ok: false; error: string }>;
  /** A reversed copy of [sourceIn, sourceOut) of a video file. */
  reverseClip(path: string, info: MediaInfo, sourceIn: number, sourceOut: number, projectPath: string | null): Promise<{ ok: true; path: string } | { ok: false; error: string }>;
  onReverseProgress(cb: (p: { path: string; fraction: number }) => void): () => void;
  /** A stabilized copy of [sourceIn, sourceOut) of a video file (strength 0..1). */
  stabilizeClip(path: string, info: MediaInfo, sourceIn: number, sourceOut: number, strength: number, projectPath: string | null): Promise<{ ok: true; path: string } | { ok: false; error: string }>;
  /** Whether the hardware encoder works here (checked once with a test encode). */
  encoders(): Promise<{ videotoolbox: boolean; reason?: string }>;
  onExportProgress(cb: (p: ExportProgress) => void): () => void;
  showInFolder(path: string): Promise<void>;
  writeRecovery(project: Project, projectPath: string | null): Promise<void>;
  clearRecovery(projectId: string): Promise<void>;
  listRecovery(): Promise<RecoveryEntry[]>;
  loadRecovery(projectId: string): Promise<{ project: Project; projectPath: string | null; missingMediaIds: string[] } | null>;
  setDirty(dirty: boolean): void;
  onMenu(cb: (action: MenuAction) => void): () => void;
  onCloseRequested(cb: () => void): () => void;
  closeNow(): void;
  // Analysis (local FFmpeg)
  detectSilence(path: string, durationSec: number, opts?: { noiseDb?: number; minDuration?: number }): Promise<{ start: number; end: number }[]>;
  detectScenes(path: string, threshold?: number): Promise<number[]>;
  // Speech-to-text (local whisper.cpp)
  whisperStatus(): Promise<WhisperStatus>;
  whisperSetOptions(o: { model?: string; language?: string }): Promise<WhisperStatus>;
  whisperDownload(id: string): Promise<{ ok: boolean; error?: string }>;
  whisperCancelDownload(): Promise<void>;
  whisperChooseModel(): Promise<{ ok: boolean; error?: string }>;
  transcribe(mediaId: string, path: string): Promise<{ ok: true; transcript: Transcript } | { ok: false; error: string }>;
  cancelTranscribe(path: string): Promise<void>;
  onWhisperProgress(cb: (p: { mediaId: string; fraction: number }) => void): () => void;
  onDownloadProgress(cb: (p: { id: string; fraction: number }) => void): () => void;
  // AI control (MCP)
  aiStatus(): Promise<AiControlStatus>;
  setAiEnabled(enabled: boolean): Promise<AiControlStatus>;
  onControlRequest(cb: (req: { id: number; name: string; args: Record<string, unknown> }) => void): () => void;
  respondControl(id: number, result: ToolResult): void;
  onAiNotify(cb: (text: string) => void): () => void;
}
