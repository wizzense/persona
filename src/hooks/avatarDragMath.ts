/**
 * The pure drag math, extracted so a test can hammer it.
 *
 * The avatar-disappearing saga (2026-08-25) had the same fly-away defect THREE
 * times: jump-to-cursor teleport, then delta-of-ground-ray (which inherited the
 * horizon singularity — a fast flick swings the ground intersection from a few
 * units to hundreds), then the same again. The fix is screen-space mapping:
 * convert the pointer's PIXEL delta to world units at the avatar's depth, where
 * the mapping is linear BY DEFINITION — a flick can only move the avatar as far
 * as its pixels say, and the stage clamp is a hard bound, not an aspiration.
 * This module is that math with nothing else in it, because the previous
 * versions could not be tested and every one of them shipped the defect.
 */

export const DRAG_ACTIVATION_PX = 5;

export interface DragFrame {
  /** Where the avatar's ground position was when the pointer went down. */
  start: { x: number; z: number };
  /** Where the pointer went down. */
  startClient: { x: number; y: number };
  /** World units per screen pixel AT the avatar's depth (see worldPerPixel). */
  wpp: number;
  /** The farthest the avatar may sit from the origin, per axis. */
  bound: number;
}

/** World units per pixel at a given camera-to-target distance and vertical fov:
 *  2 * depth * tan(fov/2) / viewportHeightPx. Square pixels mean the same value
 *  serves both axes. */
export function worldPerPixel(
  depth: number,
  fovDegrees: number,
  viewportHeightPx: number,
): number {
  if (viewportHeightPx <= 0) return 0;
  const half = (fovDegrees * Math.PI) / 360;
  return (2 * depth * Math.tan(half)) / viewportHeightPx;
}

export function clampAxis(value: number, bound: number): number {
  return Math.max(-bound, Math.min(bound, value));
}

/** Is the pointer's travel since down a drag, or a click-sized wiggle? */
export function activated(travelPx: number): boolean {
  return travelPx >= DRAG_ACTIVATION_PX;
}

/** The avatar's new ground position for a pointer event at (clientX, clientY).
 *  Screen-right = world +x; screen-down = toward the camera = world +z (the
 *  desk camera looks down at the ground from in front). Every axis is clamped
 *  to the stage bound — a fast flick cannot leave the stage, by construction. */
export function dragTarget(
  frame: DragFrame,
  clientX: number,
  clientY: number,
): { x: number; z: number } {
  const dx = clientX - frame.startClient.x;
  const dy = clientY - frame.startClient.y;
  return {
    x: clampAxis(frame.start.x + dx * frame.wpp, frame.bound),
    z: clampAxis(frame.start.z + dy * frame.wpp, frame.bound),
  };
}
