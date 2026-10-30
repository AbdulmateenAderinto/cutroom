import { describe, expect, it } from 'vitest';
import {
  DUCK_ATTACK, DUCK_RELEASE, addAudioClip, addAudioTrack, audioClipEnd, clipGainAt, duckGainAt, findAudioClip, moveAudioClip,
  setAudioClip, setSpeech, soundFromSilence, speechIntervals, splitAudioClip, trimAudioClip,
} from '../../src/shared/audio';
import { type MediaRef, PROJECT_VERSION, type Project, createProject } from '../../src/shared/model';
import { addClip, addMedia, createClip, trimEdge } from '../../src/shared/ops';
import { parseProject, serializeProject } from '../../src/shared/serialize';
import { TICKS_PER_SECOND as S } from '../../src/shared/time';

const R30 = { num: 30, den: 1 };
function media(id: string, seconds: number, kind: 'video' | 'audio'): MediaRef {
  return {
    id, name: `${id}`, path: `/m/${id}`, warnings: [],
    info: {
      kind, container: '', fileSize: 1, duration: seconds * S, videoCodec: kind === 'video' ? 'h264' : '', width: 640, height: 360,
      displayWidth: kind === 'video' ? 640 : 0, displayHeight: kind === 'video' ? 360 : 0, rotation: 0, frameRate: R30, avgFrameRate: R30,
      isVFR: false, pixFmt: '', colorTransfer: '', isHDR: false, hasAudio: true, audioCodec: 'aac', audioSampleRate: 48000, audioChannels: 2,
    },
  };
}
function proj(): Project {
  let p = addMedia(createProject(), [media('v', 10, 'video'), media('song', 30, 'audio'), media('sfx', 2, 'audio')]);
  return addClip(p, 'v')!.project;
}

describe('audio tracks', () => {
  it('audio-only media cannot go on the video track', () => {
    expect(createClip(proj(), proj().media[1])).toBeNull();
  });

  it('adding creates a track, and clips never overlap on a track', () => {
    let p = proj();
    const a = addAudioClip(p, 'sfx', 1 * S)!;
    expect(p.audioTracks).toBeUndefined();
    p = a.project;
    expect(p.audioTracks!.length).toBe(1);
    const b = addAudioClip(p, 'sfx', 2 * S, a.trackId)!; // would overlap 1–3 s → pushed to 3 s
    p = b.project;
    expect(findAudioClip(p, b.clipId)!.clip.start).toBe(3 * S);
    p = moveAudioClip(p, b.clipId, 0.5 * S); // overlaps → next free spot after the first clip
    expect(findAudioClip(p, b.clipId)!.clip.start).toBe(3 * S);
    p = moveAudioClip(p, a.clipId, 6 * S);
    p = moveAudioClip(p, b.clipId, 0);
    expect(findAudioClip(p, b.clipId)!.clip.start).toBe(0);
  });

  it('moves between tracks', () => {
    let p = proj();
    const a = addAudioClip(p, 'sfx', 0)!;
    const t2 = addAudioTrack(a.project);
    p = moveAudioClip(t2.project, a.clipId, S, t2.trackId);
    expect(findAudioClip(p, a.clipId)!.track.id).toBe(t2.trackId);
    expect(p.audioTracks![0].clips.length).toBe(0);
  });

  it('trims within the file and neighbours; split keeps timing', () => {
    let p = proj();
    const a = addAudioClip(p, 'song', 2 * S)!;
    p = trimAudioClip(a.project, a.clipId, 'start', -5 * S); // cannot go before the file start
    expect(findAudioClip(p, a.clipId)!.clip).toMatchObject({ start: 2 * S, sourceIn: 0 });
    p = trimAudioClip(p, a.clipId, 'start', S);
    expect(findAudioClip(p, a.clipId)!.clip).toMatchObject({ start: 3 * S, sourceIn: S });
    p = trimAudioClip(p, a.clipId, 'end', 10 * S); // already at the file end
    expect(audioClipEnd(findAudioClip(p, a.clipId)!.clip)).toBe(32 * S);
    const sp = splitAudioClip(p, a.clipId, 10 * S)!;
    const right = findAudioClip(sp.project, sp.rightId)!.clip;
    expect(right).toMatchObject({ start: 10 * S, sourceIn: 8 * S });
  });

  it('fades are linear and never exceed the clip', () => {
    let p = proj();
    const a = addAudioClip(p, 'sfx', 0)!;
    p = setAudioClip(a.project, a.clipId, { volume: 2, fadeIn: 5 * S, fadeOut: 5 * S });
    const c = findAudioClip(p, a.clipId)!.clip;
    expect(c.fadeIn + c.fadeOut).toBeLessThanOrEqual(2 * S);
    p = setAudioClip(p, a.clipId, { volume: 3, fadeIn: S / 2, fadeOut: S / 2 });
    const d = findAudioClip(p, a.clipId)!.clip;
    expect(d.volume).toBe(2);
    expect(clipGainAt(d, S / 4)).toBeCloseTo(1);
    expect(clipGainAt(d, S)).toBe(2);
    expect(clipGainAt(d, 2 * S)).toBe(0);
  });
});

describe('ducking', () => {
  it('speech intervals follow the video edit (trim shifts them)', () => {
    let p = proj();
    p = setSpeech(p, 'v', [{ start: 2 * S, end: 4 * S }, { start: 4.3 * S, end: 5 * S }]);
    expect(speechIntervals(p)).toEqual([{ start: 2 * S, end: 5 * S }]); // short pause bridged
    p = trimEdge(p, p.sequence.items[0].id, 'start', S);
    expect(speechIntervals(p)).toEqual([{ start: S, end: 4 * S }]);
  });

  it('dips before speech and recovers after, to the requested depth', () => {
    const iv = [{ start: 3 * S, end: 5 * S }];
    const low = Math.pow(10, -12 / 20);
    expect(duckGainAt(iv, 3 * S - DUCK_ATTACK - 1, -12)).toBe(1);
    expect(duckGainAt(iv, 3 * S, -12)).toBeCloseTo(low);
    expect(duckGainAt(iv, 4 * S, -12)).toBeCloseTo(low);
    expect(duckGainAt(iv, 5 * S + DUCK_RELEASE / 2, -12)).toBeCloseTo((1 + low) / 2);
    expect(duckGainAt(iv, 5 * S + DUCK_RELEASE, -12)).toBe(1);
  });

  it('inverts silence into sound ranges', () => {
    expect(soundFromSilence([{ start: S, end: 2 * S }], 3 * S)).toEqual([{ start: 0, end: S }, { start: 2 * S, end: 3 * S }]);
  });

  it('round-trips audio tracks through the project file', () => {
    const a = addAudioClip(proj(), 'song', S)!;
    const back = parseProject(serializeProject(a.project));
    expect(back.audioTracks).toEqual(a.project.audioTracks);
    expect(back.version).toBe(PROJECT_VERSION);
  });
});
