import { describe, expect, it } from 'vitest';
import { addMarker, chapterMetadata, deleteMarker, markers, updateMarker } from '../../src/shared/markers';
import { PROJECT_VERSION, createProject } from '../../src/shared/model';
import { parseProject, serializeProject } from '../../src/shared/serialize';
import { TICKS_PER_SECOND as S } from '../../src/shared/time';

describe('markers', () => {
  it('snap to a frame, sort by time, and one marker per frame', () => {
    let p = createProject();
    const a = addMarker(p, 5 * S + 100, { label: 'Intro' });
    p = a.project;
    expect(markers(p)[0]).toMatchObject({ time: 5 * S, label: 'Intro', color: 'yellow' });
    p = addMarker(p, 2 * S).project;
    expect(markers(p).map((m) => m.time)).toEqual([2 * S, 5 * S]);
    const again = addMarker(p, 5 * S);
    expect(again.existed).toBe(true);
    expect(again.id).toBe(a.id);
    expect(again.project).toBe(p);
  });

  it('rename, recolour, move, delete', () => {
    let p = addMarker(createProject(), 1 * S).project;
    const id = p.markers![0].id;
    p = updateMarker(p, id, { label: 'Chorus', color: 'red', time: 7 * S });
    expect(p.markers![0]).toMatchObject({ label: 'Chorus', color: 'red', time: 7 * S });
    expect(updateMarker(p, id, { time: -5 }).markers![0].time).toBe(0);
    expect(deleteMarker(p, id).markers).toEqual([]);
  });

  it('chapters: one per marker, relative to the range start, with a lead-in chapter if needed', () => {
    let p = createProject();
    p = addMarker(p, 3 * S, { label: 'Part = 1; #a' }).project;
    p = addMarker(p, 8 * S, { label: 'Part 2' }).project;
    expect(chapterMetadata(p, 0, 10 * S)).toBe(
      ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=3000\ntitle=Start\n' +
      '[CHAPTER]\nTIMEBASE=1/1000\nSTART=3000\nEND=8000\ntitle=Part \\= 1\\; \\#a\n' +
      '[CHAPTER]\nTIMEBASE=1/1000\nSTART=8000\nEND=10000\ntitle=Part 2\n',
    );
    // A range starting on a marker: no lead-in; times relative to the range.
    expect(chapterMetadata(p, 3 * S, 9 * S)).toContain('START=0\nEND=5000\ntitle=Part');
    expect(chapterMetadata(p, 9 * S, 10 * S)).toBeNull();
  });

  it('saved and reopened; damaged markers rejected', () => {
    const p = addMarker(createProject(), 2 * S, { label: 'A', color: 'blue' }).project;
    const back = parseProject(serializeProject(p));
    expect(back.version).toBe(PROJECT_VERSION);
    expect(back.markers).toEqual(p.markers);
    const bad = JSON.parse(serializeProject(p));
    bad.markers[0].color = 'pink';
    expect(() => parseProject(JSON.stringify(bad))).toThrow();
  });
});
