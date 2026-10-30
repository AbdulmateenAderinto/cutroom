/**
 * Executes AI-control tools inside the window. Every edit goes through commit(), so it is one
 * undo step and shows up live; a toast says what the AI changed.
 */
import type { ToolResult } from '../../preload/api';
import { type ClipAnimation, type InPreset, type MotionPreset } from '../../shared/animation';
import {
  CANVAS_PRESETS,
  type ClipItem,
  DEFAULT_FRAMING,
  type Framing,
  type LaidOutItem,
  type MediaRef,
  type Project,
  type TitleClip,
  type Transcript,
  evenDim,
  findMedia,
  isHexColor,
  layoutSequence,
  newId,
  sourceAt,
  timelineAt,
} from '../../shared/model';
import {
  addAudioClip, deleteAudioClip, detachAudio, findAudioClip, mediaNeedingSpeechAnalysis, moveAudioClip, setAudioClip, setAudioTrack, setSpeech, trimAudioClip,
} from '../../shared/audio';
import { buildCues, fillerRanges } from '../../shared/captions';
import { addTitle, deleteTitle, findTitle, moveTitle, removeTitleKeyframe, setTitleKeyframe, updateTitle } from '../../shared/titles';
import { addMarker, deleteMarker, findMarker, updateMarker } from '../../shared/markers';
import { addOverlay, asClip, clipLayout, deleteOverlay, findOverlay, moveOverlay, overlayLayout, pipFraming, updateOverlay } from '../../shared/overlays';
import { transitionInfo } from '../../shared/transitions';
import { NEUTRAL } from '../../shared/color';
import * as ops from '../../shared/ops';
import { COMMON_FRAME_RATES, type Rational, frameDuration, rateLabel, secondsToTicks, snapToFrame, ticksToSeconds } from '../../shared/time';
import { renderOverlayTrack } from '../captions/draw';
import { engine } from '../preview/engine';
import * as A from '../state/actions';
import { playhead } from '../state/playhead';
import { commit, redo, store, toast, undo } from '../state/store';

type Args = Record<string, any>;
const ok = (v: unknown): ToolResult => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const fail = (msg: string): ToolResult => ({ content: [{ type: 'text', text: msg }], isError: true });
const sec = (t: number) => Math.round(ticksToSeconds(t) * 1000) / 1000;
const T = (s: number) => secondsToTicks(Number(s));

class ToolError extends Error {}

/** A clip on the main track or an overlay track (clip tools work on both). */
function clipOrThrow(p: Project, id: string): ClipItem {
  const o = findOverlay(p, id);
  if (o) return asClip(o);
  const it = p.sequence.items.find((i) => i.id === id);
  if (!it) throw new ToolError(`No timeline item with id ${id}. Call get_project for current ids.`);
  if (it.kind !== 'clip') throw new ToolError(`${id} is a gap, not a clip.`);
  return it;
}

function mediaOrThrow(p: Project, id: string): MediaRef {
  const m = findMedia(p, id);
  if (!m) throw new ToolError(`No media with id ${id}. Call get_project for media ids.`);
  return m;
}

function framingFrom(f: Args | undefined, current: Framing = DEFAULT_FRAMING): Framing {
  if (!f) return current;
  if (!['fit', 'fill', 'manual'].includes(f.mode)) throw new ToolError('framing.mode must be fit, fill or manual.');
  return {
    mode: f.mode,
    scale: Math.min(20, Math.max(0.05, Number(f.scale ?? current.scale ?? 1))),
    x: Math.min(5, Math.max(-5, Number(f.x ?? 0))),
    y: Math.min(5, Math.max(-5, Number(f.y ?? 0))),
    ...(Number.isFinite(f.rotation ?? current.rotation) && (f.rotation ?? current.rotation) % 360 !== 0
      ? { rotation: Math.min(360, Math.max(-360, Number(f.rotation ?? current.rotation))) }
      : {}),
  };
}

function presetFrom(v: Args | null | undefined, keep: ClipAnimation['in']): ClipAnimation['in'] {
  if (v === undefined) return keep;
  if (v === null) return undefined;
  return { preset: v.preset as InPreset, duration: T(Math.min(10, Math.max(0.05, v.duration ?? 0.5))) };
}

function rateFromFps(fps: number): Rational {
  const known = COMMON_FRAME_RATES.find((c) => Math.abs(c.rate.num / c.rate.den - fps) < 0.01);
  if (known) return known.rate;
  if (!(fps >= 1 && fps <= 240)) throw new ToolError('frame_rate must be between 1 and 240.');
  return { num: Math.round(fps * 1000), den: 1000 };
}

/** Group words into sentences (by punctuation or pauses) for an AI-friendly transcript. */
export function sentences(words: { start: number; end: number; text: string }[]) {
  const out: { start: number; end: number; text: string }[] = [];
  let cur: typeof words = [];
  const flush = () => {
    if (cur.length) out.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.text).join(' ') });
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && w.start - prev.end > 0.8 * 705_600_000) flush();
    cur.push(w);
    if (/[.!?]$/.test(w.text) || cur.length >= 40) flush();
  }
  flush();
  return out;
}

export function projectSummary(p: Project) {
  const lay = layoutSequence(p);
  const s = store.get();
  return {
    name: p.name,
    canvas: { width: p.canvas.width, height: p.canvas.height, preset: p.canvas.preset, background: p.background },
    frame_rate: rateLabel(p.frameRate),
    duration_s: sec(lay.duration),
    playhead_s: sec(playhead.get().time),
    saved: s.project === s.savedProject,
    captions: p.captions ?? { enabled: false },
    media: p.media.map((m) => ({
      id: m.id,
      name: m.name,
      duration_s: sec(m.info.duration),
      kind: m.info.kind ?? 'video',
      size: m.info.kind === 'audio' ? undefined : `${m.info.displayWidth}x${m.info.displayHeight}`,
      fps: rateLabel(m.info.frameRate),
      has_audio: m.info.hasAudio,
      has_transcript: !!m.transcript,
      offline: !!s.missing[m.id],
      ...(m.info.isHDR ? { hdr: true, tone_map: !!m.input?.toneMap } : {}),
      ...(m.input?.lut ? { lut: m.input.lut.name } : {}),
      warnings: m.warnings,
    })),
    titles: (p.titles ?? []).map((t) => ({
      id: t.id, text: t.text, row: t.row, start_s: sec(t.start), end_s: sec(t.start + t.duration),
      font: t.style.font, size: t.style.size, weight: t.style.weight, color: t.style.color, look: t.style.look,
      align: t.style.align, x: t.style.x, y: t.style.y, anim_in: t.animIn, anim_out: t.animOut,
    })),
    audio_tracks: (p.audioTracks ?? []).map((t) => ({
      id: t.id, name: t.name, volume: t.volume, muted: t.muted, duck: t.duck ? { db: t.duckDb } : false,
      clips: t.clips.map((c) => ({
        id: c.id, media_id: c.mediaId, media_name: findMedia(p, c.mediaId)?.name, start_s: sec(c.start), end_s: sec(c.start + c.sourceOut - c.sourceIn),
        source_in_s: sec(c.sourceIn), source_out_s: sec(c.sourceOut), volume: c.volume, fade_in_s: sec(c.fadeIn), fade_out_s: sec(c.fadeOut),
      })),
    })),
    timeline: lay.items.map((l) => {
      const base = { position: l.index, id: l.item.id, kind: l.item.kind, start_s: sec(l.start), end_s: sec(l.end) };
      if (l.item.kind === 'gap') return base;
      return { ...base, ...clipSummary(p, l.item, l) };
    }),
    markers: (p.markers ?? []).map((m) => ({ id: m.id, time_s: sec(m.time), label: m.label, color: m.color })),
    overlays: (p.overlays ?? []).map((o) => {
      const l = overlayLayout(o);
      return { id: o.id, track: `V${o.row + 2}`, row: o.row, start_s: sec(l.start), end_s: sec(l.end), ...clipSummary(p, l.item as ClipItem, l) };
    }),
  };
}

/** One clip's properties (main track or overlay track). */
function clipSummary(p: Project, c: ClipItem, l: LaidOutItem) {
  return {
    media_id: c.mediaId,
    media_name: findMedia(p, c.mediaId)?.name,
    source_in_s: sec(c.sourceIn),
    source_out_s: sec(c.sourceOut),
    ...(c.speed ? { speed: c.speed } : {}),
    ...(c.color ? { color: c.color } : {}),
    ...(c.transition ? { transition_to_next: { kind: c.transition.kind, duration_s: sec(c.transition.duration) } } : {}),
    framing: c.framing,
    volume: c.volume,
    muted: c.muted,
    animation: c.animation
      ? {
          in: c.animation.in && { preset: c.animation.in.preset, duration_s: sec(c.animation.in.duration) },
          out: c.animation.out && { preset: c.animation.out.preset, duration_s: sec(c.animation.out.duration) },
          motion: c.animation.motion,
          keyframes: Object.fromEntries(
            Object.entries(c.animation.keyframes ?? {}).map(([k, keys]) => [k, keys!.map((kf) => ({ time_s: sec(timelineAt(c, l.start, kf.at)), value: kf.value, easing: kf.easing }))]),
          ),
        }
      : undefined,
  };
}

/** A clip's entry from get_project (main track or overlay). */
function clipInfo(id: string) {
  const s = projectSummary(store.get().project);
  return s.timeline.find((x) => x.id === id) ?? s.overlays.find((x) => x.id === id);
}

/** Apply an edit; returns false (and nothing changes) if it had no effect. */
function edit(label: string, fn: (p: Project) => Project, extra = {}): boolean {
  const changed = commit(fn, extra);
  if (changed) toast(`AI: ${label}`, 'info', 3000);
  return changed;
}

async function waitForPreview() {
  const end = performance.now() + 3000;
  while (performance.now() < end) {
    const v = [...document.querySelectorAll<HTMLVideoElement>('.stage-video')].find((e) => e.style.display === 'block');
    if (!v || (v.readyState >= 2 && !v.seeking)) break;
    await new Promise((r) => setTimeout(r, 30));
  }
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

export async function runRendererTool(name: string, args: Args): Promise<ToolResult> {
  try {
    const p = store.get().project;
    switch (name) {
      // ---- internal helpers used by the main process ----
      case '__get_project_raw':
        return ok(JSON.stringify(p));
      case '__add_media': {
        const existing = new Set(p.media.map((m) => m.path));
        const add: MediaRef[] = (args.media as MediaRef[]).filter((m) => !existing.has(m.path)).map((m) => ({ ...m, id: newId('media') }));
        if (add.length) edit(`imported ${add.map((m) => m.name).join(', ')}`, (pr) => ops.addMedia(pr, add));
        add.forEach(A.loadThumbnail);
        const all = store.get().project.media.filter((m) => (args.media as MediaRef[]).some((x) => x.path === m.path));
        return ok({ imported: all.map((m) => ({ id: m.id, name: m.name, duration_s: sec(m.info.duration) })) });
      }
      case '__prepare_frame': {
        store.set({ previewMediaId: null });
        engine.seek(T(args.time));
        document.body.classList.add('capturing');
        await waitForPreview();
        const r = document.querySelector('.stage')!.getBoundingClientRect();
        return ok({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) });
      }
      case '__render_overlays': {
        const track = await renderOverlayTrack(args.project as Project, args.width, args.height, args.rate);
        return ok(track ? JSON.stringify(track) : 'null');
      }
      case '__end_capture':
        document.body.classList.remove('capturing');
        return ok('ok');
      case '__save': {
        if (!store.get().projectPath) return fail('This project has never been saved. Ask the person to save it once (⌘S) to choose a location.');
        return (await A.saveProject()) ? ok({ saved: store.get().projectPath }) : fail('Saving failed.');
      }

      case '__remove_ranges_batch': {
        let removedTotal = 0;
        let parts = 0;
        let next = p;
        for (const it of args.items as { clip_id: string; ranges: { start: number; end: number }[] }[]) {
          const r = ops.removeSourceRanges(next, it.clip_id, it.ranges.map((x) => ({ start: T(x.start), end: T(x.end) })), { padding: T(args.padding ?? 0) });
          next = r.project;
          removedTotal += r.removed;
          parts += r.parts;
        }
        if (next === p) return ok({ removed_s: 0, message: 'Nothing to remove.' });
        edit(`${args.label ?? 'removed ranges'} (${sec(removedTotal)} s)`, () => next, { selection: null });
        return ok({ removed_s: sec(removedTotal), clips_now: parts, timeline: projectSummary(store.get().project).timeline });
      }
      case '__split_source_times': {
        const c = clipOrThrow(p, args.clip_id);
        const r = ops.splitAtSourceTimes(p, c.id, (args.times as number[]).map(T));
        if (r.parts <= 1) return ok({ parts: 1, message: 'No scene changes inside this clip.' });
        edit(`split into ${r.parts} scenes`, () => r.project);
        return ok({ parts: r.parts, timeline: projectSummary(store.get().project).timeline });
      }
      case '__set_speech': {
        const sp = (args.speech as { start: number; end: number }[]).map((r) => ({ start: T(r.start), end: T(r.end) }));
        store.set((st) => {
          const next = setSpeech(st.project, args.media_id, sp);
          return { project: next, savedProject: st.savedProject === st.project ? next : st.savedProject, past: st.past.map((x) => setSpeech(x, args.media_id, sp)), future: st.future.map((x) => setSpeech(x, args.media_id, sp)) };
        });
        return ok('ok');
      }
      case '__needs_speech':
        return ok(JSON.stringify(mediaNeedingSpeechAnalysis(p).map((id) => ({ id, path: findMedia(p, id)!.path, duration_s: sec(findMedia(p, id)!.info.duration) }))));

      // ---- audio tracks ----
      case 'add_title': {
        if (typeof args.text !== 'string') throw new ToolError('text is required.');
        const r = addTitle(p, T(args.start ?? ticksToSeconds(playhead.get().time)), {
          preset: args.preset, text: args.text, duration: args.duration !== undefined ? T(args.duration) : undefined, row: args.row,
        });
        const next = updateTitle(r.project, r.id, (t) => applyTitleArgs(t, { ...args, start: undefined, duration: undefined, row: undefined }));
        edit(`added the title “${args.text.slice(0, 40)}”`, () => next, { selection: { kind: 'title', id: r.id } });
        const t = findTitle(store.get().project, r.id)!;
        return ok({ title_id: r.id, row: t.row, start_s: sec(t.start), end_s: sec(t.start + t.duration), project_end_s: sec(layoutSequence(store.get().project).duration) });
      }
      case 'set_title': {
        const old = findTitle(p, args.title_id);
        if (!old) throw new ToolError(`No title with id ${args.title_id}.`);
        let next = updateTitle(p, old.id, (t) => applyTitleArgs(t, { ...args, start: undefined, row: undefined }));
        if (args.start !== undefined || args.row !== undefined) next = moveTitle(next, old.id, args.start !== undefined ? T(args.start) : old.start, args.row);
        edit('changed a title', () => next, { selection: { kind: 'title', id: old.id } });
        const t = findTitle(store.get().project, old.id)!;
        return ok({ title_id: t.id, row: t.row, start_s: sec(t.start), end_s: sec(t.start + t.duration) });
      }
      // ---- overlay tracks (picture-in-picture) ----
      case 'add_overlay':
      case 'set_overlay': {
        const adding = name === 'add_overlay';
        let next = p;
        let id: string = args.overlay_id;
        if (adding) {
          const m = mediaOrThrow(p, args.media_id);
          if (m.info.kind === 'audio') throw new ToolError(`${m.name} is an audio file: use add_audio.`);
          const r = addOverlay(p, m.id, T(args.start ?? ticksToSeconds(playhead.get().time)), { row: args.row, corner: args.position, size: args.size });
          if (!r) throw new ToolError('That media is too short to add.');
          next = r.project;
          id = r.id;
        } else if (!findOverlay(p, id)) throw new ToolError(`No overlay with id ${id}. Call get_project for current ids.`);
        const o = findOverlay(next, id)!;
        const m = findMedia(next, o.mediaId)!;
        if (args.source_in !== undefined || args.source_out !== undefined) {
          const inT = args.source_in !== undefined ? T(args.source_in) : o.sourceIn;
          const outT = args.source_out !== undefined ? T(args.source_out) : o.sourceOut;
          if (!(outT > inT)) throw new ToolError('source_out must be greater than source_in.');
          const range = ops.legalRange(next, m, inT, outT, 'in', o.speed ?? 1);
          next = updateOverlay(next, id, (x) => ({ ...x, ...range }));
        }
        if (!adding && (args.position !== undefined || args.size !== undefined)) {
          const cur = findOverlay(next, id)!;
          const size = args.size ?? (cur.framing.mode === 'manual' ? cur.framing.scale : 0.35);
          next = ops.setFraming(next, id, pipFraming(m.info.displayWidth, m.info.displayHeight, next.canvas.width, next.canvas.height, args.position ?? 'bottomRight', size));
        }
        if (!adding && (args.start !== undefined || args.row !== undefined)) {
          const cur = findOverlay(next, id)!;
          next = moveOverlay(next, id, args.start !== undefined ? T(args.start) : cur.start, args.row);
        }
        edit(adding ? `added ${m.name} as picture-in-picture` : 'changed an overlay', () => next, { selection: { kind: 'overlay', id } });
        engine.seek(playhead.get().time);
        return ok({ overlay_id: id, ...clipInfo(id), project_end_s: sec(layoutSequence(store.get().project).duration) });
      }
      case 'remove_overlay': {
        if (!findOverlay(p, args.overlay_id)) throw new ToolError(`No overlay with id ${args.overlay_id}.`);
        edit('removed an overlay', (q) => deleteOverlay(q, args.overlay_id), { selection: null });
        return ok('removed');
      }
      case 'speed_ramp': {
        if (![args.from, args.to].every(Number.isFinite)) throw new ToolError('from and to must be numbers between 0.25 and 4.');
        const r = ops.speedRamp(p, args.clip_id, Number(args.from), Number(args.to), args.steps ?? 8);
        if ('error' in r) throw new ToolError(r.error);
        edit(`ramped speed ${args.from}× → ${args.to}×`, () => r.project, { selection: { kind: 'items', ids: r.ids } });
        const tl = projectSummary(store.get().project).timeline;
        return ok({ parts: r.ids.map((id) => tl.find((x) => x.id === id)).map((x) => ({ id: x!.id, speed: (x as { speed?: number }).speed ?? 1, start_s: x!.start_s, end_s: x!.end_s })) });
      }
      case 'freeze_frame': {
        if (!Number.isFinite(args.time)) throw new ToolError('time must be a number of seconds.');
        engine.seek(T(args.time));
        const r = await A.freezeFrameAtPlayhead(args.duration !== undefined ? T(Math.min(60, Math.max(1 / 30, args.duration))) : undefined);
        if ('error' in r) throw new ToolError(r.error);
        return ok({ still_clip_id: r.clipId, media_id: r.mediaId, timeline: projectSummary(store.get().project).timeline });
      }
      case 'reverse_clip': {
        clipOrThrow(p, args.clip_id);
        const r = await A.reverseClip(args.clip_id);
        if ('error' in r) throw new ToolError(r.error);
        return ok({ clip_id: args.clip_id, media_id: r.mediaId, clip: clipInfo(args.clip_id) });
      }
      case 'detach_audio': {
        clipOrThrow(p, args.clip_id);
        const r = detachAudio(p, args.clip_id);
        if ('error' in r) throw new ToolError(r.error);
        edit('detached a clip’s sound', () => r.project, { selection: { kind: 'audio', id: r.audioClipId } });
        const hit = findAudioClip(store.get().project, r.audioClipId)!;
        return ok({ audio_clip_id: r.audioClipId, track_id: hit.track.id, start_s: sec(hit.clip.start), source_in_s: sec(hit.clip.sourceIn), source_out_s: sec(hit.clip.sourceOut) });
      }
      case 'set_media_picture': {
        const m = mediaOrThrow(p, args.media_id);
        if (m.info.kind !== 'video') throw new ToolError(`${m.name} is not a video.`);
        const patch: Record<string, unknown> = {};
        if (args.tone_map !== undefined) {
          if (!m.info.isHDR && args.tone_map) throw new ToolError(`${m.name} is not HDR; there is nothing to tone-map.`);
          patch.toneMap = !!args.tone_map;
        }
        if (args.remove_lut) patch.lut = undefined;
        else if (args.lut_path) {
          const r = await window.cutroom.importLut(String(args.lut_path));
          if (!r.ok) throw new ToolError(r.error);
          patch.lut = r.lut;
        }
        A.setMediaInput(m.id, patch);
        const n = findMedia(store.get().project, m.id)!;
        return ok({ media_id: n.id, hdr: n.info.isHDR, tone_map: !!n.input?.toneMap, lut: n.input?.lut?.name ?? null, note: 'A new preview copy is being made; get_frame (timeline) shows the new look once it is ready. Exports use it right away.' });
      }
      // ---- markers ----
      case 'add_marker': {
        if (!Number.isFinite(args.time) || args.time < 0) throw new ToolError('time must be a number of seconds ≥ 0.');
        const r = addMarker(p, T(args.time), { label: args.label, color: args.color });
        if (r.existed) {
          if (args.label !== undefined || args.color !== undefined) edit('changed a marker', (q) => updateMarker(q, r.id, { label: args.label, color: args.color }));
        } else edit(`added the marker “${findMarker(r.project, r.id)!.label}”`, () => r.project, { selection: { kind: 'marker', id: r.id } });
        const m = findMarker(store.get().project, r.id)!;
        return ok({ marker_id: m.id, time_s: sec(m.time), label: m.label, color: m.color, already_there: r.existed });
      }
      case 'set_marker': {
        if (!findMarker(p, args.marker_id)) throw new ToolError(`No marker with id ${args.marker_id}.`);
        const patch: Record<string, unknown> = {};
        if (args.time !== undefined) patch.time = T(args.time);
        if (args.label !== undefined) patch.label = String(args.label);
        if (args.color !== undefined) patch.color = args.color;
        edit('changed a marker', (q) => updateMarker(q, args.marker_id, patch));
        const m = findMarker(store.get().project, args.marker_id)!;
        return ok({ marker_id: m.id, time_s: sec(m.time), label: m.label, color: m.color });
      }
      case 'remove_marker': {
        if (!findMarker(p, args.marker_id)) throw new ToolError(`No marker with id ${args.marker_id}.`);
        edit('removed a marker', (q) => deleteMarker(q, args.marker_id), { selection: null });
        return ok('removed');
      }
      case 'set_title_keyframe': {
        const t = findTitle(p, args.title_id);
        if (!t) throw new ToolError(`No title with id ${args.title_id}.`);
        const rel = T(args.time) - t.start;
        if (rel < 0 || rel >= t.duration) throw new ToolError(`time must be inside the title (${sec(t.start)}–${sec(t.start + t.duration)} s).`);
        const at = snapToFrame(rel, p.frameRate, 'round');
        if (args.remove) edit('removed a title keyframe', (q) => removeTitleKeyframe(q, t.id, args.property, at));
        else {
          if (!Number.isFinite(args.value)) throw new ToolError('value must be a number.');
          edit(`keyframed a title's ${args.property}`, (q) => setTitleKeyframe(q, t.id, args.property, at, Number(args.value), args.easing));
        }
        const n = findTitle(store.get().project, t.id)!;
        return ok({ title_id: n.id, keyframes: Object.fromEntries(Object.entries(n.keyframes ?? {}).map(([k, ks]) => [k, ks!.map((x) => ({ time_s: sec(n.start + x.at), value: x.value, easing: x.easing }))])) });
      }
      case 'remove_title': {
        if (!findTitle(p, args.title_id)) throw new ToolError(`No title with id ${args.title_id}.`);
        edit('removed a title', (q) => deleteTitle(q, args.title_id), { selection: null });
        return ok('removed');
      }
      case 'add_audio': {
        const m = mediaOrThrow(p, args.media_id);
        if (!m.info.hasAudio) throw new ToolError(`${m.name} has no audio.`);
        if (args.track_id && !(p.audioTracks ?? []).some((t) => t.id === args.track_id)) throw new ToolError(`No audio track with id ${args.track_id}.`);
        const r = addAudioClip(p, m.id, T(args.start ?? 0), args.track_id);
        if (!r) throw new ToolError('Could not add that audio (too short?).');
        let next = r.project;
        if (args.source_in !== undefined || args.source_out !== undefined) {
          const sIn = T(args.source_in ?? 0);
          const sOut = T(args.source_out ?? ticksToSeconds(m.info.duration));
          if (!(sOut > sIn)) throw new ToolError('source_out must be greater than source_in.');
          next = trimAudioClip(next, r.clipId, 'start', sIn);
          const c = findAudioClip(next, r.clipId)!.clip;
          next = trimAudioClip(next, r.clipId, 'end', sOut - c.sourceOut);
          next = moveAudioClip(next, r.clipId, T(args.start ?? 0));
        }
        next = setAudioClip(next, r.clipId, { volume: args.volume, fadeIn: args.fade_in !== undefined ? T(args.fade_in) : undefined, fadeOut: args.fade_out !== undefined ? T(args.fade_out) : undefined });
        edit(`added ${m.name} to “${(next.audioTracks ?? []).find((t) => t.id === r.trackId)?.name}”`, () => next, { selection: { kind: 'audio', id: r.clipId } });
        return ok({ clip_id: r.clipId, track_id: r.trackId, audio_tracks: projectSummary(store.get().project).audio_tracks });
      }
      case 'set_audio_clip': {
        const hit = findAudioClip(p, args.clip_id);
        if (!hit) throw new ToolError(`No audio clip with id ${args.clip_id}.`);
        let next = p;
        if (args.source_in !== undefined) next = trimAudioClip(next, hit.clip.id, 'start', T(args.source_in) - hit.clip.sourceIn);
        if (args.source_out !== undefined) next = trimAudioClip(next, hit.clip.id, 'end', T(args.source_out) - findAudioClip(next, hit.clip.id)!.clip.sourceOut);
        if (args.start !== undefined || args.track_id !== undefined) {
          if (args.track_id && !(p.audioTracks ?? []).some((t) => t.id === args.track_id)) throw new ToolError(`No audio track with id ${args.track_id}.`);
          next = moveAudioClip(next, hit.clip.id, args.start !== undefined ? T(args.start) : findAudioClip(next, hit.clip.id)!.clip.start, args.track_id);
        }
        next = setAudioClip(next, hit.clip.id, { volume: args.volume, fadeIn: args.fade_in !== undefined ? T(args.fade_in) : undefined, fadeOut: args.fade_out !== undefined ? T(args.fade_out) : undefined });
        edit('changed an audio clip', () => next);
        return ok({ audio_tracks: projectSummary(store.get().project).audio_tracks });
      }
      case 'remove_audio_clip': {
        if (!findAudioClip(p, args.clip_id)) throw new ToolError(`No audio clip with id ${args.clip_id}.`);
        edit('removed an audio clip', (pr) => deleteAudioClip(pr, args.clip_id), { selection: null });
        return ok({ audio_tracks: projectSummary(store.get().project).audio_tracks });
      }
      case '__set_audio_track': {
        if (!(p.audioTracks ?? []).some((t) => t.id === args.track_id)) throw new ToolError(`No audio track with id ${args.track_id}.`);
        edit('changed an audio track', (pr) => setAudioTrack(pr, args.track_id, { name: args.name, volume: args.volume, muted: args.muted, duck: args.duck, duckDb: args.duck_db }));
        return ok({ audio_tracks: projectSummary(store.get().project).audio_tracks });
      }

      case 'remove_ranges': {
        clipOrThrow(p, args.clip_id);
        return runRendererTool('__remove_ranges_batch', { items: [{ clip_id: args.clip_id, ranges: args.ranges }], padding: args.padding ?? 0, label: 'cut ranges' });
      }

      case '__set_transcript': {
        mediaOrThrow(p, args.media_id);
        edit('added a transcript', (pr) => ops.setTranscript(pr, args.media_id, args.transcript as Transcript));
        return ok('ok');
      }

      // ---- speech ----
      case 'get_transcript': {
        const m = mediaOrThrow(p, args.media_id);
        if (!m.transcript) throw new ToolError(`${m.name} has no transcript yet. Call transcribe first.`);
        return ok({
          media: m.name,
          language: m.transcript.language,
          sentences: sentences(m.transcript.words).map((x) => ({ start_s: sec(x.start), end_s: sec(x.end), text: x.text })),
          ...(args.words ? { words: m.transcript.words.map((w) => ({ t: sec(w.start), e: sec(w.end), w: w.text })) } : {}),
        });
      }
      case 'set_captions': {
        if (args.color !== undefined && !isHexColor(args.color)) throw new ToolError('color must look like #ffffff.');
        if (args.highlight && !isHexColor(args.highlight)) throw new ToolError('highlight must look like #ffd23f or null.');
        edit('updated captions', (pr) =>
          ops.setCaptions(pr, (c) => ({
            ...c,
            enabled: args.enabled ?? true,
            look: args.look ?? c.look,
            fontSize: args.font_size !== undefined ? Math.min(15, Math.max(1.5, args.font_size)) : c.fontSize,
            position: args.position !== undefined ? Math.min(0.97, Math.max(0.03, args.position)) : c.position,
            color: args.color ?? c.color,
            highlight: args.highlight === undefined ? c.highlight : args.highlight,
            uppercase: args.uppercase ?? c.uppercase,
          })),
        );
        const np = store.get().project;
        const missingTranscripts = np.media.filter((m) => !m.transcript && np.sequence.items.some((i) => i.kind === 'clip' && i.mediaId === m.id)).map((m) => m.name);
        return ok({ captions: np.captions, cues: buildCues(np).length, untranscribed_media_on_timeline: missingTranscripts });
      }
      case 'remove_filler_words': {
        const items = p.sequence.items.filter((i): i is ClipItem => i.kind === 'clip' && (!args.clip_id || i.id === args.clip_id));
        if (args.clip_id && !items.length) throw new ToolError(`No clip with id ${args.clip_id}.`);
        const batch = items.map((c) => ({
          clip_id: c.id,
          ranges: fillerRanges(findMedia(p, c.mediaId)?.transcript?.words ?? []).map((r) => ({ start: ticksToSeconds(r.start), end: ticksToSeconds(r.end) })),
        })).filter((b) => b.ranges.length);
        if (!batch.length) return ok({ removed_s: 0, message: 'No filler words found (or no transcripts yet).' });
        return runRendererTool('__remove_ranges_batch', { items: batch, padding: 0, label: 'removed filler words' });
      }

      // ---- inspect ----
      case 'get_project':
        return ok(projectSummary(p));

      // ---- timeline ----
      case 'add_clip': {
        const m = mediaOrThrow(p, args.media_id);
        if (m.info.kind === 'audio') throw new ToolError(`${m.name} is an audio file: use add_audio to put it on an audio track.`);
        const r = ops.addClip(p, m.id, args.position);
        if (!r) throw new ToolError('That media is too short to add.');
        let next = r.project;
        if (args.source_in !== undefined || args.source_out !== undefined) {
          next = ops.setClipRange(next, r.clipId, T(args.source_in ?? 0), T(args.source_out ?? ticksToSeconds(m.info.duration)), 'in');
        }
        edit(`added ${m.name}`, () => next, { selection: { kind: 'item', id: r.clipId } });
        return ok({ clip_id: r.clipId, project: projectSummary(store.get().project).timeline });
      }
      case 'build_timeline': {
        const clips = args.clips as Args[];
        if (!clips.length) throw new ToolError('clips is empty.');
        const items: ClipItem[] = clips.map((c, i) => {
          const m = mediaOrThrow(p, c.media_id);
          if (m.info.kind === 'audio') throw new ToolError(`clips[${i}]: ${m.name} is audio-only; add it with add_audio.`);
          if (!(c.source_out > c.source_in)) throw new ToolError(`clips[${i}]: source_out must be greater than source_in.`);
          const range = ops.legalRange(p, m, T(c.source_in), T(c.source_out), 'in');
          const animation: ClipAnimation = {};
          const inA = presetFrom(c.in_animation, undefined);
          const outA = presetFrom(c.out_animation, undefined);
          if (inA) animation.in = inA;
          if (outA) animation.out = outA;
          return {
            kind: 'clip', id: newId('clip'), mediaId: m.id, ...range,
            framing: framingFrom(c.framing), volume: Math.min(1, Math.max(0, c.volume ?? 1)), muted: false,
            ...(Object.keys(animation).length ? { animation } : {}),
          };
        });
        edit(`built a timeline of ${items.length} clips`, (pr) => ({ ...pr, sequence: { items } }), { selection: null });
        engine.seek(0);
        return ok({ clips: items.length, timeline: projectSummary(store.get().project).timeline });
      }
      case 'set_clip_range': {
        const c = clipOrThrow(p, args.clip_id);
        const inT = args.source_in !== undefined ? T(args.source_in) : c.sourceIn;
        const outT = args.source_out !== undefined ? T(args.source_out) : c.sourceOut;
        if (!(outT > inT)) throw new ToolError('source_out must be greater than source_in.');
        edit('trimmed a clip', (pr) => ops.setClipRange(pr, c.id, inT, outT, args.source_in !== undefined && args.source_out === undefined ? 'out' : 'in'));
        return ok(clipInfo(c.id));
      }
      case 'split_at': {
        const r = ops.splitAt(p, T(args.time));
        if (!r) throw new ToolError('No clip to split there (the time must be inside a clip, not on its edge).');
        edit(`split at ${Number(args.time).toFixed(2)} s`, () => r.project);
        return ok({ left_id: r.leftId, right_id: r.rightId });
      }
      case 'delete_clip': {
        if (!p.sequence.items.some((i) => i.id === args.clip_id)) throw new ToolError(`No timeline item with id ${args.clip_id}.`);
        edit('deleted a clip', (pr) => ops.deleteItem(pr, args.clip_id, args.leave_gap ? 'leave-gap' : 'close-gap'), { selection: null });
        return ok({ timeline: projectSummary(store.get().project).timeline });
      }
      case 'move_clip': {
        if (!p.sequence.items.some((i) => i.id === args.clip_id)) throw new ToolError(`No timeline item with id ${args.clip_id}.`);
        edit('reordered clips', (pr) => ops.moveItem(pr, args.clip_id, Math.round(args.position)));
        return ok({ order: store.get().project.sequence.items.map((i) => i.id) });
      }
      case 'duplicate_clip': {
        const r = ops.duplicateItem(p, args.clip_id);
        if (!r) throw new ToolError(`No timeline item with id ${args.clip_id}.`);
        edit('duplicated a clip', () => r.project);
        return ok({ new_id: r.newId });
      }
      case 'set_framing': {
        const c = clipOrThrow(p, args.clip_id);
        edit(`set framing to ${args.framing.mode}`, (pr) => ops.setFraming(pr, c.id, framingFrom(args.framing, c.framing)));
        return ok({ framing: clipOrThrow(store.get().project, c.id).framing });
      }
      case 'set_clip_audio': {
        const c = clipOrThrow(p, args.clip_id);
        edit('changed clip audio', (pr) => ops.setClipAudio(pr, c.id, { volume: args.volume, muted: args.muted }));
        const n = clipOrThrow(store.get().project, c.id);
        return ok({ volume: n.volume, muted: n.muted });
      }

      case 'set_color': {
        const c = clipOrThrow(p, args.clip_id);
        const patch: Record<string, number> = {};
        for (const k of ['exposure', 'contrast', 'saturation', 'temperature', 'hue', 'lightness']) {
          if (args[k] === undefined) continue;
          if (!Number.isFinite(args[k])) throw new ToolError(`${k} must be a number.`);
          patch[k] = Number(args[k]);
        }
        if (args.curves) {
          const cur = { ...(args.reset ? {} : clipOrThrow(p, args.clip_id).color?.curves) } as Record<string, unknown>;
          for (const k of ['master', 'r', 'g', 'b']) if (args.curves[k] !== undefined) cur[k] = args.curves[k];
          (patch as Record<string, unknown>).curves = cur;
        }
        edit('adjusted colour', (pr) => ops.setColor(args.reset ? ops.setColor(pr, c.id, NEUTRAL) : pr, c.id, patch));
        return ok({ color: clipOrThrow(store.get().project, c.id).color ?? 'neutral' });
      }
      case 'set_transition': {
        const c = clipOrThrow(p, args.clip_id);
        if (findOverlay(p, c.id)) throw new ToolError('Transitions are between clips on the main track; fade an overlay with set_animation instead.');
        const kind = args.kind === 'none' ? null : args.kind;
        edit(kind ? `added a ${kind} transition` : 'removed a transition', (pr) => ops.setTransition(pr, c.id, kind, args.duration !== undefined ? T(args.duration) : undefined));
        const info = transitionInfo(store.get().project, c.id);
        if (!kind) return ok({ transition: 'none' });
        if (!info.resolved) return ok({ transition: kind, active: false, reason: info.reason });
        return ok({
          transition: kind, active: true, start_s: sec(info.resolved.start), end_s: sec(info.resolved.end), length_s: sec(info.resolved.end - info.resolved.start),
          ...(info.resolved.limitedBy ? { shortened_because: info.resolved.limitedBy === 'footage' ? 'not enough footage past the cut' : 'clip too short' } : {}),
        });
      }
      case 'set_speed': {
        const c = clipOrThrow(p, args.clip_id);
        if (findMedia(p, c.mediaId)?.info.kind === 'image') throw new ToolError('Photos have no speed. Change the clip duration with set_clip_range instead.');
        if (!Number.isFinite(args.speed)) throw new ToolError('speed must be a number between 0.25 and 4.');
        edit(`set speed to ${args.speed}×`, (pr) => ops.setSpeed(pr, c.id, Number(args.speed)));
        const n = clipOrThrow(store.get().project, c.id);
        const l = clipLayout(store.get().project, c.id)!;
        return ok({ speed: n.speed ?? 1, start_s: sec(l.start), end_s: sec(l.end), project_duration_s: sec(layoutSequence(store.get().project).duration) });
      }

      // ---- animation ----
      case 'set_animation': {
        const c = clipOrThrow(p, args.clip_id);
        edit('set clip animation', (pr) =>
          ops.setAnimation(pr, c.id, (a) => ({
            ...a,
            in: presetFrom(args.in, a.in),
            out: presetFrom(args.out, a.out),
            motion: args.motion === undefined ? a.motion : args.motion === null ? undefined : { preset: args.motion.preset as MotionPreset, amount: Math.min(1, Math.max(0, args.motion.amount ?? 0.5)) },
          })),
        );
        return ok(clipInfo(c.id));
      }
      case 'set_keyframe': {
        const c = clipOrThrow(p, args.clip_id);
        const l = clipLayout(p, c.id)!;
        const t = T(args.time);
        if (t < l.start || t > l.end) throw new ToolError(`time must be within the clip (${sec(l.start)}–${sec(l.end)} s).`);
        edit(`keyframed ${args.property}`, (pr) => ops.setKeyframe(pr, c.id, args.property, sourceAt(c, l.start, t), Number(args.value), args.easing));
        return ok(clipInfo(c.id));
      }
      case 'remove_keyframes': {
        const c = clipOrThrow(p, args.clip_id);
        const l = clipLayout(p, c.id)!;
        edit('removed keyframes', (pr) =>
          ops.setAnimation(pr, c.id, (a) => {
            if (!args.property) return { ...a, keyframes: undefined };
            const keys = a.keyframes?.[args.property as keyof NonNullable<ClipAnimation['keyframes']>] ?? [];
            const at = args.time === undefined ? null : sourceAt(c, l.start, T(args.time));
            const half = frameDuration(p.frameRate) / 2; // match keyframes within half a frame
            return { ...a, keyframes: { ...a.keyframes, [args.property]: at === null ? [] : keys.filter((k) => Math.abs(k.at - at) > half) } };
          }),
        );
        return ok(clipInfo(c.id));
      }

      // ---- project ----
      case 'set_canvas': {
        if (args.preset) A.applyCanvasPreset(args.preset);
        if (args.width !== undefined || args.height !== undefined) {
          A.applyCanvasPreset('custom', { width: evenDim(args.width ?? p.canvas.width), height: evenDim(args.height ?? p.canvas.height) });
        }
        if (args.frame_rate !== undefined) edit(`set ${args.frame_rate} fps`, (pr) => ops.setFrameRate(pr, rateFromFps(Number(args.frame_rate))));
        if (args.background !== undefined) {
          if (!isHexColor(args.background)) throw new ToolError('background must look like #000000.');
          edit('changed background', (pr) => ({ ...pr, background: args.background }));
        }
        const np = store.get().project;
        return ok({ canvas: np.canvas, frame_rate: rateLabel(np.frameRate), background: np.background, presets: CANVAS_PRESETS.map((c) => c.id) });
      }
      case 'undo':
        undo();
        toast('AI: undo', 'info', 2000);
        return ok({ timeline: projectSummary(store.get().project).timeline });
      case 'redo':
        redo();
        toast('AI: redo', 'info', 2000);
        return ok({ timeline: projectSummary(store.get().project).timeline });
      case 'seek':
        store.set({ previewMediaId: null });
        engine.seek(T(args.time));
        return ok({ playhead_s: sec(playhead.get().time) });
    }
    return fail(`Unknown tool ${name}.`);
  } catch (e) {
    return fail(e instanceof ToolError ? e.message : `Error: ${(e as Error).message}`);
  }
}

export function installControlBridge() {
  const api = window.cutroom;
  const off1 = api.onControlRequest(async ({ id, name, args }) => {
    const result = await runRendererTool(name, args);
    api.respondControl(id, result);
  });
  const off2 = api.onAiNotify((text) => toast(text, 'info', 6000));
  return () => {
    off1();
    off2();
  };
}

/** Apply the add_title / set_title arguments (only the ones given) to a title. */
function applyTitleArgs(t: TitleClip, a: Record<string, any>): TitleClip {
  const st = { ...t.style };
  const color = (v: unknown, name: string) => {
    if (typeof v !== 'string' || !isHexColor(v)) throw new ToolError(`${name} must be a colour like #ffcc00.`);
    return v;
  };
  if (a.font !== undefined) st.font = a.font;
  if (a.size !== undefined) st.size = a.size;
  if (a.weight !== undefined) st.weight = a.weight;
  if (a.italic !== undefined) st.italic = !!a.italic;
  if (a.color !== undefined) st.color = color(a.color, 'color');
  if (a.look !== undefined) st.look = a.look;
  if (a.box_color !== undefined) st.boxColor = color(a.box_color, 'box_color');
  if (a.box_opacity !== undefined) st.boxOpacity = a.box_opacity;
  if (a.uppercase !== undefined) st.uppercase = !!a.uppercase;
  if (a.align !== undefined) st.align = a.align;
  if (a.x !== undefined) st.x = a.x;
  if (a.y !== undefined) st.y = a.y;
  if (a.max_width !== undefined) st.maxWidth = a.max_width;
  return {
    ...t,
    style: st,
    text: typeof a.text === 'string' ? a.text : t.text,
    duration: a.duration !== undefined ? T(a.duration) : t.duration,
    animIn: a.anim_in ?? t.animIn,
    animOut: a.anim_out ?? t.animOut,
    animLength: a.anim_length !== undefined ? T(a.anim_length) : t.animLength,
  };
}
