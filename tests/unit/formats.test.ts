import { describe, expect, it } from 'vitest';
import { audioPreviewMode, imagePreviewMode, videoPreviewMode } from '../../src/shared/formats';

const MP4 = 'mov,mp4,m4a,3gp,3g2,mj2';
const MKV = 'matroska,webm';
const v = (ext: string, container: string, videoCodec: string, audioCodec: string | null, platform = 'linux') =>
  videoPreviewMode({ ext, container, videoCodec, audioCodec, platform });

describe('how the preview shows each format', () => {
  it('plays MP4/MOV with H.264 + AAC and WebM (VP9/AV1 + Opus) directly', () => {
    expect(v('mp4', MP4, 'h264', 'aac')).toBe('native');
    expect(v('mov', MP4, 'h264', null)).toBe('native');
    expect(v('webm', MKV, 'vp9', 'opus')).toBe('native');
    expect(v('mp4', MP4, 'av1', 'aac')).toBe('native');
  });
  it('HEVC plays directly on macOS only; elsewhere it gets an H.264 copy', () => {
    expect(v('mov', MP4, 'hevc', 'aac', 'darwin')).toBe('native');
    expect(v('mov', MP4, 'hevc', 'aac', 'linux')).toBe('transcode');
  });
  it('copies the picture when only the container or the sound is the problem', () => {
    expect(v('mkv', MKV, 'h264', 'opus')).toBe('remux');
    expect(v('mts', 'mpegts', 'h264', 'ac3')).toBe('remux');
    expect(v('mp4', MP4, 'h264', 'ac3')).toBe('remux');
    expect(v('mov', MP4, 'h264', 'pcm_s16le')).toBe('remux');
  });
  it('makes an H.264 copy of editing and legacy codecs, and of GIFs', () => {
    for (const c of ['prores', 'dnxhd', 'mpeg2video', 'mpeg4', 'wmv3', 'dvvideo']) expect(v('mov', MP4, c, 'pcm_s16le')).toBe('transcode');
    expect(v('gif', 'gif', 'gif', null)).toBe('transcode');
  });
  it('sound files and images', () => {
    const a = (ext: string, audioCodec: string) => audioPreviewMode({ ext, container: '', audioCodec, platform: 'linux' });
    expect(a('mp3', 'mp3')).toBe('native');
    expect(a('ogg', 'vorbis')).toBe('native');
    expect(a('wav', 'pcm_s24le')).toBe('native');
    expect(a('aiff', 'pcm_s16be')).toBe('audio');
    expect(a('wma', 'wmav2')).toBe('audio');
    expect(imagePreviewMode('jpg')).toBe('native');
    expect(imagePreviewMode('tiff')).toBe('image');
  });
});
