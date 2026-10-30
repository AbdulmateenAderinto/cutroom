/**
 * AI-control tools that run in the main process (files, FFmpeg, export). Editing tools are
 * forwarded to the window (renderer) so they go through the same undoable edit path as the UI.
 */
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ToolDef } from '../../shared/controlTools';
import { type ExportSettings, aspectDiffers, suggestBitrateMbps, validateExportSettings } from '../../shared/exportPlan';
import { type MediaRef, type Project, evenDim, findMedia, layoutSequence } from '../../shared/model';
import { COMMON_FRAME_RATES, type Rational, secondsToTicks, ticksToSeconds } from '../../shared/time';
import { lastExport, startExport } from '../export/exportJobs';
import { encoderAvailability } from '../export/encoders';
import { ffmpegPath } from '../media/ffbin';
import { probeMedia } from '../media/probe';
import { type ToolResult, textResult } from './controlServer';

export interface MainToolDeps {
  callRenderer: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  captureStage: (time: number) => Promise<string | null>; // base64 JPEG of the preview canvas
  allowMediaPath: (p: string) => void;
  notify: (text: string) => void;
  renderCaptions?: (project: Project, settings: ExportSettings) => Promise<import('../../shared/exportPlan').CaptionTrack | null>;
  /** Extra main-side tools (analysis, transcription) registered by other modules. */
  extra?: Map<string, (args: Record<string, unknown>) => Promise<ToolResult>>;
}

function ffmpegJpeg(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args, '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '4', '-'],
      { encoding: 'buffer', maxBuffer: 32 << 20, timeout: 60_000 },
      (err, stdout, stderr) => (err ? reject(new Error(stderr.toString().trim() || err.message)) : resolve(stdout)));
  });
}

export async function getProjectRaw(deps: MainToolDeps): Promise<Project> {
  const r = await deps.callRenderer('__get_project_raw', {});
  return JSON.parse((r.content[0] as { text: string }).text) as Project;
}

export function rateFromFps(fps: number): Rational {
  const known = COMMON_FRAME_RATES.find((c) => Math.abs(c.rate.num / c.rate.den - fps) < 0.01);
  return known ? known.rate : { num: Math.round(fps * 1000), den: 1000 };
}

const image = (buf: Buffer, caption: string): ToolResult => ({
  content: [{ type: 'image', data: buf.toString('base64'), mimeType: 'image/jpeg' }, { type: 'text', text: caption }],
});

export async function runMainTool(tool: ToolDef, args: Record<string, any>, deps: MainToolDeps): Promise<ToolResult> {
  const extra = deps.extra?.get(tool.name);
  if (extra) return extra(args);
  switch (tool.name) {
    case 'get_frame': {
      if (args.media_id !== undefined) {
        const project = await getProjectRaw(deps);
        const m = findMedia(project, args.media_id);
        if (!m) return textResult(`No media with id ${args.media_id}.`, true);
        const t = Math.max(0, Math.min(Number(args.source_time ?? 0), ticksToSeconds(m.info.duration) - 0.05));
        const buf = await ffmpegJpeg(['-ss', t.toFixed(3), '-i', m.path, '-frames:v', '1', '-vf', 'scale=768:768:force_original_aspect_ratio=decrease']);
        return image(buf, `${m.name} at ${t.toFixed(2)} s (original file, before framing).`);
      }
      if (args.time === undefined) return textResult('Give either `time` (timeline) or `media_id` + `source_time`.', true);
      const jpeg = await deps.captureStage(Number(args.time));
      if (!jpeg) return textResult('Could not capture the preview. Make sure the Cutroom window is open and not minimised.', true);
      return image(Buffer.from(jpeg, 'base64'), `Timeline at ${Number(args.time).toFixed(2)} s, as it will export (canvas framing and animation applied).`);
    }

    case 'get_contact_sheet': {
      const project = await getProjectRaw(deps);
      const m = findMedia(project, args.media_id);
      if (!m) return textResult(`No media with id ${args.media_id}.`, true);
      const count = Math.max(4, Math.min(24, Math.round(args.count ?? 12)));
      const dur = ticksToSeconds(m.info.duration);
      const times = Array.from({ length: count }, (_, i) => ((i + 0.5) * dur) / count);
      const cols = Math.ceil(Math.sqrt(count * 1.5));
      const rows = Math.ceil(count / cols);
      const inputs = times.flatMap((t) => ['-ss', t.toFixed(3), '-i', m.path]);
      const scaled = times.map((_, i) => `[${i}:v:0]trim=end_frame=1,scale=240:240:force_original_aspect_ratio=decrease,pad=240:240:(ow-iw)/2:(oh-ih)/2,setsar=1[f${i}]`);
      const graph = `${scaled.join(';')};${times.map((_, i) => `[f${i}]`).join('')}concat=n=${count}:v=1:a=0,tile=${cols}x${rows}:padding=4:color=0x202020[out]`;
      const buf = await ffmpegJpeg([...inputs, '-filter_complex', graph, '-map', '[out]', '-frames:v', '1']);
      return image(buf, `${m.name} (${dur.toFixed(1)} s). Frames left→right, top→bottom at: ${times.map((t) => `${t.toFixed(1)}s`).join(', ')}.`);
    }

    case 'import_media': {
      const paths: string[] = args.paths;
      const added: MediaRef[] = [];
      const errors: string[] = [];
      for (const p of paths) {
        if (!path.isAbsolute(p)) { errors.push(`${p}: use an absolute path`); continue; }
        const r = await probeMedia(p);
        if (!r.ok) { errors.push(`${path.basename(p)}: ${r.error}`); continue; }
        deps.allowMediaPath(p);
        added.push({ id: '', name: path.basename(p), path: p, info: r.info, warnings: r.warnings });
      }
      const res = added.length ? await deps.callRenderer('__add_media', { media: added }) : textResult({ imported: [] });
      if (errors.length) res.content.push({ type: 'text', text: `Not imported:\n${errors.join('\n')}` });
      return res;
    }

    case 'save_project':
      return deps.callRenderer('__save', {});

    case 'export_video': {
      const out = String(args.path);
      if (!path.isAbsolute(out) || !/\.(mp4|mov)$/i.test(out)) return textResult('`path` must be an absolute path ending in .mp4 or .mov.', true);
      if (!existsSync(path.dirname(out)) || !statSync(path.dirname(out)).isDirectory()) return textResult(`Folder does not exist: ${path.dirname(out)}`, true);
      if (existsSync(out) && !args.overwrite) return textResult(`${out} already exists. Pass overwrite=true to replace it, or choose another name.`, true);
      const project = await getProjectRaw(deps);
      const width = evenDim(args.width ?? project.canvas.width);
      const height = evenDim(args.height ?? project.canvas.height);
      if (aspectDiffers(project.canvas.width, project.canvas.height, width, height) && !args.fit) {
        return textResult(`The output shape ${width}×${height} differs from the canvas ${project.canvas.width}×${project.canvas.height}. Pass fit: "fit" (bars) or "fill" (crop).`, true);
      }
      const frameRate = args.frame_rate ? rateFromFps(args.frame_rate) : project.frameRate;
      const settings: ExportSettings = {
        outputPath: out, width, height, frameRate,
        canvasMapping: args.fit === 'fill' ? 'fill' : 'fit',
        videoBitrateMbps: args.bitrate_mbps ?? suggestBitrateMbps(width, height, frameRate, args.codec === 'hevc' ? 'hevc' : 'h264'),
        x264Preset: 'medium',
        audioBitrateKbps: 192,
        rateControl: args.crf !== undefined ? 'crf' : 'bitrate',
        crf: args.crf,
        encoder: args.encoder === 'videotoolbox' ? 'videotoolbox' : 'x264',
        codec: args.codec === 'hevc' || args.codec === 'prores' ? args.codec : 'h264',
        proresProfile: args.prores_hq ? 'hq' : 'standard',
        range: args.start !== undefined || args.end !== undefined
          ? { start: secondsToTicks(args.start ?? 0), end: Math.min(secondsToTicks(args.end ?? Infinity), layoutSequence(project).duration) }
          : null,
        chapters: args.chapters ?? (project.markers?.length ?? 0) > 0,
        loudness: Number.isFinite(args.loudness) ? Math.min(-5, Math.max(-40, Number(args.loudness))) : null,
      };
      if (settings.encoder === 'videotoolbox') {
        const hw = await encoderAvailability();
        if (!hw.videotoolbox) return textResult(hw.reason ?? 'The hardware encoder is not available.', true);
      }
      const problems = validateExportSettings(project, settings, (m) => existsSync(m.path));
      if (problems.length) return textResult(problems.join('\n'), true);
      deps.notify(`AI started an export to ${path.basename(out)}`);
      void startExport(project, settings, 'ai', undefined, deps.renderCaptions && (() => deps.renderCaptions!(project, settings))).then((r) => {
        deps.notify(r.status === 'done' ? `Export finished: ${path.basename(out)}` : r.status === 'cancelled' ? 'Export cancelled.' : `Export failed: ${r.message}`);
      });
      return textResult({
        started: true, path: out, width, height, frame_rate: `${frameRate.num}/${frameRate.den}`,
        ...(settings.rateControl === 'crf' ? { crf: settings.crf } : { bitrate_mbps: settings.videoBitrateMbps }),
        encoder: settings.encoder,
        ...(settings.range ? { range_s: [ticksToSeconds(settings.range.start), ticksToSeconds(settings.range.end)] } : {}),
        next: 'Poll get_export_status.',
      });
    }

    case 'get_export_status': {
      const j = lastExport();
      if (!j) return textResult({ status: 'none', message: 'No export has been started.' });
      if (!j.result) {
        return textResult({ status: 'running', path: j.outputPath, percent: Math.round((j.progress?.fraction ?? 0) * 100), elapsed_s: Math.round((Date.now() - j.startedAt) / 1000) });
      }
      return textResult({ ...j.result, path: j.outputPath });
    }
  }
  return textResult(`Tool ${tool.name} is not available in this version.`, true);
}
