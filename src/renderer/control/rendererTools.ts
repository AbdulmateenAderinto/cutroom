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
  evenDim,
  findMedia,
  isHexColor,
  layoutSequence,
  newId,
} from '../../shared/model';
import * as ops from '../../shared/ops';
import { COMMON_FRAME_RATES, type Rational, frameDuration, rateLabel, secondsToTicks, ticksToSeconds } from '../../shared/time';
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
    media: p.media.map((m) => ({
      id: m.id,
      name: m.name,
      duration_s: sec(m.info.duration),
      size: `${m.info.displayWidth}x${m.info.displayHeight}`,
      fps: rateLabel(m.info.frameRate),
      has_audio: m.info.hasAudio,
      has_transcript: !!m.transcript,
      offline: !!s.missing[m.id],
      warnings: m.warnings,
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
      case '__end_capture':
        document.body.classList.remove('capturing');
        return ok('ok');
      case '__save': {
        if (!store.get().projectPath) return fail('This project has never been saved. Ask the person to save it once (⌘S) to choose a location.');
        return (await A.saveProject()) ? ok({ saved: store.get().projectPath }) : fail('Saving failed.');
      }

      // ---- inspect ----
      case 'get_project':
        return ok(projectSummary(p));

      // ---- timeline ----
      case 'add_clip': {
        const m = mediaOrThrow(p, args.media_id);
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
