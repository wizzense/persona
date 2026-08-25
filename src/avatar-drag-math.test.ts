import { describe, expect, it } from 'vitest';

import {
  activated,
  clampAxis,
  dragTarget,
  worldPerPixel,
  type DragFrame,
} from './hooks/avatarDragMath';

/**
 * The fly-away pin. The avatar teleport defect shipped THREE times in one day
 * (2026-08-25): jump-to-cursor ray hits, then delta-of-ground-ray twice —
 * because a nearly-horizontal camera makes the ground-ray intersection
 * distance explode on fast pointer movement, and no version of that math had
 * a test. The screen-space rework is linear by definition; these tests pin
 * that a flick can never move the avatar more than its pixels say, a click
 * never moves it at all, and the stage bound is a hard wall.
 */
describe('avatar drag math', () => {
  const frame = (wpp = 0.01, start = { x: 0, z: 0 }): DragFrame => ({
    start,
    startClient: { x: 100, y: 100 },
    wpp,
    bound: 2,
  });

  it('worldPerPixel is linear in depth and sane in size', () => {
    // Desk camera: fov 20, depth ~5.2 -> a 900px-tall viewport maps the full
    // height to ~1.83 world units; one pixel is ~0.002 world units.
    const wpp = worldPerPixel(5.2, 20, 900);
    expect(wpp).toBeGreaterThan(0.0015);
    expect(wpp).toBeLessThan(0.003);
    expect(worldPerPixel(10.4, 20, 900)).toBeCloseTo(wpp * 2, 5);
  });

  it('a click-sized wiggle never activates', () => {
    expect(activated(0)).toBe(false);
    expect(activated(4.9)).toBe(false);
    expect(activated(5)).toBe(true);
  });

  it('a fast flick moves the avatar only as far as its pixels say', () => {
    // 300px in one event — the exact shape of "I clicked too fast and the
    // whole avatar flew away". Screen-space: 300px * wpp, clamped to the
    // stage. The ground-ray versions produced multi-hundred-unit jumps here.
    const target = dragTarget(frame(0.01), 100 + 300, 100 + 300);
    expect(Math.abs(target.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(target.z)).toBeLessThanOrEqual(2);
    // And bounded by the PIXEL math, not by the clamp: 300 * 0.01 = 3 > 2, so
    // the clamp is what engaged — but for a mid flick the answer must equal
    // the pixel math exactly.
    const mid = dragTarget(frame(0.01), 100 + 100, 100 + 100);
    expect(mid.x).toBeCloseTo(1, 10);
    expect(mid.z).toBeCloseTo(1, 10);
  });

  it('the stage bound is a hard wall from any start position', () => {
    const nearEdge = dragTarget(frame(0.01, { x: 1.8, z: 1.8 }), 100 + 500, 100 + 500);
    expect(nearEdge.x).toBe(2);
    expect(nearEdge.z).toBe(2);
    const farEdge = dragTarget(frame(0.01, { x: -1.8, z: -1.8 }), 100 - 500, 100 - 500);
    expect(farEdge.x).toBe(-2);
    expect(farEdge.z).toBe(-2);
  });

  it('screen axes map to the ground axes (right=+x, down=+z toward camera)', () => {
    const right = dragTarget(frame(0.01), 100 + 10, 100);
    expect(right.x).toBeCloseTo(0.1, 10);
    expect(right.z).toBeCloseTo(0, 10);
    const down = dragTarget(frame(0.01), 100, 100 + 10);
    expect(down.x).toBeCloseTo(0, 10);
    expect(down.z).toBeCloseTo(0.1, 10);
  });

  it('clampAxis is symmetric and tight', () => {
    expect(clampAxis(0, 2)).toBe(0);
    expect(clampAxis(2, 2)).toBe(2);
    expect(clampAxis(2.0001, 2)).toBe(2);
    expect(clampAxis(-3, 2)).toBe(-2);
  });
});
