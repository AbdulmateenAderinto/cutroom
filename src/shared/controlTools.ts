/**
 * Tools exposed to AI assistants (via the MCP bridge in src/mcp/server.ts).
 *
 * Conventions for the AI: times are in SECONDS (decimals allowed; snapped to frames), positions
 * are 0-based timeline indexes, and ids come from get_project. Every editing tool is one undo
 * step in the app, so the person can always undo an AI edit with ⌘Z.
 *
 * `runs` says where a tool executes: 'renderer' (edits the live project in the window) or
 * 'main' (file access, FFmpeg, export).
 */

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
  runs: 'renderer' | 'main';
}

const num = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'number', description, ...extra });
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const bool = (description: string) => ({ type: 'boolean', description });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object' as const, properties, required, additionalProperties: false });

const titleProps = {
  text: str('the text; \\n for a new line'),
  start: num('timeline seconds'),
  duration: num('seconds'),
  row: num('text row, 0 = lowest; higher rows draw on top'),
  font: str('font family', { enum: ['sans', 'serif', 'rounded', 'condensed', 'mono'] }),
  size: num('text height in % of the canvas height (e.g. 9 = big title, 4 = lower third)'),
  weight: num('400, 600, 700, 800 or 900'),
  italic: bool('italic'),
  color: str('#rrggbb'),
  look: str('plain, shadow, outline, or box (text on a coloured box)', { enum: ['plain', 'shadow', 'outline', 'box'] }),
  box_color: str('#rrggbb, for look=box'),
  box_opacity: num('0..1, for look=box'),
  uppercase: bool('ALL CAPS'),
  align: str('text alignment; also what x anchors', { enum: ['left', 'center', 'right'] }),
  x: num('0..1 across the canvas: left edge / centre / right edge of the text, per align'),
  y: num('0..1 down the canvas: vertical centre of the text'),
  max_width: num('0.1..1 of the canvas width; longer lines wrap'),
  anim_in: str('entrance animation', { enum: ['none', 'fade', 'rise', 'pop', 'typewriter'] }),
  anim_out: str('exit animation', { enum: ['none', 'fade', 'rise', 'pop', 'typewriter'] }),
  anim_length: num('seconds for each animation (default 0.4)'),
};

const IN_PRESETS = ['fade', 'zoom', 'pop', 'slideLeft', 'slideRight', 'slideUp', 'slideDown'];
const MOTION_PRESETS = ['kenBurnsIn', 'kenBurnsOut', 'panLeft', 'panRight'];
const EASINGS = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'hold'];

const framingSchema = obj({
  mode: str('fit = whole image visible (padded), fill = cover canvas (cropped), manual = use scale/x/y', { enum: ['fit', 'fill', 'manual'] }),
  scale: num('manual only: size relative to Fit (1 = same as fit)'),
  x: num('manual only: horizontal offset of the image centre as a fraction of canvas width (-0.5..0.5 keeps it mostly on screen)'),
  y: num('manual only: vertical offset as a fraction of canvas height'),
}, ['mode']);

const presetSchema = (list: string[]) => ({
  anyOf: [{ type: 'null' }, obj({ preset: str('preset name', { enum: list }), duration: num('seconds', { minimum: 0.05, maximum: 10 }) }, ['preset'])],
});

export const CONTROL_TOOLS: ToolDef[] = [
  // ---- Inspect ----
  {
    name: 'get_project',
    runs: 'renderer',
    description:
      'Return the open project: canvas, frame rate, media files (ids, durations, sizes, whether a transcript exists) and the timeline (clip ids, order, timeline start/end, source in/out, framing, animation, audio). Call this first and after edits.',
    inputSchema: obj({}),
  },
  {
    name: 'get_frame',
    runs: 'main',
    description:
      'Look at a picture. With `time`: the timeline preview at that time (exactly what the export will show, including framing, animation, titles and captions). With `media_id` and `source_time`: a frame of an original media file. Returns a JPEG image.',
    inputSchema: obj({ time: num('timeline time in seconds'), media_id: str('media id'), source_time: num('time inside the media file, seconds') }),
  },
  {
    name: 'get_contact_sheet',
    runs: 'main',
    description: 'Overview of a media file: a grid of evenly spaced frames with their timestamps. Use it to understand footage quickly before choosing in/out points.',
    inputSchema: obj({ media_id: str('media id'), count: num('number of frames (4–24, default 12)') }, ['media_id']),
  },

  // ---- Media ----
  {
    name: 'import_media',
    runs: 'main',
    description: 'Import files into the Media panel (absolute paths): video (MP4, MOV, MKV, WebM, AVI, MTS, MXF, … incl. ProRes and HEVC), audio for music tracks (MP3, M4A, WAV, FLAC, AIFF, OGG, …) and photos (JPEG, PNG, WebP, TIFF, HEIC on macOS). Formats the preview can\'t play get a preview copy in the background; exports use the originals. Files are referenced, never modified.',
    inputSchema: obj({ paths: { type: 'array', items: { type: 'string' }, description: 'absolute file paths' } }, ['paths']),
  },

  // ---- Timeline editing ----
  {
    name: 'add_clip',
    runs: 'renderer',
    description: 'Add a video or photo to the timeline (whole file, or source_in..source_out). Inserted at `position` (0-based) or at the end. A photo becomes a 4 s clip unless source_out is given. Use add_audio for music.',
    inputSchema: obj({ media_id: str('media id'), source_in: num('seconds into the file'), source_out: num('seconds into the file (exclusive)'), position: num('timeline index') }, ['media_id']),
  },
  {
    name: 'build_timeline',
    runs: 'renderer',
    description:
      'Replace the whole timeline with this list of clips in order, as ONE undoable edit. Best tool for rough cuts and highlight reels: pick ranges (e.g. from the transcript), then build them in one call.',
    inputSchema: obj({
      clips: {
        type: 'array',
        items: obj({
          media_id: str('media id'),
          source_in: num('seconds into the file'),
          source_out: num('seconds into the file (exclusive)'),
          framing: framingSchema,
          in_animation: presetSchema(IN_PRESETS),
          out_animation: presetSchema(IN_PRESETS),
          volume: num('0..1'),
        }, ['media_id', 'source_in', 'source_out']),
      },
    }, ['clips']),
  },
  {
    name: 'set_clip_range',
    runs: 'renderer',
    description: 'Trim a clip: set its in and/or out point in source seconds. Later clips move to follow (ripple).',
    inputSchema: obj({ clip_id: str('clip id'), source_in: num('seconds'), source_out: num('seconds') }, ['clip_id']),
  },
  {
    name: 'split_at',
    runs: 'renderer',
    description: 'Split the clip under a timeline time into two clips.',
    inputSchema: obj({ time: num('timeline seconds') }, ['time']),
  },
  {
    name: 'delete_clip',
    runs: 'renderer',
    description: 'Delete a clip. By default the gap closes; leave_gap=true keeps the space as a gap (black + silence).',
    inputSchema: obj({ clip_id: str('clip or gap id'), leave_gap: bool('keep the empty space') }, ['clip_id']),
  },
  {
    name: 'move_clip',
    runs: 'renderer',
    description: 'Move a clip so it sits before the item currently at `position` (use the number of items to move it to the end).',
    inputSchema: obj({ clip_id: str('clip id'), position: num('target timeline index') }, ['clip_id', 'position']),
  },
  {
    name: 'duplicate_clip',
    runs: 'renderer',
    description: 'Duplicate a clip (the copy is placed right after it).',
    inputSchema: obj({ clip_id: str('clip id') }, ['clip_id']),
  },
  {
    name: 'set_framing',
    runs: 'renderer',
    description: 'Set how a clip sits on the canvas: fit, fill or manual (scale, x, y).',
    inputSchema: obj({ clip_id: str('clip id'), framing: framingSchema }, ['clip_id', 'framing']),
  },
  {
    name: 'set_clip_audio',
    runs: 'renderer',
    description: 'Set a clip\'s volume (0..2, 1 = original) and/or mute it.',
    inputSchema: obj({ clip_id: str('clip id'), volume: num('0..2'), muted: bool('mute') }, ['clip_id']),
  },
  {
    name: 'set_color',
    runs: 'renderer',
    description: 'Adjust a clip\'s colour: exposure (stops, -2..2), contrast (0..2, 1 = unchanged), saturation (0..2, 0 = black and white), temperature (-1 cooler .. 1 warmer). Only the given values change; all neutral = no adjustment. Check with get_frame.',
    inputSchema: obj({
      clip_id: str('clip id'), exposure: num('-2..2'), contrast: num('0..2'), saturation: num('0..2'), temperature: num('-1..1'), reset: bool('back to neutral first'),
    }, ['clip_id']),
  },
  {
    name: 'set_transition',
    runs: 'renderer',
    description: 'Set the transition from a clip into the NEXT clip: crossfade (both pictures and sounds mix; needs footage past the cut, so trim the clips a little first), dipBlack / dipWhite (fade through a colour), or none (a hard cut). Centred on the cut; the timeline length does not change. Returns the length actually used and why it is shorter, if it is.',
    inputSchema: obj({
      clip_id: str('the clip BEFORE the cut'),
      kind: str('transition', { enum: ['none', 'crossfade', 'dipBlack', 'dipWhite'] }),
      duration: num('seconds, 0.1..4 (default 0.5)'),
    }, ['clip_id', 'kind']),
  },
  {
    name: 'set_speed',
    runs: 'renderer',
    description: 'Play a video clip faster or slower (0.25 = quarter speed slow motion … 4 = four times faster). The clip keeps the same footage, so it gets shorter or longer on the timeline and later clips move. Sound keeps its pitch. Not for photos (change their duration instead).',
    inputSchema: obj({ clip_id: str('clip id'), speed: num('0.25..4 (1 = normal); two decimals') }, ['clip_id', 'speed']),
  },

  // ---- Animation ----
  {
    name: 'set_animation',
    runs: 'renderer',
    description:
      `Set preset animations on a clip. in/out: {preset, duration}; presets: ${IN_PRESETS.join(', ')}. motion (whole clip): {preset, amount 0..1}; presets: ${MOTION_PRESETS.join(', ')}. Pass null to remove one; omit to keep it.`,
    inputSchema: obj({
      clip_id: str('clip id'),
      in: presetSchema(IN_PRESETS),
      out: presetSchema(IN_PRESETS),
      motion: { anyOf: [{ type: 'null' }, obj({ preset: str('preset', { enum: MOTION_PRESETS }), amount: num('0..1, default 0.5') }, ['preset'])] },
    }, ['clip_id']),
  },
  {
    name: 'set_keyframe',
    runs: 'renderer',
    description:
      'Add or update a keyframe on a clip at a TIMELINE time. property: scale (1 = as framed), x / y (offset as a fraction of canvas width/height), opacity (0..1). Values between keyframes are interpolated with the easing of the earlier keyframe. Keyframes stay attached to the footage when the clip is trimmed.',
    inputSchema: obj({
      clip_id: str('clip id'),
      property: str('animated property', { enum: ['scale', 'x', 'y', 'opacity'] }),
      time: num('timeline seconds (must be within the clip)'),
      value: num('value'),
      easing: str('easing to the next keyframe', { enum: EASINGS }),
    }, ['clip_id', 'property', 'time', 'value']),
  },
  {
    name: 'remove_keyframes',
    runs: 'renderer',
    description: 'Remove keyframes from a clip: one at `time`, or all of a property (omit time), or all (omit property and time).',
    inputSchema: obj({ clip_id: str('clip id'), property: str('property', { enum: ['scale', 'x', 'y', 'opacity'] }), time: num('timeline seconds') }, ['clip_id']),
  },

  // ---- Titles / text ----
  {
    name: 'add_title',
    runs: 'renderer',
    description: 'Add a title / text overlay at a TIMELINE time (default: 3 s long, on the lowest free text row). Start from a style preset (title, subtitle, lowerThird, quote, label) and override any style field. Titles are drawn over the picture, under captions; they keep their timeline position when video clips are edited. Check the result with get_frame.',
    inputSchema: obj({ preset: str('style preset', { enum: ['title', 'subtitle', 'lowerThird', 'quote', 'label'] }), ...titleProps }, ['text']),
  },
  {
    name: 'set_title',
    runs: 'renderer',
    description: 'Change a title: text, timing (start, duration, row), style or animation. Only the given fields change.',
    inputSchema: obj({ title_id: str('title id'), ...titleProps }, ['title_id']),
  },
  {
    name: 'remove_title',
    runs: 'renderer',
    description: 'Delete a title.',
    inputSchema: obj({ title_id: str('title id') }, ['title_id']),
  },
  // ---- Overlay tracks (picture-in-picture) ----
  {
    name: 'add_overlay',
    runs: 'renderer',
    description: 'Put a video or photo on an overlay track (V2, V3, …) over the main track at a TIMELINE time: picture-in-picture, a logo, a cutaway. By default it is 35% of its Fit size in the bottom-right corner, on the lowest free track (overlays never overlap on a track; higher tracks draw on top). Its sound is mixed in. Overlays keep their timeline position when main-track clips are edited; nothing past the end of the main track is exported. The clip tools (set_framing, set_color, set_speed, set_animation, set_keyframe, set_clip_audio) also work with an overlay id. Check with get_frame.',
    inputSchema: obj({
      media_id: str('media id (video or photo)'),
      start: num('timeline seconds (default: the playhead)'),
      row: num('overlay track: 0 = V2, 1 = V3, … (default: lowest free)'),
      position: str('where to put it', { enum: ['topLeft', 'topRight', 'bottomLeft', 'bottomRight', 'center', 'full'] }),
      size: num('fraction of the Fit size, e.g. 0.35 (ignored for full)'),
      source_in: num('seconds into the file'),
      source_out: num('seconds into the file'),
    }, ['media_id']),
  },
  {
    name: 'set_overlay',
    runs: 'renderer',
    description: 'Change an overlay clip: move it (start, row), place it (position, size), or trim it (source_in/source_out in file seconds). Only the given fields change.',
    inputSchema: obj({
      overlay_id: str('overlay id'), start: num('timeline seconds'), row: num('overlay track (0 = V2)'),
      position: str('where to put it', { enum: ['topLeft', 'topRight', 'bottomLeft', 'bottomRight', 'center', 'full'] }), size: num('fraction of the Fit size'),
      source_in: num('file seconds'), source_out: num('file seconds'),
    }, ['overlay_id']),
  },
  {
    name: 'remove_overlay',
    runs: 'renderer',
    description: 'Delete an overlay clip.',
    inputSchema: obj({ overlay_id: str('overlay id') }, ['overlay_id']),
  },
  {
    name: 'detach_audio',
    runs: 'renderer',
    description: 'Move a video clip\'s sound (main track or overlay) to an audio track at exactly the same time, and mute the clip. Then trim/move the audio clip with set_audio_clip for a J-cut (sound starts before the picture) or L-cut (sound continues after it). Clip must be at 1× speed.',
    inputSchema: obj({ clip_id: str('clip id') }, ['clip_id']),
  },
  // ---- Markers ----
  {
    name: 'add_marker',
    runs: 'renderer',
    description: 'Add a named marker at a TIMELINE time (snapped to a frame). Markers stay put when clips are edited and become chapters in the export. Colours: yellow, red, green, blue, purple.',
    inputSchema: obj({ time: num('timeline seconds'), label: str('name'), color: str('colour', { enum: ['yellow', 'red', 'green', 'blue', 'purple'] }) }, ['time']),
  },
  {
    name: 'set_marker',
    runs: 'renderer',
    description: 'Rename, recolour or move a marker.',
    inputSchema: obj({ marker_id: str('marker id'), time: num('timeline seconds'), label: str('name'), color: str('colour', { enum: ['yellow', 'red', 'green', 'blue', 'purple'] }) }, ['marker_id']),
  },
  {
    name: 'remove_marker',
    runs: 'renderer',
    description: 'Delete a marker.',
    inputSchema: obj({ marker_id: str('marker id') }, ['marker_id']),
  },
  // ---- Audio tracks (music, voice-over) ----
  {
    name: 'add_audio',
    runs: 'renderer',
    description: 'Put an audio file (music/voice-over; or a video\'s sound) on an audio track at a TIMELINE time. Creates a track if needed. Clips never overlap on a track: it moves to the next free spot. Audio past the end of the video is not exported.',
    inputSchema: obj({
      media_id: str('media id'),
      start: num('timeline seconds (default 0)'),
      track_id: str('audio track id (default: first track; a new one if none)'),
      source_in: num('seconds into the file'),
      source_out: num('seconds into the file'),
      volume: num('0..2 (1 = original)'),
      fade_in: num('seconds'),
      fade_out: num('seconds'),
    }, ['media_id']),
  },
  {
    name: 'set_audio_clip',
    runs: 'renderer',
    description: 'Change an audio-track clip: move it (start, track_id), trim it (source_in/source_out in file seconds), volume (0..2), fades (seconds).',
    inputSchema: obj({
      clip_id: str('audio clip id'), start: num('timeline seconds'), track_id: str('move to this track'),
      source_in: num('file seconds'), source_out: num('file seconds'), volume: num('0..2'), fade_in: num('seconds'), fade_out: num('seconds'),
    }, ['clip_id']),
  },
  {
    name: 'remove_audio_clip',
    runs: 'renderer',
    description: 'Delete a clip from an audio track.',
    inputSchema: obj({ clip_id: str('audio clip id') }, ['clip_id']),
  },
  {
    name: 'set_audio_track',
    runs: 'main',
    description: 'Audio track settings: name, volume (0..2), muted, and duck (automatically lower the track while the video has speech; duck_db how much, default -14).',
    inputSchema: obj({ track_id: str('audio track id'), name: str('name'), volume: num('0..2'), muted: bool('mute'), duck: bool('lower under speech'), duck_db: num('-40..-1 dB') }, ['track_id']),
  },

  // ---- Analysis (local FFmpeg, nothing uploaded) ----
  {
    name: 'detect_silence',
    runs: 'main',
    description: 'Find pauses in a media file\'s audio. Returns silent ranges in SOURCE seconds. Defaults: quieter than -35 dB for at least 0.6 s.',
    inputSchema: obj({ media_id: str('media id'), threshold_db: num('silence level in dB, e.g. -35 (higher = more aggressive)'), min_duration: num('shortest pause to report, seconds') }, ['media_id']),
  },
  {
    name: 'remove_silence',
    runs: 'main',
    description: 'Cut the pauses out of one clip (clip_id) or every clip, as ONE undoable edit. Keeps `padding` seconds (default 0.12) at each side so words are not clipped.',
    inputSchema: obj({ clip_id: str('clip id (omit for all clips)'), threshold_db: num('dB, default -35'), min_duration: num('seconds, default 0.6'), padding: num('seconds kept at each edge, default 0.12') }),
  },
  {
    name: 'detect_scenes',
    runs: 'main',
    description: 'Find shot changes (cuts) in a media file. Returns SOURCE seconds. threshold 0.1–0.6 (default 0.3; lower finds more).',
    inputSchema: obj({ media_id: str('media id'), threshold: num('scene-change sensitivity') }, ['media_id']),
  },
  {
    name: 'split_at_scenes',
    runs: 'main',
    description: 'Split a clip at every detected shot change (one undoable edit).',
    inputSchema: obj({ clip_id: str('clip id'), threshold: num('scene-change sensitivity, default 0.3') }, ['clip_id']),
  },
  {
    name: 'remove_ranges',
    runs: 'renderer',
    description: 'Cut arbitrary SOURCE-time ranges out of a clip (e.g. off-topic sentences found in the transcript). The rest of the clip is kept in order. One undoable edit.',
    inputSchema: obj({
      clip_id: str('clip id'),
      ranges: { type: 'array', items: obj({ start: num('source seconds'), end: num('source seconds') }, ['start', 'end']) },
      padding: num('seconds kept at each edge (default 0)'),
    }, ['clip_id', 'ranges']),
  },

  // ---- Speech (local whisper.cpp) ----
  {
    name: 'transcribe',
    runs: 'main',
    description: 'Transcribe a media file\'s speech locally (word timestamps). Waits up to 90 s; if still running, call again with the same media_id. Requires the person to have set up a speech model once.',
    inputSchema: obj({ media_id: str('media id'), redo: bool('transcribe again even if a transcript exists') }, ['media_id']),
  },
  {
    name: 'get_transcript',
    runs: 'renderer',
    description: 'Read a media file\'s transcript as sentences with SOURCE start/end seconds (use them with add_clip / build_timeline / remove_ranges). words=true also returns every word with times.',
    inputSchema: obj({ media_id: str('media id'), words: bool('include word-level timing') }, ['media_id']),
  },
  {
    name: 'set_captions',
    runs: 'renderer',
    description: 'Turn burned-in captions on/off and style them. Captions come from transcripts and follow all edits. look: outline | box | plain; font_size: % of canvas height (default 4.8); position: 0 top … 1 bottom (default 0.78); highlight: colour for the word being spoken, or null.',
    inputSchema: obj({
      enabled: bool('show captions'),
      look: str('style', { enum: ['outline', 'box', 'plain'] }),
      font_size: num('percent of canvas height'),
      position: num('0..1 vertical position'),
      color: str('#rrggbb text colour'),
      highlight: { anyOf: [{ type: 'null' }, { type: 'string' }], description: '#rrggbb or null' },
      uppercase: bool('ALL CAPS'),
    }),
  },
  {
    name: 'remove_filler_words',
    runs: 'renderer',
    description: 'Cut filler words (um, uh, er, hmm…) found in the transcripts out of one clip or all clips, as ONE undoable edit.',
    inputSchema: obj({ clip_id: str('clip id (omit for all clips)') }),
  },

  // ---- Project ----
  {
    name: 'set_canvas',
    runs: 'renderer',
    description: 'Change the canvas: preset (16:9, 9:16, 1:1, 4:5, match) or width+height; frame_rate (e.g. 30, 29.97, 25, 24, 60); background colour (#rrggbb). Clip framing is kept.',
    inputSchema: obj({
      preset: str('canvas preset', { enum: ['16:9', '9:16', '1:1', '4:5', 'match'] }),
      width: num('pixels (even)'),
      height: num('pixels (even)'),
      frame_rate: num('frames per second'),
      background: str('#rrggbb'),
    }),
  },
  { name: 'undo', runs: 'renderer', description: 'Undo the last edit (the person\'s or the AI\'s).', inputSchema: obj({}) },
  { name: 'redo', runs: 'renderer', description: 'Redo the last undone edit.', inputSchema: obj({}) },
  {
    name: 'seek',
    runs: 'renderer',
    description: 'Move the playhead (to show the person a moment).',
    inputSchema: obj({ time: num('timeline seconds') }, ['time']),
  },
  {
    name: 'save_project',
    runs: 'main',
    description: 'Save the project to its current file. Fails if it has never been saved (the person must choose a location first).',
    inputSchema: obj({}),
  },
  {
    name: 'export_video',
    runs: 'main',
    description:
      'Start exporting a video (.mp4 or QuickTime .mov, chosen by the path\'s ending). Returns immediately; poll get_export_status. Defaults: H.264, whole timeline, canvas size, project frame rate, a suggested bitrate, software encoder. For Apple devices HEVC gives about half the size; ProRes (.mov only) is for editing in Final Cut Pro. Will not overwrite an existing file unless overwrite=true.',
    inputSchema: obj({
      path: str('absolute output path ending in .mp4 or .mov'),
      codec: str('h264 (default), hevc (H.265, tagged for Apple devices) or prores (ProRes 422, .mov only)', { enum: ['h264', 'hevc', 'prores'] }),
      prores_hq: bool('ProRes 422 HQ instead of standard ProRes 422'),
      width: num('output width (even)'),
      height: num('output height (even)'),
      frame_rate: num('frames per second'),
      bitrate_mbps: num('target average video bitrate in Mb/s'),
      crf: num('constant quality instead of a bitrate: 12..35, lower = better and larger (18–22 typical). Software encoder only.'),
      encoder: str('x264 (software, default) or videotoolbox (Apple hardware, macOS only; faster, bitrate mode only)', { enum: ['x264', 'videotoolbox'] }),
      start: num('export only from this timeline time (seconds)'),
      end: num('export only up to this timeline time (seconds)'),
      fit: str('when the output shape differs from the canvas: fit (bars) or fill (crop)', { enum: ['fit', 'fill'] }),
      chapters: bool('write the timeline markers as chapters (default: true when there are markers)'),
      overwrite: bool('replace an existing file'),
    }, ['path']),
  },
  {
    name: 'get_export_status',
    runs: 'main',
    description: 'Progress or result of the most recent export.',
    inputSchema: obj({}),
  },
];

export const TOOLS_BY_NAME = new Map(CONTROL_TOOLS.map((t) => [t.name, t]));
