/**
 * Audio track rows on the timeline (music, voice-over).
 *
 * Mouse: drag a clip to move it (also up/down to another track); drag its edges to trim; drag the
 * small squares at its top corners to set fade-in / fade-out; drop media from the Media panel on a
 * row to add it there. Audio after the end of the video track is shaded: it is not exported.
 */
import { useEffect, useRef } from 'react';
import { type AudioClip, type AudioTrack, findMedia } from '../../shared/model';
import { addAudioClip, audioClipDuration, moveAudioClip, setAudioClip, setAudioTrack, trimAudioClip } from '../../shared/audio';
import { type Ticks, formatDuration, secondsToTicks, ticksToSeconds } from '../../shared/time';
import * as A from '../state/actions';
import { beginGesture, commit, endGesture, store, updateGesture, useStore } from '../state/store';
import { MEDIA_DRAG_TYPE } from './MediaBin';

export interface TimeHelpers {
  pps: number;
  tToX: (t: Ticks) => number;
  xToT: (x: number) => Ticks;
  contentX: (clientX: number) => number;
  snap: (t: Ticks, alt: boolean, exclude?: string) => Ticks;
  duration: Ticks;
}

function Waveform({ clip, width, height }: { clip: AudioClip; width: number; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const media = useStore((s) => findMedia(s.project, clip.mediaId));
  const peaks = useStore((s) => s.waves[clip.mediaId]);
  useEffect(() => {
    if (media && !peaks) A.loadWaveform(media.id);
  }, [media, peaks]);
  useEffect(() => {
    const c = ref.current;
    if (!c || !peaks) return;
    const w = Math.max(1, Math.min(4000, Math.round(width)));
    c.width = w;
    c.height = height;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, w, height);
    ctx.fillStyle = 'rgba(220, 240, 255, 0.75)';
    const a = ticksToSeconds(clip.sourceIn) * 100;
    const b = ticksToSeconds(clip.sourceOut) * 100;
    for (let x = 0; x < w; x++) {
      const i0 = Math.floor(a + ((b - a) * x) / w);
      const i1 = Math.max(i0 + 1, Math.floor(a + ((b - a) * (x + 1)) / w));
      let peak = 0;
      for (let i = i0; i < i1 && i < peaks.length; i++) peak = Math.max(peak, peaks[i]);
      const h = (peak / 255) * (height - 2);
      ctx.fillRect(x, (height - h) / 2, 1, Math.max(1, h));
    }
  }, [peaks, clip.sourceIn, clip.sourceOut, width, height]);
  return <canvas ref={ref} className="waveform" style={{ width, height }} />;
}

// A stable empty list: selectors must not return a new array each time (React would re-render forever).
const NO_TRACKS: AudioTrack[] = [];

export function AudioTracks(h: TimeHelpers) {
  const tracksList = useStore((s) => s.project.audioTracks ?? NO_TRACKS);
  const selection = useStore((s) => s.selection);
  const rowsRef = useRef<HTMLDivElement>(null);

  const trackAtY = (clientY: number): string | undefined => {
    const rows = rowsRef.current?.querySelectorAll<HTMLElement>('.tl-audio-row');
    for (const r of rows ?? []) {
      const b = r.getBoundingClientRect();
      if (clientY >= b.top && clientY < b.bottom) return r.dataset.track;
    }
    return undefined;
  };

  const drag = (e: React.PointerEvent, clip: AudioClip, mode: 'move' | 'start' | 'end' | 'fadeIn' | 'fadeOut') => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    store.set({ selection: { kind: 'audio', id: clip.id } });
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    beginGesture();
    const move = (ev: PointerEvent) => {
      const dx = secondsToTicks((ev.clientX - x0) / h.pps);
      updateGesture((p) => {
        switch (mode) {
          case 'move': {
            const start = h.snap(clip.start + dx, ev.altKey, clip.id);
            // also allow the clip's end to snap
            const endSnapped = h.snap(clip.start + dx + audioClipDuration(clip), ev.altKey, clip.id) - audioClipDuration(clip);
            const s = start !== clip.start + dx ? start : endSnapped;
            return moveAudioClip(p, clip.id, s, trackAtY(ev.clientY));
          }
          case 'start':
            return trimAudioClip(p, clip.id, 'start', h.snap(clip.start + dx, ev.altKey, clip.id) - clip.start);
          case 'end':
            return trimAudioClip(p, clip.id, 'end', h.snap(clip.start + audioClipDuration(clip) + dx, ev.altKey, clip.id) - (clip.start + audioClipDuration(clip)));
          case 'fadeIn':
            return setAudioClip(p, clip.id, { fadeIn: Math.max(0, clip.fadeIn + dx) });
          case 'fadeOut':
            return setAudioClip(p, clip.id, { fadeOut: Math.max(0, clip.fadeOut - dx) });
        }
      });
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      endGesture();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };

  const onDrop = (e: React.DragEvent, track?: AudioTrack) => {
    const id = e.dataTransfer.getData(MEDIA_DRAG_TYPE);
    if (!id) return;
    e.preventDefault();
    const t = h.snap(h.xToT(h.contentX(e.clientX)), e.altKey);
    const r = addAudioClip(store.get().project, id, t, track?.id);
    if (!r) return A.notify('That file has no audio.');
    commit(() => r.project, { selection: { kind: 'audio', id: r.clipId } });
  };
  const allowDrop = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(MEDIA_DRAG_TYPE)) e.preventDefault();
  };

  const endX = h.tToX(h.duration);
  return (
    <div className="tl-audio" ref={rowsRef}>
      {tracksList.map((track) => (
        <div key={track.id} className={`tl-audio-row${track.muted ? ' muted' : ''}`} data-track={track.id} onDragOver={allowDrop} onDrop={(e) => onDrop(e, track)}>
          <div className="tl-audio-label">
            <button
              className={`chip${selection?.kind === 'audioTrack' && selection.id === track.id ? ' on' : ''}`}
              onClick={() => store.set({ selection: { kind: 'audioTrack', id: track.id } })}
              title="Track settings"
            >
              ♪ {track.name}
            </button>
            <button
              className={`chip small${track.muted ? ' warn' : ''}`}
              onClick={() => commit((p) => setAudioTrack(p, track.id, { muted: !track.muted }))}
              title={track.muted ? 'Unmute track' : 'Mute track'}
              aria-label={`${track.muted ? 'Unmute' : 'Mute'} ${track.name}`}
            >
              {track.muted ? 'Muted' : 'M'}
            </button>
            {track.duck && <span className="chip small on" title={`Lowered ${track.duckDb} dB under speech`}>Duck</span>}
          </div>
          {track.clips.map((c) => {
            const x = h.tToX(c.start);
            const w = Math.max(4, ticksToSeconds(audioClipDuration(c)) * h.pps);
            const sel = selection?.kind === 'audio' && selection.id === c.id;
            const media = findMedia(store.get().project, c.mediaId);
            const fadeInW = ticksToSeconds(c.fadeIn) * h.pps;
            const fadeOutW = ticksToSeconds(c.fadeOut) * h.pps;
            return (
              <div
                key={c.id}
                className={`aclip${sel ? ' selected' : ''}`}
                style={{ left: x, width: w }}
                onPointerDown={(e) => drag(e, c, 'move')}
                title={`${media?.name ?? '?'} — ${formatDuration(audioClipDuration(c))}. Drag to move; edges trim; top corners set fades.`}
              >
                <Waveform clip={c} width={w} height={40} />
                <svg className="fade-shape" width={w} height={40} viewBox={`0 0 ${w} 40`} preserveAspectRatio="none">
                  {fadeInW > 0 && <polygon points={`0,0 ${fadeInW},0 0,40`} />}
                  {fadeOutW > 0 && <polygon points={`${w},0 ${w - fadeOutW},0 ${w},40`} />}
                </svg>
                <span className="aclip-label">{media?.name}{c.volume !== 1 ? ` · ${Math.round(c.volume * 100)}%` : ''}</span>
                <div className="fade-handle in" style={{ left: Math.min(w - 10, fadeInW) }} onPointerDown={(e) => drag(e, c, 'fadeIn')} title="Drag to set the fade-in" />
                <div className="fade-handle out" style={{ right: Math.min(w - 10, fadeOutW) }} onPointerDown={(e) => drag(e, c, 'fadeOut')} title="Drag to set the fade-out" />
                <div className="trim-handle left" onPointerDown={(e) => drag(e, c, 'start')} title="Drag to trim the start" />
                <div className="trim-handle right" onPointerDown={(e) => drag(e, c, 'end')} title="Drag to trim the end" />
              </div>
            );
          })}
          <div className="tl-past-end" style={{ left: endX }} title="After the end of the video: not exported" />
        </div>
      ))}
      <div className="tl-audio-add" onDragOver={allowDrop} onDrop={(e) => onDrop(e)}>
        <button className="btn tiny" onClick={() => A.addAudioTrackAction()}>+ Audio track</button>
        <span className="muted small">Drop music or voice-over here (MP3, M4A, WAV, FLAC — or a video’s sound)</span>
      </div>
    </div>
  );
}
