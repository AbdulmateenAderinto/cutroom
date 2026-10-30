import { describe, expect, it } from 'vitest';
import { PROJECT_VERSION, createProject } from '../../src/shared/model';
import { parseProject, serializeProject } from '../../src/shared/serialize';
import {
  TITLE_DEFAULT_DURATION, addTitle, deleteTitle, duplicateTitle, findTitle, isAnimating, moveTitle, setTitleStyle, splitTitle,
  titleStateAt, titlesAt, trimTitle, updateTitle,
} from '../../src/shared/titles';
import { TICKS_PER_SECOND as S, frameDuration } from '../../src/shared/time';

const p0 = () => createProject('titles');
const f = frameDuration({ num: 30, den: 1 });

describe('titles', () => {
  it('adds a 3 s title at a frame-snapped time, from a preset', () => {
    const r = addTitle(p0(), 1.01 * S, { preset: 'lowerThird', text: 'Ada Lovelace' });
    const t = findTitle(r.project, r.id)!;
    expect(t.start).toBe(30 * f);
    expect(t.duration).toBe(TITLE_DEFAULT_DURATION);
    expect(t.text).toBe('Ada Lovelace');
    expect(t.style.align).toBe('left');
    expect(t.style.look).toBe('box');
  });

  it('a second title at the same time goes on the next row; never overlaps on a row', () => {
    let { project: p, id: a } = addTitle(p0(), 0);
    const r = addTitle(p, S);
    p = r.project;
    expect(findTitle(p, a)!.row).toBe(0);
    expect(findTitle(p, r.id)!.row).toBe(1);
    // Moving b down onto row 0 at 1 s collides with a (0–3 s): it lands right after a.
    p = moveTitle(p, r.id, S, 0);
    expect(findTitle(p, r.id)!.row).toBe(0);
    expect(findTitle(p, r.id)!.start).toBe(3 * S);
    // Trimming a's end can't run into b; trimming b's start can't run into a.
    p = trimTitle(p, a, 'end', 5 * S);
    expect(findTitle(p, a)!.duration).toBe(3 * S);
    p = trimTitle(p, r.id, 'start', -2 * S);
    expect(findTitle(p, r.id)!.start).toBe(3 * S);
    // A change of timing that would overlap is refused; style changes still apply.
    p = updateTitle(p, a, (t) => ({ ...t, duration: 10 * S, text: 'new' }));
    expect(findTitle(p, a)!.duration).toBe(3 * S);
    expect(findTitle(p, a)!.text).toBe('new');
  });

  it('split, duplicate and delete', () => {
    const { project, id } = addTitle(p0(), 0, { duration: 4 * S });
    const sp = splitTitle(project, id, 1.5 * S)!;
    const left = findTitle(sp.project, id)!;
    const right = findTitle(sp.project, sp.rightId)!;
    expect([left.duration, right.start, right.duration]).toEqual([1.5 * S, 1.5 * S, 2.5 * S]);
    expect(left.animOut).toBe('none'); // no exit animation in the middle of a split title
    expect(right.animIn).toBe('none');
    expect(splitTitle(project, id, 0)).toBeNull();
    const d = duplicateTitle(project, id)!;
    expect(findTitle(d.project, d.id)!.start).toBe(4 * S);
    expect(deleteTitle(d.project, id).titles!.length).toBe(1);
  });

  it('clamps style values', () => {
    const { project, id } = addTitle(p0(), 0);
    const p = setTitleStyle(project, id, { size: 500, boxOpacity: 3, color: 'red' });
    const st = findTitle(p, id)!.style;
    expect(st.size).toBe(40);
    expect(st.boxOpacity).toBe(1);
    expect(st.color).toBe('#ffffff');
  });

  it('animation state: fade/rise/pop/typewriter in, fade out, hidden outside', () => {
    const { project, id } = addTitle(p0(), S, { duration: 2 * S });
    const set = (animIn: any, animOut: any) => updateTitle(project, id, (t) => ({ ...t, animIn, animOut, animLength: 0.5 * S }));
    let t = findTitle(set('fade', 'fade'), id)!;
    expect(titleStateAt(t, 0.99 * S)).toBeNull();
    expect(titleStateAt(t, S)!.opacity).toBe(0);
    expect(titleStateAt(t, 1.25 * S)!.opacity).toBeCloseTo(0.5, 6);
    expect(titleStateAt(t, 2 * S)!.opacity).toBe(1);
    expect(titleStateAt(t, 2.75 * S)!.opacity).toBeCloseTo(0.5, 6);
    expect(titleStateAt(t, 3 * S)).toBeNull();
    expect(isAnimating(t, 1.2 * S)).toBe(true);
    expect(isAnimating(t, 2 * S)).toBe(false);
    t = findTitle(set('rise', 'none'), id)!;
    expect(titleStateAt(t, S)!.dy).toBeGreaterThan(0.04);
    expect(titleStateAt(t, 1.5 * S)!.dy).toBe(0);
    t = findTitle(set('pop', 'none'), id)!;
    expect(titleStateAt(t, S)!.scale).toBeCloseTo(0.5, 6);
    expect(Math.max(...[0.3, 0.35, 0.4, 0.45].map((x) => titleStateAt(t, (1 + x) * S)!.scale))).toBeGreaterThan(1); // overshoot
    t = findTitle(set('typewriter', 'none'), id)!;
    expect(titleStateAt(t, 1.25 * S)!.reveal).toBeCloseTo(0.5, 6);
    expect(titleStateAt(t, 1.25 * S)!.opacity).toBe(1);
  });

  it('animation length never exceeds half the title', () => {
    const { project, id } = addTitle(p0(), 0, { duration: 0.4 * S });
    const t = findTitle(updateTitle(project, id, (x) => ({ ...x, animLength: 5 * S })), id)!;
    expect(t.animLength).toBe(0.2 * S);
  });

  it('draw order follows rows; saved and reopened intact', () => {
    let { project: p } = addTitle(p0(), 0, { text: 'low' });
    p = addTitle(p, 0, { text: 'high' }).project;
    expect(titlesAt(p, S).map((x) => x.title.text)).toEqual(['low', 'high']);
    const back = parseProject(serializeProject(p));
    expect(back.titles).toEqual(p.titles);
  });

  it('opens version-4 projects (no titles)', () => {
    const v4 = { ...p0(), version: 4 } as any;
    delete v4.titles;
    const back = parseProject(JSON.stringify(v4));
    expect(back.version).toBe(PROJECT_VERSION);
    expect(back.titles ?? []).toEqual([]);
  });

  it('rejects damaged titles', () => {
    const p = addTitle(p0(), 0).project;
    const bad = JSON.parse(serializeProject(p));
    bad.titles[0].duration = -1;
    expect(() => parseProject(JSON.stringify(bad))).toThrow(/bad timing/);
  });
});
