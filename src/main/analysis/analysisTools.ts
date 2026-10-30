/**
 * Exposes analysis to the UI (IPC) and to AI control (MCP tools).
 */
import { existsSync } from 'node:fs';
import { ipcMain } from 'electron';
import { findMedia } from '../../shared/model';
import { ticksToSeconds } from '../../shared/time';
import { registerMainTool } from '../control/aiControl';
import { textResult } from '../control/controlServer';
import { type MainToolDeps, getProjectRaw } from '../control/mainTools';
import { DEFAULT_SCENE_THRESHOLD, DEFAULT_SILENCE, detectScenes, detectSilence } from './analyze';

const round = (n: number) => Math.round(n * 1000) / 1000;

export function setupAnalysis(deps: () => Pick<MainToolDeps, 'callRenderer'>) {
  ipcMain.handle('analysis:silence', (_e, file: string, durationSec: number, opts) => detectSilence(file, durationSec, opts));
  ipcMain.handle('analysis:scenes', (_e, file: string, threshold?: number) => detectScenes(file, threshold));

  const mediaFor = async (mediaId: string) => {
    const project = await getProjectRaw(deps() as MainToolDeps);
    const m = findMedia(project, mediaId);
    if (!m) throw new Error(`No media with id ${mediaId}.`);
    if (!existsSync(m.path)) throw new Error(`${m.name} is offline.`);
    return { project, m };
  };

  registerMainTool('detect_silence', async (a) => {
    const { m } = await mediaFor(a.media_id);
    const ranges = await detectSilence(m.path, ticksToSeconds(m.info.duration), { noiseDb: a.threshold_db, minDuration: a.min_duration });
    const total = ranges.reduce((s, r) => s + r.end - r.start, 0);
    return textResult({ media: m.name, silences: ranges.map((r) => ({ start_s: round(r.start), end_s: round(r.end) })), total_silence_s: round(total) });
  });

  registerMainTool('remove_silence', async (a) => {
    const project = await getProjectRaw(deps() as MainToolDeps);
    const clips = project.sequence.items.filter((i) => i.kind === 'clip' && (!a.clip_id || i.id === a.clip_id));
    if (!clips.length) return textResult(a.clip_id ? `No clip with id ${a.clip_id}.` : 'The timeline has no clips.', true);
    const batch = [];
    for (const c of clips) {
      if (c.kind !== 'clip') continue;
      const m = findMedia(project, c.mediaId)!;
      if (!m.info.hasAudio) continue;
      const ranges = await detectSilence(m.path, ticksToSeconds(m.info.duration), { noiseDb: a.threshold_db, minDuration: a.min_duration });
      batch.push({ clip_id: c.id, ranges: ranges.map((r) => ({ start: r.start, end: r.end })) });
    }
    return deps().callRenderer('__remove_ranges_batch', { items: batch, padding: a.padding ?? 0.12, label: 'removed silences' });
  });

  registerMainTool('set_audio_track', async (a) => {
    if (a.duck) {
      // Ducking needs to know where the video track has sound: analyse any media not done yet.
      const r = await deps().callRenderer('__needs_speech', {});
      const need = JSON.parse((r.content[0] as { text: string }).text) as { id: string; path: string; duration_s: number }[];
      for (const m of need) {
        const silence = await detectSilence(m.path, m.duration_s, { noiseDb: -35, minDuration: 0.3 });
        const speech: { start: number; end: number }[] = [];
        let cursor = 0;
        for (const x of silence) {
          if (x.start > cursor) speech.push({ start: cursor, end: x.start });
          cursor = Math.max(cursor, x.end);
        }
        if (cursor < m.duration_s) speech.push({ start: cursor, end: m.duration_s });
        await deps().callRenderer('__set_speech', { media_id: m.id, speech });
      }
    }
    return deps().callRenderer('__set_audio_track', a);
  });

  registerMainTool('detect_scenes', async (a) => {
    const { m } = await mediaFor(a.media_id);
    const times = await detectScenes(m.path, a.threshold ?? DEFAULT_SCENE_THRESHOLD);
    return textResult({ media: m.name, scene_changes_s: times.map(round), count: times.length });
  });

  registerMainTool('split_at_scenes', async (a) => {
    const project = await getProjectRaw(deps() as MainToolDeps);
    const c = project.sequence.items.find((i) => i.id === a.clip_id);
    if (!c || c.kind !== 'clip') return textResult(`No clip with id ${a.clip_id}.`, true);
    const m = findMedia(project, c.mediaId)!;
    const times = await detectScenes(m.path, a.threshold ?? DEFAULT_SCENE_THRESHOLD);
    return deps().callRenderer('__split_source_times', { clip_id: c.id, times });
  });
}

export { DEFAULT_SCENE_THRESHOLD, DEFAULT_SILENCE };
