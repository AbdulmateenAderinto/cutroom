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

The output is BT.709 limited range. Sources are interpreted the way Chromium (the preview) does:
the tagged matrix if present, otherwise BT.601 below 720 lines and BT.709 above; full-range sources
are converted. Solid colours (backgrounds, caption images) are converted RGB→YUV with BT.709 explicitly.

## AI control (src/main/control, src/mcp, src/renderer/control)

```
Claude ──stdio MCP──▶ cutroom-mcp (src/mcp/server.ts) ──HTTP 127.0.0.1 + token──▶ ControlServer (main)
                                                                   │ files/FFmpeg tools: mainTools, analysis, whisper
                                                                   └─ editing tools ──IPC──▶ rendererTools → commit()
```

Tool definitions (names, descriptions, JSON schemas) live in `src/shared/controlTools.ts`. The bridge
lists them; the server validates arguments. Editing tools execute in the window through the same
`commit()` as UI edits, which gives live updates and one undo step per call.

## Where to add the planned features

- **Colour adjustments:** a second visual layer in the preview, and an extra
  overlay or `eq` stage per segment in the export plan.
