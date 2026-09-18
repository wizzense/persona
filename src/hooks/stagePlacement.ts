/**
 * Where a NEW body stands: the nearest free spot on the stage line, never on
 * top of anyone.
 *
 * Measured 2026-09-18 (persisted layout, live desk): two spawned slots both
 * sat at [1.6, 0, 0]. The old default was `(index + 1) * 1.6` over the CURRENT
 * extra-slot array, so after a removal the next slot took the same index --
 * and the same spot -- as one still standing there. Two bodies on one point
 * read as "moving one moves them all" (the proxy under the cursor is the other
 * one) and as a stage nobody can arrange. Placement is now a function of what
 * is OCCUPIED, not of an array index, and it is pure so it is unit-tested.
 */

export const STAGE_STEP = 1.6;
/** Two bodies closer than this on X share a spot for placement purposes. */
export const STAGE_MIN_GAP = 0.9;

/** Candidate x positions in preference order: right of the resident first,
 *  then left, alternating and widening, all inside `bound`. */
export function candidateSpots(bound: number, step = STAGE_STEP): number[] {
  const out: number[] = [];
  for (let k = 1; k * step <= bound + 1e-9; k += 1) {
    out.push(k * step, -k * step);
  }
  return out;
}

/** The first candidate spot no occupied x is within STAGE_MIN_GAP of. Falls
 *  back to the least crowded candidate when every spot is taken (a full stage
 *  still places, it does not throw). */
export function freeSpot(occupiedX: number[], bound: number, step = STAGE_STEP): number {
  const spots = candidateSpots(bound, step);
  if (spots.length === 0) return 0;
  for (const x of spots) {
    if (occupiedX.every((o) => Math.abs(o - x) >= STAGE_MIN_GAP)) return x;
  }
  let best = spots[0];
  let bestCrowd = Infinity;
  for (const x of spots) {
    const crowd = occupiedX.filter((o) => Math.abs(o - x) < STAGE_MIN_GAP).length;
    if (crowd < bestCrowd) {
      bestCrowd = crowd;
      best = x;
    }
  }
  return best;
}
