# Cutroom

A lightweight desktop video editor for people who find Premiere too much: import clips, trim and
arrange them on one timeline, reframe for landscape/portrait/square, and export an MP4 with exact
control over resolution, frame rate and bitrate. Everything runs locally, with no accounts or uploads.

Status: the core workflow (import → edit → save → export) works and is tested, plus:

- **Animations:** in/out presets (fade, zoom, pop, slides), whole-clip motion (slow zoom, pan) and
  keyframes for zoom, position and opacity with easing.
- **Smart tools (local):** remove pauses, split at scene changes, transcribe speech (whisper.cpp),
  remove filler words, and burned-in captions that follow every edit.
- **Music and photos:** audio tracks with waveforms, fades, volume up to 200% and automatic
  ducking under speech; photos (JPEG/PNG/WebP, transparency, EXIF rotation) as clips with Ken Burns moves.
- **Transitions:** select the clip before a cut and choose **Transition to next clip** (crossfade or a dip
to black/white). A crossfade needs a little footage past the cut, so trim the clips slightly first.

**Colour:** select a clip and use the **Colour** sliders (exposure, contrast, saturation, temperature).

**Speed:** select a clip and pick 0.25×–4× in its **Speed** section (sound keeps its pitch).

**Titles:** text rows with styles (title, lower third, quote…), fonts, box/outline/shadow looks,
  drag-to-position in the preview, and fade/rise/pop/typewriter animations.
- **AI control (MCP):** let Claude Desktop or Claude Code edit with you. See [docs/AI.md](docs/AI.md).

Picking this up on your own machine? Start with [HANDOFF.md](HANDOFF.md).

See [docs/STATUS.md](docs/STATUS.md) for what works, what's planned and the known limitations.

## Requirements (macOS)

- macOS 12+ (Apple Silicon or Intel)
- [Node.js](https://nodejs.org) 20 or newer (22 LTS recommended): `brew install node`
- FFmpeg with libx264 (used for inspecting media, thumbnails and export): `brew install ffmpeg`
- Optional, for transcripts and captions: `brew install whisper-cpp` (a speech model is downloaded in the app)

Cutroom looks for `ffmpeg`/`ffprobe` in `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin` and your
`PATH`. To use a specific build, set `CUTROOM_FFMPEG` and `CUTROOM_FFPROBE` to their full paths.

## Run it

```bash
npm install
```

```bash
npm run dev
```

`npm run dev` compiles the main process, starts the UI dev server (with hot reload for UI code) and
opens the app. Restart it after changing files in `src/main` or `src/preload`.

To run a production build instead (no dev server):

```bash
npm start
```

## Try the milestone workflow

1. **Import…** (top of the Media panel) and pick some videos, or drag files onto the panel. Most
   formats work (MP4, MOV, MKV, WebM, AVI, MTS, MXF, ProRes, HEVC, GIF, and HEIC photos on a Mac);
   ones the preview can't play show **Preparing…** while a preview copy is made — the export always
   uses the original file.
2. Click a media item to preview it as a source clip. Use **Back to timeline** to return.
3. Click **+ Add to timeline** on each one, or drag it onto the timeline.
4. Drag a clip's left/right edge to trim it. For exact values, select the clip and type in
   **Source in / Source out / Duration** (formats: `00:00:01:15`, `1.5`, `45f`; the ±1f buttons step one frame).
5. Move the playhead (click/drag the ruler, or ←/→ for single frames), then **✂ Split**. Choose
   **Delete** (closes the gap) or **Delete, leave gap**. Drag clips to reorder them. **Undo/Redo** are in the top bar.
6. Pick a **Canvas** preset in the top bar (Match source, 16:9, 9:16, 1:1, 4:5) or type a custom size.
7. With a clip selected, choose **Fit**, **Fill** or **Manual** in its panel. In Manual, drag the
   image in the preview (corner handle scales it), or type Scale / X / Y.
8. **Save** (⌘S) creates a `.cutroom` file; **Open…** reopens it.
9. **Export…**: choose a file, resolution, frame rate and target bitrate in Mb/s, then **Export**.
   Or pick a **Preset** (including *Apple devices*: HEVC for iPhone/iPad/Mac/Apple TV, ProRes for Final
   Cut Pro), choose the codec (H.264, HEVC, ProRes) and .mp4 or .mov, switch to **Constant quality (CRF)**,
   or use Apple's hardware encoder. To export
   part of the timeline, press **I** and **O** at its start and end first.

**Music:** import an MP3/M4A/WAV/FLAC and click **+ Add to timeline**. It goes on an audio track at
the playhead. Drag it to move, drag its edges to trim, and drag the small squares at its top corners to
fade. Click the track name for track volume, mute and **Lower under speech** (ducking).

**Photos:** import JPEG/PNG/WebP files and add them like videos. Each becomes a 4-second clip; drag its
end to change that. Try **Motion → Slow zoom in** in its Animation section.

**Picture-in-picture:** click **⧉ PiP** on a video or photo in the Media panel. It goes on an
overlay track (V2) at the playhead, small in the bottom-right corner. Drag it in the preview (the
corner handle resizes it) or pick a corner in its panel; drag its block on the timeline to change when
it shows. Overlapping overlays go on V3, V4…; higher tracks draw on top.

**Markers:** press **M** (or **+ Marker**) to mark a moment; name and colour it in its panel. ↑/↓ stop at
markers, and the export can write them as chapters.

**Several clips:** ⌘-click (Ctrl-click) clips to select more than one, Shift-click for a range, ⌘A for
all; then Delete, ⌘C/⌘V and more apply to all of them. **Detach audio** (in a clip's Audio section) puts
its sound on an audio track so you can let it start before or run past the picture (J- and L-cuts).

**Speed tricks:** a clip's Speed section has ramps (ease into slow motion and back). **⇧F** freezes the
frame at the playhead for 2 s. **Reverse** (in the clip's Actions) plays a clip backwards; the stills and
reversed copies are saved in a “Cutroom Media” folder next to the project.

**Titles:** click **+ Text** above the timeline (or press T). Type in the **Text** box, pick a style,
and drag the text in the preview to place it. Drag its block on the timeline to change when it shows.

More, with a clip selected: the **Animation** section (presets and keyframes) and **Smart tools**
(pauses, scenes, transcription, filler words, captions). Caption style is in **Project settings**
(deselect with Esc).

Every action has a button or menu item. Keyboard shortcuts (J/K/L, Q/W trim to playhead, ↑/↓ between
cuts, ⌘C/⌘V clips, I/O and more) are listed under **Shortcuts** in the top bar, or press **?**.

## Tests

```bash
npm test
```

This runs unit tests (timing maths, editing operations, framing, project files) and integration
tests that run real FFmpeg exports and inspect the output with ffprobe and decoded frames/audio.
It needs `ffmpeg`/`ffprobe` on your PATH.

```bash
npm run test:e2e
```

This launches the real app and clicks through the editing workflow, the Smart tools / captions
workflow, music tracks, photos and titles (native file dialogs are stubbed). Screenshots go to `tests/.output/`. On a Linux machine
without a display, use `xvfb-run -a npm run test:e2e`.

```bash
npm run test:mcp
```

This connects the official MCP client to the app through the `cutroom-mcp` bridge and drives an edit
with tools, the way Claude does.

The speech tests use a stand-in for whisper.cpp (`tests/helpers/fake-whisper.mjs`), so they check
everything around recognition but not recognition itself.

```bash
npm run typecheck
```

## Project layout

```
src/shared/     Project model, timebase, editing operations, animation, captions, export plan, AI tool list (pure TS)
src/main/       Electron main process: windows, menus, dialogs, ffprobe, thumbnails, export, project files,
                analysis (silence/scenes), whisper.cpp, AI control server
src/mcp/        cutroom-mcp: the stdio MCP bridge Claude launches
src/preload/    The small, typed API the UI may call (window.cutroom)
src/renderer/   React UI: panels, timeline, preview engine, export dialog
tests/          unit/, integration/ (real FFmpeg), e2e/ (drives the app), helpers/ (synthetic media)
docs/           ARCHITECTURE.md, AI.md (Smart tools + MCP), STATUS.md (feature checklist + known limitations)
```

## Packaging (.dmg)

On your Mac:

```bash
npm run dist:mac
```

This builds `dist/Cutroom-<version>-arm64.dmg` (Apple Silicon) and `dist/Cutroom-<version>.dmg` (Intel).
Open the `.dmg` and drag Cutroom to Applications.

- The app is **ad-hoc signed, not notarized** (no Apple Developer ID yet). A `.dmg` you built yourself
  opens normally. One downloaded from elsewhere is blocked the first time: right-click the app →
  **Open** → **Open**.
- FFmpeg is **not bundled** (an FFmpeg build with libx264 is GPL, which affects how the app could be
  distributed). Install it with `brew install ffmpeg`; Cutroom finds it in `/opt/homebrew/bin` or
  `/usr/local/bin` even when started from Finder.
- For AI control, the bridge command shown in **AI control** points inside the installed app, so
  re-copy it into Claude's settings after moving or updating the app.

To build it without a Mac: on GitHub, open **Actions → macOS app (.dmg) → Run workflow**. It runs the
tests on macOS, builds both `.dmg`s, checks the packaged app, and attaches them to the run as
`cutroom-macos`.

`npm run dist:dir` builds an unpacked app for the current platform, and `npm run test:packaged`
checks it starts, finds FFmpeg, and that the AI bridge runs from inside the packaged app.
