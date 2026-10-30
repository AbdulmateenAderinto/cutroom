/**
 * Preview playback.
 *
 * How it works:
 *  - Two <video> elements (A/B). The one showing the current clip plays; the other preloads the
 *    next clip and seeks to its in-point, so cuts switch quickly.
 *  - While a clip plays, the <video> element's own clock drives the playhead
 *    (timeline time = clip start + (video.currentTime − sourceIn)). Picture and sound come from
 *    the same element, so they stay in sync after trims, splits and reordering.
 *  - Gaps use the wall clock and show the background colour.
 *  - Each clip is positioned with the same computeClipRect() the exporter uses, as percentages of
 *    the canvas box, so framing matches the export.
 *
 * Preview vs export quality: the browser decodes at full resolution but draws at the preview size;
 * export always renders from the original files at the chosen output size.
 */
import {
  type ClipItem,
  type LaidOutItem,
  type Project,
  DEFAULT_FRAMING,
  animateRect,
  computeClipRect,
  createProject,
  findMedia,
  layoutSequence,
} from '../../shared/model';
import { type Ticks, TICKS_PER_SECOND, frameDuration, secondsToTicks, snapToFrame, ticksToSeconds } from '../../shared/time';
import { evalAnimation } from '../../shared/animation';
import { playhead } from '../state/playhead';
import { attachVideoElement, setVideoGain, stopMusic, syncMusic } from './audio';
import { store } from '../state/store';

interface Seq {
  project: Project;
  items: LaidOutItem[];
  duration: Ticks;
}

const PRELOAD_AHEAD = 2 * TICKS_PER_SECOND;

class PreviewEngine {
  private els: HTMLVideoElement[] = [];
  private elMedia: (string | null)[] = [null, null];
  private active = -1;
  private seq: Seq = { project: createProject(), items: [], duration: 0 };
  private current: LaidOutItem | null = null;
  private raf = 0;
  private wallStart = 0;
  private wallT0 = 0;
  private sourceMode: string | null = null;
  private unsub: (() => void) | null = null;
  onOffline: (mediaName: string | null) => void = () => {};

  private img: HTMLImageElement | null = null;
  private imgMedia: string | null = null;

  attach(a: HTMLVideoElement, b: HTMLVideoElement, img?: HTMLImageElement) {
    this.els = [a, b];
    this.img = img ?? null;
    if (this.img) this.img.style.display = 'none';
    for (const el of this.els) {
      el.preload = 'auto';
      attachVideoElement(el); // Web Audio routing (volume above 100%), set before any src
      el.playsInline = true;
      el.style.display = 'none';
    }
    let lastProject = store.get().project;
    let lastSource = store.get().previewMediaId;
    this.rebuild();
    this.unsub = store.subscribe(() => {
      const s = store.get();
      if (s.project === lastProject && s.previewMediaId === lastSource) return;
      const modeChanged = s.previewMediaId !== lastSource;
      lastProject = s.project;
      lastSource = s.previewMediaId;
      this.rebuild(modeChanged);
    });
  }

  detach() {
    this.pause();
    this.unsub?.();
    this.els = [];
  }

  /** The sequence being previewed: the timeline, or a single source file shown whole. */
  private buildSeq(): Seq {
    const s = store.get();
    const p = s.project;
    if (s.previewMediaId) {
      const m = findMedia(p, s.previewMediaId);
      if (m) {
        const clip: ClipItem = {
          kind: 'clip', id: '__source', mediaId: m.id, sourceIn: 0,
          sourceOut: snapToFrame(m.info.duration, m.info.frameRate, 'floor'),
          framing: DEFAULT_FRAMING, volume: 1, muted: false,
        };
        const vp: Project = {
          ...p,
          canvas: { width: m.info.displayWidth, height: m.info.displayHeight, preset: 'custom' },
          frameRate: m.info.frameRate,
          sequence: { items: [clip] },
          audioTracks: [], // source preview: just the file
        };
        const lay = layoutSequence(vp);
        return { project: vp, items: lay.items, duration: lay.duration };
      }
    }
    const lay = layoutSequence(p);
    return { project: p, items: lay.items, duration: lay.duration };
  }

  get project() {
    return this.seq.project;
  }

  get duration() {
    return this.seq.duration;
  }

  get isSourceMode() {
    return this.sourceMode !== null;
  }

  private rebuild(modeChanged = false) {
    const wasPlaying = playhead.get().playing;
    const prevMode = this.sourceMode;
    this.seq = this.buildSeq();
    this.sourceMode = store.get().previewMediaId;
    if (modeChanged || prevMode !== this.sourceMode) {
      this.pause();
      this.timelineTimeBeforeSource = prevMode === null ? playhead.get().time : this.timelineTimeBeforeSource;
      this.seek(this.sourceMode ? 0 : this.timelineTimeBeforeSource);
      return;
    }
    if (wasPlaying) {
      // The edit changed what is playing: restart from the same timeline position.
      const t = playhead.get().time;
      this.stopLoop();
      this.startAt(Math.min(t, this.seq.duration));
    } else this.seek(playhead.get().time);
  }

  private timelineTimeBeforeSource = 0;

  private frame(): Ticks {
    return frameDuration(this.seq.project.frameRate);
  }

  private itemAt(t: Ticks): LaidOutItem | null {
    const items = this.seq.items;
    for (const l of items) if (t >= l.start && t < l.end) return l;
    return items.length && t >= this.seq.duration ? items[items.length - 1] : null;
  }

  /** Pick a video element for this media, loading it into the inactive one if needed. */
  private elementFor(mediaId: string, preferInactive = false): number {
    const other = this.active === 0 ? 1 : 0;
    if (!preferInactive && this.active >= 0 && this.elMedia[this.active] === mediaId) return this.active;
    if (this.elMedia[other] === mediaId) return other;
    const idx = other; // never replace the element currently on screen
    const m = findMedia(this.seq.project, mediaId);
    const el = this.els[idx];
    if (!m || !el) return -1;
    el.src = window.cutroom.mediaUrl(m.path);
    this.elMedia[idx] = mediaId;
    return idx;
  }

  /** Position the element for clip `l` at timeline time t (framing + animation, as in export). */
  private applyStyle(idx: number | HTMLImageElement, l: LaidOutItem, t: Ticks) {
    const el = typeof idx === 'number' ? this.els[idx] : idx;
    if (l.item.kind !== 'clip') return;
    const clip = l.item;
    const m = findMedia(this.seq.project, clip.mediaId);
    if (!el || !m) return;
    const { width: cw, height: ch } = this.seq.project.canvas;
    const base = computeClipRect(m.info.displayWidth, m.info.displayHeight, cw, ch, clip.framing);
    const dur = l.end - l.start;
    const st = evalAnimation(clip.animation, Math.min(Math.max(0, t - l.start), dur), dur, clip.sourceIn);
    const r = animateRect(base, st, cw, ch);
    el.style.opacity = String(st.opacity);
    el.style.left = `${(r.x / cw) * 100}%`;
    el.style.top = `${(r.y / ch) * 100}%`;
    el.style.width = `${(r.w / cw) * 100}%`;
    el.style.height = `${(r.h / ch) * 100}%`;
    if (el instanceof HTMLVideoElement) setVideoGain(el, clip.muted ? 0 : clip.volume);
  }

  private show(idx: number, image = false) {
    this.els.forEach((el, i) => (el.style.display = i === idx ? 'block' : 'none'));
    if (this.img) this.img.style.display = image ? 'block' : 'none';
    if (idx !== this.active && this.active >= 0) this.els[this.active]?.pause();
    this.active = idx;
  }

  private sourceSeconds(clip: ClipItem, l: LaidOutItem, t: Ticks): number {
    // A quarter-frame nudge: seeking to an exact frame boundary can land on the previous frame.
    const nudge = frameDuration(findMedia(this.seq.project, clip.mediaId)?.info.frameRate ?? this.seq.project.frameRate) / 4;
    return ticksToSeconds(clip.sourceIn + (t - l.start) + nudge);
  }

  /** Show the frame at timeline time t (paused). */
  seek(t: Ticks) {
    if (playhead.get().playing) this.pause();
    t = Math.max(0, Math.min(t, this.seq.duration));
    this.current = this.itemAt(t);
    playhead.set({ time: t });
    syncMusic(this.seq.project, t, false, store.get().missing);
    this.render(t, false);
  }

  private render(t: Ticks, forPlay: boolean): HTMLVideoElement | null {
    const l = this.current;
    if (!l || l.item.kind === 'gap') {
      this.show(-1);
      this.onOffline(null);
      return null;
    }
    const clip = l.item;
    if (store.get().missing[clip.mediaId]) {
      this.show(-1);
      this.onOffline(findMedia(this.seq.project, clip.mediaId)?.name ?? 'media');
      return null;
    }
    this.onOffline(null);
    const media = findMedia(this.seq.project, clip.mediaId);
    if (media?.info.kind === 'image' && this.img) {
      // Photos: an <img> positioned like a video; the wall clock drives playback.
      if (this.imgMedia !== media.id) {
        this.img.src = window.cutroom.mediaUrl(media.path);
        this.imgMedia = media.id;
      }
      this.applyStyle(this.img, l, Math.min(t, l.end - this.frame()));
      this.show(-1, true);
      return null;
    }
    const idx = this.elementFor(clip.mediaId);
    if (idx < 0) return null;
    const el = this.els[idx];
    const displayT = Math.min(t, l.end - this.frame());
    const target = this.sourceSeconds(clip, l, displayT);
    if (Math.abs(el.currentTime - target) > (forPlay ? 0.02 : 0.002)) el.currentTime = target;
    this.applyStyle(idx, l, displayT);
    this.show(idx);
    return el;
  }

  play() {
    if (!this.els.length || playhead.get().playing) return;
    let t = playhead.get().time;
    if (t >= this.seq.duration - this.frame()) t = 0;
    this.startAt(t);
  }

  private startAt(t: Ticks) {
    if (!this.seq.items.length) return;
    this.current = this.itemAt(t);
    playhead.set({ time: t, playing: true });
    this.beginItem(t);
    this.raf = requestAnimationFrame(this.tick);
  }

  private beginItem(t: Ticks) {
    const el = this.render(t, true);
    this.wallStart = performance.now();
    this.wallT0 = t;
    if (el) {
      el.play().catch(() => {
        /* interrupted by a later pause/seek — harmless */
      });
    }
  }

  pause() {
    this.stopLoop();
    for (const el of this.els) el.pause();
    if (playhead.get().playing) {
      playhead.set({ playing: false });
      // Land exactly on a frame so the paused picture, the playhead and the export agree.
      const t = snapToFrame(playhead.get().time, this.seq.project.frameRate, 'floor');
      this.current = this.itemAt(t);
      playhead.set({ time: t });
      this.render(t, false);
    }
  }

  private stopLoop() {
    stopMusic();
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  toggle() {
    playhead.get().playing ? this.pause() : this.play();
  }

  step(frames: number) {
    const f = this.frame();
    const t = snapToFrame(playhead.get().time, this.seq.project.frameRate, 'floor') + frames * f;
    this.seek(Math.max(0, Math.min(t, Math.max(0, this.seq.duration - f))));
  }

  private tick = () => {
    const l = this.current;
    if (!l) return this.pause();
    let t: Ticks;
    const el = this.active >= 0 ? this.els[this.active] : null;
    if (l.item.kind === 'clip' && el && el.style.display !== 'none') {
      const clip = l.item;
      t = l.start + (secondsToTicks(el.currentTime) - clip.sourceIn);
      if (el.ended) t = l.end;
    } else {
      t = this.wallT0 + secondsToTicks((performance.now() - this.wallStart) / 1000);
    }
    t = Math.max(l.start, t);
    if (t >= l.end) {
      this.advance();
      return;
    }
    playhead.set({ time: t });
    syncMusic(this.seq.project, t, true, store.get().missing);
    if (l.item.kind === 'clip' && l.item.animation) {
      if (this.img && this.img.style.display === 'block') this.applyStyle(this.img, l, t);
      else if (this.active >= 0) this.applyStyle(this.active, l, t);
    }
    this.preloadNext(l, t);
    this.raf = requestAnimationFrame(this.tick);
  };

  private preloadNext(l: LaidOutItem, t: Ticks) {
    const next = this.seq.items[l.index + 1];
    if (!next || next.item.kind !== 'clip' || l.end - t > PRELOAD_AHEAD) return;
    if (this.continuesInSameElement(l, next)) return;
    if (store.get().missing[next.item.mediaId]) return;
    const other = this.active === 0 ? 1 : 0;
    const idx = this.elMedia[other] === next.item.mediaId ? other : this.elementFor(next.item.mediaId, true);
    if (idx !== other) return;
    const target = this.sourceSeconds(next.item, next, next.start);
    const el = this.els[idx];
    if (Math.abs(el.currentTime - target) > 0.002 && !el.seeking) el.currentTime = target;
  }

  /** A split clip continuing from the same file: keep the element playing, no seek needed. */
  private continuesInSameElement(l: LaidOutItem, next: LaidOutItem): boolean {
    return (
      l.item.kind === 'clip' && next.item.kind === 'clip' && next.item.mediaId === l.item.mediaId &&
      Math.abs(next.item.sourceIn - l.item.sourceOut) < frameDuration(this.seq.project.frameRate) / 2 &&
      this.active >= 0 && this.elMedia[this.active] === l.item.mediaId
    );
  }

  private advance() {
    const l = this.current!;
    const next = this.seq.items[l.index + 1];
    if (!next) {
      this.stopLoop();
      for (const el of this.els) el.pause();
      playhead.set({ playing: false });
      this.seek(this.seq.duration);
      return;
    }
    const seamless = this.continuesInSameElement(l, next);
    this.current = next;
    playhead.set({ time: next.start });
    if (seamless && next.item.kind === 'clip') this.applyStyle(this.active, next, next.start);
    else this.beginItem(next.start);
    this.raf = requestAnimationFrame(this.tick);
  }
}

export const engine = new PreviewEngine();
