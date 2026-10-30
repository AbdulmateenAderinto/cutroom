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

export function previewUrl(m: MediaRef): string | null {
  if (!needsProxy(m)) return window.cutroom.mediaUrl(m.path);
  const p = store.get().proxies[m.id];
  return p?.status === 'ready' && p.path && p.source === proxySource(m) ? window.cutroom.mediaUrl(p.path) : null;
}
