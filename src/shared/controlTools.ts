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
      'Look at a picture. With `time`: the timeline preview at that time (exactly what the export will show, including framing and animation). With `media_id` and `source_time`: a frame of an original media file. Returns a JPEG image.',
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
    description: 'Import video files (absolute paths to MP4/MOV with H.264) into the Media panel. Files are referenced, never modified.',
    inputSchema: obj({ paths: { type: 'array', items: { type: 'string' }, description: 'absolute file paths' } }, ['paths']),
  },

  // ---- Timeline editing ----
  {
    name: 'add_clip',
    runs: 'renderer',
    description: 'Add a media file to the timeline (whole file, or source_in..source_out). Inserted at `position` (0-based) or at the end.',
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
    description: 'Set a clip\'s volume (0..1) and/or mute it.',
    inputSchema: obj({ clip_id: str('clip id'), volume: num('0..1'), muted: bool('mute') }, ['clip_id']),
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
      'Start exporting an MP4 (H.264/AAC). Returns immediately; poll get_export_status. Defaults: canvas size, project frame rate, a suggested bitrate. Will not overwrite an existing file unless overwrite=true.',
    inputSchema: obj({
      path: str('absolute output path ending in .mp4'),
      width: num('output width (even)'),
      height: num('output height (even)'),
      frame_rate: num('frames per second'),
      bitrate_mbps: num('target average video bitrate in Mb/s'),
      fit: str('when the output shape differs from the canvas: fit (bars) or fill (crop)', { enum: ['fit', 'fill'] }),
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
