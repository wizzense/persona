import { useCallback, useEffect, useRef, useState } from 'react';

export interface AvatarTransform {
  position: [number, number, number];
  scale: number;
}

const STORAGE_KEY = 'desk.avatar-layout.v1';

/** The farthest a stored/dragged avatar may sit from the origin, per axis. The scene's
 *  usable stage is a few units across; anything beyond this is not a placement, it is an
 *  accident. Measured 2026-08-25: slot0 was persisted at z=-2665 (a near-horizontal drag
 *  ray intersecting the ground plane out at the horizon), so every boot restored an
 *  avatar 2,600 units away — a perfectly healthy renderer showing NOTHING, no errors,
 *  which read as "Desk is broken".
 *
 *  10 was the first value and it was STILL a hole: full-body camera framing shows only
 *  about ±2 units of stage, so a click-teleport artifact at e.g. x=-8 (see
 *  useAvatarDrag's delta rework) was LEGAL to the sanitizer and invisible to the owner
 *  — every character switch reloaded the window and faithfully restored an avatar just
 *  off-camera, which read as "changing avatars breaks it AGAIN" after every other leg
 *  of this saga was already fixed. The bound must be the VISIBLE stage, not a number
 *  that merely excludes the horizon: an entry the owner cannot see or grab is exactly
 *  as lost at x=8 as at z=-2665. */
export const POSITION_BOUND = 2;
const SCALE_MIN = 0.05;
const SCALE_MAX = 10;

/** A stored transform is only usable if every number is finite and inside the stage.
 *  An out-of-bounds entry is dropped (fall back to the default placement) rather than
 *  clamped: clamping a horizon-drag artifact would pin the avatar to a stage edge the
 *  owner never chose, which is a second surprise instead of a recovery. */
export function sane(entry: unknown): entry is AvatarTransform {
  if (!entry || typeof entry !== 'object') return false;
  const t = entry as { position?: unknown; scale?: unknown };
  if (!Array.isArray(t.position) || t.position.length !== 3) return false;
  if (!t.position.every((v) => Number.isFinite(v) && Math.abs(v as number) <= POSITION_BOUND))
    return false;
  return typeof t.scale === 'number' && t.scale >= SCALE_MIN && t.scale <= SCALE_MAX;
}

export function sanitizeLayout(parsed: unknown): Record<string, AvatarTransform> {
  if (!parsed || typeof parsed !== 'object') return {};
  const cleaned: Record<string, AvatarTransform> = {};
  for (const [slot, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (sane(entry)) cleaned[slot] = entry;
  }
  return cleaned;
}

function loadStored(): Record<string, AvatarTransform> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return sanitizeLayout(JSON.parse(raw));
  } catch {
    return {}; // private window / cleared site data / storage disabled -- render with defaults
  }
}

function persist(layout: Record<string, AvatarTransform>) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    /* best-effort only -- a failed write must not break rendering */
  }
}

/**
 * Per-avatar-slot position + scale, independent of every other slot and of the shared
 * OrbitControls camera. Fixes: avatars got put into one shared group with a fixed
 * x-offset and no way to move or resize any one of them individually -- rotating the
 * camera rotated the whole arrangement together because there was nothing PER-AVATAR to
 * move in the first place.
 *
 * Persisted to localStorage so a window reload remembers where everyone was put; a slot
 * with no stored entry yet falls back to `defaultFor(slotId)` (the caller's initial
 * placement -- e.g. the existing x-offset spacing for a freshly spawned extra slot).
 */
export function useAvatarLayout(defaultFor: (slotId: string) => AvatarTransform) {
  const [layout, setLayout] = useState<Record<string, AvatarTransform>>(loadStored);
  // defaultFor is recreated every render (it closes over live component state in the
  // caller); read it through a ref so the setters below don't need it in their deps and
  // don't churn identity every render.
  const defaultForRef = useRef(defaultFor);
  defaultForRef.current = defaultFor;

  useEffect(() => {
    persist(layout);
  }, [layout]);

  const getTransform = useCallback(
    (slotId: string): AvatarTransform => layout[slotId] ?? defaultForRef.current(slotId),
    [layout],
  );

  const setPosition = useCallback((slotId: string, position: [number, number, number]) => {
    setLayout((current) => ({
      ...current,
      [slotId]: {
        position,
        scale: current[slotId]?.scale ?? defaultForRef.current(slotId).scale,
      },
    }));
  }, []);

  const setScale = useCallback((slotId: string, scale: number) => {
    setLayout((current) => ({
      ...current,
      [slotId]: {
        position: current[slotId]?.position ?? defaultForRef.current(slotId).position,
        scale,
      },
    }));
  }, []);

  /** Drop a slot's stored transform (e.g. on remove_avatar) so a LATER slot reusing the
   *  same slot id (nextFreeSlotId() reuses freed ids) doesn't inherit a stranger's spot. */
  const clearSlot = useCallback((slotId: string) => {
    setLayout((current) => {
      if (!(slotId in current)) return current;
      const next = { ...current };
      delete next[slotId];
      return next;
    });
  }, []);

  return { getTransform, setPosition, setScale, clearSlot };
}
