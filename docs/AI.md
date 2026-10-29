# AI features

Cutroom's AI features run in two ways:

- **Smart tools run on your computer:** silence and scene detection (FFmpeg), and speech-to-text
  (whisper.cpp). No account is needed and nothing is uploaded.
- **Claude edits through MCP:** Claude Desktop or Claude Code connects to Cutroom and uses the same
  tools you do. Every AI edit appears live and is one undo step (⌘Z).

## Smart tools (clip panel)

| Tool | What it does | Runs on |
|---|---|---|
| Find pauses → Remove pauses | Detects silence (default: quieter than −35 dB for ≥ 0.6 s) and cuts it out, keeping 0.12 s at each edge | FFmpeg `silencedetect` |
| Find scene changes → Split | Splits a clip at shot changes (sensitivity 0.3) | FFmpeg scene score |
| Transcribe | Speech-to-text with word timestamps, stored with the media file | whisper.cpp |
| Find filler words → Remove | Cuts "um, uh, er, hmm…" using the transcript | transcript |
| Add captions | Burned-in captions built from transcripts; they follow every edit | the app's own renderer |

Detections are shown on the timeline (red = to be removed, yellow = scene cuts) and nothing changes
until you click Apply.

### Setting up speech-to-text (one time)

1. Install the engine:

   ```bash
   brew install whisper-cpp
   ```

2. In Cutroom, select a clip and go to **Smart tools → Set up…**, then download a model. **Base
   (English)** (142 MB) is a good default; multilingual and larger models are listed too. Models
   come from the official whisper.cpp repository on Hugging Face and are stored in Cutroom's
   settings folder. If you already have a `ggml-*.bin` model, choose **Use a model file I already have…**
   instead of downloading.

To use a specific whisper build, set `CUTROOM_WHISPER=/path/to/whisper-cli`.

## AI control with Claude (MCP)

1. In Cutroom, click **AI control** in the top bar and tick **Allow AI assistants to control Cutroom**.
2. Copy the snippet the dialog shows:
   - **Claude Desktop:** go to Settings → Developer → Edit Config, paste the `cutroom` entry inside `mcpServers`, and restart Claude Desktop.
   - **Claude Code:** run the `claude mcp add …` command the dialog shows.
3. Ask Claude things like:
   - "Look at my clips and make a 30-second vertical highlight with fast cuts."
   - "Transcribe interview.mov, remove the silences and filler words, and add boxed captions."
   - "Give every clip a quick fade-in and a slow zoom."
   - "Show me the frame at 12 s. Is the subject centred? Fix the framing."
   - "Export a 1080×1920 MP4 at 8 Mb/s to ~/Desktop/reel.mp4."

The bridge (`build/main/mcp/server.js`) runs on Cutroom's own Electron binary
(`ELECTRON_RUN_AS_NODE=1`), so you don't need Node.js installed. If you move the Cutroom folder,
copy the config again.

### Tools

| Area | Tools |
|---|---|
| Look | `get_project`, `get_frame` (timeline as it will export, or an original file), `get_contact_sheet` |
| Media | `import_media` |
| Edit | `build_timeline` (whole rough cut in one step), `add_clip`, `set_clip_range`, `split_at`, `delete_clip`, `move_clip`, `duplicate_clip`, `set_framing`, `set_clip_audio`, `remove_ranges` |
| Animate | `set_animation` (in/out/motion presets), `set_keyframe`, `remove_keyframes` |
| Analyse | `detect_silence`, `remove_silence`, `detect_scenes`, `split_at_scenes` |
| Speech | `transcribe`, `get_transcript`, `set_captions`, `remove_filler_words` |
| Project | `set_canvas`, `undo`, `redo`, `seek`, `save_project`, `export_video`, `get_export_status` |

All tool definitions live in `src/shared/controlTools.ts`. To add a tool, add its definition there
and implement it in `src/renderer/control/rendererTools.ts` (edits) or in a main-process module
via `registerMainTool` (files and FFmpeg).

### Safety

- AI control is **off by default** and is a per-computer setting.
- The control server only listens on `127.0.0.1`. It requires a random token stored in a file only
  your user can read (`control.json` in Cutroom's settings folder), and it rejects requests from web
  pages (any request with an `Origin` header).
- The AI cannot download speech models (that takes your click). It can't overwrite an existing
  file on export unless it asks with `overwrite: true`, and it can't save a project that has never been saved.
- Frames and transcripts reach Claude only when Claude asks for them in your conversation.
  Smart tools never send anything anywhere.
