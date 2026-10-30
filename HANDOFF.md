# Cutroom — pick-up guide

Everything you need to carry on with Cutroom on your own Mac: setup, running it, what was built,
what still needs checking on a Mac, and where to look in the code.

Repository: https://github.com/AbdulmateenAderinto/cutroom (branch `main`)

**Status at hand-off (30 Oct 2026):** Phases 1–4 of the feature plan are built, tested and pushed.

- **On your Mac (arm64, Homebrew `ffmpeg-full`), 30 Oct:** 270/270 unit + real-FFmpeg tests, all 16
  end-to-end suites (the real app, preview compared with export), the MCP test and the packaged-app
  test (`npm run dist:dir`) pass — after the FFmpeg 9 fixes in commit `6212064`.
- **In the cloud (Linux):** the same, plus the 4 MCP steps added afterwards (versions, export queue,
  proxy mode, media manager; MCP 22/22). Re-run `npm run test:mcp` on the Mac to cover those.
- **Still to check by hand on the Mac** (section 6): real footage and devices, the hardware encoder,
  the `.dmg`, the microphone. Phase 5 (notarized release, bundled FFmpeg) is waiting on you (section 11).

---

## 1. Set up (once)

You need Homebrew. Then, in Terminal:

```bash
brew install node ffmpeg-full
```

(`ffmpeg-full` rather than `ffmpeg`: Homebrew's plain `ffmpeg` has no zscale, vid.stab or rubberband,
so HDR tone mapping would be refused and stabilizing/speed would use the weaker fallbacks.)

```bash
git clone https://github.com/AbdulmateenAderinto/cutroom.git ~/cutroom
```

```bash
cd ~/cutroom && npm install
```

Already have a clone from earlier? Update it instead:

```bash
cd ~/cutroom && git pull origin main && npm install
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
| Effects | Blur, masks (ellipse/rectangle, soft edge; circle PiP), chroma key (green screen), stabilization |
| Smart tools | Remove pauses, split at scenes, transcribe (whisper.cpp), remove filler words, captions |
| Export | H.264, HEVC (Apple `hvc1`) or ProRes 422/HQ in .mp4/.mov; Apple device presets; size, frame rate, bitrate or CRF; presets; export a marked range (**I** / **O**, Alt+X clears); Apple hardware encoder where available; safe `.partial` → verify → rename |
| Project & media | Versions (named snapshots, restore with undo), media manager (uses, remove unused, relink a whole folder, collect files), proxy mode for smooth 4K preview |
| Export queue | Queue several exports and keep editing; optional parallel parts (same frames as one pass) |
| AI | 68 MCP tools so Claude can edit, look at frames, save and restore versions, queue exports, switch proxy mode and manage media (relink, collect, remove unused) |

Projects save as `.cutroom` files (format version 7; older ones open fine).

## 6. Verify on your Mac (not possible in the cloud session)

The automated tests already pass on your Mac (last item). The rest needs real footage, devices or
hardware. Tick these off; anything that fails is worth a GitHub issue or a message to Claude.

- [ ] `npm run dev` opens the window; FFmpeg is found (no red banner).
- [ ] Import a few iPhone clips (HEVC, portrait, **HDR/HLG**: check the tone-mapped picture looks right) and **HEIC photos** (converted with macOS's sips — untested so far).
- [ ] Import a ProRes or camera file (.mov/.mts/.mxf): "Preparing…" then preview; export matches.
- [ ] Playback is smooth with real 4K footage; music stays in sync. Then turn on **Proxy** and compare.
- [ ] Queue two exports with “Render in parallel parts” on and off: is parallel faster on your Mac?
- [ ] Picture-in-picture: two 4K clips at once (main + PiP) still play smoothly; the PiP stays in sync.
- [ ] Export with **Apple hardware — VideoToolbox** in the export dialog (it is only offered if a test encode works).
- [ ] AirDrop an *Apple devices — HEVC* export to an iPhone; open it in Photos. Open a ProRes export in Final Cut Pro.
- [ ] Try the keyboard shortcuts (press **?** for the list), especially J/K/L and ⌘C/⌘V on a Mac keyboard.
- [ ] Speech: `brew install whisper-cpp`, download a model in the app, transcribe a real clip.
- [ ] Record a voice-over (● Record voice-over): macOS asks for the microphone once; check the take lines up with the picture.
- [ ] AI control from the real Claude Desktop / Claude Code.
- [ ] `npm run dist:mac` builds the `.dmg`, and the installed app starts and exports.
- [ ] Colour: load a real `.cube` LUT from a grading pack; check the preview and the export look the same.
- [ ] Noise reduction on a real noisy voice recording (use **Listen**); stabilize a real handheld clip.
- [ ] Move a project's media to another drive, reopen, and use **Manage… → Relink missing from a folder**.
- [ ] Save a version, change things, restore it, undo.
- [x] Run the automated tests on the Mac (section 7). **Passed 30 Oct** with `ffmpeg-full`: 270/270, 16/16 e2e, MCP, packaged. Re-run `npm run test:mcp` for the 4 newer MCP steps.

## 7. Tests

```bash
npm test
```

Unit + real-FFmpeg export tests (~270, about 2 minutes).

```bash
npm run test:e2e
```

Drives the real app through every feature (16 scripts, about 15 minutes) and compares the preview with the exported video.

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
- HDR tone mapping, LUTs, noise reduction, voice-over and the hardware encoder have not been tried with real Mac footage/hardware.
- Noise reduction is export-only (use “Listen” to hear it). Speed ramps are stepped.
- The export queue lives in the window: closing the app stops it. Parallel export has not been benchmarked.
- `.dmg` not notarized; FFmpeg must come from Homebrew. Phase 5 (notarized release, bundled FFmpeg) is waiting on your Apple Developer account and an FFmpeg licensing decision.
- Crossfade playback in the preview: smoothness at the cut has not been measured; a brief stutter is possible.

## 9. Where things live

| Path | What |
|---|---|
| `src/shared/` | The editing model and all maths shared by preview and export: `model.ts`, `ops.ts`, `time.ts`, `exportPlan.ts`, `audio.ts`, `audioFx.ts`, `titles.ts`, `transitions.ts`, `color.ts`, `effects.ts`, `animation.ts`, `overlays.ts`, `markers.ts`, `captions.ts` |
| `src/main/` | Electron main process: media probing, preview copies (`media/proxy.ts`), freeze/reverse/stabilize (`media/derived.ts`), LUTs, relink/collect (`media/manage.ts`), export runner (incl. parallel parts), project files and versions, MCP control server, whisper |
| `src/renderer/` | React UI, the preview engine (`preview/engine.ts`), state and actions (`state/`), export queue (`state/exportQueue.ts`) |
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

A good first message: *"Read HANDOFF.md and docs/STATUS.md, run `npm run test:mcp` on this Mac
(the newest MCP steps haven't run here yet) and fix anything that fails. Then help me work through
the checklist in HANDOFF.md section 6."*

## 11. What's next

**Phase 5 — needs your input before it can start:**

- **Notarized release:** needs an Apple Developer account (paid) for a Developer ID certificate and
  notarization, so downloaded copies open without the right-click → Open step.
- **Bundled FFmpeg:** shipping FFmpeg inside the app means choosing a build and licence. An LGPL build
  can be bundled more freely but lacks libx264/libx265 (H.264/HEVC would then use Apple's hardware
  encoder only); a GPL build keeps them but makes the whole app GPL. Decide which you want.

**Other ideas:** smooth (curve) speed ramps; a queue that
survives quitting; transitions on overlay tracks; per-shot colour matching; real-time noise reduction
in the preview.
