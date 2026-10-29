/**
 * Poster-frame thumbnails, generated asynchronously by FFmpeg and cached on disk.
 * FFmpeg seeks to the frame, so the video is never loaded into memory.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { ffmpegPath } from './ffbin';

export async function thumbnailDataUrl(cacheDir: string, file: string, atSeconds: number): Promise<string | null> {
  try {
    const st = statSync(file);
    const key = createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}|${atSeconds.toFixed(2)}`).digest('hex');
    mkdirSync(cacheDir, { recursive: true });
    const out = path.join(cacheDir, `${key}.jpg`);
    if (!existsSync(out)) {
      await new Promise<void>((resolve, reject) => {
        execFile(
          ffmpegPath(),
          ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-ss', atSeconds.toFixed(3), '-i', file,
            '-frames:v', '1', '-vf', 'scale=320:320:force_original_aspect_ratio=decrease', '-q:v', '5', out],
          { timeout: 30_000 },
          (err) => (err ? reject(err) : resolve()),
        );
      });
    }
    return `data:image/jpeg;base64,${readFileSync(out).toString('base64')}`;
  } catch {
    return null;
  }
}
