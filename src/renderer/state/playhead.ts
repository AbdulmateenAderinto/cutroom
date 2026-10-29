/**
 * Playhead time and play state live in their own store: they change every animation frame
 * during playback, and only the few components that show them should re-render.
 */
import { useSyncExternalStore } from 'react';
import type { Ticks } from '../../shared/time';

interface PlayheadState {
  time: Ticks;
  playing: boolean;
}

let state: PlayheadState = { time: 0, playing: false };
const listeners = new Set<() => void>();

export const playhead = {
  get: () => state,
  set(p: Partial<PlayheadState>) {
    if ((p.time === undefined || p.time === state.time) && (p.playing === undefined || p.playing === state.playing)) return;
    state = { ...state, ...p };
    listeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
};

export function usePlayhead<R>(sel: (s: PlayheadState) => R): R {
  return useSyncExternalStore(playhead.subscribe, () => sel(playhead.get()));
}
