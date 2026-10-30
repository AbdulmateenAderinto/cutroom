/**
 * The URL the preview loads for a media file: the original, or its preview copy for formats the
 * preview can't play (made in the background; see main/media/proxy.ts). null = copy not ready yet.
 */
import { inputRecipe } from '../../shared/exportPlan';
import type { MediaRef } from '../../shared/model';
import { store } from '../state/store';

/**
 * What a preview copy is made from: the file, plus the input transform (tone mapping, LUT) if any.
 * A file with an input transform always gets a copy (made with the export's own chain).
 */
export function proxySource(m: MediaRef): string {
  const recipe = inputRecipe(m);
  return recipe ? `${m.path}#${recipe}` : m.path;
}
export function needsProxy(m: MediaRef): boolean {
  return !!inputRecipe(m) || (!!m.info.preview && m.info.preview !== 'native');
}

/** Proxy mode: video larger than 960×540 gets a smaller copy (kept under "low:<id>" in proxies). */
export function wantsLowProxy(m: MediaRef): boolean {
  return (m.info.kind ?? 'video') === 'video' && (Math.max(m.info.displayWidth, m.info.displayHeight) > 960 || Math.min(m.info.displayWidth, m.info.displayHeight) > 540);
}
export const lowKey = (id: string) => `low:${id}`;

/**
 * The preview's URL. In proxy mode the smaller copy once it is ready (until then the normal one,
 * so nothing waits on it). The export never uses these copies.
 */
export function previewUrl(m: MediaRef): string | null {
  const s = store.get();
  if (s.proxyMode && wantsLowProxy(m)) {
    const low = s.proxies[lowKey(m.id)];
    if (low?.status === 'ready' && low.path && low.source === proxySource(m)) return window.cutroom.mediaUrl(low.path);
  }
  if (!needsProxy(m)) return window.cutroom.mediaUrl(m.path);
  const p = store.get().proxies[m.id];
  return p?.status === 'ready' && p.path && p.source === proxySource(m) ? window.cutroom.mediaUrl(p.path) : null;
}
