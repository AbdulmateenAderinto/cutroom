import { useEffect, useState } from 'react';
import type { WhisperStatus } from '../../preload/api';
import { store } from '../state/store';

const LANGUAGES = [
  ['auto', 'Detect automatically'], ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['pt', 'Portuguese'],
  ['it', 'Italian'], ['nl', 'Dutch'], ['yo', 'Yoruba'], ['ar', 'Arabic'], ['hi', 'Hindi'], ['ja', 'Japanese'], ['zh', 'Chinese'], ['ko', 'Korean'], ['ru', 'Russian'],
];

/** One-time setup for local speech-to-text (whisper.cpp + a model). */
export function SpeechSetupDialog() {
  const [st, setSt] = useState<WhisperStatus | null>(null);
  const [dl, setDl] = useState<{ id: string; fraction: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => window.cutroom.whisperStatus().then(setSt);
  useEffect(() => {
    refresh();
    return window.cutroom.onDownloadProgress(setDl);
  }, []);
  const close = () => store.set({ dialog: null });
  const download = async (id: string) => {
    setError(null);
    setDl({ id, fraction: 0 });
    const r = await window.cutroom.whisperDownload(id);
    setDl(null);
    if (!r.ok) setError(r.error ?? 'Download failed.');
    refresh();
  };
  const selected = st?.models.find((m) => m.id === st.selected);
  const englishOnlyModel = !st?.customPath && st?.selected.endsWith('.en');

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !dl && close()}>
      <div className="modal" role="dialog" aria-label="Speech-to-text setup">
        <header className="modal-head">
          <h2>Speech-to-text setup</h2>
          {!dl && <button className="btn ghost tiny" onClick={close} aria-label="Close">✕</button>}
        </header>
        <div className="modal-body">
          <p className="small">
            Transcripts, captions and filler-word removal use <strong>whisper.cpp</strong>, which runs entirely on this computer.
            Your audio is never uploaded.
          </p>
          {!st ? <p className="muted">Checking…</p> : (
            <>
              <h3>1. Speech engine</h3>
              {st.binary ? (
                <p className="small ok-text">✓ Found <span className="mono">{st.binary}</span></p>
              ) : (
                <div className="banner warn small">
                  whisper.cpp is not installed. In Terminal run <span className="mono">brew install whisper-cpp</span>, then reopen this window.
                  <button className="btn tiny" onClick={refresh}>Check again</button>
                </div>
              )}

              <h3 style={{ marginTop: 12 }}>2. Speech model (one-time download)</h3>
              <p className="muted small">Downloaded from the official whisper.cpp model repository on Hugging Face and stored in Cutroom’s settings folder.</p>
              <div className="model-list">
                {st.models.map((m) => (
                  <label key={m.id} className={`model-row${st.selected === m.id && !st.customPath ? ' on' : ''}`}>
                    <input
                      type="radio"
                      name="model"
                      checked={st.selected === m.id && !st.customPath}
                      onChange={async () => setSt(await window.cutroom.whisperSetOptions({ model: m.id }))}
                    />
                    <span className="grow">{m.label} <span className="muted small">· {m.sizeMB} MB</span></span>
                    {m.installed ? (
                      <span className="small ok-text">Installed</span>
                    ) : dl?.id === m.id ? (
                      <span className="row gap center">
                        <span className="mini-progress"><span style={{ width: `${dl.fraction * 100}%` }} /></span>
                        <span className="small mono">{Math.round(dl.fraction * 100)}%</span>
                        <button className="btn tiny" onClick={() => window.cutroom.whisperCancelDownload()}>Cancel</button>
                      </span>
                    ) : (
                      <button className="btn tiny" disabled={!!dl} onClick={(e) => { e.preventDefault(); download(m.id); }}>Download</button>
                    )}
                  </label>
                ))}
              </div>
              <div className="row gap" style={{ marginTop: 6 }}>
                <button className="btn tiny" onClick={async () => { const r = await window.cutroom.whisperChooseModel(); if (r.error) setError(r.error); refresh(); }}>
                  Use a model file I already have…
                </button>
                {st.customPath && <span className="small mono">{st.customPath}</span>}
              </div>
              {error && <div className="banner warn small" style={{ marginTop: 6 }}>{error}</div>}

              <h3 style={{ marginTop: 12 }}>3. Language</h3>
              <select
                className="input"
                value={englishOnlyModel ? 'en' : st.language}
                disabled={englishOnlyModel}
                onChange={async (e) => setSt(await window.cutroom.whisperSetOptions({ language: e.target.value }))}
                aria-label="Spoken language"
              >
                {LANGUAGES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
              {englishOnlyModel && <p className="muted small">“{selected?.label}” only understands English. Choose a multilingual model for other languages.</p>}

              <p className={`small ${st.ready ? 'ok-text' : 'muted'}`} style={{ marginTop: 12 }}>
                {st.ready ? '✓ Ready. Use “Transcribe” in Smart tools (select a clip).' : 'Not ready yet: install the engine and download a model.'}
              </p>
            </>
          )}
        </div>
        <footer className="modal-actions">
          <button className="btn primary" disabled={!!dl} onClick={close}>Done</button>
        </footer>
      </div>
    </div>
  );
}
