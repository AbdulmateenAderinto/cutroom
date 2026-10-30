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
- **Speed:** select a clip and pick 0.25×–4× in its **Speed** section (sound keeps its pitch).

**Titles:** text rows with styles (title, lower third, quote…), fonts, box/outline/shadow looks,
  drag-to-position in the preview, and fade/rise/pop/typewriter animations.
- **AI control (MCP):** let Claude Desktop or Claude Code edit with you. See [docs/AI.md](docs/AI.md).

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

1. **Import…** (top of the Media panel) and pick three MP4/MOV files, or drag files onto the panel.
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
   Or pick a **Preset**, switch to **Constant quality (CRF)**, or use Apple's hardware encoder. To export
   part of the timeline, press **I** and **O** at its start and end first.

**Music:** import an MP3/M4A/WAV/FLAC and click **+ Add to timeline**. It goes on an audio track at
the playhead. Drag it to move, drag its edges to trim, and drag the small squares at its top corners to
fade. Click the track name for track volume, mute and **Lower under speech** (ducking).

**Photos:** import JPEG/PNG/WebP files and add them like videos. Each becomes a 4-second clip; drag its
end to change that. Try **Motion → Slow zoom in** in its Animation section.

**Titles:** click **+ Text** above the timeline (or press T). Type in the **Text** box, pick a style,
and drag the text in the preview to place it. Drag its block on the timeline to change when it shows.

More, with a clip selected: the **Animation** section (presets and keyframes) and **Smart tools**
(pauses, scenes, transcription, filler words, captions). Caption style is in **Project settings**
(deselect with Esc).

Every action has a button or menu item. Keyboard shortcuts are a convenience; see **Shortcuts** in the top bar.

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

## Packaging

There is no `.app`/`.dmg` build yet; it's planned (electron-builder, with an arm64 or universal
build). Until then, run Cutroom with `npm run dev` or `npm start`. Bundling FFmpeg inside the app raises
licensing questions (an FFmpeg build that includes libx264 is GPL), which need to be settled at that point.
