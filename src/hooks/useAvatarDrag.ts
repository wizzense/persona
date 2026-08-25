import { useCallback, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';

/**
 * Drag an avatar across the ground (X/Z) plane by raycasting the pointer against a
 * horizontal plane at the avatar's own Y.
 *
 * Not drei's PivotControls (a gizmo with its own controlled-matrix API) -- the shared
 * OrbitControls camera already owns left-drag on empty space to rotate, so this only
 * needs to (a) grab ONE avatar on pointerdown when the pointer is actually over it, (b)
 * suspend orbit for the duration, and (c) release everything on pointerup even if the
 * pointer leaves the canvas or the avatar mid-drag. Window-level listeners guarantee
 * (c) -- a plain r3f onPointerMove bound to the mesh does not: the pointer can outrun a
 * small/fast-moving mesh and simply stop delivering events, leaving the drag "stuck on".
 *
 * De-jank rework: `onMove` is expected to mutate the THREE object IMPERATIVELY (a ref),
 * not setState -- a setState per pointermove forces a React re-render between the
 * pointer moving and the avatar following it, which is the measured "janky as fuck"
 * stutter. Commit to persisted state ONCE, in `onEnd`. `getY` is a function (read from
 * a ref) instead of a captured number so a re-render mid-drag can never leave the drag
 * raycasting against a stale plane height.
 */
export function useAvatarDrag(getY: () => number, onMove: (x: number, z: number) => void) {
  const { camera, gl } = useThree();
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const plane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), []);
  const point = useMemo(() => new THREE.Vector3(), []);
  const ndc = useMemo(() => new THREE.Vector2(), []);
  const draggingRef = useRef(false);

  const raycastTo = useCallback(
    (clientX: number, clientY: number) => {
      const rect = gl.domElement.getBoundingClientRect();
      ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      plane.constant = -getY(); // live height, never a captured one
      raycaster.setFromCamera(ndc, camera);
      if (raycaster.ray.intersectPlane(plane, point)) onMove(point.x, point.z);
    },
    [camera, getY, gl, ndc, onMove, plane, point, raycaster],
  );

  /** Call from onPointerDown with the native event's clientX/clientY. `onEnd` fires
   *  exactly once, on pointerup, wherever it happens -- re-enable orbit AND commit the
   *  final position to persisted state there. */
  const beginDrag = useCallback(
    (clientX: number, clientY: number, onEnd: () => void) => {
      if (draggingRef.current) return;
      draggingRef.current = true;
      raycastTo(clientX, clientY);

      const handleMove = (event: PointerEvent) => raycastTo(event.clientX, event.clientY);
      const handleUp = () => {
        draggingRef.current = false;
        window.removeEventListener('pointermove', handleMove);
        window.removeEventListener('pointerup', handleUp);
        onEnd();
      };
      window.addEventListener('pointermove', handleMove);
      window.addEventListener('pointerup', handleUp);
    },
    [raycastTo],
  );

  return { beginDrag, isDragging: () => draggingRef.current };
}
