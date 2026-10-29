# Status

Legend: ✅ works and has automated tests · ☑️ works, checked by hand or in screenshots only · 🔜 planned (not in the app) · ❌ not planned yet

## First milestone

| Feature | Status | Notes |
|---|---|---|
| Import MP4/MOV (H.264 + AAC) via button or drag-and-drop | ✅ | Unsupported files are rejected with a reason |
| Metadata and thumbnails, generated asynchronously | ✅ | Thumbnails cached in the app's data folder |
| Source preview of a media file | ✅ | Click it in the Media panel |
| Add to timeline (button or drag-and-drop) | ✅ | |
| Trim by dragging clip edges (ripple) | ✅ | |
| Exact numeric trim (in/out/duration) with ±1 frame | ✅ | `HH:MM:SS:FF`, `1.5`, `45f` |
| Split at playhead | ✅ | |
| Delete: close gap / leave gap | ✅ | Gaps are clips you can select, resize and remove |
| Reorder by dragging | ✅ | |
| Duplicate | ✅ | |
| Undo / redo (drags count as one step) | ✅ | 200 steps |
| Snapping (toggle, hold Alt to bypass) | ☑️ | Edges, playhead and preview centring |
| Frame stepping, timeline zoom | ✅ / ☑️ | ←/→, toolbar, ⌘+scroll |
| Canvas: Match source, 16:9, 9:16, 1:1, 4:5, custom | ✅ | Even sizes enforced (H.264 needs them) |
| Per-clip framing: Fit / Fill / Manual (drag + numeric) | ✅ | Preview vs export compared pixel by pixel |
| Background colour for padding and gaps | ✅ | |
| Per-clip volume (0–100%) and mute | ☑️ / ✅ | Export is tested for gaps and silence; volume levels are not measured |
| Save / Save As / Open (atomic save, format version) | ✅ | |
| Missing media detection and Relink | ✅ | Also finds media moved together with the project folder |
| Autosave and crash recovery | ☑️ | Logic is tested only through the app; the crash path itself has not been simulated |
| Unsaved-changes prompt on close / new / open | ☑️ | |
| Export MP4 H.264/AAC: resolution, frame rate, target bitrate | ✅ | Verified with ffprobe and decoded frames |
| Explicit fit/crop when output aspect ≠ canvas | ✅ | Export is blocked until you choose |
| Size estimate, progress, cancel, readable errors | ✅ | |
| Safe export (`.partial` → verify → rename) | ✅ | |

## Planned, in this order

1. 🔜 Music tracks, waveforms, volume above 100%, audio fades
2. 🔜 Photos with adjustable duration
3. 🔜 Text and simple overlays
4. 🔜 Exposure, contrast, saturation, temperature
5. 🔜 Keyframes (position, scale, opacity) with easing
6. 🔜 Constant-speed changes
7. 🔜 Proxies; hardware encoding (VideoToolbox); constant-quality (CRF) export; export a marked range; saved export presets; `.app`/`.dmg` packaging

Not planned yet: AI captions, generative tools, background removal, motion tracking, optical flow,
plugins, complex compositing, transitions (cuts are hard cuts for now).

## Verification

**Automated (`npm test`, 45 tests, about 30 s):**
- Timebase: exact frame and sample maths at 23.976–60 fps, no drift over 10 h, timecode round trips.
- Editing operations: split, trim clamps, ripple, frame-grid snapping, delete modes, gap merging,
  reorder, duplicate, inputs never mutated (undo safety), frame-rate change.
- Exports with real FFmpeg, inspected by decoding:
  - every output frame is identified (fixtures encode their frame number in the pixels) after
    trims, a split, a delete and a reorder: all 165 frames match exactly;
  - audio: each clip's tone appears in its segment and switches within 5 ms of each video cut;
  - A/V sync: flash frames vs beeps after fractional trims and reordering, within half a frame;
  - fit pads with the background colour; fill covers; manual position and scale are measured in pixels;
    oversized manual framing is cropped, not stretched; portrait canvas to square output with fit (bars) and fill (crop);
  - 1280×720 at 29.97 fps (`30000/1001`), H.264 High, AAC 48 kHz stereo, frame count, and average
    bitrate within ±25% of target (4 Mb/s target measured at about 3.9–4.1 Mb/s on noisy test content);
  - cancel removes the partial file; a missing source, an FFmpeg failure and an unwritable folder
    all fail with readable messages and leave no output file.
- Media inspection: H.264/AAC accepted; rotation metadata (display size and upright export);
  no-audio video accepted; HDR10 HEVC flagged; ProRes, MKV, audio-only and corrupt files rejected.
- Export filter graph: 2,000 randomised framings / canvas / output sizes; crop regions always stay
  inside the source frame (regression for a real rounding bug found by the UI test).
- Colour: background/padding colour decodes as the exact RGB value (BT.709), not shifted.
- Project files: save/load round trip, relative-path recovery, damaged/foreign/newer files rejected,
  a failed save leaves the old file intact.

**Automated UI run (`npm run test:e2e`, 23 steps, real Electron app, Linux + Xvfb):** all milestone
steps: import order, source preview playback, drag-trimming both edges, numeric trim, split,
both delete modes, drag-reordering, undo/redo, duplicate, every canvas preset, Fit/Fill, dragging
the image in the preview, playback across a cut (checks the video element's clock against the
timeline), save, reopen, missing-media relink, three exports (one cancelled), the explicit fit/crop
prompt, and a preview-vs-export pixel comparison of a rotated, manually framed clip on a red
background (mean difference 3.3/255; an unframed control scores 119/255).

**Checked by looking at screenshots (not asserted):** layout of all panels, the export dialog,
progress/result screens, missing-media state and the gap rendering.

**Not verified yet:**
- Running on macOS / Apple Silicon. All runs so far were on Linux; Electron and FFmpeg are
  cross-platform, but macOS-specific behaviour (menus, dialogs, HEVC hardware decoding,
  Homebrew paths, the window-close prompt) hasn't been exercised.
- Playback smoothness with real camera footage (4K, long GOP, high bitrate) and long timelines.
- Real phone footage (VFR, HDR, Dolby Vision, rotation variants), MOV files from cameras, 44.1 kHz or 5.1 audio.
- Listening tests for audio quality, and volume levels in the export.

## Known limitations

- **Inputs:** H.264 in MP4/MOV only (HEVC is accepted but untested). ProRes, DNxHD, AV1, VP9,
  MKV/WebM, images and audio-only files are rejected for now.
- **Variable frame rate:** export conforms to the project frame rate. A frame can occasionally differ
  from the preview. In-points are snapped to the file's nominal (`r_frame_rate`) grid.
- **HDR / colour:** no tone mapping or colour management. HDR files are flagged and will look wrong.
  YUV values are passed through and tagged BT.709. That's correct for typical HD/phone footage; SD
  BT.601 sources will look slightly off. 10-bit sources are exported as 8-bit.
- **Rotation:** 0/90/180/270° metadata is handled (verified for 90°). Mirrored display matrices are not.
- **Files with a non-zero video start time** (some edited or camera MOVs) may be offset by that amount in export.
- **Mismatched frame rates** (e.g. 25 fps clip in a 30 fps project): splitting can shift the
  right-hand part by under one source frame (audio moves with it, so sync is kept).
- **Timecode display** is "real seconds + frame number", not SMPTE drop-frame.
- **Timeline:** one video track; audio always travels with its clip; no transitions.
- **Volume** is limited to 0–100% (the preview cannot boost yet).
- **Export:** CPU encoding (libx264) only; constant quality and hardware encoding are planned.
  Each clip opens its own decoder in one FFmpeg process, which is fine for dozens of clips; very
  long timelines (hundreds of clips) may need segment-by-segment rendering.
- **Packaging:** no signed `.app` yet; FFmpeg must be installed separately.
