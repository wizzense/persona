/**
 * Named stage arrangements — Plan 40, slice G ("think macOS Stage Manager").
 *
 * The owner can already drag one body at a time. What was missing is the verb:
 * "put them in a row", "have those two face each other", "frame Atlas and let
 * the rest step back". Dragging four bodies into a conversation by hand is the
 * kind of work a stage manager exists to remove — and on a frameless, gesture-
 * driven overlay it is also the work that is hardest to do accurately.
 *
 * PURE on purpose, and living in the RENDERER rather than in main: the stage's
 * limits are here (`POSITION_BOUND`, the scale clamp, the minimum gap that stops
 * two bodies sharing a spot), and a copy of them in the main process is exactly
 * the duplication the console's bugs came from. Main sends an arrangement NAME;
 * this decides where everyone stands, and every arrangement is a function of the
 * live slots, so it is unit-tested without a window.
 */

import { POSITION_BOUND, type AvatarTransform } from '../hooks/useAvatarLayout';
import { STAGE_MIN_GAP, STAGE_STEP } from '../hooks/stagePlacement';

export const ARRANGEMENTS = ['row', 'arc', 'pair', 'focus', 'reset'] as const;
export type ArrangementName = (typeof ARRANGEMENTS)[number];

/** Scale floor/ceiling for an arranged body. Arrangements never make a body so
 *  small it cannot be grabbed again -- an unreachable body is a lost one. */
const SCALE_MIN = 0.45;
const SCALE_MAX = 1.6;
/** A body that has stepped back sits at this scale; the focused one at this. */
const BACK_SCALE = 0.72;
const FOCUS_SCALE = 1.15;
/** How far a body turns to face the centre in `arc`, and inward in `pair`. */
const ARC_YAW = 0.38;
const PAIR_YAW = 0.55;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const clampX = (x: number) => clamp(x, -POSITION_BOUND, POSITION_BOUND);
const clampScale = (s: number) => clamp(s, SCALE_MIN, SCALE_MAX);

/**
 * The gap between neighbours for `count` bodies.
 *
 * Wide when there are few (a pair should not stand at opposite walls), and as
 * narrow as the stage forces when there are many -- but never a value that would
 * put the outermost bodies outside the stage, because clamping them there is how
 * two bodies end up on ONE spot. Measured by the test: `spread` used to take
 * `max(STAGE_MIN_GAP, ideal)`, so six bodies wanted 4.5 units of a 4-unit stage
 * and the two ends clamped to the same x.
 */
export function laneStep(count: number, bound = POSITION_BOUND): number {
  if (count <= 1) return 0;
  const ideal = (2 * bound) / (count - 1);
  return Math.min(ideal, STAGE_STEP);
}

/** Evenly spaced, symmetric about the centre, always inside the stage. */
export function spread(count: number, bound = POSITION_BOUND): number[] {
  if (count <= 0) return [];
  if (count === 1) return [0];
  const step = laneStep(count, bound);
  const start = -(step * (count - 1)) / 2;
  return Array.from({ length: count }, (_, i) => clampX(start + i * step));
}

/**
 * `count` positions that LEAVE THE CENTRE CLEAR — where the supporting bodies
 * stand while one is the subject. Alternating outward keeps the group balanced,
 * and the step is the one the same number of bodies would use in a row, so a
 * focus never packs two of them tighter than a row would.
 */
export function flanks(count: number, bound = POSITION_BOUND): number[] {
  if (count <= 0) return [];
  // Rings of two (right, left, wider right, …). The step is whatever makes the
  // OUTERMOST ring land inside the stage, so no ring is ever clamped onto
  // another -- the first version stepped by a row's gap, ran out of stage at
  // three bodies, and dropped the third onto x=0, which is where the FOCUSED
  // body stands. A supporting body standing inside the subject is the exact
  // "two bodies on one spot" failure, wearing a different hat.
  const rings = Math.ceil(count / 2);
  const step = Math.min(STAGE_STEP, bound / rings);
  const out: number[] = [];
  for (let k = 1; k <= rings; k += 1) out.push(k * step, -k * step);
  return out.slice(0, count).map(clampX);
}

/** Slots in a STABLE order: the resident first, then the rest by id. An
 *  arrangement that reshuffles on every call is a stage that twitches. */
export function order(slotIds: string[]): string[] {
  const rest = slotIds.filter((id) => id !== 'slot0').sort();
  return slotIds.includes('slot0') ? ['slot0', ...rest] : rest;
}

function flat(x: number, scale: number, yaw = 0): AvatarTransform {
  return { position: [clampX(x), 0, 0], scale: clampScale(scale), yaw };
}

/**
 * Where everyone stands for one arrangement.
 *
 * `reset` returns {} — "no opinion", which the caller applies by CLEARING each
 * slot back to its default placement rather than by writing a layout. A reset
 * that wrote positions would be one more arrangement to undo.
 */
export function arrange(
  name: ArrangementName,
  slotIds: string[],
  { focus = null, pair = [] }: { focus?: string | null; pair?: string[] } = {},
): Record<string, AvatarTransform> {
  const ids = order(slotIds);
  if (!ids.length || name === 'reset') return {};

  if (name === 'row') {
    const xs = spread(ids.length);
    return Object.fromEntries(ids.map((id, i) => [id, flat(xs[i], 1)]));
  }

  if (name === 'arc') {
    // A shallow curve: the outer bodies stand back and turn inward, so four
    // bodies read as a group facing the owner instead of a police line-up.
    const xs = spread(ids.length);
    const widest = Math.max(...xs.map(Math.abs), 1e-6);
    return Object.fromEntries(ids.map((id, i) => {
      const t = xs[i] / widest;                    // -1 … 1
      const depth = -0.55 * t * t;                 // the middle stands forward
      const scale = 1 - 0.08 * Math.abs(t);        // and reads slightly larger
      return [id, {
        position: [clampX(xs[i]), 0, depth],
        scale: clampScale(scale),
        yaw: -ARC_YAW * t,
      }];
    }));
  }

  if (name === 'pair') {
    // Two bodies at conversational distance, turned toward each other. Named
    // ids win; otherwise the first two in stable order, so "pair" always does
    // something rather than refusing over a missing argument.
    const [a, b] = (pair.filter((id) => ids.includes(id)).length === 2 ? pair : ids).slice(0, 2);
    const gap = Math.max(STAGE_MIN_GAP, 1.25);
    const placed: Record<string, AvatarTransform> = {};
    if (a) placed[a] = { position: [clampX(-gap / 2), 0, 0], scale: clampScale(1), yaw: PAIR_YAW };
    if (b) placed[b] = { position: [clampX(gap / 2), 0, 0], scale: clampScale(1), yaw: -PAIR_YAW };
    // Everyone else steps back and to the edges so the pair is the subject.
    const others = ids.filter((id) => id !== a && id !== b);
    // Two extra rings, innermost DROPPED: the pair is standing in the middle, so
    // a supporting body on the first ring crowds it (0.475 units apart, measured
    // by the test at six bodies -- close enough to read as one clump).
    const xs = flanks(others.length + 2).slice(2);
    others.forEach((id, i) => {
      placed[id] = {
        position: [clampX(xs[i] ?? 0), 0, -0.8], scale: clampScale(BACK_SCALE), yaw: 0,
      };
    });
    return placed;
  }

  // focus: one body centre stage and larger, the rest pushed out and smaller.
  const target = focus && ids.includes(focus) ? focus : ids[0];
  const others = ids.filter((id) => id !== target);
  const xs = flanks(others.length);
  const placed: Record<string, AvatarTransform> = {
    [target]: { position: [0, 0, 0.15], scale: clampScale(FOCUS_SCALE), yaw: 0 },
  };
  others.forEach((id, i) => {
    placed[id] = { position: [clampX(xs[i] ?? 0), 0, -0.7], scale: clampScale(BACK_SCALE), yaw: 0 };
  });
  return placed;
}

/** Is this a name we can actually arrange? Main sends strings over IPC. */
export function isArrangement(name: unknown): name is ArrangementName {
  return typeof name === 'string' && (ARRANGEMENTS as readonly string[]).includes(name);
}
