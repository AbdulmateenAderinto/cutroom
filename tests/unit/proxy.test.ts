import { describe, expect, it } from 'vitest';
import { proxyArgs, proxySize } from '../../src/main/media/proxy';
import type { MediaInfo } from '../../src/shared/model';

const info = (w: number, h: number, extra: Partial<MediaInfo> = {}): MediaInfo => ({
  container: 'mov,mp4', fileSize: 1, duration: 1, videoCodec: 'h264', width: w, height: h, displayWidth: w, displayHeight: h, rotation: 0,
  frameRate: { num: 30, den: 1 }, avgFrameRate: { num: 30, den: 1 }, isVFR: false, pixFmt: 'yuv420p', colorTransfer: '', isHDR: false,
  hasAudio: true, audioCodec: 'aac', audioSampleRate: 48000, audioChannels: 2, ...extra,
});

describe('preview copies', () => {
  it('fit 1920×1080, or 960×540 in proxy mode, either orientation, keeping the shape', () => {
    expect(proxySize(info(3840, 2160))).toEqual({ w: 1920, h: 1080 });
    expect(proxySize(info(3840, 2160), true)).toEqual({ w: 960, h: 540 });
    expect(proxySize(info(1080, 1920), true)).toEqual({ w: 540, h: 960 });
    expect(proxySize(info(4096, 2160), true)).toEqual({ w: 960, h: 506 });
    expect(proxySize(info(640, 360), true)).toEqual({ w: 640, h: 360 }); // never enlarged
  });

  it('proxy mode copies are transcoded at the small size; the source file is only read', () => {
    const a = proxyArgs('/in/a.mov', info(3840, 2160), 'transcode', '/out/x.mp4', undefined, true);
    expect(a[a.indexOf('-vf') + 1]).toContain('scale=w=960:h=540');
    expect(a[a.indexOf('-i') + 1]).toBe('/in/a.mov');
    expect(a[a.length - 1]).toBe('/out/x.mp4');
  });
});
