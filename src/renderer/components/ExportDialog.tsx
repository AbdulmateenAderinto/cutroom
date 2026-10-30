import { useEffect, useMemo, useRef, useState } from 'react';
import type { ExportProgress, ExportResult } from '../../preload/api';
import {
  AUDIO_BITRATES,
  CRF_RANGE,
  type ExportSettings,
  type VideoEncoder,
  X264_PRESETS,
  type X264Preset,
  aspectDiffers,
  estimateFileSizeBytes,
  outputSizeOptions,
  suggestBitrateMbps,
  validateExportSettings,
} from '../../shared/exportPlan';
import { BUILTIN_PRESETS, type ExportPreset, isValidPreset, presetFromSettings, resolvePreset } from '../../shared/exportPresets';
import { evenDim, layoutSequence } from '../../shared/model';
import { COMMON_FRAME_RATES, type Rational, formatTimecode, frameToTicks, rateLabel, sameRate, ticksToFrame, ticksToSeconds } from '../../shared/time';
import { engine } from '../preview/engine';
import { markedRange } from '../state/actions';
import { store, useStore } from '../state/store';
import { Disclosure, formatBytes } from './controls';

type Phase = { kind: 'settings' } | { kind: 'running'; progress: ExportProgress | null; startedAt: number } | { kind: 'result'; result: ExportResult };

// Remember choices for the rest of the session.
let remembered: Partial<ExportSettings> & { sizeKey?: string; presetId?: string } = {};

// Saved presets live in this computer's local storage (per user, not in the project).
const PRESETS_KEY = 'cutroom.exportPresets';
function loadSavedPresets(): ExportPreset[] {
  try {
    const list = JSON.parse(localStorage.getItem(PRESETS_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter(isValidPreset) : [];
  } catch {
    return [];
  }
}
function storeSavedPresets(list: ExportPreset[]) {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(list));
  } catch {
    // storage unavailable: presets last for this session only
  }
}

function fmtTime(s: number) {
  if (!Number.isFinite(s)) return '—';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

export function ExportDialog() {
  const project = useStore((s) => s.project);
  const missing = useStore((s) => s.missing);
  const { width: cw, height: ch } = project.canvas;
  const sizes = useMemo(() => outputSizeOptions(cw, ch), [cw, ch]);

  const [sizeKey, setSizeKey] = useState(remembered.sizeKey && (remembered.sizeKey === 'custom' || sizes.some((s) => `${s.width}x${s.height}` === remembered.sizeKey)) ? remembered.sizeKey : `${cw}x${ch}`);
  const [customW, setCustomW] = useState(String(remembered.width ?? cw));
  const [customH, setCustomH] = useState(String(remembered.height ?? ch));
  const [rate, setRate] = useState<Rational>(remembered.frameRate ?? project.frameRate);
  const [mapping, setMapping] = useState<'fit' | 'fill' | null>(remembered.canvasMapping ?? null);
  const [audioKbps, setAudioKbps] = useState(remembered.audioBitrateKbps ?? 192);
  const [preset, setPreset] = useState<X264Preset>(remembered.x264Preset ?? 'medium');
  const [rateControl, setRateControl] = useState<'bitrate' | 'crf'>(remembered.rateControl ?? 'bitrate');
  const [crf, setCrf] = useState(remembered.crf ?? CRF_RANGE.default);
  const [encoder, setEncoder] = useState<VideoEncoder>(remembered.encoder ?? 'x264');
  const [hw, setHw] = useState<{ videotoolbox: boolean; reason?: string } | null>(null);
  const range = useMemo(() => markedRange(), []);
  const [useRange, setUseRange] = useState(!!range);
  const [presetId, setPresetId] = useState(remembered.presetId ?? '');
  const [saved, setSaved] = useState<ExportPreset[]>(loadSavedPresets);
  const [naming, setNaming] = useState<string | null>(null);
  // Always choose the file explicitly (the save dialog confirms before replacing an existing file).
  const [outputPath, setOutputPath] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'settings' });
  const [, forceTick] = useState(0);

  const size = sizeKey === 'custom'
    ? { width: Number(customW) || 0, height: Number(customH) || 0 }
    : sizes.find((s) => `${s.width}x${s.height}` === sizeKey) ?? sizes[0];
  const suggested = suggestBitrateMbps(size.width || cw, size.height || ch, rate);
  const [mbps, setMbps] = useState(String(remembered.videoBitrateMbps ?? suggested));
  const aspectMismatch = size.width > 0 && size.height > 0 && aspectDiffers(cw, ch, size.width, size.height);

  const projDuration = layoutSequence(project).duration;
  const activeRange = useRange && range ? range : null;
  const outFrames = activeRange
    ? ticksToFrame(activeRange.end, rate, 'round') - ticksToFrame(activeRange.start, rate, 'round')
    : ticksToFrame(projDuration, rate, 'round');
  const durationSec = ticksToSeconds(frameToTicks(outFrames, rate));
  const estimate = estimateFileSizeBytes(durationSec, Number(mbps) || 0, audioKbps);

  const settings: ExportSettings = {
    outputPath,
    width: size.width,
    height: size.height,
    frameRate: rate,
    canvasMapping: mapping ?? 'fit',
    videoBitrateMbps: Number(mbps),
    x264Preset: preset,
    audioBitrateKbps: audioKbps,
    rateControl,
    crf,
    encoder,
    range: activeRange,
  };
  const errors = validateExportSettings(project, settings, (m) => !missing[m.id]);
  if (aspectMismatch && !mapping) errors.push('Choose how the canvas fits the different output shape.');
  if (encoder === 'videotoolbox' && hw && !hw.videotoolbox) errors.push(hw.reason ?? 'The hardware encoder is not available.');

  useEffect(() => {
    void window.cutroom.encoders().then(setHw);
  }, []);

  const allPresets = [...BUILTIN_PRESETS, ...saved];
  const applyPreset = (id: string) => {
    setPresetId(id);
    const pr = allPresets.find((x) => x.id === id);
    if (!pr) return;
    const r = resolvePreset(pr, cw, ch, project.frameRate, CRF_RANGE.default);
    setSizeKey(r.sizeKey);
    setRate(r.frameRate);
    setRateControl(r.rateControl);
    setMbps(String(r.mbps));
    setCrf(r.crf);
    setPreset(r.x264Preset);
    setAudioKbps(r.audioKbps);
    setEncoder(r.encoder);
  };
  // Any manual change means the settings no longer match the chosen preset.
  const edited = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPresetId('');
  };
  const savePreset = () => {
    const pr = presetFromSettings(naming ?? '', { width: size.width, height: size.height, frameRate: rate, rateControl, mbps: Number(mbps), crf, x264Preset: preset, audioKbps, encoder }, cw, ch, project.frameRate);
    const next = [...saved, pr];
    setSaved(next);
    storeSavedPresets(next);
    setPresetId(pr.id);
    setNaming(null);
  };
  const deletePreset = () => {
    const next = saved.filter((x) => x.id !== presetId);
    setSaved(next);
    storeSavedPresets(next);
    setPresetId('');
  };

  useEffect(() => {
    if (phase.kind !== 'running') return;
    const off = window.cutroom.onExportProgress((p) => setPhase((ph) => (ph.kind === 'running' ? { ...ph, progress: p } : ph)));
    const timer = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => {
      off();
      clearInterval(timer);
    };
  }, [phase.kind]);

  const close = () => {
    if (phase.kind === 'running') return;
    store.set({ dialog: null });
  };

  const choosePath = async () => {
    const p = await window.cutroom.chooseExportPath(outputPath || `${project.name || 'Untitled'}.mp4`);
    if (p) setOutputPath(p);
  };

  const start = async () => {
    remembered = { ...settings, outputPath: undefined, canvasMapping: mapping ?? undefined, sizeKey, presetId, range: undefined };
    engine.pause();
    setPhase({ kind: 'running', progress: null, startedAt: Date.now() });
    const result = await window.cutroom.startExport(project, settings);
    setPhase({ kind: 'result', result });
  };

  const fixCustom = () => {
    setCustomW(String(evenDim(Number(customW) || cw)));
    setCustomH(String(evenDim(Number(customH) || ch)));
  };

  const firstInput = useRef<HTMLButtonElement>(null);
  useEffect(() => firstInput.current?.focus(), []);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal export" role="dialog" aria-label="Export video">
        <header className="modal-head">
          <h2>Export video</h2>
          {phase.kind !== 'running' && <button className="btn ghost tiny" onClick={close} aria-label="Close">✕</button>}
        </header>

        {phase.kind === 'settings' && (
          <div className="modal-body export-grid">
            <div className="export-row">
              <span className="field-label">Save to</span>
              <div className="row gap">
                <div className={`path${outputPath ? '' : ' muted'}`} title={outputPath}>
                  {/* rtl + bdi: long paths are truncated at the start, keeping the file name visible */}
                  <bdi>{outputPath || 'No file chosen'}</bdi>
                </div>
                <button ref={firstInput} className="btn small" onClick={choosePath}>Choose…</button>
              </div>
            </div>

            <div className="export-row">
              <span className="field-label">Preset</span>
              <div className="col gap">
                <div className="row gap center">
                  <select className="input" value={presetId} onChange={(e) => applyPreset(e.target.value)} aria-label="Export preset">
                    <option value="">Custom settings</option>
                    <optgroup label="Built in">
                      {BUILTIN_PRESETS.map((pr) => (
                        <option key={pr.id} value={pr.id} disabled={pr.encoder === 'videotoolbox' && hw !== null && !hw.videotoolbox}>
                          {pr.name}{pr.encoder === 'videotoolbox' && hw !== null && !hw.videotoolbox ? ' — not available here' : ''}
                        </option>
                      ))}
                    </optgroup>
                    {saved.length > 0 && (
                      <optgroup label="Saved">
                        {saved.map((pr) => <option key={pr.id} value={pr.id}>{pr.name}</option>)}
                      </optgroup>
                    )}
                  </select>
                  {naming === null && <button className="btn tiny" onClick={() => setNaming('')}>Save as preset…</button>}
                  {saved.some((x) => x.id === presetId) && <button className="btn tiny danger" onClick={deletePreset}>Delete preset</button>}
                </div>
                {naming !== null && (
                  <div className="row gap center">
                    <input
                      className="input"
                      autoFocus
                      placeholder="Preset name"
                      aria-label="Preset name"
                      value={naming}
                      onChange={(e) => setNaming(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') savePreset();
                        if (e.key === 'Escape') setNaming(null);
                      }}
                    />
                    <button className="btn tiny primary" onClick={savePreset}>Save</button>
                    <button className="btn tiny" onClick={() => setNaming(null)}>Cancel</button>
                  </div>
                )}
                <span className="muted small">Presets set size (by the short edge, so they keep your canvas shape), frame rate, quality and audio.</span>
              </div>
            </div>

            <div className="export-row">
              <span className="field-label">Range</span>
              <div className="col gap">
                <label className="check">
                  <input type="radio" name="range" checked={!activeRange} onChange={() => setUseRange(false)} />
                  Whole timeline ({fmtTime(ticksToSeconds(projDuration))})
                </label>
                <label className={`check${range ? '' : ' disabled'}`} title={range ? undefined : 'Press I and O on the timeline to mark a range'}>
                  <input type="radio" name="range" disabled={!range} checked={!!activeRange} onChange={() => setUseRange(true)} />
                  {range
                    ? `Marked range ${formatTimecode(range.start, project.frameRate)} – ${formatTimecode(range.end, project.frameRate)}`
                    : 'Marked range — none marked (press I and O on the timeline)'}
                </label>
              </div>
            </div>

            <div className="export-row">
              <span className="field-label">Format</span>
              <div>MP4 · H.264 video (High profile, 8-bit 4:2:0) · AAC audio <span className="muted small">— more codecs are planned</span></div>
            </div>

            <div className="export-row">
              <span className="field-label">Resolution</span>
              <div className="col gap">
                <select className="input" value={sizeKey} onChange={(e) => edited(setSizeKey)(e.target.value)} aria-label="Output resolution">
                  {sizes.map((s) => (
                    <option key={s.label} value={`${s.width}x${s.height}`}>{s.label}</option>
                  ))}
                  <option value="custom">Custom…</option>
                </select>
                {sizeKey === 'custom' && (
                  <div className="row gap center">
                    <input className="input mono dim" value={customW} onChange={(e) => setCustomW(e.target.value.replace(/\D/g, ''))} onBlur={fixCustom} aria-label="Output width" />
                    <span>×</span>
                    <input className="input mono dim" value={customH} onChange={(e) => setCustomH(e.target.value.replace(/\D/g, ''))} onBlur={fixCustom} aria-label="Output height" />
                    <span className="muted small">even numbers</span>
                  </div>
                )}
                {aspectMismatch && (
                  <div className="banner warn small">
                    <div>
                      The output shape ({size.width}×{size.height}) differs from the canvas ({cw}×{ch}). How should the canvas fit?
                    </div>
                    <label className="check">
                      <input type="radio" name="map" checked={mapping === 'fit'} onChange={() => setMapping('fit')} />
                      Fit — show the whole canvas, add bars in the background colour
                    </label>
                    <label className="check">
                      <input type="radio" name="map" checked={mapping === 'fill'} onChange={() => setMapping('fill')} />
                      Fill — cover the output, crop the canvas edges
                    </label>
                  </div>
                )}
              </div>
            </div>

            <div className="export-row">
              <span className="field-label">Frame rate</span>
              <select
                className="input"
                value={rateLabel(rate)}
                onChange={(e) => {
                  const r = COMMON_FRAME_RATES.find((x) => x.label === e.target.value)?.rate ?? project.frameRate;
                  edited(setRate)(r);
                }}
                aria-label="Output frame rate"
              >
                {!COMMON_FRAME_RATES.some((r) => sameRate(r.rate, project.frameRate)) && (
                  <option value={rateLabel(project.frameRate)}>{rateLabel(project.frameRate)} fps (project)</option>
                )}
                {COMMON_FRAME_RATES.map((r) => (
                  <option key={r.label} value={r.label}>
                    {r.label} fps{sameRate(r.rate, project.frameRate) ? ' (project)' : ''}
                  </option>
                ))}
              </select>
            </div>

            <div className="export-row">
              <span className="field-label">Encoder</span>
              <div className="col gap">
                <select className="input" value={encoder} onChange={(e) => {
                  const v = e.target.value as VideoEncoder;
                  edited(setEncoder)(v);
                  if (v === 'videotoolbox') setRateControl('bitrate');
                }} aria-label="Video encoder">
                  <option value="x264">Software — libx264 (best quality per bit)</option>
                  <option value="videotoolbox" disabled={hw !== null && !hw.videotoolbox}>
                    Apple hardware — VideoToolbox (much faster){hw !== null && !hw.videotoolbox ? ' — not available here' : ''}
                  </option>
                </select>
                {hw && !hw.videotoolbox && <span className="muted small">{hw.reason}</span>}
                {encoder === 'videotoolbox' && <span className="muted small">The hardware encoder is fast but needs a higher bitrate than libx264 for the same quality; constant quality is not offered with it.</span>}
              </div>
            </div>

            <div className="export-row">
              <span className="field-label">Video quality</span>
              <div className="col gap">
                <label className="check">
                  <input type="radio" name="rc" checked={rateControl === 'bitrate'} onChange={() => edited(setRateControl)('bitrate')} /> Target bitrate (average)
                </label>
                {rateControl === 'bitrate' && (
                  <div className="row gap center indent">
                    <input
                      className="input mono"
                      style={{ width: 80 }}
                      value={mbps}
                      onChange={(e) => edited(setMbps)(e.target.value.replace(/[^\d.]/g, ''))}
                      aria-label="Target video bitrate in megabits per second"
                    />
                    <span>Mb/s</span>
                    <button className="btn tiny" onClick={() => edited(setMbps)(String(suggested))} title="A reasonable starting point for this size and frame rate">
                      Suggest ({suggested} Mb/s)
                    </button>
                  </div>
                )}
                <label className={`check${encoder === 'videotoolbox' ? ' disabled' : ''}`} title={encoder === 'videotoolbox' ? 'Not available with the hardware encoder' : undefined}>
                  <input type="radio" name="rc" disabled={encoder === 'videotoolbox'} checked={rateControl === 'crf'} onChange={() => edited(setRateControl)('crf')} /> Constant quality (CRF)
                </label>
                {rateControl === 'crf' && (
                  <div className="row gap center indent">
                    <span className="muted small">Better</span>
                    <input
                      type="range"
                      className="slider"
                      min={CRF_RANGE.min}
                      max={CRF_RANGE.max}
                      value={crf}
                      onChange={(e) => edited(setCrf)(Number(e.target.value))}
                      aria-label="Constant quality CRF"
                    />
                    <span className="muted small">Smaller</span>
                    <span className="mono">CRF {crf}</span>
                    <span className="muted small">{crf <= 17 ? '(visually lossless, large)' : crf <= 22 ? '(high quality)' : crf <= 27 ? '(good, smaller)' : '(drafts)'}</span>
                  </div>
                )}
                <Disclosure title="Target bitrate vs constant quality">
                  <p className="small">
                    <strong>Target bitrate</strong> tells the encoder roughly how many bits to spend per second on average. It makes file
                    size predictable, but quality varies: complex, fast-moving shots get fewer bits than they need, and simple ones get more
                    than they need. The bitrate moment-to-moment is <em>not</em> constant (it is capped at about 2× the target), and the final
                    size is approximate.
                  </p>
                  <p className="small">
                    <strong>Constant quality (CRF)</strong> aims for consistent visual quality and lets the bitrate (and file size) go wherever the
                    content requires: lower numbers are better and larger. 18–22 suits most finished videos. The size can't be predicted in advance.
                  </p>
                </Disclosure>
              </div>
            </div>

            <div className="export-row">
              <span className="field-label">Audio</span>
              <div className="row gap center">
                <span>AAC · 48 kHz · stereo ·</span>
                <select className="input" value={audioKbps} onChange={(e) => edited(setAudioKbps)(Number(e.target.value))} aria-label="Audio bitrate">
                  {AUDIO_BITRATES.map((b) => (
                    <option key={b} value={b}>{b} kb/s{b === 192 ? ' (default)' : ''}</option>
                  ))}
                </select>
              </div>
            </div>

            <Disclosure title="Advanced">
              <div className="export-row">
                <span className="field-label">Encoder speed</span>
                <select className="input" value={preset} disabled={encoder !== 'x264'} onChange={(e) => edited(setPreset)(e.target.value as X264Preset)} aria-label="Encoder speed preset">
                  {X264_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
              </div>
              <p className="muted small">Encoder speed applies to libx264 only.</p>
            </Disclosure>

            <div className="estimate">
              <div>
                Duration <strong>{fmtTime(durationSec)}</strong> ({outFrames} frames)
                {rateControl === 'bitrate' && <> · Estimated size <strong>≈ {formatBytes(estimate)}</strong></>}
              </div>
              <div className="muted small">
                {rateControl === 'bitrate'
                  ? 'Estimate = (video + audio bitrate) × duration. The real file is usually close but can be noticeably smaller or larger.'
                  : 'Constant quality: the size depends on the content, so there is no estimate.'}
              </div>
            </div>

            {errors.length > 0 && (
              <ul className="errors">
                {errors.map((e) => <li key={e}>{e}</li>)}
              </ul>
            )}
          </div>
        )}

        {phase.kind === 'running' && (
          <div className="modal-body">
            <p>Exporting to <span className="mono small">{outputPath}</span></p>
            <div className="progress" role="progressbar" aria-valuenow={Math.round((phase.progress?.fraction ?? 0) * 100)}>
              <div className="progress-bar" style={{ width: `${(phase.progress?.fraction ?? 0) * 100}%` }} />
            </div>
            {(() => {
              const f = phase.progress?.fraction ?? 0;
              const elapsed = (Date.now() - phase.startedAt) / 1000;
              const remaining = f > 0.02 ? (elapsed / f) * (1 - f) : NaN;
              return (
                <p className="muted small">
                  {Math.round(f * 100)}% · elapsed {fmtTime(elapsed)} · about {fmtTime(remaining)} left
                  {phase.progress?.speed ? ` · ${phase.progress.speed} realtime` : ''}
                </p>
              );
            })()}
            <p className="muted small">The file is written as “.partial” and only renamed when it is complete and verified.</p>
          </div>
        )}

        {phase.kind === 'result' && phase.result.status === 'done' && (
          <div className="modal-body">
            <h3 className="ok">✓ Export complete and verified</h3>
            <dl className="details">
              <div><dt>File</dt><dd>{phase.result.output.path}</dd></div>
              <div><dt>Video</dt><dd>{phase.result.output.videoCodec.toUpperCase()} · {phase.result.output.width}×{phase.result.output.height} · {phase.result.output.frameRate} fps</dd></div>
              <div><dt>Duration</dt><dd>{phase.result.output.durationSeconds.toFixed(2)} s</dd></div>
              <div><dt>Size</dt><dd>{formatBytes(phase.result.output.sizeBytes)}{rateControl === 'bitrate' && <> (estimated ≈ {formatBytes(estimate)})</>}</dd></div>
              <div><dt>Measured video bitrate</dt><dd>{phase.result.output.videoBitrateMbps?.toFixed(2) ?? '—'} Mb/s average ({rateControl === 'crf' ? `CRF ${crf}` : `target ${mbps}`}{encoder === 'videotoolbox' ? ', hardware encoder' : ''})</dd></div>
              <div><dt>Audio</dt><dd>{phase.result.output.audioCodec?.toUpperCase()} · {phase.result.output.audioSampleRate} Hz</dd></div>
            </dl>
          </div>
        )}
        {phase.kind === 'result' && phase.result.status === 'cancelled' && (
          <div className="modal-body">
            <h3>Export cancelled</h3>
            <p className="muted">The unfinished file was deleted. Nothing was saved.</p>
          </div>
        )}
        {phase.kind === 'result' && phase.result.status === 'failed' && (
          <div className="modal-body">
            <h3 className="err">Export failed</h3>
            <p>{phase.result.message}</p>
            {phase.result.details && (
              <Disclosure title="Technical details (FFmpeg output)">
                <pre className="log">{phase.result.details.slice(-4000)}</pre>
              </Disclosure>
            )}
          </div>
        )}

        <footer className="modal-actions">
          {phase.kind === 'settings' && (
            <>
              <button className="btn" onClick={close}>Cancel</button>
              <button className="btn primary" disabled={errors.length > 0} onClick={start}>Export</button>
            </>
          )}
          {phase.kind === 'running' && (
            <button className="btn danger" onClick={() => window.cutroom.cancelExport()}>Cancel export</button>
          )}
          {phase.kind === 'result' && (
            <>
              {phase.result.status === 'done' && (
                <button className="btn" onClick={() => phase.result.status === 'done' && window.cutroom.showInFolder(phase.result.output.path)}>
                  Show in {window.cutroom.platform === 'darwin' ? 'Finder' : 'folder'}
                </button>
              )}
              {phase.result.status !== 'done' && <button className="btn" onClick={() => setPhase({ kind: 'settings' })}>Back to settings</button>}
              <button className="btn primary" onClick={close}>Close</button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
