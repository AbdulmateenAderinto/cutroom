/**
 * Serves local media to the preview's <video> elements as cutroom-media://file/<encoded path>.
 *
 * Supports HTTP Range requests, which Chromium uses to seek: only the requested byte ranges are
 * read from disk, so large files are never loaded into memory. Only files that went through
 * probing (import, open, relink) are served.
 */
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { protocol } from 'electron';

export const MEDIA_SCHEME = 'cutroom-media';
const allowed = new Set<string>();

export function allowMediaPath(p: string) {
  allowed.add(path.resolve(p));
}

export function registerSchemePrivileges() {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } },
  ]);
}

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.flac': 'audio/flac',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
};
// The preview routes media through Web Audio (for volume above 100% and ducking), which requires CORS.
const CORS = { 'Access-Control-Allow-Origin': '*' };

export function handleMediaProtocol() {
  protocol.handle(MEDIA_SCHEME, (request) => {
    const url = new URL(request.url);
    const file = path.resolve(decodeURIComponent(url.pathname.slice(1)));
    if (!allowed.has(file)) return new Response('Not allowed', { status: 403 });
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return new Response('Not found', { status: 404 });
    }
    const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    const range = request.headers.get('range');
    const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
    if (m) {
      let start = m[1] ? Number(m[1]) : 0;
      let end = m[2] ? Number(m[2]) : size - 1;
      if (!m[1] && m[2]) {
        start = Math.max(0, size - Number(m[2])); // suffix range
        end = size - 1;
      }
      if (start >= size || end < start) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      }
      end = Math.min(end, size - 1);
      const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream;
      return new Response(body, {
        status: 206,
        headers: {
          'Content-Type': type,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
          ...CORS,
        },
      });
    }
    const body = Readable.toWeb(createReadStream(file)) as ReadableStream;
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes', ...CORS },
    });
  });
}
