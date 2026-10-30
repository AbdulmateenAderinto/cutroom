/**
 * Which files Cutroom imports, and how the preview can show them. FFmpeg decodes all of these for
 * export; the preview (Chromium) plays fewer, so the others get a cached preview copy.
 */
export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mts', 'm2ts', 'ts', 'mxf', 'mpg', 'mpeg', 'vob', '3gp', 'dv', 'wmv', 'flv', 'gif'];
export const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'aif', 'aiff', 'ogg', 'oga', 'opus', 'caf', 'wma', 'ac3'];
export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'heif'];
export const SUPPORTED_EXTENSIONS = [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS, ...IMAGE_EXTENSIONS];

/** Containers Chromium plays (by FFmpeg format name). */
const NATIVE_CONTAINERS = ['mov,mp4,m4a,3gp,3g2,mj2', 'matroska,webm'];
/** Video codecs Chromium plays everywhere; HEVC only where the OS decodes it (macOS). */
const NATIVE_VIDEO = ['h264', 'vp8', 'vp9', 'av1'];
/** Audio codecs Chromium plays (in MP4/MOV/WebM, or as files). */
const NATIVE_AUDIO = ['aac', 'mp3', 'opus', 'vorbis', 'flac'];
const NATIVE_AUDIO_FILES = [...NATIVE_AUDIO, 'pcm_s16le', 'pcm_s24le', 'pcm_f32le', 'pcm_u8'];
/** Codecs that can be copied into an MP4 preview without re-encoding the picture. */
const REMUXABLE_VIDEO = ['h264', 'hevc', 'av1', 'vp9'];
const NATIVE_IMAGES = ['jpg', 'jpeg', 'png', 'webp', 'bmp'];

export interface FormatFacts {
  ext: string; // lower case, no dot
  container: string; // ffprobe format_name
  videoCodec?: string;
  audioCodec?: string | null;
  platform: string; // process.platform
}

/** How the preview shows a video file. */
export function videoPreviewMode(f: FormatFacts): 'native' | 'remux' | 'transcode' {
  const v = f.videoCodec ?? '';
  const videoOk = NATIVE_VIDEO.includes(v) || (v === 'hevc' && f.platform === 'darwin');
  const audioOk = !f.audioCodec || NATIVE_AUDIO.includes(f.audioCodec);
  // WebM only for VP8/VP9/AV1 (Chromium doesn't play H.264 in Matroska files).
  const containerOk = f.container === NATIVE_CONTAINERS[0] || (f.container === NATIVE_CONTAINERS[1] && f.ext === 'webm' && v !== 'h264');
  if (f.ext !== 'gif' && videoOk && audioOk && containerOk) return 'native';
  if (f.ext !== 'gif' && (videoOk || REMUXABLE_VIDEO.includes(v)) && !(v === 'hevc' && f.platform !== 'darwin')) return 'remux';
  return 'transcode';
}

export function audioPreviewMode(f: FormatFacts): 'native' | 'audio' {
  return f.audioCodec && NATIVE_AUDIO_FILES.includes(f.audioCodec) && !['aif', 'aiff', 'caf', 'wma', 'ac3'].includes(f.ext) ? 'native' : 'audio';
}

export function imagePreviewMode(ext: string): 'native' | 'image' {
  return NATIVE_IMAGES.includes(ext) ? 'native' : 'image';
}
