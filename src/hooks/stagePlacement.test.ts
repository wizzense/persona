import { describe, expect, it } from 'vitest';
import {
  STAGE_MIN_GAP,
  STAGE_STEP,
  authoredFields,
  authoredTransform,
  candidateSpots,
  freeSpot,
} from './stagePlacement';
import { POSITION_BOUND, sane, type AvatarTransform } from './useAvatarLayout';

describe('stagePlacement', () => {
  it('offers spots right then left, widening, inside the bound', () => {
    expect(candidateSpots(2)).toEqual([STAGE_STEP, -STAGE_STEP]);
    expect(candidateSpots(3.5)).toEqual([1.6, -1.6, 3.2, -3.2]);
  });

  it('the first body stands to the right of the resident', () => {
    expect(freeSpot([0], 2)).toBe(STAGE_STEP);
  });

  it('the second body does NOT land on the first (the measured collision)', () => {
    const first = freeSpot([0], 2);
    const second = freeSpot([0, first], 2);
    expect(Math.abs(second - first)).toBeGreaterThanOrEqual(STAGE_MIN_GAP);
    expect(second).toBe(-STAGE_STEP);
  });

  it('a removed body frees its spot for the next one', () => {
    expect(freeSpot([0, -STAGE_STEP], 2)).toBe(STAGE_STEP);
  });

  it('a full stage still places, on the least crowded spot', () => {
    const spot = freeSpot([0, 1.6, -1.6, 1.6, -1.6], 2);
    expect([1.6, -1.6]).toContain(spot);
  });
});

/** Scene's unauthored default for a new body, so the fallback these tests pass is
 *  the real one: the nearest FREE lane, scale 1. */
function freeSpotFallback(occupiedX: number[]): AvatarTransform {
  return { position: [freeSpot(occupiedX, POSITION_BOUND), 0, 0], scale: 1 };
}

describe('authored placement (place-avatar)', () => {
  const occupied = [0];
  const fallback = freeSpotFallback(occupied);

  it('an absent place is exactly the freeSpot fallback', () => {
    expect(authoredTransform(undefined, fallback)).toEqual(fallback);
    expect(authoredTransform(null, fallback)).toEqual(fallback);
    expect(authoredTransform({}, fallback).position[0]).toBe(freeSpot(occupied, POSITION_BOUND));
  });

  it('DROPS an out-of-stage position instead of clamping it to the edge', () => {
    const placed = authoredTransform({ position: [8, 0, 0] }, fallback);
    expect(placed).toEqual(fallback);
    // The whole point: x=8 must not become x=POSITION_BOUND, a spot nobody authored.
    expect(placed.position[0]).not.toBe(POSITION_BOUND);
    expect(authoredFields({ position: [8, 0, 0] }).position).toBeUndefined();
    // ...and a malformed position is a drop too, not a throw.
    expect(authoredTransform({ position: [0, 0] }, fallback)).toEqual(fallback);
    expect(authoredTransform({ position: [NaN, 0, 0] }, fallback)).toEqual(fallback);
    expect(authoredTransform({ position: 'centre' }, fallback)).toEqual(fallback);
  });

  it('keeps an authored position inside the stage', () => {
    const placed = authoredTransform({ position: [-1.2, 0, 0.4] }, fallback);
    expect(placed.position).toEqual([-1.2, 0, 0.4]);
    expect(sane(placed)).toBe(true);
  });

  it('drops a scale outside the stored-layout bounds and keeps one inside', () => {
    expect(authoredTransform({ scale: 50 }, fallback).scale).toBe(fallback.scale);
    expect(authoredTransform({ scale: 0 }, fallback).scale).toBe(fallback.scale);
    expect(authoredTransform({ scale: 0.0001 }, fallback).scale).toBe(fallback.scale);
    expect(authoredTransform({ scale: 0.05 }, fallback).scale).toBe(0.05);
    expect(authoredTransform({ scale: 10 }, fallback).scale).toBe(10);
    expect(authoredTransform({ scale: 0.7 }, fallback).scale).toBe(0.7);
  });

  it('takes yaw as radians, and only a finite one', () => {
    expect(authoredTransform({ yaw: Math.PI / 2 }, fallback).yaw).toBe(Math.PI / 2);
    expect(authoredTransform({ yaw: -0.38 }, fallback).yaw).toBe(-0.38);
    expect(authoredTransform({ yaw: Infinity }, fallback).yaw).toBe(fallback.yaw);
    expect(authoredFields({ yaw: '90deg' }).yaw).toBeUndefined();
  });

  it('drops per FIELD: a bad position does not cost the body its good scale', () => {
    const placed = authoredTransform({ position: [0, 0, -9], scale: 0.6, yaw: 0.2 }, fallback);
    expect(placed.position).toEqual(fallback.position);
    expect(placed.scale).toBe(0.6);
    expect(placed.yaw).toBe(0.2);
  });

  it('does not alias the event object into the layout', () => {
    const position: [number, number, number] = [1, 0, 0];
    const fields = authoredFields({ position });
    expect(fields.position).toEqual(position);
    expect(fields.position).not.toBe(position);
  });

  it('accepts the place-avatar desk event as authored input', () => {
    // Typed as the union member U09 adds to vite-env.d.ts: this line is what fails
    // `tsc -b` (npm run build) if the member is missing or shaped differently.
    const event: AvatarBridgeEvent = {
      type: 'place-avatar',
      slotId: 'slot1',
      position: [1.2, 0, 0.3],
      scale: 0.8,
      yaw: 0.25,
    };
    expect(event.type).toBe('place-avatar');
    expect(authoredFields(event)).toEqual({ position: [1.2, 0, 0.3], scale: 0.8, yaw: 0.25 });
    // slotId alone is legal -- the renderer then changes nothing for that body.
    const bare: AvatarBridgeEvent = { type: 'place-avatar', slotId: 'slot0' };
    expect(authoredFields(bare)).toEqual({});
  });
});
