# Cutroom

A lightweight desktop video editor for people who find Premiere too much: import clips, trim and
arrange them on one timeline, reframe for landscape/portrait/square, and export an MP4 with exact
control over resolution, frame rate and bitrate. Everything runs locally, with no accounts or uploads.

Status: **first milestone**. The import → edit → save → export workflow works and is tested.
See [docs/STATUS.md](docs/STATUS.md) for what works, what's planned and the known limitations.

## Requirements (macOS)

- macOS 12+ (Apple Silicon or Intel)
- [Node.js](https://nodejs.org) 20 or newer (22 LTS recommended): `brew install node`
- FFmpeg with libx264 (used for inspecting media, thumbnails and export): `brew install ffmpeg`

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

This launches the real app and clicks through the whole workflow (native file dialogs are stubbed).
Screenshots go to `tests/.output/e2e/`. On a Linux machine without a display, use `xvfb-run -a npm run test:e2e`.

```bash
npm run typecheck
```

## Project layout

```
src/shared/     Project model, timebase, editing operations, export plan (pure TypeScript, no I/O)
src/main/       Electron main process: windows, menus, dialogs, ffprobe, thumbnails, export, project files
src/preload/    The small, typed API the UI may call (window.cutroom)
src/renderer/   React UI: panels, timeline, preview engine, export dialog
tests/          unit/, integration/ (real FFmpeg), e2e/ (drives the app), helpers/ (synthetic media)
docs/           ARCHITECTURE.md, STATUS.md (feature checklist + known limitations)
```

## Packaging

There is no `.app`/`.dmg` build yet; it's planned (electron-builder, with an arm64 or universal
build). Until then, run Cutroom with `npm run dev` or `npm start`. Bundling FFmpeg inside the app raises
licensing questions (an FFmpeg build that includes libx264 is GPL), which need to be settled at that point.
