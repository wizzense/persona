/**
 * Per-body mouth levels, OUTSIDE React.
 *
 * The audio level changes every animation frame while anyone speaks, and the
 * native listener streams it even in silence. As React state that meant one
 * `setState` per frame → App → Scene → `<Canvas>` re-configured → every body
 * re-rendered: R3F's `commitUpdate` / `configure` / deep-equal showed up in the
 * CPU profile beside the physics (measured 2026-09-18, three bodies: 5.5 s of
 * script per 6 s). A level is a per-frame SIGNAL, not UI state — each body
 * reads its own level inside `useFrame`, and React hears only about the
 * speaking START/STOP transitions.
 */

const levels = new Map<string, number>();
let lastActiveAt = -Infinity;

/** Anything above this opens a mouth / counts as activity. */
export const AUDIBLE = 0.02;

export function setLevel(slotId: string, level: number): void {
  const v = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
  levels.set(slotId, v);
  if (v > AUDIBLE) lastActiveAt = now();
}

export function getLevel(slotId: string): number {
  return levels.get(slotId) ?? 0;
}

export function clearLevel(slotId: string): void {
  levels.delete(slotId);
}

/** True while any body is audible, and for `tailMs` after the last audible
 *  sample — the frame governor keeps full rate through a sentence's pauses. */
export function anyoneAudible(tailMs = 400): boolean {
  return now() - lastActiveAt <= tailMs;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Test seam. */
export function resetLevels(): void {
  levels.clear();
  lastActiveAt = -Infinity;
}
