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

import { sane, type AvatarTransform } from './useAvatarLayout';

/** 🚩 Do not widen this, and do not widen POSITION_BOUND (2) to make room: with
 *  step 1.6 and bound 2 there is exactly ONE clean lane per side, so a third
 *  body lands on the least-crowded lane via freeSpot's fallback below — that is
 *  the designed outcome, not a bug. A bigger bound puts bodies outside the ~±2
 *  units full-body framing actually shows, which is the state the owner read as
 *  "Desk is broken" (useAvatarLayout's POSITION_BOUND comment, 2026-08-25).
 *  Raising the room's body cap is not the answer either: four VRMs drove the
 *  heap to 2.36 GB. An exact spot for a specific body comes from an AUTHORED placement
 *  (`authoredTransform` below), never from a looser bound. */
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

/**
 * An AUTHORED placement: where the cast file says a body stands, delivered to
 * the renderer as a `place-avatar` desk event. Every field is optional and
 * arrives from outside the renderer (a hand-edited file, relayed by main), so it
 * is untrusted input to the same stage limits a drag obeys.
 *
 * `yaw` is radians, like AvatarTransform.yaw and the drag's onRotate.
 */
export interface AuthoredPlace {
  position?: unknown;
  scale?: unknown;
  yaw?: unknown;
}

/**
 * The fields of an authored place that survive the stage limits, and ONLY those
 * — a rejected or omitted field is absent from the result, never clamped.
 *
 * Per-field DROP, the house idiom (useAvatarLayout.sane): an authored x=8 is not
 * a placement pinned to the stage edge at x=2, it is a typo, and clamping it
 * would put the body on a spot nobody wrote — a second surprise instead of a
 * recovery. Dropping one field keeps the others: a good scale beside a bad
 * position still applies.
 *
 * The bounds are probed through `sane()` with a neutral partner field rather
 * than copied: the scale limits (0.05–10) are unexported in useAvatarLayout,
 * and a second copy of them here is exactly the drift arrangements.ts's header
 * warns about. 🚩 If `sane()` ever gains a CROSS-field rule, these probes stop
 * meaning "this field alone is fine" — revisit them then.
 */
export function authoredFields(place: AuthoredPlace | null | undefined): Partial<AvatarTransform> {
  const out: Partial<AvatarTransform> = {};
  if (!place || typeof place !== 'object') return out;
  const { position, scale, yaw } = place;
  if (sane({ position, scale: 1 }) && Array.isArray(position)) {
    // A fresh tuple: the event object is not ours to alias into layout state.
    out.position = [position[0], position[1], position[2]] as [number, number, number];
  }
  if (typeof scale === 'number' && sane({ position: [0, 0, 0], scale })) out.scale = scale;
  if (typeof yaw === 'number' && Number.isFinite(yaw)) out.yaw = yaw;
  return out;
}

/**
 * The whole transform an authored place yields for one slot: every accepted
 * field over `fallback`, which is the caller's unauthored default (Scene's
 * freeSpot placement). An absent or wholly unusable place returns the fallback
 * unchanged, so a bad cast entry costs the body its authored spot and nothing
 * else — it still stands on a free lane, in view.
 *
 * Scene's `place-avatar` handler writes `authoredFields` per component instead,
 * because an OMITTED field must leave that component alone (writing the
 * fallback back would freeze a defaulted slot's free-spot placement into the
 * stored layout). This is the form a whole-slot consumer needs.
 */
export function authoredTransform(
  place: AuthoredPlace | null | undefined,
  fallback: AvatarTransform,
): AvatarTransform {
  return { ...fallback, ...authoredFields(place) };
}
