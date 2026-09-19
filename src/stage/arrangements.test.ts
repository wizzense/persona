import { describe, expect, it } from 'vitest';

import { POSITION_BOUND } from '../hooks/useAvatarLayout';
import { STAGE_MIN_GAP } from '../hooks/stagePlacement';
import { ARRANGEMENTS, arrange, isArrangement, laneStep, order, spread } from './arrangements';

const ids = ['slot0', 'room-atlas', 'room-lyra', 'room-hydra'];

/** Nobody may share a spot, and nobody may leave the visible stage: the two
 *  failures that read as "the stage is broken" rather than "the layout is odd". */
function assertStageSane(
  placed: Record<string, { position: [number, number, number]; scale: number }>,
  count = Object.keys(placed).length,
) {
  const xs = Object.values(placed).map((t) => t.position[0]);
  for (const t of Object.values(placed)) {
    expect(Math.abs(t.position[0])).toBeLessThanOrEqual(POSITION_BOUND + 1e-9);
    expect(t.scale).toBeGreaterThan(0.4);
    expect(t.scale).toBeLessThan(2);
    for (const v of t.position) expect(Number.isFinite(v)).toBe(true);
  }
  // Neighbours keep the gap a row of this many would use, and never less than a
  // visibly separate distance -- a crowded stage packs, it never stacks.
  const floor = Math.min(STAGE_MIN_GAP, laneStep(count)) - 1e-9;
  const sorted = [...xs].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i += 1) {
    expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(Math.min(floor, 0.6));
  }
}

describe('stage arrangements', () => {
  it('places every live body, and only live bodies', () => {
    for (const name of ARRANGEMENTS) {
      const placed = arrange(name, ids);
      if (name === 'reset') {
        expect(placed).toEqual({});
        continue;
      }
      expect(Object.keys(placed).sort()).toEqual([...ids].sort());
    }
  });

  it('never stacks two bodies and never leaves the stage', () => {
    for (const name of ARRANGEMENTS) {
      if (name === 'reset') continue;
      for (const count of [1, 2, 3, 4, 6]) {
        assertStageSane(arrange(name, ids.slice(0, count).concat(
          Array.from({ length: Math.max(0, count - ids.length) }, (_, i) => `extra-${i}`),
        )));
      }
    }
  });

  it('is stable: the same slots in any order arrange identically', () => {
    const a = arrange('row', ids);
    const b = arrange('row', [...ids].reverse());
    expect(b).toEqual(a);
  });

  it('row is symmetric about the centre', () => {
    const xs = spread(4);
    expect(xs.map((x) => Number(x.toFixed(6)))).toEqual(
      xs.map((x) => Number(x.toFixed(6))).slice().reverse().map((x) => -x),
    );
  });

  it('a single body stands centre stage, not off to one side', () => {
    expect(arrange('row', ['slot0']).slot0.position[0]).toBe(0);
  });

  it('focus puts the named body centre stage and steps the others back', () => {
    const placed = arrange('focus', ids, { focus: 'room-lyra' });
    expect(placed['room-lyra'].position[0]).toBe(0);
    expect(placed['room-lyra'].scale).toBeGreaterThan(1);
    for (const id of ids.filter((x) => x !== 'room-lyra')) {
      expect(placed[id].scale).toBeLessThan(placed['room-lyra'].scale);
      expect(placed[id].position[2]).toBeLessThan(0);      // behind the subject
      expect(Math.abs(placed[id].position[0])).toBeGreaterThan(0);
    }
  });

  it('focus on an unknown slot still arranges (the resident is the subject)', () => {
    const placed = arrange('focus', ids, { focus: 'ghost' });
    expect(placed.slot0.position[0]).toBe(0);
  });

  it('pair turns two bodies toward each other', () => {
    const placed = arrange('pair', ids, { pair: ['room-atlas', 'room-lyra'] });
    expect(placed['room-atlas'].position[0]).toBeLessThan(0);
    expect(placed['room-lyra'].position[0]).toBeGreaterThan(0);
    // Facing each other means opposite yaw signs, both non-zero.
    expect(Math.sign(placed['room-atlas'].yaw!)).toBe(1);
    expect(Math.sign(placed['room-lyra'].yaw!)).toBe(-1);
    // and the rest are behind them
    for (const id of ['slot0', 'room-hydra']) expect(placed[id].position[2]).toBeLessThan(0);
  });

  it('pair with a bad argument falls back to the first two, it does not refuse', () => {
    const placed = arrange('pair', ids, { pair: ['ghost'] });
    expect(Object.keys(placed).sort()).toEqual([...ids].sort());
    expect(placed.slot0.yaw).not.toBe(0);
  });

  it('arc turns the outer bodies inward and stands them back', () => {
    const placed = arrange('arc', ids);
    const left = placed[order(ids)[1]];
    const xs = Object.values(placed).map((t) => t.position[0]);
    const outer = Object.values(placed).find((t) => t.position[0] === Math.max(...xs))!;
    expect(outer.yaw!).toBeLessThan(0);              // rightmost turns left
    expect(outer.position[2]).toBeLessThanOrEqual(left.position[2] + 1e-9);
  });

  it('reset means "no opinion", so the caller restores defaults', () => {
    expect(arrange('reset', ids)).toEqual({});
  });

  it('an empty stage arranges to nothing rather than throwing', () => {
    for (const name of ARRANGEMENTS) expect(arrange(name, [])).toEqual({});
  });

  it('only known names are arrangements (main sends strings over IPC)', () => {
    expect(isArrangement('row')).toBe(true);
    expect(isArrangement('ROW')).toBe(false);
    expect(isArrangement('')).toBe(false);
    expect(isArrangement(undefined)).toBe(false);
  });
});
