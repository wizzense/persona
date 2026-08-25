import { useCallback, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';

import { POSITION_BOUND as DRAG_BOUND } from './useAvatarLayout';
import {
  activated as dragActivated,
  dragTarget,
  worldPerPixel,
} from './avatarDragMath';

/**
 * Drag an avatar across the ground (X/Z) plane.
 *
 * Not drei's PivotControls (a gizmo with its own controlled-matrix API) -- the shared
 * OrbitControls camera owns rotation, so this only needs to (a) grab ONE avatar on
 * pointerdown when the pointer is actually over it, (b) suspend orbit for the duration,
 * and (c) release everything on pointerup even if the pointer leaves the canvas or the
 * avatar mid-drag. Window-level listeners guarantee (c) -- a plain r3f onPointerMove
 * bound to the mesh does not: the pointer can outrun a small/fast-moving mesh and simply
 * stop delivering events, leaving the drag "stuck on".
 *
 * De-jank rework: `onMove` is expected to mutate the THREE object IMPERATIVELY (a ref),
 * not setState -- a setState per pointermove forces a React re-render between the
 * pointer moving and the avatar following it, which is the measured "janky as fuck"
 * stutter. Commit to persisted state ONCE, in `onEnd`.
 *
 * SCREEN-SPACE rework (the fly-away fix, 2026-08-25): every earlier version moved the
 * avatar by raycasting the pointer against the world ground plane. With the desk camera
 * nearly horizontal, the ground ray's intersection distance is wildly nonlinear -- a
 * fast flick swings the hit point from a few units to the horizon, so a "click too
 * fast" teleported the avatar meters away (reported twice: the bare-click teleport, and
 * again after the delta rework, because delta-of-ray-hit inherits the same singularity).
 * Screen-space mapping has no singularity: convert the pointer's PIXEL delta to world
 * units at the avatar's own depth (world-per-pixel is linear there by definition). A
 * fast flick can only ever move the avatar as far as its pixels say -- no ray, no
 * horizon, no fly-away -- and a sub-5px click still moves nothing at all.
 */
export function useAvatarDrag(
  onMove: (x: number, z: number) => void,
  getStart: () => { x: number; z: number },
) {
  const { camera, gl } = useThree();
  const draggingRef = useRef(false);

  /** Call from onPointerDown with the native event's clientX/clientY. `onEnd` fires
   *  exactly once, on pointerup, wherever it happens -- re-enable orbit AND commit the
   *  final position to persisted state there. */
  const beginDrag = useCallback(
    (clientX: number, clientY: number, onEnd: () => void) => {
      if (draggingRef.current) return;
      draggingRef.current = true;
      const start = getStart();
      const startClientX = clientX;
      const startClientY = clientY;
      let isActive = false;

      // World units per pixel AT THE AVATAR'S DEPTH (pure math lives in
      // avatarDragMath.ts — the module the fly-away test hammers, so what the
      // test pins is exactly what runs). Camera is PerspectiveCamera (fov 20
      // in the desk scene); square pixels mean one wpp serves both axes.
      const rect = gl.domElement.getBoundingClientRect();
      const fov = camera instanceof THREE.PerspectiveCamera ? camera.fov : 45;
      const depth = camera.position.distanceTo(
        new THREE.Vector3(start.x, 1, start.z),
      );
      const wpp = worldPerPixel(depth, fov, Math.max(1, rect.height));
      const frame = {
        start,
        startClient: { x: startClientX, y: startClientY },
        wpp,
        bound: DRAG_BOUND,
      };

      const handleMove = (event: PointerEvent) => {
        if (!isActive) {
          const travelled = Math.hypot(
            event.clientX - startClientX,
            event.clientY - startClientY,
          );
          if (!dragActivated(travelled)) return; // click-sized wiggle: not a drag
          isActive = true;
        }
        const target = dragTarget(frame, event.clientX, event.clientY);
        onMove(target.x, target.z);
      };
      const handleUp = () => {
        draggingRef.current = false;
        window.removeEventListener('pointermove', handleMove);
        window.removeEventListener('pointerup', handleUp);
        onEnd();
      };
      window.addEventListener('pointermove', handleMove);
      window.addEventListener('pointerup', handleUp);
    },
    [camera, getStart, gl, onMove],
  );

  return { beginDrag, isDragging: () => draggingRef.current };
}
