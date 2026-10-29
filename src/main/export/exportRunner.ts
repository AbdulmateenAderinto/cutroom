/**
 * Runs an export with FFmpeg as a child process (off the UI thread), reports progress,
 * supports cancellation, and verifies the result before it is given its final name.
 *
 * Safety: FFmpeg writes to "<name>.mp4.partial". Only after FFmpeg succeeds AND ffprobe confirms
 * the file has the expected codec, size and duration is it renamed to "<name>.mp4". On failure
 * or cancel the partial file is deleted, so an unfinished export never looks like a finished video.
 */
import { execFile, spawn } from 'node:child_process';
import { accessSync, constants, existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { MediaRef, Project } from '../../shared/model';
import { type ExportSettings, buildExportPlan, validateExportSettings } from '../../shared/exportPlan';
import { parseRational, rateToFloat } from '../../shared/time';
import { ffmpegPath, ffprobePath } from '../media/ffbin';

export interface ExportProgress {
  fraction: number; // 0..1
  outTimeSeconds: number;
  speed: string | null;
}

export interface VerifiedOutput {
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
}

export type ExportResult =
  | { status: 'done'; output: VerifiedOutput }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string; details: string };

export function partialPathFor(outputPath: string): string {
  return `${outputPath}.partial`;
}

function tryUnlink(p: string) {
  try {
    if (existsSync(p)) unlinkSync(p);
  } catch {}
}

export function humanizeFfmpegError(stderr: string): string {
  const s = stderr.toLowerCase();
  if (s.includes('no space left')) return 'The destination disk is full.';
  if (s.includes('permission denied')) return 'Cutroom does not have permission to read a source file or write to the destination folder.';
  if (s.includes('no such file or directory')) return 'A source media file could not be found. It may have been moved, renamed or disconnected.';
  if (s.includes('invalid data found')) return 'A source file is damaged or in a format FFmpeg cannot decode.';
  if (s.includes('unknown encoder') && s.includes('libx264')) return 'This FFmpeg build has no H.264 (libx264) encoder. Install FFmpeg with "brew install ffmpeg".';
  const lines = stderr.trim().split('\n').filter(Boolean);
  // The first specific complaint is usually more useful than the generic last line.
  const specific = lines.find((l) => /invalid|error|failed|cannot|unable/i.test(l) && !/error while|nothing was written/i.test(l));
  const line = (specific ?? lines[lines.length - 1])?.replace(/^\[[^\]]+\]\s*/, '');
  return line ? `FFmpeg could not render the video: ${line}` : 'FFmpeg stopped unexpectedly.';
}

function probe(file: string): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile(ffprobePath(), ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { maxBuffer: 8 << 20 }, (err, out) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
  });
}

export interface RunExportOptions {
  signal?: AbortSignal;
  onProgress?: (p: ExportProgress) => void;
  mediaPath?: (m: MediaRef) => string;
}

export async function runExport(project: Project, settings: ExportSettings, opts: RunExportOptions = {}): Promise<ExportResult> {
  const fail = (message: string, details = ''): ExportResult => ({ status: 'failed', message, details });
  const errors = validateExportSettings(project, settings, (m) => existsSync(m.path));
  if (errors.length) return fail(errors.join('\n'));

  const dir = path.dirname(settings.outputPath);
  try {
    accessSync(dir, constants.W_OK);
  } catch {
    return fail(`Cannot write to the folder “${dir}”. Choose another destination.`);
  }
  if (project.media.some((m) => path.resolve(m.path) === path.resolve(settings.outputPath))) {
    return fail('The export would overwrite one of the source files. Choose a different file name.');
  }

  const partial = partialPathFor(settings.outputPath);
  tryUnlink(partial);
  const plan = buildExportPlan(project, settings, partial, opts.mediaPath ?? ((m) => m.path));

  let bin: string;
  try { bin = ffmpegPath(); } catch (e) { return fail((e as Error).message); }

  const outcome = await new Promise<{ code: number | null; cancelled: boolean; stderr: string }>((resolve) => {
    const child = spawn(bin, plan.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let cancelled = false;
    let buf = '';
    let speed: string | null = null;
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const [k, v] = line.split('=');
        if (k === 'speed') speed = v?.trim() ?? null;
        if (k === 'out_time_us' || k === 'out_time_ms') {
          const sec = Number(v) / 1e6; // both keys are in microseconds in FFmpeg's progress output
          if (Number.isFinite(sec) && sec >= 0) {
            opts.onProgress?.({ fraction: Math.min(0.999, sec / plan.durationSeconds), outTimeSeconds: sec, speed });
          }
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-16_000);
    });
    const onAbort = () => {
      cancelled = true;
      child.kill('SIGTERM');
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000);
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => { stderr += `\n${e.message}`; });
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code, cancelled, stderr });
    });
  });

  if (outcome.cancelled) {
    tryUnlink(partial);
    return { status: 'cancelled' };
  }
  if (outcome.code !== 0) {
    tryUnlink(partial);
    return fail(humanizeFfmpegError(outcome.stderr), outcome.stderr);
  }

  // Verify the actual file — a zero exit code alone is not proof of a good export.
  let info: any;
  try {
    info = await probe(partial);
  } catch (e) {
    tryUnlink(partial);
    return fail('The exported file could not be read back for verification.', String(e));
  }
  const v = (info.streams ?? []).find((s: any) => s.codec_type === 'video');
  const a = (info.streams ?? []).find((s: any) => s.codec_type === 'audio');
  const duration = Number(info.format?.duration) || 0;
  const frameDur = 1 / rateToFloat(settings.frameRate);
  const problems: string[] = [];
  if (!v || v.codec_name !== 'h264') problems.push('no H.264 video stream');
  if (v && (v.width !== settings.width || v.height !== settings.height)) problems.push(`size is ${v.width}×${v.height}`);
  if (Math.abs(duration - plan.durationSeconds) > 3 * frameDur + 0.05) {
    problems.push(`duration is ${duration.toFixed(3)}s, expected ${plan.durationSeconds.toFixed(3)}s`);
  }
  if (!a) problems.push('no audio stream');
  if (problems.length) {
    tryUnlink(partial);
    return fail(`The exported file did not pass verification (${problems.join('; ')}). Nothing was saved.`, outcome.stderr);
  }

  try {
    renameSync(partial, settings.outputPath);
  } catch (e) {
    tryUnlink(partial);
    return fail(`Could not move the finished export into place: ${(e as Error).message}`);
  }
  const fr = parseRational(v.r_frame_rate);
  return {
    status: 'done',
    output: {
      path: settings.outputPath,
      sizeBytes: statSync(settings.outputPath).size,
      durationSeconds: duration,
      width: v.width,
      height: v.height,
      videoCodec: v.codec_name,
      frameRate: fr ? `${fr.num}/${fr.den}` : String(v.r_frame_rate),
      videoBitrateMbps: v.bit_rate ? Number(v.bit_rate) / 1e6 : null,
      audioCodec: a?.codec_name ?? null,
      audioSampleRate: a ? Number(a.sample_rate) : null,
    },
  };
}
