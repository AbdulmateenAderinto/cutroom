/**
 * A clip's sound effects: 3-band EQ (heard in the preview) and noise reduction (export only;
 * "Listen" renders a few seconds through the export to hear the result).
 */
import { type AudioFx, EQ_BANDS, NO_FX } from '../../shared/audioFx';
import * as A from '../state/actions';
import { beginGesture, commit, endGesture, gestureActive, updateGesture, useStore } from '../state/store';
import type { Project } from '../../shared/model';

export function AudioFxSection({ fx, edit, mediaId }: { fx: AudioFx | undefined; edit: (p: Project, patch: Partial<AudioFx>) => Project; mediaId: string }) {
  const f = fx ?? NO_FX;
  const listening = useStore((s) => s.working.includes('audition'));
  const set = (patch: Partial<AudioFx>) => {
    if (gestureActive()) updateGesture((p) => edit(p, patch));
    else commit((p) => edit(p, patch));
    // Noise reduction needs the recording's background level: measured once, when first turned on.
    if (patch.denoise && f.noiseFloor === undefined) void A.measureNoiseFloor(mediaId, (q, nf) => edit(q, { noiseFloor: nf }));
  };
  const row = (key: keyof AudioFx, label: string, min: number, max: number, step: number, show: string) => (
    <div key={key} className="color-row">
      <span className="field-label">{label}</span>
      <input
        type="range"
        className="slider"
        min={min}
        max={max}
        step={step}
        value={f[key]}
        aria-label={label}
        onPointerDown={beginGesture}
        onPointerUp={() => endGesture()}
        onDoubleClick={() => commit((p) => edit(p, { [key]: 0 }))}
        onChange={(e) => set({ [key]: Number(e.target.value) })}
      />
      <span className="mono small color-value">{show}</span>
    </div>
  );
  return (
    <div className="audio-fx">
      <span className="field-label">EQ</span>
      {EQ_BANDS.map((b) => row(b.key, `${b.label} (${b.freq >= 1000 ? `${b.freq / 1000} kHz` : `${b.freq} Hz`})`, -12, 12, 0.5, `${f[b.key] > 0 ? '+' : ''}${f[b.key]} dB`))}
      {row('denoise', 'Noise reduction', 0, 1, 0.1, f.denoise ? `${Math.round(f.denoise * 100)}%` : 'off')}
      <p className="muted small">
        EQ is heard in the preview. Noise reduction is applied in the export only (the preview plays the original sound).{' '}
        <button className="btn tiny" disabled={listening} onClick={() => void A.listenToExport()} title="Renders 5 s from the playhead through the export and plays it">
          {listening ? 'Rendering…' : '▶ Listen to the export sound'}
        </button>
      </p>
    </div>
  );
}
