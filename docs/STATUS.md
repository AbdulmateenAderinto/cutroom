# Status

Legend: ✅ works and has automated tests · ☑️ works, checked by hand or in screenshots only · 🔜 planned (not in the app) · ❌ not planned yet

## First milestone

| Feature | Status | Notes |
|---|---|---|
| Import video, audio and photos via button or drag-and-drop (formats below) | ✅ | Unreadable/unknown files are rejected with a reason |
| Video: MP4/MOV/M4V (H.264, HEVC, AV1, ProRes, DNxHR…), MKV, WebM, AVI, MTS/M2TS/TS, MXF, MPG/VOB, 3GP, DV, WMV, FLV, animated GIF | ✅ | Tested: ProRes .mov, DNxHR .mxf, H.264+Opus .mkv, H.264+AC-3 .mts (1.4 s start offset), MPEG-4 .avi, VP9 .webm, GIF |
| Formats the preview can't play get a preview copy, made once in the background (progress shown); export reads the original | ✅ | Every frame of each preview copy checked against the original; preview vs export compared in the app |
| Audio: MP3, M4A/AAC, WAV, FLAC, AIFF, OGG/Opus, CAF, WMA, AC-3 | ✅ | Tested: AIFF, OGG, WMA |
| Photos: JPEG, PNG, WebP, BMP, TIFF; HEIC/HEIF on macOS | ✅ / ☑️ | TIFF/BMP tested; **HEIC is converted with macOS's `sips` and has not been tested yet** (Linux refuses it with a message) |
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
| Keyboard shortcuts: J/K/L shuttle (2×, 4×, backward), ↑/↓ cuts, Q/W trim to playhead, X select, ⌘C/⌘X/⌘V clips, ⌥←/→ move, S/⌘B/⌘K split, T, I/O, ⇧Z fit, and more | ✅ | One table drives keys, menus and the searchable list (`?`); not active while typing |
| Frame stepping, timeline zoom | ✅ / ☑️ | ←/→, toolbar, ⌘+scroll |
| Canvas: Match source, 16:9, 9:16, 1:1, 4:5, custom | ✅ | Even sizes enforced (H.264 needs them) |
| Per-clip framing: Fit / Fill / Manual (drag + numeric) | ✅ | Preview vs export compared pixel by pixel |
| Background colour for padding and gaps | ✅ | |
| Per-clip volume (0–200%) and mute | ✅ | Boost measured in the export; preview uses Web Audio gain |
| Save / Save As / Open (atomic save, format version) | ✅ | |
| Missing media detection and Relink | ✅ | Also finds media moved together with the project folder |
| Autosave and crash recovery | ☑️ | Logic is tested only through the app; the crash path itself has not been simulated |
| Unsaved-changes prompt on close / new / open | ☑️ | |
| Export MP4 H.264/AAC: resolution, frame rate, target bitrate | ✅ | Verified with ffprobe and decoded frames |
| Constant quality (CRF 12–35) | ✅ | |
| Export a marked range (I / O on the timeline, Alt+X clears) | ✅ | Frame-exact: same frames as the full export |
| Presets: 5 built-in, save your own (stored on this computer), delete | ✅ | Sizes by short edge, so presets keep the canvas shape |
| HEVC (H.265) export tagged `hvc1` (what QuickTime, Photos, iOS and Apple TV need), in .mp4 or .mov | ✅ | Checked with ffprobe: Main, 8-bit 4:2:0, BT.709, AAC-LC, moov before mdat; every frame decoded. **Not yet played on a real iPhone/Apple TV** |
| H.264 in QuickTime .mov (`avc1`) | ✅ | |
| Apple ProRes 422 / 422 HQ in .mov with PCM sound (for Final Cut Pro) | ✅ | 10-bit 4:2:2, `apcn`/`apch`, every frame decoded. **Not yet opened in Final Cut Pro** |
| Apple device presets: H.264 1080p, HEVC 1080p, HEVC 4K, Messages/AirDrop 720p, hardware HEVC, ProRes 422 / HQ | ✅ | |
| Hardware encoding (VideoToolbox) | ☑️ | Offered only after a test encode succeeds. **Not tested on a Mac yet** (Linux: correctly shown as unavailable) |
| Explicit fit/crop when output aspect ≠ canvas | ✅ | Export is blocked until you choose |
| Size estimate, progress, cancel, readable errors | ✅ | |
| Safe export (`.partial` → verify → rename) | ✅ | |

## Animation, Smart tools and AI

| Feature | Status | Notes |
|---|---|---|
| In/out presets: fade, zoom, pop, slide ×4; motion: slow zoom in/out, pan | ✅ | Opacity curve and position measured per exported frame |
| Keyframes: zoom, X/Y, opacity, rotation; easing; on the timeline; follow trims/splits | ✅ | Preview vs export compared at animated frames |
| Rotation: any angle per clip (field, ↺/↻ 90° buttons), plus rotation keyframes; main track and overlays | ✅ | Export geometry checked against the shared maths at 30°, 90°, −135°, a 0→90° keyframed turn (every 5th frame) and a rotated PiP; preview (CSS) vs export 2.1–3.0/255 |
| Remove pauses (silence detection) with review | ✅ | |
| Split at scene changes with review | ✅ | Brightness-based; see limitations |
| Transcribe (whisper.cpp, local) | ☑️ | Pipeline tested with a stand-in; **real recognition not tested here** |
| Speech model download / use own model file | ☑️ | Download path not exercisable in CI (network policy) |
| Filler-word removal | ✅ | Uses the transcript |
| Captions: outline/box/plain, size, position, colour, word highlight, ALL CAPS, text editing | ✅ | Frame-exact in export; preview vs export compared |
| AI control via MCP (Claude Desktop / Claude Code) | ✅ | 54 tools; official MCP client test drives a full edit |

## Music and photos

| Feature | Status | Notes |
|---|---|---|
| Import MP3, M4A/AAC, WAV, FLAC (or a video's sound) onto audio tracks | ✅ | Any number of tracks; clips placed freely, never overlapping on one track |
| Waveforms | ✅ | 100 peaks/s, generated by FFmpeg and cached |
| Move (also between tracks), trim, split, duplicate, delete audio clips; undo | ✅ | Snaps to video cuts, other audio clips and the playhead |
| Clip volume 0–200%, fade in/out (drag the corner squares or type) | ✅ | Levels measured in the export |
| Track volume, mute | ✅ | |
| Ducking: lower a track under speech in the video, by N dB | ✅ | Speech found locally (silence detection); measured in preview and export |
| Audio after the end of the video is shaded and not exported | ✅ | |
| Photos (JPEG, PNG, WebP) as clips: 4 s by default, any length by trimming | ✅ | |
| EXIF rotation, transparent PNG/WebP over the background colour | ✅ | Pixel-checked in export; preview vs export compared |
| Fit/Fill/Manual framing and all animations (Ken Burns etc.) on photos | ✅ | Pan measured per exported frame |

## Titles and text

| Feature | Status | Notes |
|---|---|---|
| Add a title at the playhead (**+ Text** or T); several text rows, freely placed | ✅ | Rows never overlap; higher rows draw on top |
| Styles: Title, Subtitle, Lower third, Quote, Label | ✅ | |
| Font (sans, serif, rounded, condensed, mono), size, weight, italic, colour, ALL CAPS | ✅ | System fonts; see limitations |
| Looks: plain, shadow, outline, box (colour + opacity) | ✅ | |
| Multi-line text, wrapping width, left/centre/right alignment | ✅ | |
| Drag the text in the preview (centre snapping), or type X/Y | ✅ | |
| In/out animations: fade, rise, pop, typewriter | ✅ | Preview vs export matched frame by frame mid-animation |
| Title keyframes: move X/Y, zoom, opacity, rotate (on top of the style and in/out animation); move with the title, kept when trimming/splitting | ✅ | Preview vs export compared while moving and rotating |
| Move, trim, split, duplicate, delete, undo; save/reopen | ✅ | |
| AI tools: `add_title`, `set_title`, `remove_title` | ✅ | |

## Speed

| Feature | Status | Notes |
|---|---|---|
| Constant speed per clip, 0.25×–4× (buttons or typed, two decimals) | ✅ | Clip keeps its footage; timeline length changes (ripple) |
| Every exported frame is the expected source frame (0.25×, 0.5×, 1.5×, 2×) | ✅ | Decoded frame numbers checked one by one |
| Sound keeps its pitch | ✅ | `rubberband` when FFmpeg has it, else `atempo`; see limitations for sync |
| Split, trim, keyframes, captions, ducking and pause removal follow the speed | ✅ | |
| Preview plays at the speed (`playbackRate`, pitch kept) and matches the export | ✅ | |
| AI tool `set_speed` | ✅ | |

## Transitions

| Feature | Status | Notes |
|---|---|---|
| Crossfade, dip to black, dip to white between two clips; 0.1–4 s | ✅ | Centred on the cut; timeline length unchanged |
| Crossfade uses footage past the cut; shortened (with a note) when the files have less | ✅ | The inspector explains when there is none |
| Picture and sound mix per frame exactly as `transitionMix()` says | ✅ | Brightness measured on every exported frame (≤ 4 levels) |
| Preview: the other clip plays in a transition layer; dips fade a colour layer | ✅ | Preview vs export compared through the window |
| Range export through a transition; transitions on both ends of a clip | ✅ | |
| Wipes (left, right, up, down) and slides (left, right, up, down) | ✅ | FFmpeg `xfade`; every 3rd frame of all 8 checked point by point against `transitionLook()` (the preview's maths); preview vs export 2.2–3.3/255 |
| Zoom (crossfade while the outgoing clip zooms in and the incoming one settles) | ✅ | Preview vs export 2.6–3.3/255 |
| Wipes on rotated clips | ✅ | The preview maps the wipe edge back through the rotation (CSS clip-path polygon) |
| AI tool `set_transition` | ✅ | |

## Editing tools

| Feature | Status | Notes |
|---|---|---|
| Markers: **M** or **+ Marker** at the playhead; name, colour, time in the inspector; drag on the ruler; ↑/↓ stop at them; delete, undo | ✅ | One marker per frame; they keep their timeline position when clips change |
| Markers as chapters in the export (MP4 and MOV), shifted for a range export | ✅ | Checked with `ffprobe -show_chapters`; chapters are never copied from source files any more |
| AI tools `add_marker`, `set_marker`, `remove_marker`; `export_video` `chapters` | ✅ | |
| Multi-select on the main track: ⌘/Ctrl-click, Shift-click (range), ⌘A; delete (close/leave gaps), copy/cut/paste, mute all, reset colour | ✅ | Dragging several clips at once is not supported yet; overlays/titles/audio are selected one at a time |
| Detach audio: the clip's sound goes on an audio track at exactly the same time (clip muted), for J- and L-cuts | ✅ | Beeps within 2 ms of where they were before detaching; only at 1× speed |
| AI tool `detach_audio` | ✅ | |
| Speed ramps: ease into / out of slow motion, speed up, slow down (any from → to with `speed_ramp`) | ✅ | **Stepped**: the clip becomes 8 parts at evenly stepped speeds, not a continuous curve. Every exported frame checked; preview vs export compared |
| Freeze frame (**⇧F**): a 2 s still of the exact frame at the playhead, inserted there with the clip's framing and colour; silent | ✅ | Saved as a PNG in “Cutroom Media” next to the project (or the app's data folder until it is saved). Export checked frame by frame (luma within 1.5/255); preview vs export 5.5/255 |
| Reverse a clip (main track or overlay): a reversed copy of its footage is made (H.264 CRF 12) and used; “Play forwards again” or undo returns to the original | ✅ | Every frame in reverse order; sound reversed in step (beeps on the flash frames within 6 ms). Keyframes are dropped; HDR and clips over 10 min are refused; **one generation of re-encoding** |
| Splitting keeps a clip's in-animation on the first part and its out-animation and transition on the last | ✅ | Before, both halves kept them (a crossfade appeared between the halves) |

## Overlay tracks (picture-in-picture)

| Feature | Status | Notes |
|---|---|---|
| Overlay video tracks V2, V3, … (up to 6) above the main track; clips placed freely, never overlapping on one track; higher tracks on top | ✅ | |
| **⧉ PiP** in the Media panel: adds a video or photo at the playhead, 35% size in the bottom-right corner | ✅ | Or drop media onto an overlay row |
| Position presets (corners, centre, full frame); drag and resize in the preview; Fit/Fill/Manual | ✅ | The preview's handles act on the selected overlay; clicking picks the topmost clip under the pointer |
| Move (also between tracks), trim, split, duplicate, delete, copy/paste, ⌥←/→, Q/W; undo | ✅ | Snaps to cuts, titles, audio and other overlays |
| Speed, colour, animation (fades change only the overlay's opacity), keyframes, volume/mute | ✅ | Same code as main-track clips |
| Overlay sound mixed in | ✅ | Measured: on only while the overlay plays |
| Export: right source frame inside the PiP rectangle on every frame; main track around it; range export | ✅ | Coded frame numbers checked frame by frame |
| Preview matches the export | ✅ | Before, during and after the PiP: 2.1–3.2/255 vs 29–44 with/without the PiP |
| AI tools: `add_overlay`, `set_overlay`, `remove_overlay` (clip tools take overlay ids) | ✅ | |
| Overlays never extend the video: past the main track's end they are shaded and not exported | ✅ | Same rule as audio tracks |
| Transitions between overlay clips, blend modes, masks/crop of an overlay | ❌ | Use fade in/out animations |

## Colour

| Feature | Status | Notes |
|---|---|---|
| Per clip: exposure, contrast, saturation, temperature; reset; live sliders (one undo step per drag) | ✅ | |
| Hue and lightness sliders | ✅ | Part of the same colour matrix |
| Curves: master and red/green/blue; click to add, drag, double-click or drag out to remove; presets (S-curve, lift shadows, faded, teal & orange) | ✅ | Monotone cubic, one 256-entry table per channel; the preview (feComponentTransfer) and the export (all 256 points to FFmpeg `curves`) use the same table |
| Export colours match the shared maths (`applyColor`) | ✅ | SD BT.601, HD BT.709 and photo sources, 9 settings incl. hue, lightness and curves: within 4/255 |
| Preview (SVG `feColorMatrix` in sRGB) matches the export | ✅ | 5 slider settings and a curves preset compared: within 3–5/255, same as with no adjustment |
| HDR (PQ/HDR10 and HLG) video tone-mapped to SDR BT.709, on by default (Media → Picture to turn off) | ✅ | zscale + Mobius curve, HDR reference white (203 nits) = SDR white. Preview copy and export use the same chain (within 7/255). **Not tried with real iPhone HLG/Dolby Vision footage yet**; needs an FFmpeg with zscale (Homebrew's has it; checked before export) |
| 3D LUTs (.cube) per media file, before the clip's own colour | ✅ | Copied into the app's LUT folder under a hash name; FFmpeg `lut3d` (tetrahedral) in both the preview copy and the export (within 8/255). A project file can't smuggle anything else into the filter graph (the name is checked) |
| Selective colour (change only the reds…), colour wheels, scopes | ❌ | |
| AI tool `set_color` | ✅ | |

## Packaging

| Feature | Status | Notes |
|---|---|---|
| `npm run dist:mac` → arm64 and Intel `.dmg` (electron-builder, ad-hoc signed) | ☑️ | Configured; **not built yet** — a `.dmg` can only be made on macOS |
| Packaged app layout (code in `app.asar`) starts, finds FFmpeg, AI bridge runs from inside it | ✅ | Tested with the Linux build of the same package (`npm run test:packaged`) |
| GitHub Actions workflow: macOS tests + `.dmg` build + packaged-app test | ☑️ | Manual trigger (or `v*` tag); not run yet |
| Notarization / Developer ID signing, auto-update, bundled FFmpeg | ❌ | Needs an Apple Developer account; FFmpeg licensing decision |

Not planned yet: generative tools, background removal, motion tracking, optical flow,
plugins, blend modes, proxies, other transition shapes (circles, pushes with blur…).

## Verification

**Automated (`npm test`, 197 tests, about 60 s):**
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
- Animation: fade curve within 6/255 per frame; keyframed position/size within 2 px per frame;
  keyframes follow splits; easing and preset maths.
- Smart tools: silence ranges found within 0.1 s; pause removal leaves no pause longer than the kept
  padding; scene cuts found and each shot exported in the right order.
- Speech: audio extraction to 16 kHz mono, whisper.cpp arguments and JSON parsing (punctuation
  merged, `[BLANK_AUDIO]` skipped), captions following trim/split/reorder, filler removal.
- Captions in export: each caption image appears on exactly the right frames, at the right place, in the right colour.
- Overlay tracks: inside the PiP rectangle every frame is the expected source frame while the overlay
  is on the timeline and the main track otherwise; the main track shows around it; a higher track
  covers a lower one; a fade changes only the overlay's opacity (luma within 6/255 of the shared
  curve); its sound plays only while it is on; a range export starting inside it matches.
- Colour: untagged SD/HD, tagged BT.601, tagged PAL and full-range sources export pure green as pure
  green for the Linux preview, and with SD primaries converted as the macOS preview shows them
  (SMPTE-C 63,251,0; EBU 0,255,28), both within 12/255. The size rules for untagged video were
  measured in the macOS app with both decoders (hardware: SD up to 704×576).
- Music: audio clips land at the right time (tone onset within 5 ms), 150% boost and fades measured,
  ducking level during speech and pauses within 4% of the shared envelope.
- Photos: EXIF orientation 6 exported upright, pure red/blue within 16/255 (RGB → BT.709 conversion),
  transparent PNG shows the background, a Ken Burns pan within 2 px of the shared maths every frame.
- Project files: save/load round trip, relative-path recovery, damaged/foreign/newer files rejected,
  a failed save leaves the old file intact.

**Automated UI run (`npm run test:e2e`, 23 steps, real Electron app, Linux + Xvfb):** all milestone
steps: import order, source preview playback, drag-trimming both edges, numeric trim, split,
both delete modes, drag-reordering, undo/redo, duplicate, every canvas preset, Fit/Fill, dragging
the image in the preview, playback across a cut (checks the video element's clock against the
timeline), save, reopen, missing-media relink, three exports (one cancelled), the explicit fit/crop
prompt, and a preview-vs-export pixel comparison of a rotated, manually framed clip on a red
background (mean difference 3.3/255; an unframed control scores 119/255).

**Smart tools / captions UI run (`npm run test:e2e`, second script, 8 steps):** pause review and
removal plus undo, speech setup dialog, transcription via the stand-in, caption editing, filler removal,
caption styling, and preview vs export at two captioned moments.

**Audio UI run (third script, 7 steps):** import MP3, waveform drawn, drag/fade handles and undo,
volume and fade fields, ducking analysis, preview plays the music in sync (within 0.15 s) at the right
gain and ducked under speech, export levels measured.

**Photos UI run (fourth script, 7 steps):** import a rotated JPEG and a transparent PNG, thumbnails,
4 s photo clips, upright fitted preview, playback across a video → photo cut, slow zoom in, and
preview vs export compared for the photo, the zoom and the PNG (mean difference 1.8–7.1/255 vs
19–125 for a different moment).

**Titles UI run (fifth script, 7 steps):** add a title with the button and another with T (second
row), multi-line text, the Lower third style, dragging in the preview plus undo, preview vs export
inside each title's area at a settled frame, mid-“rise” and mid-“pop” (the matching export frame is
clearly closer than frames 2 away), and save/reopen.

**Export options UI run (sixth script, 6 steps):** I/O marks shown on the ruler and toolbar, the
dialog preselects the range, a CRF 24 export of the range has exactly 45 frames starting at source
frame 30, presets apply/save/reload/delete, the hardware encoder is disabled with its reason when it
doesn't work, and Alt+X clears the range.

**Speed UI run (seventh script, 5 steps):** 2× button halves the clip and labels it, the preview
shows source 2 s at timeline 1 s and plays at playbackRate 2, typing 0.5 gives 8 s and undo restores,
and preview vs export at two frames (each closer to its own export frame than to frames 3 away).

**Transitions UI run (eighth script, 7 steps):** trim two clips, add a 1 s crossfade (marker, note,
length unchanged), the preview's transition layer is on top before the cut and underneath after it,
it plays during playback and hides afterwards, preview vs export at five frames through the window
(2–3/255 vs 39–43 for frames 8 away), a dip to black is black at the cut in both, and the "needs
footage" note when there is none.

**Colour UI run (ninth script, 3 steps):** sliders change the clip and attach the preview filter,
undo and Reset, and preview vs export colours for four settings (max difference 3–5/255).

**Shortcuts UI run (tenth script, 8 steps):** every new shortcut pressed in the real app with its
effect checked (cuts, trims, select, move, copy/cut/paste + undo, shuttle rates, title, fit, the
searchable list) and that typing in a text field doesn't trigger them.

**Editing tools UI run (thirteenth script):** markers with M and the button, rename/recolour in the
inspector, dragging on the ruler, ↑/↓ stopping at them, chapters in an export, delete and undo;
⌘-click / Shift-click / ⌘A selection with copy/paste and delete of both clips plus undo; detach audio
and an L-cut (picture trimmed with W while its sound keeps running); a speed ramp (8 parts, the
video element's rate changes during playback, preview vs export at three moments: 2.0–4.4/255 vs
11.7–53 for a frame 45 earlier); a freeze frame with ⇧F and a reversed clip, each compared with the
export (2.3–5.5/255 vs 16–21 for another moment), and “Play forwards again”.

**Motion UI run (fourteenth script, 5 steps):** rotation by field and ↺/↻, a rotation keyframe pair,
a title with position and rotation keyframes, and preview vs export at four moments (2.1–3.0/255 vs
23–53 for a moment with a different angle or position); then a wipe (out of the rotated clip), a
slide and a zoom, each compared at three frames inside the transition (2.2–3.3/255 vs 25–55).

**Overlays UI run (twelfth script, 7 steps):** **⧉ PiP** adds the clip at the playhead on a V2 row
and selects it; dragging and resizing it in the preview and the “Top left” preset (the main clip's
framing untouched); dragging it on the timeline; during playback the overlay video stays within
0.15 s of the timeline; preview vs export before, during and after the PiP (2.1–3.2/255 vs 29–44
for a frame with/without the PiP); delete removes its element from the preview; undo.

**MCP run (`npm run test:mcp`, 12 steps):** security checks (no token, wrong token, browser origin
all refused), tool listing, import, contact sheet and frames, `build_timeline`, editing plus undo/redo,
readable errors for bad input, timeline frame capture, export with polling, analysis tools, speech
and caption tools, and disconnecting when AI control is turned off.

**Checked by looking at screenshots (not asserted):** layout of all panels, the export dialog,
progress/result screens, missing-media state and the gap rendering.

**Not verified yet:**
- Running on macOS / Apple Silicon. All runs so far were on Linux; Electron and FFmpeg are
  cross-platform, but macOS-specific behaviour (menus, dialogs, HEVC hardware decoding,
  Homebrew paths, the window-close prompt) hasn't been exercised. The macOS workflow
  (Actions → "macOS app (.dmg)") runs every automated test on a Mac runner when started.
- The `.dmg` itself, and the VideoToolbox hardware encoder (both need a Mac).
- Playback smoothness with real camera footage (4K, long GOP, high bitrate) and long timelines,
  and with picture-in-picture (two videos decoding at once).
- Real phone footage (VFR, HDR, Dolby Vision, rotation variants), MOV files from cameras, 44.1 kHz or 5.1 audio.
  HDR tone mapping was only tried with a synthetic PQ clip.
- Listening tests for audio quality, and volume levels in the export.
- **Speech recognition quality.** whisper.cpp and its models couldn't be downloaded in this
  environment, so a stand-in replaced it in tests. Verify on a Mac: `brew install whisper-cpp`,
  download a model in the app, and transcribe a real clip.
- Model download from Hugging Face (same reason).
- Using the MCP bridge from the real Claude Desktop / Claude Code apps (it was tested with the official MCP client library).

## Known limitations

- **Inputs:** anything FFmpeg decodes in the listed file types. Formats the preview can't play are shown
  from a preview copy (H.264, at most 1920×1080, frame-exact), made once and cached in the app's data
  folder; the export always reads the original, so quality isn't lost. HEVC plays directly on macOS
  and gets a copy elsewhere. Untagged AVI/MPG/etc. follow the usual rule (SD = BT.601). AVI files with
  MP3 sound written by FFmpeg can start with a repeated frame (the file's own timing; preview and export
  agree). HEIC needs macOS; animated WebP and RAW photos are not supported.
- **Photos** are decoded at full size for every clip in the export; very large photos (e.g. 50 MP)
  make exports slower and use more memory. Wide-gamut (Display P3) photos are treated as sRGB.
- **Variable frame rate:** export conforms to the project frame rate. A frame can occasionally differ
  from the preview. In-points are snapped to the file's nominal (`r_frame_rate`) grid.
- **HDR / colour:** no tone mapping. HDR files are flagged and will look wrong. Sources are
  interpreted like the preview (tag, else SD by size; on macOS SD primaries are converted) and
  exported as BT.709. 10-bit sources are exported as 8-bit. Other matrices and primaries (e.g. BT.2020
  SDR) are passed through unconverted. On macOS:
  - An untagged 704×576 clip is shown with EBU (PAL) primaries but exported as SMPTE-C (a small hue difference).
  - Software-decoded clips (very small, or 4:4:4) follow Chromium's "below 720 lines" rule. For untagged
    clips 706–1279 wide or 578–719 high, the preview then differs from the export.
  - With hardware decoding, SD exports show within ≈10/255 of their source in near-black channels.
- **Rotation:** 0/90/180/270° metadata is handled (verified for 90°). Mirrored display matrices are not.
- **Files with a non-zero video start time** (some edited or camera MOVs) may be offset by that amount in export.
- **Mismatched frame rates** (e.g. 25 fps clip in a 30 fps project): splitting can shift the
  right-hand part by under one source frame (audio moves with it, so sync is kept).
- **Timecode display** is "real seconds + frame number", not SMPTE drop-frame.
- **Timeline:** one video track (plus audio tracks); a video clip's own sound always travels with it.
- **Transitions:** crossfade and dips only. In the preview, a letterboxed (Fit) clip crossfading with a
  clip of another shape mixes slightly differently in the bars than the export (which mixes whole frames).
  How smooth preview playback is at a crossfade's cut (where the clips swap layers) has not been
  measured; a brief stutter there is possible.
- **Audio tracks:** fades are linear; ducking reacts to any sound in the video (not just speech) and
  needs the video's audio analysed once (cached). The export limiter catches peaks above −0.2 dBFS
  when boosted tracks add up.
- **Apple formats:** HEVC and ProRes files were checked against Apple's format requirements with
  ffprobe, not played on Apple hardware yet. With FFmpeg 6.1 the .mov's container vendor field reads
  `FFMP` (the ProRes frame headers say `apl0`); Final Cut Pro and QuickTime don't require it.
  HEVC/ProRes 10-bit HDR output is not offered.
- **Export:** the hardware encoder (VideoToolbox) uses an average bitrate only and needs more bits than
  libx264 for the same quality; it has not been tried on a Mac yet. A range late in a long timeline still
  builds the timeline from the start (clips before the range are not decoded, but their length is
  rendered as background), so it is quick but not instant.
  Each clip opens its own decoder in one FFmpeg process, which is fine for dozens of clips; very
  long timelines (hundreds of clips) may need segment-by-segment rendering.
- **Packaging:** the `.dmg` is ad-hoc signed, not notarized (right-click → Open the first time when
  downloaded). FFmpeg must be installed separately (Homebrew).
- **Animation:** no rotation keyframes yet; position is rounded to whole output pixels per frame
  (sub-pixel drift is not visible at normal speeds). An animated clip is scaled from the full
  frame each output frame; extreme zooms (> 8192 px) are clamped.
- **Scene detection** uses brightness changes: cuts between shots of similar brightness and colour
  can be missed. Lower the sensitivity to find more.
- **Speed and sound:** pitch-preserving time stretch is not sample-exact. Measured beep-vs-flash offsets
  in exports (negative = sound early): with `rubberband` (used when the FFmpeg build has it, as
  Homebrew's does) −51 ms at 0.25×, −30 ms at 0.5×, +8…+15 ms at 2×; with the `atempo` fallback up to
  −118 ms at 0.25×, −44 ms at 0.5×, −15 ms at 2×. Normal-speed clips are unaffected (sample-exact).
  The preview uses Chromium's own time stretch, whose offset has not been measured. Speed ramps
  (changing speed within a clip) are not supported.
- **Colour:** adjustments work on gamma-encoded RGB (like most simple editors), not in linear light, so
  exposure is a gain on the encoded values rather than a physical exposure change. A clip with colour
  adjustments goes through 8-bit RGB in the export (slightly more banding in smooth gradients). No curves,
  LUTs, or per-shot colour matching.
- **Titles:** fonts are the ones installed on the computer (a fallback is used if one is missing), so a
  project can look different on another Mac. Text is drawn at the output resolution, so export is sharp;
  the preview draws at the on-screen size. No per-word styling, rotation or keyframed motion for titles yet.
  Right-to-left and complex scripts are untested.
- **Captions:** one caption track for the whole project; per-word timing comes from whisper.cpp and can be
  off by ~0.1–0.3 s; editing a line's text spreads the new words evenly across its time span.
  Right-to-left and complex scripts are untested.
- **AI control** works with one Cutroom window and one AI client at a time; large transcripts are
  returned whole (very long files may be slow for the AI to read).
