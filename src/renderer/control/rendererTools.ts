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
  type MediaRef,
  type Project,
  type TitleClip,
  type Transcript,
  evenDim,
  findMedia,
  isHexColor,
  layoutSequence,
  newId,
} from '../../shared/model';
import {
  addAudioClip, deleteAudioClip, findAudioClip, mediaNeedingSpeechAnalysis, moveAudioClip, setAudioClip, setAudioTrack, setSpeech, trimAudioClip,
} from '../../shared/audio';
import { buildCues, fillerRanges } from '../../shared/captions';
import { addTitle, deleteTitle, findTitle, moveTitle, updateTitle } from '../../shared/titles';
import * as ops from '../../shared/ops';
import { COMMON_FRAME_RATES, type Rational, frameDuration, rateLabel, secondsToTicks, ticksToSeconds } from '../../shared/time';
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

function clipOrThrow(p: Project, id: string): ClipItem {
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
      const c = l.item;
      return {
        ...base,
        media_id: c.mediaId,
        media_name: findMedia(p, c.mediaId)?.name,
        source_in_s: sec(c.sourceIn),
        source_out_s: sec(c.sourceOut),
        framing: c.framing,
        volume: c.volume,
        muted: c.muted,
        animation: c.animation
          ? {
              in: c.animation.in && { preset: c.animation.in.preset, duration_s: sec(c.animation.in.duration) },
              out: c.animation.out && { preset: c.animation.out.preset, duration_s: sec(c.animation.out.duration) },
              motion: c.animation.motion,
              keyframes: Object.fromEntries(
                Object.entries(c.animation.keyframes ?? {}).map(([k, keys]) => [k, keys!.map((kf) => ({ time_s: sec(l.start + kf.at - c.sourceIn), value: kf.value, easing: kf.easing }))]),
              ),
            }
          : undefined,
      };
    }),
  };
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
        return ok(projectSummary(store.get().project).timeline.find((x) => x.id === c.id));
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
        return ok(projectSummary(store.get().project).timeline.find((x) => x.id === c.id));
      }
      case 'set_keyframe': {
        const c = clipOrThrow(p, args.clip_id);
        const l = layoutSequence(p).items.find((x) => x.item.id === c.id)!;
        const t = T(args.time);
        if (t < l.start || t > l.end) throw new ToolError(`time must be within the clip (${sec(l.start)}–${sec(l.end)} s).`);
        edit(`keyframed ${args.property}`, (pr) => ops.setKeyframe(pr, c.id, args.property, c.sourceIn + (t - l.start), Number(args.value), args.easing));
        return ok(projectSummary(store.get().project).timeline.find((x) => x.id === c.id));
      }
      case 'remove_keyframes': {
        const c = clipOrThrow(p, args.clip_id);
        const l = layoutSequence(p).items.find((x) => x.item.id === c.id)!;
        edit('removed keyframes', (pr) =>
          ops.setAnimation(pr, c.id, (a) => {
            if (!args.property) return { ...a, keyframes: undefined };
            const keys = a.keyframes?.[args.property as keyof NonNullable<ClipAnimation['keyframes']>] ?? [];
            const at = args.time === undefined ? null : c.sourceIn + (T(args.time) - l.start);
            const half = frameDuration(p.frameRate) / 2; // match keyframes within half a frame
            return { ...a, keyframes: { ...a.keyframes, [args.property]: at === null ? [] : keys.filter((k) => Math.abs(k.at - at) > half) } };
          }),
        );
        return ok(projectSummary(store.get().project).timeline.find((x) => x.id === c.id));
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
