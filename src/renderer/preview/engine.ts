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
 *  - Overlay-track clips (picture-in-picture) get their own <video>/<img> in a layer above the main
 *    track, created shortly before they start, following the timeline clock like music does.
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
  clipAngle,
  computeClipRect,
  createProject,
  findMedia,
  layoutSequence,
  clipSpeed,
  sourceAt,
  timelineAt,
} from '../../shared/model';
import { type Ticks, TICKS_PER_SECOND, frameDuration, secondsToTicks, snapToFrame, ticksToSeconds } from '../../shared/time';
import { evalAnimation } from '../../shared/animation';
import { clipColor, svgCurveTables, svgMatrix } from '../../shared/color';
import { cssMask } from '../../shared/effects';
import { previewUrl } from './mediaUrl';
import { overlayEnd, overlayLayout, overlays } from '../../shared/overlays';

/** Which preview copies are ready (changes when one finishes, so the preview can show it). */
function readyProxies(): string {
  return Object.entries(store.get().proxies).filter(([, p]) => p.status === 'ready').map(([id]) => id).join(',');
}
import { type LayerFx, type ResolvedTransition, dipColour, isDip, resolveTransitions, transitionLook, transitionMix } from '../../shared/transitions';
import { playhead } from '../state/playhead';
import { attachVideoElement, detachVideoElement, setEq, setVideoGain, stopMusic, syncMusic } from './audio';
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
  /** The URL each element (by its media cache key) loaded; a changed URL (new preview copy) reloads it. */
  private loaded = new Map<HTMLElement, string>();
  private active = -1;
  private seq: Seq = { project: createProject(), items: [], duration: 0 };
  private current: LaidOutItem | null = null;
  private raf = 0;
  /** J/K/L shuttle: playback speed multiplier (1, 2, 4); `reverse` while playing backwards. */
  private shuttle = 1;
  private reverse = false;
  private wallStart = 0;
  private wallT0 = 0;
  private sourceMode: string | null = null;
  private unsub: (() => void) | null = null;
  onOffline: (mediaName: string | null) => void = () => {};
  onPreparing: (mediaId: string | null) => void = () => {};

  private img: HTMLImageElement | null = null;
  private imgMedia: string | null = null;
  // Transition layers: the other clip of a crossfade (video or photo) and a colour layer for dips.
  private tv: HTMLVideoElement | null = null;
  private timg: HTMLImageElement | null = null;
  private dip: HTMLDivElement | null = null;
  private tvMedia: string | null = null;
  private timgMedia: string | null = null;
  private transitions: ResolvedTransition[] = [];
  private inTransition = false;
  /** For tests: the source time (seconds) the main-track video element was last asked to show. */
  mainTarget: number | null = null;
  // Overlay tracks: one element per overlay clip that is on screen (or about to be).
  private ovLayer: HTMLDivElement | null = null;
  private ovEls = new Map<string, { el: HTMLVideoElement | HTMLImageElement; mediaId: string }>();

  attach(
    a: HTMLVideoElement,
    b: HTMLVideoElement,
    img?: HTMLImageElement,
    layers?: { tv: HTMLVideoElement; timg: HTMLImageElement; dip: HTMLDivElement; overlays?: HTMLDivElement },
  ) {
    this.els = [a, b];
    this.ovLayer = layers?.overlays ?? null;
    this.img = img ?? null;
    if (this.img) this.img.style.display = 'none';
    if (layers) {
      this.tv = layers.tv;
      this.timg = layers.timg;
      this.dip = layers.dip;
      this.tv.preload = 'auto';
      attachVideoElement(this.tv);
      this.tv.playsInline = true;
      this.tv.style.display = 'none';
      this.timg.style.display = 'none';
      this.dip.style.opacity = '0';
    }
    for (const el of this.els) {
      el.preload = 'auto';
      attachVideoElement(el); // Web Audio routing (volume above 100%), set before any src
      el.playsInline = true;
      el.style.display = 'none';
    }
    let lastProject = store.get().project;
    let lastSource = store.get().previewMediaId;
    let lastReady = readyProxies();
    this.rebuild();
    this.unsub = store.subscribe(() => {
      const s = store.get();
      const ready = readyProxies();
      if (s.project === lastProject && s.previewMediaId === lastSource && ready === lastReady) return;
      lastReady = ready;
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
    for (const id of [...this.ovEls.keys()]) this.dropOverlay(id);
    this.ovLayer = null;
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
          overlays: [],
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
    this.forgetStaleSources();
    this.sourceMode = store.get().previewMediaId;
    this.transitions = this.sourceMode ? [] : resolveTransitions(this.seq.project, this.seq.items);
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

  /**
   * Elements keep a media file loaded between clips. When the file's preview URL changes (a new
   * preview copy, e.g. after choosing a LUT), forget it so the next use loads the new URL.
   */
  private forgetStaleSources() {
    const url = (id: string | null) => {
      const m = id ? findMedia(this.seq.project, id) : undefined;
      return m ? previewUrl(m) : null;
    };
    const stale = (el: HTMLElement | null, id: string | null) => !!el && !!id && this.loaded.get(el) !== url(id);
    this.els.forEach((el, i) => {
      if (stale(el, this.elMedia[i])) this.elMedia[i] = null;
    });
    if (stale(this.img, this.imgMedia)) this.imgMedia = null;
    if (stale(this.tv, this.tvMedia)) this.tvMedia = null;
    if (stale(this.timg, this.timgMedia)) this.timgMedia = null;
    for (const [id, e] of this.ovEls) if (stale(e.el, e.mediaId)) this.dropOverlay(id);
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
    const url = previewUrl(m);
    if (!url) return -1; // preview copy not ready yet
    el.src = url;
    this.loaded.set(el, url);
    this.elMedia[idx] = mediaId;
    return idx;
  }

  /** Position the element for clip `l` at timeline time t (framing + animation, as in export). */
  private applyStyle(idx: number | HTMLVideoElement | HTMLImageElement, l: LaidOutItem, t: Ticks, mix = 1, fx?: LayerFx) {
    const el = typeof idx === 'number' ? this.els[idx] : idx;
    if (l.item.kind !== 'clip') return;
    const clip = l.item;
    const m = findMedia(this.seq.project, clip.mediaId);
    if (!el || !m) return;
    const { width: cw, height: ch } = this.seq.project.canvas;
    const base = computeClipRect(m.info.displayWidth, m.info.displayHeight, cw, ch, clip.framing);
    const dur = l.end - l.start;
    const st0 = evalAnimation(clip.animation, Math.min(Math.max(0, t - l.start), dur), dur, clip.sourceIn, clipSpeed(clip));
    const st = fx && fx.scale !== 1 ? { ...st0, scale: st0.scale * fx.scale } : st0;
    const r0 = animateRect(base, st, cw, ch);
    // Transitions: slides move the whole picture by a fraction of the canvas.
    const r = fx ? { ...r0, x: r0.x + fx.dx * cw, y: r0.y + fx.dy * ch } : r0;
    // Wipes: only part of the canvas shows this clip. clip-path works in the element's own
    // (rotated) box, so the canvas rectangle's corners are mapped back through the rotation.
    const angle = clipAngle(clip.framing, st.rotation);
    let clipPath = '';
    if (fx?.clip) {
      const c = fx.clip;
      const a = (-angle * Math.PI) / 180;
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      const pts = [[c.x0, c.y0], [c.x1, c.y0], [c.x1, c.y1], [c.x0, c.y1]].map(([u, v]) => {
        const dx = u * cw - cx;
        const dy = v * ch - cy;
        const lx = dx * Math.cos(a) - dy * Math.sin(a) + r.w / 2;
        const ly = dx * Math.sin(a) + dy * Math.cos(a) + r.h / 2;
        return `${((lx / r.w) * 100).toFixed(3)}% ${((ly / r.h) * 100).toFixed(3)}%`;
      });
      clipPath = `polygon(${pts.join(', ')})`;
    }
    if (el.style.clipPath !== clipPath) el.style.clipPath = clipPath;
    el.style.opacity = String(st.opacity * mix);
    el.style.left = `${(r.x / cw) * 100}%`;
    el.style.top = `${(r.y / ch) * 100}%`;
    el.style.width = `${(r.w / cw) * 100}%`;
    el.style.height = `${(r.h / ch) * 100}%`;
    // Rotation around the picture's centre (CSS rotates clockwise, like FFmpeg's rotate).
    const transform = angle % 360 !== 0 ? `rotate(${angle}deg)` : '';
    if (el.style.transform !== transform) el.style.transform = transform;
    if (el instanceof HTMLVideoElement) {
      setVideoGain(el, clip.muted ? 0 : clip.volume * mix);
      setEq(el, clip.audioFx);
    }
    this.colorFilter(el, clip, (r.w / cw) * (el.parentElement?.clientWidth ?? 0));
    this.maskStyle(el, clip);
  }

  // One SVG filter per element (each element shows one clip at a time).
  private filters = new Map<HTMLElement, { matrix: SVGFEColorMatrixElement; transfer: SVGFEComponentTransferElement; blur: SVGFEGaussianBlurElement }>();

  /**
   * The clip's picture filter: colour adjustments as an SVG feColorMatrix on gamma-encoded RGB (the
   * export's transform), the curves as feComponentTransfer tables (the export's tables), then the
   * blur (feGaussianBlur, edges duplicated like FFmpeg's gblur; the filter region is the element's
   * own box, so nothing spills outside the picture, as in the export). `widthPx`: the element's
   * width on screen, for the blur radius (a fraction of the picture width).
   */
  private colorFilter(el: HTMLElement, clip: ClipItem, widthPx = 0) {
    const adj = clipColor(clip);
    const blurPx = (clip.effects?.blur ?? 0) * widthPx;
    if (!adj && blurPx <= 0) {
      if (el.style.filter) el.style.filter = '';
      return;
    }
    let f = this.filters.get(el);
    const ns = 'http://www.w3.org/2000/svg';
    if (!f) {
      let svg = document.getElementById('cutroom-color-filters') as SVGSVGElement | null;
      if (!svg) {
        svg = document.createElementNS(ns, 'svg') as SVGSVGElement;
        svg.id = 'cutroom-color-filters';
        svg.setAttribute('width', '0');
        svg.setAttribute('height', '0');
        svg.setAttribute('aria-hidden', 'true');
        svg.style.position = 'absolute';
        document.body.appendChild(svg);
      }
      const filter = document.createElementNS(ns, 'filter');
      filter.id = `cutroom-cf${++filterSeq}`;
      filter.setAttribute('color-interpolation-filters', 'sRGB');
      for (const [k, v] of [['x', '0'], ['y', '0'], ['width', '1'], ['height', '1']]) filter.setAttribute(k, v);
      const matrix = document.createElementNS(ns, 'feColorMatrix') as SVGFEColorMatrixElement;
      matrix.setAttribute('type', 'matrix');
      filter.appendChild(matrix);
      const transfer = document.createElementNS(ns, 'feComponentTransfer') as SVGFEComponentTransferElement;
      for (const k of ['R', 'G', 'B']) transfer.appendChild(document.createElementNS(ns, `feFunc${k}`));
      filter.appendChild(transfer);
      const blur = document.createElementNS(ns, 'feGaussianBlur') as SVGFEGaussianBlurElement;
      blur.setAttribute('edgeMode', 'duplicate');
      filter.appendChild(blur);
      svg.appendChild(filter);
      f = { matrix, transfer, blur };
      this.filters.set(el, f);
      el.dataset.colorFilter = filter.id;
    }
    const values = adj ? svgMatrix(adj) : '1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0';
    if (f.matrix.getAttribute('values') !== values) f.matrix.setAttribute('values', values);
    const tables = adj ? svgCurveTables(adj) : null;
    [...f.transfer.children].forEach((fn, i) => {
      const v = tables ? [tables.r, tables.g, tables.b][i] : null;
      if (v) {
        if (fn.getAttribute('type') !== 'table') fn.setAttribute('type', 'table');
        if (fn.getAttribute('tableValues') !== v) fn.setAttribute('tableValues', v);
      } else if (fn.getAttribute('type') !== 'identity') {
        fn.setAttribute('type', 'identity');
        fn.removeAttribute('tableValues');
      }
    });
    const sd = String(Math.round(blurPx * 100) / 100);
    if (f.blur.getAttribute('stdDeviation') !== sd) f.blur.setAttribute('stdDeviation', sd);
    const want = `url("#${el.dataset.colorFilter}")`;
    if (el.style.filter !== want) el.style.filter = want;
  }

  /** The clip's mask as CSS mask-image gradients (the same ramps as the export's alpha). */
  private maskStyle(el: HTMLElement, clip: ClipItem) {
    const m = clip.effects?.mask;
    const css = m ? cssMask(m) : { image: '', composite: '' };
    if (el.style.getPropertyValue('mask-image') === css.image) return;
    el.style.setProperty('mask-image', css.image);
    el.style.setProperty('mask-composite', css.composite);
    el.style.setProperty('mask-repeat', css.image ? 'no-repeat' : '');
    el.style.setProperty('mask-size', css.image ? '100% 100%' : '');
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
    return ticksToSeconds(sourceAt(clip, l.start, t) + nudge);
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
    const el = this.renderItem(t, forPlay);
    this.applyTransition(t, forPlay);
    this.syncOverlays(t, forPlay);
    return el;
  }

  /**
   * Overlay tracks at timeline time t: each visible overlay clip is drawn by its own element,
   * positioned with applyStyle() (the export's computeClipRect + evalAnimation), higher rows on
   * top. While playing, videos play at clip speed × shuttle and are re-synced if they drift; when
   * paused they are seeked to the exact frame (a quarter frame in, as for main clips).
   */
  private syncOverlays(t: Ticks, playing: boolean) {
    const layer = this.ovLayer;
    if (!layer) return;
    const p = this.seq.project;
    const missing = store.get().missing;
    const live = new Set<string>();
    for (const o of overlays(p)) {
      const end = overlayEnd(o);
      const active = t >= o.start && t < end;
      const soon = playing && t >= o.start - PRELOAD_AHEAD && t < end;
      if (!active && !soon) continue;
      const m = findMedia(p, o.mediaId);
      const url = m && !missing[m.id] ? previewUrl(m) : null;
      if (!m || !url) continue; // offline, or its preview copy is not ready yet
      let e = this.ovEls.get(o.id);
      if (e && e.mediaId !== o.mediaId) {
        this.dropOverlay(o.id);
        e = undefined;
      }
      if (!e) {
        const el = m.info.kind === 'image' ? document.createElement('img') : document.createElement('video');
        el.className = 'overlay-media';
        el.style.display = 'none';
        if (el instanceof HTMLVideoElement) {
          el.preload = 'auto';
          el.playsInline = true;
          attachVideoElement(el);
          el.preservesPitch = true;
        }
        el.src = url;
        this.loaded.set(el, url);
        layer.appendChild(el);
        e = { el, mediaId: o.mediaId };
        this.ovEls.set(o.id, e);
      }
      live.add(o.id);
      const el = e.el;
      el.dataset.overlayId = o.id;
      el.style.zIndex = String(o.row + 1);
      const l = overlayLayout(o);
      const clip = l.item as ClipItem;
      const displayT = Math.min(Math.max(t, l.start), l.end - this.frame());
      if (el instanceof HTMLVideoElement) {
        const target = this.sourceSeconds(clip, l, displayT);
        const rate = clipSpeed(clip) * this.shuttle;
        if (el.playbackRate !== rate) el.playbackRate = rate;
        if (!active || !playing) {
          if (!el.paused) el.pause();
          if (Math.abs(el.currentTime - target) > 0.002 && !(el.seeking && !active)) el.currentTime = target;
        } else if (el.paused) {
          if (Math.abs(el.currentTime - target) > 0.03) el.currentTime = target;
          void el.play().catch(() => {});
        } else if (!el.seeking && el.readyState >= 3 && Math.abs(el.currentTime - target) > 0.1 * rate) {
          el.currentTime = target; // real drift only (see syncMusic)
        }
      }
      if (!active) {
        el.style.display = 'none';
        continue;
      }
      this.applyStyle(el, l, displayT);
      el.style.display = 'block';
    }
    for (const id of [...this.ovEls.keys()]) if (!live.has(id)) this.dropOverlay(id);
  }

  private dropOverlay(id: string) {
    const e = this.ovEls.get(id);
    if (!e) return;
    if (e.el instanceof HTMLVideoElement) {
      e.el.pause();
      detachVideoElement(e.el);
      e.el.removeAttribute('src');
      e.el.load();
    }
    const fe = this.filters.get(e.el);
    if (fe) {
      fe.matrix.parentElement?.remove();
      this.filters.delete(e.el);
    }
    e.el.remove();
    this.ovEls.delete(id);
  }

  /** For tests: the overlay elements on screen. */
  get overlayDebug() {
    return [...this.ovEls.entries()].map(([id, e]) => ({
      id, shown: e.el.style.display === 'block', time: e.el instanceof HTMLVideoElement ? e.el.currentTime : null,
      playing: e.el instanceof HTMLVideoElement ? !e.el.paused : false,
    }));
  }

  /**
   * Transitions (see shared/transitions.ts): during a crossfade the other clip is shown in a
   * third element — over the outgoing clip before the cut, under the incoming one after it — with
   * the weights from transitionMix(), the same values the export uses. Dips fade a colour layer.
   */
  private applyTransition(t: Ticks, playing: boolean) {
    if (!this.tv || !this.timg || !this.dip) return;
    const tr = this.transitions.find((x) => t >= x.start && t < x.end);
    const activeEl: HTMLElement | null = this.active >= 0 ? this.els[this.active] : this.img?.style.display === 'block' ? this.img : null;
    if (!tr) {
      if (this.inTransition) {
        this.inTransition = false;
        this.tv.pause();
        this.tv.style.display = 'none';
        this.timg.style.display = 'none';
        this.dip.style.opacity = '0';
        if (activeEl) activeEl.style.zIndex = '';
        const l = this.current;
        if (l && activeEl && l.item.kind === 'clip') this.applyStyle(activeEl as HTMLVideoElement, l, Math.min(t, l.end - this.frame()));
      }
      this.prepareTransition(t);
      return;
    }
    this.inTransition = true;
    const m = transitionMix(tr, t);
    const before = t < tr.cut;
    const cur = before ? tr.a : tr.b;
    if (isDip(tr.kind)) {
      this.tv.style.display = 'none';
      this.timg.style.display = 'none';
      this.dip.style.background = dipColour(tr.kind);
      this.dip.style.opacity = String(m.colour);
      if (activeEl) this.applyStyle(activeEl as HTMLVideoElement, cur, t, 1 - m.colour); // sound dips too
      return;
    }
    this.dip.style.opacity = '0';
    const otherL = before ? tr.b : tr.a;
    const other = otherL.item as ClipItem;
    const media = findMedia(this.seq.project, other.mediaId);
    if (!media || store.get().missing[media.id]) return;
    // Before the cut the incoming clip is drawn on top of the outgoing one by the transition layer;
    // after it the incoming clip is the main one, on top of the outgoing clip in the layer below.
    // Crossfade/zoom: the incoming clip's opacity is the mix. Wipes/slides: both fully opaque,
    // with the incoming clip cut to the wipe's edge or both pictures shifted (transitionLook).
    const look = transitionLook(tr, t);
    const otherMix = before && !look.opaque ? m.b : 1;
    const fxCur = before ? look.a : look.bFx;
    const fxOther = before ? look.bFx : look.a;
    if (activeEl) {
      activeEl.style.zIndex = '1';
      this.applyStyle(activeEl as HTMLVideoElement, cur, t, before || look.opaque ? 1 : m.b, fxCur);
      if (activeEl instanceof HTMLVideoElement) setVideoGain(activeEl, (cur.item as ClipItem).muted ? 0 : (cur.item as ClipItem).volume * (before ? 1 - m.b : m.b));
    }
    const z = before ? '2' : '0';
    if (media.info.kind === 'image') {
      this.tv.pause();
      this.tv.style.display = 'none';
      if (this.timgMedia !== media.id) {
        this.timg.src = previewUrl(media) ?? '';
        this.loaded.set(this.timg, previewUrl(media) ?? '');
        this.timgMedia = media.id;
      }
      this.applyStyle(this.timg, otherL, t, otherMix, fxOther);
      this.timg.style.zIndex = z;
      this.timg.style.display = 'block';
      return;
    }
    this.timg.style.display = 'none';
    if (this.tvMedia !== media.id) {
      this.tv.src = previewUrl(media) ?? '';
      this.loaded.set(this.tv, previewUrl(media) ?? '');
      this.tvMedia = media.id;
    }
    const target = this.sourceSeconds(other, otherL, t);
    const rate = clipSpeed(other) * this.shuttle;
    if (this.tv.playbackRate !== rate) this.tv.playbackRate = rate;
    this.tv.preservesPitch = true;
    if (playing) {
      if (this.tv.paused) {
        this.tv.currentTime = target;
        void this.tv.play().catch(() => {});
      } else if (!this.tv.seeking && Math.abs(this.tv.currentTime - target) > 0.1) this.tv.currentTime = target;
    } else {
      if (!this.tv.paused) this.tv.pause();
      if (Math.abs(this.tv.currentTime - target) > 0.002) this.tv.currentTime = target;
    }
    this.applyStyle(this.tv, otherL, t, otherMix, fxOther);
    setVideoGain(this.tv, other.muted ? 0 : other.volume * (before ? m.b : 1 - m.b));
    this.tv.style.zIndex = z;
    this.tv.style.display = 'block';
  }

  /** Load the incoming clip of an upcoming crossfade into the transition element ahead of time. */
  private prepareTransition(t: Ticks) {
    const next = this.transitions.find((x) => !isDip(x.kind) && x.start > t && x.start - t < 1.5 * TICKS_PER_SECOND);
    if (!next || !this.tv || this.tv.seeking) return;
    const clip = next.b.item as ClipItem;
    const media = findMedia(this.seq.project, clip.mediaId);
    if (!media || media.info.kind === 'image' || store.get().missing[media.id]) return;
    if (this.tvMedia !== media.id) {
      if (!previewUrl(media)) return;
      this.tv.src = previewUrl(media)!;
      this.tvMedia = media.id;
    }
    const target = this.sourceSeconds(clip, next.b, next.start);
    if (Math.abs(this.tv.currentTime - target) > 0.002) this.tv.currentTime = target;
  }

  private renderItem(t: Ticks, forPlay: boolean): HTMLVideoElement | null {
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
    if (media && !previewUrl(media)) {
      // A preview copy is being made for this file (format the preview can't play directly).
      this.show(-1);
      this.onPreparing(media.id);
      return null;
    }
    this.onPreparing(null);
    if (media?.info.kind === 'image' && this.img) {
      // Photos: an <img> positioned like a video; the wall clock drives playback.
      if (this.imgMedia !== media.id) {
        this.img.src = previewUrl(media) ?? '';
        this.loaded.set(this.img, previewUrl(media) ?? '');
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
    this.mainTarget = target;
    // Speed: the element plays its media faster/slower; pitch is kept (as in the export).
    const rate = clipSpeed(clip) * this.shuttle;
    if (el.playbackRate !== rate) el.playbackRate = rate;
    el.preservesPitch = true;
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
    this.shuttle = 1;
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
    this.tv?.pause();
    for (const e of this.ovEls.values()) if (e.el instanceof HTMLVideoElement) e.el.pause();
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.reverse = false;
  }

  /** Current shuttle speed: 0 paused, 1/2/4 forward, -1/-2/-4 backward. */
  get shuttleSpeed(): number {
    if (!playhead.get().playing) return 0;
    return this.reverse ? -this.shuttle : this.shuttle;
  }

  /** L: play forward; pressed again while playing forward: 2×, then 4×. */
  shuttleForward() {
    const sp = this.shuttleSpeed;
    if (sp > 0) {
      if (this.shuttle >= 4) return;
      this.shuttle *= 2;
      const t = playhead.get().time;
      this.stopLoop();
      this.startAt(t);
      return;
    }
    if (sp < 0) this.pause();
    this.shuttle = 1;
    this.play();
  }

  /** J: play backward (picture only); pressed again: 2×, then 4×. */
  shuttleBackward() {
    const sp = this.shuttleSpeed;
    if (sp < 0) {
      this.shuttle = Math.min(4, this.shuttle * 2);
      this.wallT0 = playhead.get().time;
      this.wallStart = performance.now();
      return;
    }
    if (sp > 0) this.pause();
    if (playhead.get().time <= 0) return;
    this.shuttle = 1;
    this.reverse = true;
    for (const el of this.els) el.pause();
    this.wallT0 = playhead.get().time;
    this.wallStart = performance.now();
    playhead.set({ playing: true });
    this.raf = requestAnimationFrame(this.reverseTick);
  }

  private reverseTick = () => {
    const t = this.wallT0 - secondsToTicks(((performance.now() - this.wallStart) / 1000) * this.shuttle);
    if (t <= 0) {
      this.pause();
      this.seek(0);
      return;
    }
    this.current = this.itemAt(t);
    playhead.set({ time: t });
    this.render(t, false); // shows the frame at t (each frame is a seek; sound stays silent)
    syncMusic(this.seq.project, t, false, store.get().missing);
    this.raf = requestAnimationFrame(this.reverseTick);
  };

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
      t = timelineAt(clip, l.start, secondsToTicks(el.currentTime));
      if (el.ended) t = l.end;
    } else {
      t = this.wallT0 + secondsToTicks(((performance.now() - this.wallStart) / 1000) * this.shuttle);
    }
    t = Math.max(l.start, t);
    if (t >= l.end) {
      this.advance();
      return;
    }
    playhead.set({ time: t });
    syncMusic(this.seq.project, t, true, store.get().missing, this.shuttle);
    this.applyTransition(t, true);
    this.syncOverlays(t, true);
    if (l.item.kind === 'clip' && l.item.animation && !this.inTransition) {
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
    if (seamless && next.item.kind === 'clip') {
      // Same file, next part (a split, or a step of a speed ramp): keep playing, at its speed.
      const el = this.els[this.active];
      const rate = clipSpeed(next.item) * this.shuttle;
      if (el && el.playbackRate !== rate) el.playbackRate = rate;
      this.applyStyle(this.active, next, next.start);
    } else this.beginItem(next.start);
    this.raf = requestAnimationFrame(this.tick);
  }
}

let filterSeq = 0;

export const engine = new PreviewEngine();

