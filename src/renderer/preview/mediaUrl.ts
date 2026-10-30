/**
 * The URL the preview loads for a media file: the original, or its preview copy for formats the
 * preview can't play (made in the background; see main/media/proxy.ts). null = copy not ready yet.
 */
import type { MediaRef } from '../../shared/model';
import { store } from '../state/store';

export function previewUrl(m: MediaRef): string | null {
  const mode = m.info.preview;
  if (!mode || mode === 'native') return window.cutroom.mediaUrl(m.path);
  const p = store.get().proxies[m.id];
  return p?.status === 'ready' && p.path && p.source === m.path ? window.cutroom.mediaUrl(p.path) : null;
}
