/**
 * Runs an export with FFmpeg as a child process (off the UI thread), reports progress,
 * supports cancellation, and verifies the result before it is given its final name.
 *
 * Safety: FFmpeg writes to "<name>.mp4.partial". Only after FFmpeg succeeds AND ffprobe confirms
 * the file has the expected codec, size and duration is it renamed to "<name>.mp4". On failure
 * or cancel the partial file is deleted, so an unfinished export never looks like a finished video.
 */
import { execFile, spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MediaRef, PreviewPlatform, Project } from '../../shared/model';
import { chapterMetadata } from '../../shared/markers';
import type { LoudnessMeasurement } from '../../shared/exportPlan';
import { ensureLut, getLutDir } from '../media/luts';
import { type CaptionTrack, type ExportSettings, buildExportPlan, canvasInOutput, validateExportSettings } from '../../shared/exportPlan';
import { type Rational, parseRational, rateToFloat } from '../../shared/time';
import { ffmpegPath, ffprobePath } from '../media/ffbin';
import { hasFilter, timeStretchFilter } from './encoders';

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
  captions?: CaptionTrack | null;
  /** Force a time-stretch filter for speed changes (default: the best one available). */
  timeStretch?: 'rubberband' | 'atempo';
  /** Match the preview of this platform's Chromium (default: the one running). */
  previewPlatform?: PreviewPlatform;
}

/**
 * Write caption PNGs and an ffconcat list that shows each image for its time span (blank between).
 * Span boundaries are rounded to output frames, and each image is read at the output frame rate
 * (`option framerate`) so its timestamps are exact; FFmpeg's default 1/25 s image timebase would
 * shift captions by up to 20 ms.
 */
export function writeCaptionTrack(dir: string, track: CaptionTrack, totalFrames: number, rate: Rational): string {
  writeFileSync(path.join(dir, 'blank.png'), Buffer.from(track.blank, 'base64'));
  const fps = rate.num / rate.den;
  const lines = ['ffconcat version 1.0'];
  let frame = 0;
  const entry = (file: string, untilFrame: number) => {
    const until = Math.min(untilFrame, totalFrames + 1);
    if (until <= frame) return;
    lines.push(`file '${file}'`, `option framerate ${rate.num}/${rate.den}`, `duration ${((until - frame) / fps).toFixed(6)}`);
    frame = until;
  };
  track.segments.forEach((seg, i) => {
    const name = `cap${i}.png`;
    writeFileSync(path.join(dir, name), Buffer.from(seg.png, 'base64'));
    entry('blank.png', Math.round(seg.start * fps));
    entry(name, Math.round(seg.end * fps));
  });
  entry('blank.png', totalFrames + 1);
  lines.push(`file 'blank.png'`, `option framerate ${rate.num}/${rate.den}`); // the last file is repeated so its duration applies
  const list = path.join(dir, 'captions.ffconcat');
  writeFileSync(list, lines.join('\n') + '\n');
  return list;
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

  // Input transforms: LUT copies must be in the LUT folder (FFmpeg runs there), and tone mapping
  // needs the zscale filter.
  const used = new Set([...project.sequence.items, ...(project.overlays ?? [])].flatMap((i) => (i.kind === 'gap' ? [] : [i.mediaId])));
  const usedMedia = project.media.filter((m) => used.has(m.id));
  for (const m of usedMedia) {
    if (m.input?.lut) {
      const problem = ensureLut(m.input.lut);
      if (problem) return fail(`${m.name}: ${problem}`);
    }
  }
  if (usedMedia.some((m) => m.input?.toneMap && m.info.isHDR) && !(await hasFilter('zscale'))) {
    return fail('HDR tone mapping needs an FFmpeg with the zscale filter (libzimg). Install a full FFmpeg build (e.g. `brew install ffmpeg`), or turn tone mapping off for the HDR clips.');
  }
  const lutCwd = usedMedia.some((m) => m.input?.lut) ? getLutDir() : undefined;

  const partial = partialPathFor(settings.outputPath);
  tryUnlink(partial);
  let captionDir: string | null = null;
  let captionTrack: string | undefined;
  let chaptersFile: string | undefined;
  const probePlan = () => buildExportPlan(project, settings, partial, opts.mediaPath ?? ((m) => m.path));
  if (opts.captions) {
    const { bw, bh } = canvasInOutput(project, settings);
    if (opts.captions.width !== bw || opts.captions.height !== bh) return fail('Internal error: caption images have the wrong size.');
    captionDir = mkdtempSync(path.join(os.tmpdir(), 'cutroom-captions-'));
    captionTrack = writeCaptionTrack(captionDir, opts.captions, probePlan().timelineFrames, settings.frameRate);
  }
  if (settings.chapters) {
    // Markers inside the exported part become chapters (times relative to the output's start).
    const { span } = probePlan();
    const meta = chapterMetadata(project, span.start, span.end);
    if (meta) {
      captionDir ??= mkdtempSync(path.join(os.tmpdir(), 'cutroom-captions-'));
      chaptersFile = path.join(captionDir, 'chapters.txt');
      writeFileSync(chaptersFile, meta);
    }
  }
  /** Run FFmpeg, reporting progress mapped into [from, to] of the bar; cancellable. */
  function runFfmpeg(bin: string, args: string[], durationSeconds: number, from: number, to: number) {
    return new Promise<{ code: number | null; cancelled: boolean; stderr: string }>((resolve) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: lutCwd });
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
              opts.onProgress?.({ fraction: from + (to - from) * Math.min(0.999, sec / durationSeconds), outTimeSeconds: sec, speed });
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
  }

  try {
    return await encode();
  } finally {
    if (captionDir) rmSync(captionDir, { recursive: true, force: true });
  }

  async function encode(): Promise<ExportResult> {
  const timeStretch = opts.timeStretch ?? (project.sequence.items.some((i) => i.kind === 'clip' && i.speed) ? await timeStretchFilter() : 'atempo');
  const previewPlatform = opts.previewPlatform ?? (process.platform === 'darwin' ? 'mac' : 'other');
  const extras = { captionTrack, timeStretch, previewPlatform, chaptersFile };

  let bin: string;
  try { bin = ffmpegPath(); } catch (e) { return fail((e as Error).message); }

  // Loudness normalization: measure the finished mix first (first half of the progress bar).
  const loud = settings.loudness !== undefined && settings.loudness !== null;
  let measured: LoudnessMeasurement | undefined;
  if (loud) {
    const mPlan = buildExportPlan(project, settings, partial, opts.mediaPath ?? ((m) => m.path), { ...extras, loudness: 'measure' });
    const m = await runFfmpeg(bin, mPlan.args, mPlan.durationSeconds, 0, 0.5);
    if (m.cancelled) return { status: 'cancelled' };
    if (m.code !== 0) return fail(humanizeFfmpegError(m.stderr), m.stderr);
    const json = /\{[^{}]*"input_i"[^{}]*\}/.exec(m.stderr)?.[0];
    try {
      measured = JSON.parse(json ?? '');
    } catch {
      return fail('Could not measure the loudness of the mix.', m.stderr);
    }
    if (!measured || !Number.isFinite(Number(measured.input_i))) {
      // Silence (−inf): nothing to normalize.
      measured = undefined;
    }
  }
  const plan = buildExportPlan(project, measured ? settings : { ...settings, loudness: null }, partial, opts.mediaPath ?? ((m) => m.path), { ...extras, loudness: measured });

  const outcome = await runFfmpeg(bin, plan.args, plan.durationSeconds, loud ? 0.5 : 0, 1);

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
  const codec = settings.codec ?? 'h264';
  const label = { h264: 'H.264', hevc: 'HEVC', prores: 'ProRes' }[codec];
  if (!v || v.codec_name !== codec) problems.push(`no ${label} video stream`);
  // Apple devices only play HEVC tagged hvc1.
  if (v && codec === 'hevc' && v.codec_tag_string !== 'hvc1') problems.push(`HEVC is tagged ${v.codec_tag_string}, not hvc1`);
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
}
