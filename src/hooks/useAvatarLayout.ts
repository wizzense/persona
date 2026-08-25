import { useCallback, useEffect, useRef, useState } from 'react';

export interface AvatarTransform {
  position: [number, number, number];
  scale: number;
}

const STORAGE_KEY = 'persona.avatar-layout.v1';

function loadStored(): Record<string, AvatarTransform> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, AvatarTransform>) : {};
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
