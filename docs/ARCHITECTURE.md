# Architecture

Cutroom is an Electron app written in TypeScript. The UI is React. FFmpeg and ffprobe run as child
processes. The code is split into four responsibilities, with one shared project model at the centre.

```
            ┌──────────────── src/shared (pure, no I/O) ─────────────────┐
            │ time.ts      integer ticks, rational frame rates             │
            │ model.ts     Project / MediaRef / ClipItem / GapItem, layout,│
            │              computeClipRect() framing maths                 │
            │ ops.ts       split, trim, move, delete, duplicate … (pure)   │
            │ exportPlan.ts Project + settings → FFmpeg argument array     │
            │ serialize.ts  JSON format, version, validation               │
            └───────────────▲──────────────────────────▲──────────────────┘
                            │ same model & maths        │
  UI + interaction state    │                           │  media inspection & export
  src/renderer              │                           │  src/main
  - state/store.ts  project + undo/redo + selection     │  - media/probe.ts   ffprobe → MediaInfo
  - components/*    panels, timeline, export dialog     │  - media/thumbnails.ts
  - preview/engine.ts  playback (see below)  ◀── IPC ──▶│  - export/exportRunner.ts
                                         (preload/api.ts)│  - project/projectFiles.ts, recovery.ts
                                                         │  - mediaProtocol.ts (streams files to <video>)
```

## Key decisions

**One project model drives both preview and export.** `computeClipRect()` decides where a clip sits
on the canvas. The preview applies it as CSS percentages; the exporter turns it into FFmpeg
crop/scale/overlay. Timing comes from `layoutSequence()` in both. An automated test screenshots the
preview and compares it to the exported frame.

**Time is integer ticks (1/705,600,000 s).** That number divides evenly by every common frame rate
(including 23.976/29.97/59.94) and audio sample rate, so frame boundaries are exact integers and
repeated edits never accumulate floating-point error. Frame rates are rationals (`30000/1001`).
BigInt is used only inside conversions, where products could exceed 2^53.

- `sourceIn` sits on the source file's frame grid (the first frame shown is unambiguous).
- Clip durations are whole project frames (every cut lands on a frame boundary).
- Source time (`sourceIn/sourceOut`) and timeline time (derived from clip order) are separate.

**A magnetic single track.** Clips play back to back in array order; timeline positions are derived,
not stored. "Delete, leave gap" inserts an explicit `GapItem` (exported as background colour plus silence).
Each clip carries its own audio, so A/V sync after trims, splits and reordering follows from the timing rules.
Audio tracks (music, voice-over) sit underneath: their clips have an explicit timeline `start`, so they
stay where they are when the video track is edited. A photo is a clip whose media is a still image with a
nominal one-hour source length, so trimming works exactly as for video.

**Undo/redo = snapshots.** Edits are pure functions returning a new `Project`, so history is a list
of previous projects (unchanged parts are shared). A drag is a "gesture": updated live, committed as one undo step.

**Explicit, cautious media support.** Video: H.264 (HEVC flagged as untested) in MP4/MOV. Audio:
MP3, M4A/AAC, WAV, FLAC. Photos: JPEG, PNG, WebP. Anything else is rejected with a reason. See STATUS.md for format limitations.

## Playback and preview (src/renderer/preview/engine.ts)

FFmpeg does not do interactive playback here. Chromium's `<video>` element does (hardware-decoded
H.264/HEVC on macOS via VideoToolbox).

- Media is served through a custom `cutroom-media://` protocol that supports HTTP Range requests,
  so Chromium reads only the bytes it needs (large files are never loaded into memory). Only files
  that were probed (imported, opened, relinked) are served.
- Two `<video>` elements alternate (A/B). One plays the current clip; the other preloads the next
  clip and seeks to its in-point about 2 s before the cut. A split clip continuing from the same
  file keeps playing in the same element with no seek.
- During playback the active element's clock is the master: `timeline = clipStart + (currentTime − sourceIn)`.
  Picture and sound come from the same element, so they stay in sync. Gaps use the wall clock.
- Paused seeks add a quarter-frame offset (exact frame boundaries can land on the previous frame), and
  pausing snaps the playhead to a frame, so the paused picture matches the exported frame.
- Preview quality is not export quality: the browser decodes the original and draws it at preview
  size; export always renders from the original files at the chosen output size.

- Overlay-track clips (`Project.overlays`, src/shared/overlays.ts) each get their own `<video>`/`<img>`
  in a layer above the main track (and its dips) and below titles/captions, created about 2 s before
  they start and removed after. They follow the timeline clock like music: `playbackRate` = speed ×
  shuttle, re-seeked only on real drift (> 0.1 s), seeked exactly when paused. They are positioned with
  the same `applyStyle()` as main clips, via `overlayLayout()` (an overlay seen as a laid-out clip).

If preview of heavy footage (4K HEVC, long GOP) becomes sluggish, the hook for proxies is
`elementFor()` in the engine. It would load a proxy URL instead of the original, while export keeps using originals.

## Export (src/shared/exportPlan.ts, src/main/export/exportRunner.ts)

One FFmpeg process. For each timeline item:

```
clip:  -ss (in − ½ frame) -t … -i file        (input seek: fast, frame-accurate when re-encoding)
       [v] setpts → crop (only if partly off-canvas) → scale → overlay on a background of exactly N frames
       [a] trim ½ frame → align → resample 48 kHz stereo → volume → pad/trim to exactly M samples
photo: -loop 1 -framerate <output rate> -t … -i file, decoded to RGB(A) → same chain, converted RGB→BT.709;
       alpha kept (yuva420p) so the background shows through
gap:   background colour × N frames + silence × M samples
then:  concat → (pad or crop if the output aspect differs, chosen explicitly) → libx264 + AAC → MP4
```

**Colour** (src/shared/color.ts): the sliders are one affine RGB transform (preview: SVG
`feColorMatrix`; export: `colorchannelmixer`), then curves as one 256-entry table per channel
(preview: `feComponentTransfer` tables; export: FFmpeg `curves` given all 256 points, x rounded up so
FFmpeg's own spacing check passes). Both sides work on gamma-encoded 8-bit RGB.

**Media input transforms** (`MediaRef.input`): HDR tone mapping and a 3D LUT are applied when a
file is read, by one FFmpeg chain (`inputTransformChain`) that ends in BT.709 RGB. The export puts
it at the start of the clip's chain; the preview plays a preview copy made with the same chain
(keyed by the recipe), so they agree. LUTs live in the app's LUT folder as `<sha1>.cube` and FFmpeg
runs with that folder as its working directory, so the filter graph only ever contains a hex name.

**Transitions**: crossfade, wipes, slides and zoom are one `xfade` segment over the window
(`transition=fade|wipeleft|…|slidedown`); zoom also scales each clip per frame through the animated
path. `transitionLook()` in transitions.ts restates xfade's formulas (b = incoming mix, progress =
1 − b) as a visible region / offset / scale per layer, and the preview applies exactly that with
CSS (clip-path polygon, position offset, scale). Dips use `fade` on each clip's own segment.

**Rotation** (`Framing.rotation` + the `rotation` keyframe): the clip goes through the animated path.
The picture is scaled once to its largest size, rotated (`rotate`, transparent fill) into a square
whose side is its diagonal, and the square is resized per frame with `scale` commands — uniform
scaling commutes with rotation, so this equals rotating the resized picture, and the per-frame size
change stays directly in front of `overlay` (where FFmpeg handles it). The preview uses CSS
`rotate()` around the element's centre; both rotate clockwise.

**Overlay tracks** (picture-in-picture): after the concat, each overlay clip goes through the same
`renderClip()` as a main clip, but on a transparent canvas (`layer` mode: `color=black@0`, `yuva420p`;
fades scale the alpha with `blend` `c3_opacity` instead of mixing with the background colour), for
its own frames only. It is shifted to its start (`setpts=…+start/TB`) and laid over the main track with
`overlay=…:eof_action=pass`, lowest row first. Its sound is delayed to its start (`adelay`) and mixed
with the audio tracks. Nothing past the main track's end is exported (as for audio tracks).

N and M come from the cumulative timeline boundaries rounded once each, with audio boundaries derived
from the same video frame boundaries. So no rounding drift builds up, and every cut is sample-aligned
to its frame.

Safety: FFmpeg writes `name.mp4.partial`. The result is checked with ffprobe (codec, size,
duration, audio present) and only then renamed to `name.mp4`. On failure or cancel the partial file is
deleted. Arguments are always an array (`spawn`, never a shell), so any file name is safe.

**Speed** (`ClipItem.speed`): timeline length = source length / speed, kept on the frame grid by
`legalRange`. Every conversion between timeline and source time goes through `sourceAt()` /
`timelineAt()` (split, trim, keyframes, captions, ducking, preview). Export divides video timestamps
by the speed and time-stretches sound with `rubberband` (or `atempo`), padded so the stretcher
doesn't drop its last window; the segment is then trimmed to an exact sample count as usual.

**Transitions** (`src/shared/transitions.ts`) are stored on the left clip and centred on the cut.
`resolveTransitions()` clamps each to the footage past the cut (crossfade) and half of each clip;
`transitionMix()` gives the per-time mix used by the preview. In export a crossfade is its own segment:
both clips are rendered over the window by the normal clip code (frames before the incoming clip's start
and after the outgoing clip's end come from `sourceAt()`), mixed with `xfade`, and the sound with linear
`afade`s and `amix`. Dips apply `fade` to/from the colour on the clips' own frames. The preview shows the
other clip in a third element (over the outgoing clip before the cut, under the incoming one after) and
dips with a colour layer.

**Colour adjustments** (`src/shared/color.ts`) combine into one affine transform of gamma-encoded
RGB (`colorTransform`). The preview applies it as an SVG `feColorMatrix` with
`color-interpolation-filters="sRGB"` on the clip's element; the export converts the clip to RGB with its
own matrix/range (Chromium's interpretation), applies `colorchannelmixer` on RGBA (the alpha column
carries the offset) and converts to BT.709 like photos.

**Range export** builds the timeline only up to the range end (the clip straddling it renders fewer
frames, with its animation still timed on its full length), renders clips wholly before the range as
plain background without decoding them, and trims the start off video and audio. So every frame in the
range is the frame a full export would have. (Cutting the end with `trim` instead stalled FFmpeg 6 when
it fell inside an animated clip's `split`/`blend` graph.)

**Encoders:** libx264 with an average bitrate (VBV-capped) or CRF; or `h264_videotoolbox` with an
average bitrate, offered only after a one-frame test encode succeeds (`src/main/export/encoders.ts`).

Audio tracks are mixed after the concat:

```
each clip:  -ss in -t len -i file → resample → volume → fades → adelay (in samples) ─┐
track:      amix (normalize=0) → track volume → ducking envelope (asendcmd, 20 ms steps)
final:      amix with the video track's audio → alimiter (−0.2 dBFS)
```

The preview routes every `<video>`/`<audio>` element through Web Audio gain nodes and computes gains
with the same functions (`clipGainAt`, `duckGainAt` in `src/shared/audio.ts`). Music elements follow the
timeline clock and are re-seeked only if they drift by more than 120 ms. Ducking uses the video's
"sound present" ranges (the inverse of silence detection), cached per media file.

## Project files

JSON with `format: "cutroom-project"` and `version`. Saving writes a temp file in the same folder,
fsyncs it, then renames it over the target (atomic), so a crash never leaves a half-written project.
Media is stored with absolute and relative paths; missing files are reported and can be relinked.
Autosave writes unsaved work to `<userData>/recovery/` every 20 s. On launch, leftover files are offered for recovery.

## Animation (src/shared/animation.ts)

`evalAnimation(clip, t)` returns `{scale, x, y, opacity}` applied on top of the clip's framing. It
combines keyframes (anchored to **source** time, so they follow trims and splits), a whole-clip motion
preset, and in/out presets (anchored to the clip's edges). The preview calls it every frame and sets CSS.
The exporter samples it at every output frame and sends the values to FFmpeg as per-frame commands
(`sendcmd` → `scale` size, `overlay` position, `blend` opacity), so both use one implementation.
Two FFmpeg details matter: commands fire a quarter frame early so they land on the right frame, and the
pixel-format conversion must come *before* the resizing `scale` (a `format` filter after it stops size changes).

## Captions and titles (src/shared/captions.ts, src/shared/titles.ts, src/renderer/captions/)

Titles live on text rows with an explicit timeline start, like audio clips. `titleStateAt()` gives a
title's opacity / offset / scale / revealed characters at any time. `drawOverlay()` draws every title
(by row) and then the caption with Canvas 2D. The preview calls it for the playhead time. For export,
the window renders each distinct overlay state into a PNG (`renderOverlayTrack`): states change at
caption and title boundaries, and on every output frame while a title animates. The PNGs go through
the same image track as captions (below), so titles and captions are one overlay in FFmpeg.


Transcripts are stored per media file as words with **source** times. `buildCues(project)` maps
them through the timeline (trims, splits, reordering, removed pauses) and groups them into lines,
so captions never need re-timing. One Canvas 2D function draws a cue. The preview draws live; for export, the window
renders each caption state (one per spoken word when highlighting) to a PNG. Those PNGs become a
single timed image stream (`ffconcat` with `option framerate` = output rate, so boundaries are frame-exact)
overlaid on the canvas.

## Colour

The output is BT.709 limited range. Sources are interpreted the way Chromium (the preview) does,
which differs by platform (`sourceColor` in `model.ts`; measured in the app):

- The tagged matrix wins. Untagged video counts as SD (BT.601) below 720 lines, except on macOS,
  where VideoToolbox treats it as SD only up to 704×576 (720×480 and 360×640 portrait count as HD).
- Chromium on macOS also converts SD primaries to the display: SMPTE-C (tagged, or implied by a
  BT.601 matrix) and EBU (`bt470bg`). Pure SMPTE-C green shows as 63,251,0. The export does the same
  (FFmpeg `colorspace`, linear light with the sRGB curve, as Chromium) before anything else, so the
  rest of the chain sees BT.709. Chromium elsewhere shows SD primaries as if they were BT.709, so there
  is no conversion. `exportRunner` picks the platform it runs on (`previewPlatform`).
- Full-range sources are converted to TV range.

Every video source's frames are tagged with the assumed matrix/range at the start of its chain:
FFmpeg 8+ otherwise converts untagged frames (assumed BT.601) to match the output's BT.709 tag.
Solid colours (backgrounds, caption images) are converted RGB→YUV with BT.709 explicitly.

macOS colour management that the export does not copy (it applies to the exported file too, e.g. in
QuickTime): hardware-decoded video gets the BT.709 → display gamma change, and the window is
colour-managed to the display (P3). The UI tests therefore run Electron with `--force-color-profile=srgb`
and `--disable-accelerated-video-decode` so their screenshots compare with FFmpeg's decode.

## AI control (src/main/control, src/mcp, src/renderer/control)

```
Claude ──stdio MCP──▶ cutroom-mcp (src/mcp/server.ts) ──HTTP 127.0.0.1 + token──▶ ControlServer (main)
                                                                   │ files/FFmpeg tools: mainTools, analysis, whisper
                                                                   └─ editing tools ──IPC──▶ rendererTools → commit()
```

Tool definitions (names, descriptions, JSON schemas) live in `src/shared/controlTools.ts`. The bridge
lists them; the server validates arguments. Editing tools execute in the window through the same
`commit()` as UI edits, which gives live updates and one undo step per call.
