import { describe, expect, it } from 'vitest';
import { STAGE_MIN_GAP, STAGE_STEP, candidateSpots, freeSpot } from './stagePlacement';

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
