/**
 * Turns a Project + ExportSettings into an FFmpeg argument list (an array — never a shell string,
 * so file names with spaces/quotes/etc. are passed through untouched).
 *
 * Graph shape, one segment per timeline item:
 *   clip:  [input] crop→scale (same maths as the preview) → overlay onto a background of exactly
 *          N frames;  audio: trim/align → resample 48k stereo → volume → pad/trim to exactly M samples
 *   gap:   background colour for N frames + M samples of silence
 * then concat all segments, then pad/crop the canvas into the output size if the aspect differs.
 *
 * Segment lengths come from cumulative timeline boundaries rounded once each, so per-segment
 * rounding never accumulates, and audio boundaries are derived from the same video frame
 * boundaries (keeps A/V in sync across any number of cuts).
 */
import { animatesOpacity, evalAnimation, hasAnimation } from './animation';
import { audioClipDuration, audioClipEnd, duckGainAt, speechIntervals, tracks } from './audio';
import {
  type MediaRef,
  type Project,
  type Rect,
  animateRect,
  computeClipRect,
  sourceMatrix,
  evenDim,
  findMedia,
  layoutSequence,
} from './model';
import {
  type Rational,
  frameDuration,
  frameToTicks,
  rateToFloat,
  secondsToTicks,
  ticksToFrame,
  ticksToSamples,
  ticksToSeconds,
} from './time';

export type X264Preset = 'veryfast' | 'faster' | 'fast' | 'medium' | 'slow';

export interface ExportSettings {
  outputPath: string;
  width: number;
  height: number;
  frameRate: Rational;
  /** Only matters when the output aspect ratio differs from the canvas: letterbox (fit) or crop (fill). */
  canvasMapping: 'fit' | 'fill';
  videoBitrateMbps: number;
  x264Preset: X264Preset;
  audioBitrateKbps: number;
}

export const AUDIO_BITRATES = [128, 160, 192, 256, 320];
export const X264_PRESETS: { id: X264Preset; label: string }[] = [
  { id: 'veryfast', label: 'Very fast (larger artefacts at the same bitrate)' },
  { id: 'faster', label: 'Faster' },
  { id: 'fast', label: 'Fast' },
  { id: 'medium', label: 'Medium (recommended)' },
  { id: 'slow', label: 'Slow (better quality per bit, slower export)' },
];

/** Largest size an animated clip may be scaled to in one frame (protects memory). */
export const MAX_ANIMATED_DIM = 8192;

export interface ExportPlan {
  args: string[];
  durationSeconds: number;
  totalFrames: number;
  width: number;
  height: number;
}

/** Output sizes that keep the canvas aspect ratio. */
export function outputSizeOptions(canvasW: number, canvasH: number): { label: string; width: number; height: number }[] {
  const out = [{ label: `Canvas size (${canvasW}×${canvasH})`, width: canvasW, height: canvasH }];
  const short = Math.min(canvasW, canvasH);
  for (const target of [2160, 1440, 1080, 720, 540, 480]) {
    if (target === short) continue;
    const k = target / short;
    const w = evenDim(canvasW * k);
    const h = evenDim(canvasH * k);
    if (w > 7680 || h > 7680) continue;
    out.push({ label: `${target}p (${w}×${h})`, width: w, height: h });
  }
  return out;
}

/** Rough starting point: ~0.1 bits per pixel per frame (H.264, typical footage). */
export function suggestBitrateMbps(w: number, h: number, fps: Rational): number {
  const mbps = (w * h * rateToFloat(fps) * 0.1) / 1e6;
  return Math.max(1, Math.round(mbps * 2) / 2);
}

/** Approximate size: average bitrate × duration. Real files vary with content and container overhead. */
export function estimateFileSizeBytes(durationSeconds: number, videoMbps: number, audioKbps: number): number {
  return ((videoMbps * 1e6 + audioKbps * 1e3) * durationSeconds) / 8;
}

export function aspectDiffers(w1: number, h1: number, w2: number, h2: number): boolean {
  return Math.abs(w1 / h1 - w2 / h2) > 0.005;
}

export function validateExportSettings(project: Project, s: ExportSettings, mediaAvailable: (m: MediaRef) => boolean): string[] {
  const errors: string[] = [];
  const clips = project.sequence.items.filter((i) => i.kind === 'clip');
  if (clips.length === 0) errors.push('The timeline is empty. Add at least one clip before exporting.');
  if (!s.outputPath) errors.push('Choose where to save the exported video.');
  if (!(s.width >= 16 && s.height >= 16 && s.width <= 7680 && s.height <= 7680)) errors.push('Output size must be between 16 and 7680 pixels.');
  if (s.width % 2 || s.height % 2) errors.push('H.264 output needs even width and height.');
  if (!(s.videoBitrateMbps >= 0.1 && s.videoBitrateMbps <= 400)) errors.push('Video bitrate must be between 0.1 and 400 Mb/s.');
  const missing = new Set<string>();
  const used = [...clips.map((c) => (c.kind === 'clip' ? c.mediaId : '')), ...tracks(project).flatMap((t) => t.clips.map((c) => c.mediaId))];
  for (const id of used) {
    if (!id) continue;
    const m = findMedia(project, id);
    if (!m || !mediaAvailable(m)) missing.add(m?.name ?? id);
  }
  if (missing.size) errors.push(`Some media files are offline: ${[...missing].join(', ')}. Relink them first.`);
  return errors;
}

const f6 = (n: number) => n.toFixed(6);
/** Truncate (never round up) so values stay within bounds. */
const trunc3 = (n: number) => (Math.floor(n * 1000) / 1000).toFixed(3);
const hexColor = (c: string) => '0x' + c.replace('#', '');

function intersect(a: Rect, w: number, h: number): Rect | null {
  const x0 = Math.max(0, a.x);
  const y0 = Math.max(0, a.y);
  const x1 = Math.min(w, a.x + a.w);
  const y1 = Math.min(h, a.y + a.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** How the project canvas maps into the output frame: scale k and the canvas size in output pixels. */
export function canvasInOutput(project: Project, s: Pick<ExportSettings, 'width' | 'height' | 'canvasMapping'>) {
  const cw = project.canvas.width;
  const ch = project.canvas.height;
  const k = s.canvasMapping === 'fill' ? Math.max(s.width / cw, s.height / ch) : Math.min(s.width / cw, s.height / ch);
  return { k, bw: Math.max(2, Math.round(cw * k)), bh: Math.max(2, Math.round(ch * k)) };
}

/** Caption images rendered by the app for one export (base64 PNGs of the canvas-in-output size). */
export interface CaptionTrack {
  width: number;
  height: number;
  blank: string;
  segments: { start: number; end: number; png: string }[]; // timeline seconds
}

export interface ExportExtras {
  /** ffconcat file listing caption PNGs (canvas-in-output size) with durations; see exportRunner. */
  captionTrack?: string;
}

export function buildExportPlan(project: Project, s: ExportSettings, outputFile: string, mediaPath: (m: MediaRef) => string, extras: ExportExtras = {}): ExportPlan {
  const rate = s.frameRate;
  const sr = project.audio.sampleRate;
  const { items } = layoutSequence(project);
  const cw = project.canvas.width;
  const ch = project.canvas.height;

  // How the project canvas maps into the output frame (identity when sizes match).
  const { k, bw, bh } = canvasInOutput(project, s);
  const rateStr = `${rate.num}/${rate.den}`;
  const bg = hexColor(project.background);

  // Solid background. Converted from RGB with the BT.709 matrix the output is tagged with; FFmpeg's
  // default (BT.601) would shift colours, e.g. pure red would play back slightly orange.
  const background = (w: number, h: number, frames: number) =>
    `color=c=${bg}:s=${w}x${h}:r=${rateStr},trim=end_frame=${frames},format=rgb24,` +
    `scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setsar=1`;

  const inputs: string[] = [];
  const filters: string[] = [];
  const concatPads: string[] = [];
  let totalFrames = 0;
  let inputIndex = 0;

  items.forEach((l, n) => {
    const f0 = ticksToFrame(l.start, rate, 'round');
    const f1 = ticksToFrame(l.end, rate, 'round');
    const frames = f1 - f0;
    if (frames <= 0) return; // shorter than one output frame
    const samples = ticksToSamples(frameToTicks(f1, rate), sr) - ticksToSamples(frameToTicks(f0, rate), sr);
    totalFrames += frames;
    const v = `v${n}`;
    const a = `a${n}`;
    filters.push(`${background(bw, bh, frames)}[bg${n}]`);
    const silence = `anullsrc=r=${sr}:cl=stereo,atrim=end_sample=${samples}[${a}]`;

    const item = l.item;
    if (item.kind === 'gap') {
      filters.push(`[bg${n}]format=yuv420p[${v}]`);
      filters.push(silence);
      concatPads.push(`[${v}][${a}]`);
      return;
    }
    const media = findMedia(project, item.mediaId)!;
    const info = media.info;
    // Convert the source's colour matrix/range to the BT.709 limited-range output, the same
    // interpretation the preview (Chromium) uses, so colours match.
    const isImage = info.kind === 'image';
    const matrix = sourceMatrix(info);
    // Photos are first decoded to RGB (JPEG's full-range BT.601 is undone by that step), so the
    // resizing scale converts RGB → BT.709 limited range, as for backgrounds and captions.
    const colour = isImage
      ? ':out_color_matrix=bt709:out_range=tv'
      : `${matrix === 'bt601' ? ':in_color_matrix=bt601:out_color_matrix=bt709' : ''}${info.colorRange === 'pc' ? ':in_range=pc:out_range=tv' : ''}`;
    // Transparent PNG/WebP keep their alpha so the background colour shows through.
    const fgFormat = isImage && info.hasAlpha ? 'yuva420p' : 'yuv420p';
    const readFor0 = ticksToSeconds(item.sourceOut - item.sourceIn) + 2 * ticksToSeconds(frameDuration(rate));
    let lead = 0;
    if (isImage) {
      // A still image, repeated at the output frame rate for as long as the clip lasts.
      inputs.push('-loop', '1', '-framerate', rateStr, '-t', f6(readFor0), '-i', mediaPath(media));
    } else {
      // Start decoding half a source frame early so the frame at sourceIn is kept even if its
      // timestamp is a hair below sourceIn; the audio is then trimmed back by exactly that amount.
      const half = Math.floor(frameDuration(info.frameRate) / 2);
      const ss = Math.max(0, item.sourceIn - half);
      lead = ticksToSeconds(item.sourceIn - ss);
      inputs.push('-ss', f6(ticksToSeconds(ss)), '-t', f6(readFor0 + lead), '-i', mediaPath(media));
    }
    const i = inputIndex++;
    const decode = isImage ? 'format=rgba,' : '';

    // Video framing — identical maths to the preview, scaled into output pixels.
    const r0 = computeClipRect(info.displayWidth, info.displayHeight, cw, ch, item.framing);
    const R = { x: r0.x * k, y: r0.y * k, w: r0.w * k, h: r0.h * k };
    const V = intersect(R, bw, bh);
    if (hasAnimation(item.animation)) {
      // Animated clip: evaluate the animation at every output frame (same function as the preview)
      // and drive FFmpeg with per-frame commands for size, position and opacity.
      const dur = l.end - l.start;
      const quarter = 0.25 / (rate.num / rate.den);
      const sizeCmds: string[] = [];
      const posCmds: string[] = [];
      const opCmds: string[] = [];
      let prev = { w: -1, h: -1, x: NaN, y: NaN, o: -1 };
      let first = prev;
      for (let j = 0; j < frames; j++) {
        const rel = Math.max(0, frameToTicks(f0 + j, rate) - l.start);
        const st = evalAnimation(item.animation, Math.min(rel, dur), dur, item.sourceIn);
        const r = animateRect(r0, st, cw, ch);
        const cur = {
          w: Math.min(MAX_ANIMATED_DIM, Math.max(2, Math.round(r.w * k))),
          h: Math.min(MAX_ANIMATED_DIM, Math.max(2, Math.round(r.h * k))),
          x: Math.round(r.x * k),
          y: Math.round(r.y * k),
          o: Math.round(st.opacity * 1000) / 1000,
        };
        if (j === 0) first = cur;
        // Commands fire a quarter frame early so they are in place before frame j is processed.
        const at = Math.max(0, j / (rate.num / rate.den) - quarter).toFixed(6);
        if (j > 0 && (cur.w !== prev.w || cur.h !== prev.h)) sizeCmds.push(`${at} scale@s${n} w ${cur.w}, scale@s${n} h ${cur.h}`);
        if (j > 0 && (cur.x !== prev.x || cur.y !== prev.y)) posCmds.push(`${at} overlay@o${n} x ${cur.x}, overlay@o${n} y ${cur.y}`);
        if (j > 0 && cur.o !== prev.o) opCmds.push(`${at} ${['c0', 'c1', 'c2'].map((c) => `blend@b${n} ${c}_opacity ${cur.o}`).join(', ')}`);
        prev = cur;
      }
      const sendcmd = (cmds: string[]) => (cmds.length ? `sendcmd=c='${cmds.join(';')}',` : '');
      const fade = animatesOpacity(item.animation);
      filters.push(
        // Pixel format is converted BEFORE the resizing scale: a format filter after it would
        // stop size changes from reaching the overlay (verified with FFmpeg 6.1).
        `[${i}:v:0]setpts=PTS-STARTPTS,${decode}${isImage ? `scale=${colour.slice(1)},` : ''}format=${fgFormat},${sendcmd(sizeCmds)}scale@s${n}=w=${first.w}:h=${first.h}:flags=bicubic${isImage ? '' : colour},setsar=1[fg${n}]`,
      );
      if (fade) filters.push(`[bg${n}]split[bga${n}][bgb${n}]`);
      const base = fade ? `bga${n}` : `bg${n}`;
      filters.push(`[${base}]${sendcmd(posCmds).replace(/,$/, '') || 'null'}[bgp${n}]`);
      const layer = fade ? `lay${n}` : v;
      filters.push(
        `[bgp${n}][fg${n}]overlay@o${n}=x=${first.x}:y=${first.y}:eof_action=repeat:format=auto,trim=end_frame=${frames},format=yuv420p[${layer}]`,
      );
      if (fade) {
        filters.push(`[bgb${n}]${sendcmd(opCmds).replace(/,$/, '') || 'null'}[bgo${n}]`);
        const o = first.o;
        filters.push(`[${layer}][bgo${n}]blend@b${n}=all_mode=normal:c0_opacity=${o}:c1_opacity=${o}:c2_opacity=${o},format=yuv420p[${v}]`);
      }
    } else if (V) {
      const ox = Math.round(V.x);
      const oy = Math.round(V.y);
      const ow = Math.max(1, Math.round(V.x + V.w) - ox);
      const oh = Math.max(1, Math.round(V.y + V.h) - oy);
      // After FFmpeg's auto-rotation, frames are display-oriented; crop works in frame pixels.
      const rotated = info.rotation % 180 !== 0;
      const fw = rotated ? info.height : info.width;
      const fh = rotated ? info.width : info.height;
      const chain = ['setpts=PTS-STARTPTS', ...(isImage ? ['format=rgba'] : [])];
      const fullyVisible = R.x >= 0 && R.y >= 0 && R.x + R.w <= bw + 0.5 && R.y + R.h <= bh + 0.5;
      if (!fullyVisible) {
        // Source region that maps onto the visible part, clamped to the frame (rounding of the
        // output rectangle can otherwise push it a fraction of a pixel outside, which FFmpeg rejects).
        let cx = Math.max(0, ((ox - R.x) / R.w) * fw);
        let cy = Math.max(0, ((oy - R.y) / R.h) * fh);
        cx = Math.min(cx, fw - 1);
        cy = Math.min(cy, fh - 1);
        const cwid = Math.max(1, Math.min((ow / R.w) * fw, fw - cx));
        const chei = Math.max(1, Math.min((oh / R.h) * fh, fh - cy));
        chain.push(`crop=w=${trunc3(cwid)}:h=${trunc3(chei)}:x=${trunc3(cx)}:y=${trunc3(cy)}:exact=1`);
      }
      chain.push(`scale=w=${ow}:h=${oh}:flags=bicubic${colour}`, `format=${fgFormat}`, 'setsar=1');
      filters.push(`[${i}:v:0]${chain.join(',')}[fg${n}]`);
      // overlay keeps going while the clip input lasts, so cut back to exactly N frames.
      filters.push(`[bg${n}][fg${n}]overlay=x=${ox}:y=${oy}:eof_action=repeat:format=auto,trim=end_frame=${frames},format=yuv420p[${v}]`);
    } else {
      filters.push(`[bg${n}]format=yuv420p[${v}]`); // framed entirely off-canvas
    }

    if (info.hasAudio && !item.muted && item.volume > 0) {
      filters.push(
        `[${i}:a:0]atrim=start=${f6(lead)},asetpts=PTS-${f6(lead)}/TB,` +
          `aresample=${sr}:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
          `volume=${item.volume.toFixed(4)},apad,atrim=end_sample=${samples}[${a}]`,
      );
    } else filters.push(silence);
    concatPads.push(`[${v}][${a}]`);
  });

  filters.push(`${concatPads.join('')}concat=n=${concatPads.length}:v=1:a=1[vcat0][acat]`);
  if (extras.captionTrack) {
    // Caption images (drawn by the app, so they match the preview) as one timed PNG stream.
    // RGB → YUV with BT.709, like the backgrounds, so coloured text keeps its colour.
    inputs.push('-f', 'concat', '-safe', '0', '-i', extras.captionTrack);
    filters.push(`[${inputIndex}:v:0]format=rgba,scale=out_color_matrix=bt709:out_range=tv,format=yuva420p[cap]`);
    filters.push(`[vcat0][cap]overlay=x=0:y=0:format=auto:eof_action=pass,format=yuv420p[vcat]`);
    inputIndex++;
  } else {
    filters.push('[vcat0]null[vcat]');
  }
  if (bw === s.width && bh === s.height) {
    filters.push('[vcat]setsar=1,format=yuv420p[vout]');
  } else if (s.canvasMapping === 'fill') {
    const crop = `crop=${s.width}:${s.height}:${Math.floor((bw - s.width) / 2)}:${Math.floor((bh - s.height) / 2)}`;
    filters.push(`[vcat]${crop},setsar=1,format=yuv420p[vout]`);
  } else {
    // Letterbox: place the canvas on a background of the output size (same colour handling as above).
    filters.push(`${background(s.width, s.height, totalFrames)}[obg]`);
    const x = Math.floor((s.width - bw) / 2);
    const y = Math.floor((s.height - bh) / 2);
    filters.push(`[obg][vcat]overlay=x=${x}:y=${y}:format=auto,setsar=1,format=yuv420p[vout]`);
  }

  // ---- Audio tracks (music, voice-over), mixed under the video track's audio ----
  const totalSamples = ticksToSamples(frameToTicks(totalFrames, rate), sr);
  const projectEnd = frameToTicks(totalFrames, rate);
  const speech = speechIntervals(project);
  const trackPads: string[] = [];
  tracks(project).forEach((track, ti) => {
    if (track.muted || track.volume === 0) return;
    const clipPads: string[] = [];
    track.clips.forEach((c, ci) => {
      const m = findMedia(project, c.mediaId);
      if (!m || !m.info.hasAudio || c.volume === 0) return;
      const startSample = ticksToSamples(c.start, sr);
      if (startSample >= totalSamples) return; // starts after the video ends
      const durSamples = Math.min(ticksToSamples(audioClipEnd(c), sr), totalSamples) - startSample;
      const durSec = durSamples / sr;
      inputs.push('-ss', f6(ticksToSeconds(c.sourceIn)), '-t', f6(durSec + 0.1), '-i', mediaPath(m));
      const i = inputIndex++;
      const chain = [`aresample=${sr}:async=1:first_pts=0`, 'aformat=sample_fmts=fltp:channel_layouts=stereo', `volume=${c.volume.toFixed(4)}`];
      // Linear fades, matching clipGainAt() used by the preview. Fade-out is placed against the
      // clip's own end even if the video ends first.
      if (c.fadeIn > 0) chain.push(`afade=t=in:st=0:d=${f6(ticksToSeconds(c.fadeIn))}`);
      if (c.fadeOut > 0) chain.push(`afade=t=out:st=${f6(ticksToSeconds(audioClipDuration(c) - c.fadeOut))}:d=${f6(ticksToSeconds(c.fadeOut))}`);
      chain.push('apad', `atrim=end_sample=${durSamples}`, `adelay=delays=${startSample}S:all=1`);
      filters.push(`[${i}:a:0]${chain.join(',')}[ac${ti}_${ci}]`);
      clipPads.push(`[ac${ti}_${ci}]`);
    });
    if (!clipPads.length) return;
    const bus = [clipPads.length > 1 ? `${clipPads.join('')}amix=inputs=${clipPads.length}:normalize=0:duration=longest` : `${clipPads[0]}anull`];
    bus.push(`volume=${track.volume.toFixed(4)}`);
    if (track.duck && speech.length) {
      // Ducking envelope sampled every 20 ms (same function as the preview), applied as commands.
      const step = 0.02;
      const cmds: string[] = [];
      let prev = 1;
      for (let t = 0; t < ticksToSeconds(projectEnd); t += step) {
        const g = Math.round(duckGainAt(speech, secondsToTicks(t), track.duckDb) * 10000) / 10000;
        if (Math.abs(g - prev) > 0.0005) cmds.push(`${t.toFixed(3)} volume@duck${ti} volume ${g}`);
        prev = g;
      }
      const g0 = Math.round(duckGainAt(speech, 0, track.duckDb) * 10000) / 10000;
      if (cmds.length) bus.push(`asendcmd=c='${cmds.join(';')}'`);
      bus.push(`volume@duck${ti}=${g0}`);
    }
    bus.push('apad', `atrim=end_sample=${totalSamples}`);
    filters.push(`${bus.join(',')}[trk${ti}]`);
    trackPads.push(`[trk${ti}]`);
  });
  let audioOut = '[acat]';
  if (trackPads.length) {
    // Sum (not average) the tracks, then a transparent limiter so loud overlaps cannot clip.
    filters.push(`[acat]${trackPads.join('')}amix=inputs=${trackPads.length + 1}:normalize=0:duration=first,alimiter=limit=0.98:level=0:latency=1[amix]`);
    audioOut = '[amix]';
  }

  const kbps = Math.round(s.videoBitrateMbps * 1000);
  const args = [
    '-hide_banner', '-nostdin', '-y',
    '-loglevel', 'error',
    '-progress', 'pipe:1', '-nostats',
    ...inputs,
    '-filter_complex', filters.join(';\n'),
    '-map', '[vout]', '-map', audioOut,
    '-c:v', 'libx264', '-preset', s.x264Preset, '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    // Average-bitrate mode with a VBV cap: the encoder aims for this average; it is not constant
    // and the final size is approximate.
    '-b:v', `${kbps}k`, '-maxrate', `${kbps * 2}k`, '-bufsize', `${kbps * 2}k`,
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    '-r', `${rate.num}/${rate.den}`,
    '-c:a', 'aac', '-b:a', `${s.audioBitrateKbps}k`, '-ar', String(sr), '-ac', '2',
    '-movflags', '+faststart',
    '-f', 'mp4', outputFile,
  ];
  return {
    args,
    totalFrames,
    durationSeconds: ticksToSeconds(frameToTicks(totalFrames, rate)),
    width: s.width,
    height: s.height,
  };
}
