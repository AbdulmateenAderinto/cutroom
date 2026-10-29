/**
 * Project (de)serialization with validation. Files are JSON with a format marker and version.
 * When the format changes, bump PROJECT_VERSION and add a migration step in migrate().
 */
import { type Project, PROJECT_FORMAT, PROJECT_VERSION, isHexColor } from './model';

export class ProjectFormatError extends Error {}

export function serializeProject(project: Project): string {
  return JSON.stringify(project, null, 2) + '\n';
}

export function parseProject(text: string): Project {
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ProjectFormatError('The project file is not valid JSON. It may be damaged or not a Cutroom project.');
  }
  if (!data || data.format !== PROJECT_FORMAT) {
    throw new ProjectFormatError('This file is not a Cutroom project.');
  }
  if (typeof data.version !== 'number') throw new ProjectFormatError('The project file has no format version.');
  if (data.version > PROJECT_VERSION) {
    throw new ProjectFormatError(
      `This project was saved by a newer version of Cutroom (format ${data.version}; this app reads up to ${PROJECT_VERSION}).`,
    );
  }
  const p = migrate(data);
  validate(p);
  return p;
}

function migrate(data: any): Project {
  // Version 1 is the first format; future migrations go here, e.g. if (data.version === 1) {...; data.version = 2}
  return data as Project;
}

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new ProjectFormatError(`Damaged project file: ${msg}`);
}

const isInt = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n);

function validate(p: Project) {
  check(typeof p.id === 'string', 'missing project id');
  check(p.canvas && isInt(p.canvas.width) && isInt(p.canvas.height) && p.canvas.width > 0 && p.canvas.height > 0, 'bad canvas size');
  check(p.frameRate && isInt(p.frameRate.num) && isInt(p.frameRate.den) && p.frameRate.num > 0 && p.frameRate.den > 0, 'bad frame rate');
  check(isHexColor(p.background), 'bad background colour');
  check(Array.isArray(p.media), 'media list missing');
  check(p.sequence && Array.isArray(p.sequence.items), 'sequence missing');
  const mediaIds = new Set<string>();
  for (const m of p.media) {
    check(typeof m.id === 'string' && typeof m.path === 'string' && m.info, `bad media entry ${m.name ?? ''}`);
    check(isInt(m.info.duration), `bad media duration for ${m.name}`);
    mediaIds.add(m.id);
  }
  const ids = new Set<string>();
  for (const it of p.sequence.items) {
    check(!ids.has(it.id), `duplicate item id ${it.id}`);
    ids.add(it.id);
    if (it.kind === 'clip') {
      check(mediaIds.has(it.mediaId), `clip ${it.id} refers to unknown media`);
      check(isInt(it.sourceIn) && isInt(it.sourceOut) && it.sourceOut > it.sourceIn && it.sourceIn >= 0, `clip ${it.id} has bad in/out points`);
      check(['fit', 'fill', 'manual'].includes(it.framing?.mode), `clip ${it.id} has bad framing`);
    } else {
      check(it.kind === 'gap' && isInt(it.duration) && it.duration > 0, `bad gap ${it.id}`);
    }
  }
}
