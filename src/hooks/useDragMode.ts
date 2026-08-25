import { useEffect, useState } from 'react';

/**
 * The visible drag-mode toggle — the resolution of a three-way gesture fight
 * (all measured, owner-reported, 2026-08-25):
 *
 *   v1 plain-drag = move          -> "I can't rotate/swivel anymore"
 *   v2 Shift+drag = move          -> "I can't move the avatar at all"
 *   v3 plain-drag = move, Shift = rotate -> "I can drag to move but can't
 *                                     simply rotate... and fast clicks fly away"
 *
 * One button cannot serve two intents on the same pixels, and BOTH hidden
 * modifiers failed with the owner — so the intent is now EXPLICIT state:
 * plain drag on the avatar does exactly what the mode says, and the mode is
 * a visible toggle (bead + panel row) that persists. Default is rotate (the
 * gesture every 3D surface on earth has), so nothing changed for the
 * everyday case; moving is one labeled click away and stays until toggled.
 * Empty-space drag always rotates (OrbitControls owns it) regardless of mode.
 */
export type DragMode = 'rotate' | 'move';

const STORAGE_KEY = 'desk.drag-mode';

function readMode(): DragMode {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'move' ? 'move' : 'rotate';
  } catch {
    return 'rotate';
  }
}

let current: DragMode = readMode();
const listeners = new Set<(mode: DragMode) => void>();

function apply(mode: DragMode) {
  current = mode;
  for (const listener of listeners) listener(mode);
}

// Cross-window sync: the panel (deck window) and the avatar window are
// SIBLING windows on the same origin. localStorage writes in one fire a
// `storage` event in the others — without this, toggling the mode in the
// PANEL would update only the panel's copy and the avatar window would keep
// its old mode until a reload (measured class of bug, 2026-08-25: a visible
// toggle that silently does nothing in the window that matters).
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) {
      apply(event.newValue === 'move' ? 'move' : 'rotate');
    }
  });
}

export function getDragMode(): DragMode {
  return current;
}

export function setDragMode(mode: DragMode) {
  if (mode === current) return;
  apply(mode);
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* best-effort persistence — the toggle still works for this session */
  }
}

/** React binding: re-renders the caller when the mode changes (from any
 *  surface — bead, panel row, or another window's same-origin storage). */
export function useDragMode(): DragMode {
  const [mode, setMode] = useState<DragMode>(current);
  useEffect(() => {
    const listener = (next: DragMode) => setMode(next);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return mode;
}
