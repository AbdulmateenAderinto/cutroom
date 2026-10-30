# Cutroom — pick-up guide

Everything you need to carry on with Cutroom on your own Mac: setup, running it, what was built,
what still needs checking on a Mac, and where to look in the code.

Repository: https://github.com/AbdulmateenAderinto/cutroom (branch `main`)

---

## 1. Set up (once)

You need Homebrew. Then, in Terminal:

```bash
brew install node ffmpeg
```

```bash
git clone https://github.com/AbdulmateenAderinto/cutroom.git ~/cutroom
```

```bash
cd ~/cutroom && npm install
```

Optional, for transcripts and captions:

```bash
brew install whisper-cpp
```

(Then download a speech model inside the app: clip panel → Smart tools → Transcribe.)

## 2. Run it

```bash
cd ~/cutroom && npm run dev
```

`npm run dev` hot-reloads UI changes. Restart it after changing anything in `src/main` or `src/preload`.
To run a normal build instead: `npm start`.

## 3. Make an installable app (.dmg)

```bash
cd ~/cutroom && npm run dist:mac
```

Output: `dist/Cutroom-0.1.0-arm64.dmg` (Apple Silicon) and `dist/Cutroom-0.1.0.dmg` (Intel).
Open it and drag Cutroom to Applications.

- Ad-hoc signed, not notarized. A `.dmg` you built yourself opens normally; one downloaded from
  elsewhere needs right-click → **Open** the first time.
- FFmpeg is not bundled (licensing). Homebrew's FFmpeg is found automatically, even when started from Finder.
- No Mac handy? On GitHub: **Actions → "macOS app (.dmg)" → Run workflow**. It runs all tests on a
  Mac runner, builds both `.dmg` files and attaches them to the run (`cutroom-macos`). Free for this
  public repo; it only runs when started by hand or on a `v*` tag.

## 4. Connect Claude (AI control)

1. In Cutroom: **AI control** (top bar) → tick **Allow AI assistants to control Cutroom**.
2. Copy the snippet it shows:
   - Claude Desktop: Settings → Developer → Edit Config → paste the `cutroom` entry under `mcpServers` → restart.
   - Claude Code: run the `claude mcp add …` command it shows.
3. Ask things like "Remove the silences in interview.mov and add boxed captions" or
   "Make a 30-second vertical cut with a crossfade between each clip".

If you move or reinstall the app, copy the snippet again (the path changes). Details: `docs/AI.md`.

---

## 5. What is in the app

| Area | Features |
|---|---|
| Import | MP4/MOV/MKV/WebM/AVI/MTS/MXF… (H.264, HEVC, ProRes, DNxHR…), GIF; MP3/WAV/AIFF/OGG…; JPEG/PNG/TIFF/HEIC (Mac). Preview copies for formats the preview can't play |
| Editing | Trim, split, delete (close gap / leave gap), reorder, duplicate, undo/redo, snapping, frame stepping, markers (**M**, exported as chapters), multi-select (⌘-click, Shift-click, ⌘A), detach audio for J/L-cuts |
| Framing | Canvas presets (16:9, 9:16, 1:1, 4:5, custom), Fit / Fill / Manual per clip |
| Overlays | Video tracks V2, V3… over the main track: picture-in-picture (**⧉ PiP** in the Media panel), corner presets, drag/resize in the preview |
| Animation | In/out presets, slow zoom/pan, keyframes with easing (incl. rotation); clip rotation; title keyframes |
| Music | Audio tracks, waveforms, fades, volume to 200%, auto-ducking under speech, EQ, noise reduction, loudness normalization (export), voice-over recording |
| Photos | JPEG/PNG/WebP clips, EXIF rotation, transparency, Ken Burns |
| Titles | Text rows, 5 styles, fonts, looks, drag to place, fade/rise/pop/typewriter (key **T**) |
| Speed | 0.25×–4× per clip, pitch kept; stepped speed ramps (ease into/out of slow motion); freeze frame (**⇧F**); reverse |
| Transitions | Crossfade, dip to black/white, wipes, slides, zoom |
| Colour | Exposure, contrast, saturation, temperature, hue, lightness, curves; HDR → SDR tone mapping; .cube LUTs per media file |
| Effects | Blur, masks (ellipse/rectangle, soft edge; circle PiP) |
| Smart tools | Remove pauses, split at scenes, transcribe (whisper.cpp), remove filler words, captions |
| Export | H.264, HEVC (Apple `hvc1`) or ProRes 422/HQ in .mp4/.mov; Apple device presets; size, frame rate, bitrate or CRF; presets; export a marked range (**I** / **O**, Alt+X clears); Apple hardware encoder where available; safe `.partial` → verify → rename |
| AI | 55 MCP tools so Claude can edit, look at frames and export |

Projects save as `.cutroom` files (format version 7; older ones open fine).

## 6. Verify on your Mac (not possible in the cloud session)

Tick these off; anything that fails is worth a GitHub issue or a message to Claude.

- [ ] `npm run dev` opens the window; FFmpeg is found (no red banner).
- [ ] Import a few iPhone clips (HEVC, portrait, **HDR/HLG**: check the tone-mapped picture looks right) and **HEIC photos** (converted with macOS's sips — untested so far).
- [ ] Import a ProRes or camera file (.mov/.mts/.mxf): "Preparing…" then preview; export matches.
- [ ] Playback is smooth with real 4K footage; music stays in sync.
- [ ] Picture-in-picture: two 4K clips at once (main + PiP) still play smoothly; the PiP stays in sync.
- [ ] Export with **Apple hardware — VideoToolbox** in the export dialog (it is only offered if a test encode works).
- [ ] AirDrop an *Apple devices — HEVC* export to an iPhone; open it in Photos. Open a ProRes export in Final Cut Pro.
- [ ] Try the keyboard shortcuts (press **?** for the list), especially J/K/L and ⌘C/⌘V on a Mac keyboard.
- [ ] Speech: `brew install whisper-cpp`, download a model in the app, transcribe a real clip.
- [ ] Record a voice-over (● Record voice-over): macOS asks for the microphone once; check the take lines up with the picture.
- [ ] AI control from the real Claude Desktop / Claude Code.
- [ ] `npm run dist:mac` builds the `.dmg`, and the installed app starts and exports.
- [ ] Run the automated tests on the Mac (section 7).

## 7. Tests

```bash
npm test
```

Unit + real-FFmpeg export tests (~150, about 40 s).

```bash
npm run test:e2e
```

Drives the real app through every feature (10 scripts) and compares the preview with the exported video.

```bash
npm run test:mcp
```

Connects the official MCP client and edits through the AI tools.

```bash
npm run dist:dir && npm run test:packaged
```

Checks a packaged build starts and the AI bridge works from inside it.

Screenshots and exported files from the tests go to `tests/.output/`.

## 8. Known limits (short version — full list in `docs/STATUS.md`)

- Speed changes: sound is time-stretched and lands slightly early/late (≈ −50 ms at 0.25×, −30 ms at 0.5×, +8…15 ms at 2×). Normal speed is exact.
- One video track; no wipes/slides; no curves/LUTs; no rotation keyframes.
- HDR is flagged, not tone-mapped. ProRes, MKV, WebM are rejected.
- `.dmg` not notarized; FFmpeg must come from Homebrew.
- Crossfade playback in the preview: smoothness at the cut has not been measured; a brief stutter is possible.

## 9. Where things live

| Path | What |
|---|---|
| `src/shared/` | The editing model and all maths shared by preview and export: `model.ts`, `ops.ts`, `time.ts`, `exportPlan.ts`, `audio.ts`, `titles.ts`, `transitions.ts`, `color.ts`, `animation.ts`, `captions.ts` |
| `src/main/` | Electron main process: media probing, export runner, project files, MCP control server, whisper |
| `src/renderer/` | React UI and the preview engine (`preview/engine.ts`) |
| `src/mcp/` | The stdio MCP bridge Claude launches |
| `tests/` | `unit/`, `integration/` (real exports), `e2e/` (the real app) |
| `docs/STATUS.md` | Every feature with how it was tested, plus limitations |
| `docs/ARCHITECTURE.md` | How preview and export stay identical, timing model, export pipeline |
| `docs/AI.md` | Smart tools and AI control |

Rule the code follows: anything that affects the picture or sound is computed once in `src/shared/`
and used by both the preview and the export, so they can't drift apart. Keep it that way.

## 10. Continuing with Claude Code locally

```bash
cd ~/cutroom && claude
```

A good first message: *"Read HANDOFF.md and docs/STATUS.md, run `npm test` and `npm run test:e2e`
on this Mac, and fix anything that fails. Then work through the checklist in HANDOFF.md section 6."*

Ideas for what's next: speed ramps, more transition shapes, curves/LUTs, notarized builds, bundled FFmpeg (needs a licensing decision), proxies for 4K editing.
