import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { useThree } from '@react-three/fiber';
import { Environment, OrbitControls } from '@react-three/drei';
import dawnEnvironment from '@pmndrs/assets/hdri/dawn.exr';
import * as THREE from 'three';
import { Avatar, type AvatarProps } from './Avatar';
import type { AnimationType } from '../animation-catalog';
import { calculateFullBodyFraming } from '../camera-framing';
import { useAvatarLayout, type AvatarTransform } from '../hooks/useAvatarLayout';
import { useAvatarDrag } from '../hooks/useAvatarDrag';
import { getDragMode } from '../hooks/useDragMode';

const MIN_SCALE = 0.3;
const MAX_SCALE = 3;
const clampScale = (value: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));

interface SceneProps {
  animation: AnimationType | string;
  animationRequest: number;
  audioLevel: number;
  onAnimationComplete: () => void;
  playback: 'loop' | 'once';
  speaking: boolean;
  extraSlots?: Array<{ slotId: string; modelUrl: string }>;
  /** Detached-window mode: render THIS character in slot0's spot instead of the default
   *  `./assets/model.vrm`. Set by App.tsx from the `?solo=` query param a detached
   *  avatar window is opened with (see detached-avatar-window.cjs). */
  modelUrl?: string;
}

interface TargetControls {
  target: THREE.Vector3;
  update: () => void;
}

function supportsTarget(controls: unknown): controls is TargetControls {
  if (!controls || typeof controls !== 'object') return false;
  const candidate = controls as Partial<TargetControls>;
  return candidate.target instanceof THREE.Vector3 &&
    typeof candidate.update === 'function';
}

// D-2xxx: extraSlots avatars WERE rendering — the bug was invisibility, not absence.
// spawn_avatar sent the event, App.tsx updated state, Scene.tsx mounted a real <Avatar> at
// a 1.6-unit x-offset — but FullBodyCamera framed ONLY slot 0's tight bounding box at a
// narrow 20deg FOV, so anything positioned beside slot 0 fell outside the frame entirely.
// The feature was fully wired and completely invisible, which reads identically to "not
// implemented" from the one vantage point that matters (what's on screen). Now frames the
// UNION of every avatar's bounding box, not just slot 0's — with zero extra slots this
// degenerates to exactly the old single-box behavior (a union of one box is that box), so
// nothing changes for the existing single-avatar case.
function FullBodyCamera({
  objects,
  focusUuid,
}: {
  objects: THREE.Object3D[];
  /** When set (per-avatar "Focus camera here"), frame ONLY the object with this uuid
   *  instead of the union of all avatars. Cleared by "Frame everyone". */
  focusUuid?: string | null;
}) {
  const getThreeState = useThree((state) => state.get);
  const controlsReady = useThree((state) => Boolean(state.controls));
  // D-2170: this used to guard on `framedObject.current === object` and
  // never re-run for the SAME avatar — so the window is user-resizable
  // (Electron default; nothing sets resizable:false) but resizing it left
  // the framing computed for the OLD aspect ratio in place, which reads as
  // the model being "cut off" the moment the window doesn't match whatever
  // size it first loaded at. Re-frame on size change too, not just on a
  // new avatar object.
  const size = useThree((state) => state.size);
  // Re-frame when the SET of objects changes (count and identity), not just on size —
  // spawning/removing an avatar must re-trigger framing even though slot 0's own object
  // reference never changes.
  const objectsKey = objects.map((o) => o.uuid).join(',');
  // Focus narrows the framed set to one avatar. A focus whose object has since been
  // removed filters to nothing and the effect returns early — the camera holds its last
  // framing until "Frame everyone" clears it, which is the least surprising hold.
  const framed = focusUuid ? objects.filter((o) => o.uuid === focusUuid) : objects;

  useLayoutEffect(() => {
    const { camera, controls } = getThreeState();
    if (
      framed.length === 0 ||
      !(camera instanceof THREE.PerspectiveCamera) ||
      !supportsTarget(controls)
    ) {
      return;
    }

    const box = new THREE.Box3();
    for (const object of framed) {
      object.updateWorldMatrix(true, true);
      box.union(new THREE.Box3().setFromObject(object));
    }
    if (box.isEmpty()) return;

    const framing = calculateFullBodyFraming(
      box,
      camera.fov,
      camera.aspect,
      1.12,
      1.5,
    );
    camera.position.copy(framing.position);
    camera.near = Math.max(0.01, framing.distance / 100);
    camera.far = Math.max(100, framing.distance * 100);
    camera.lookAt(framing.target);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    controls.target.copy(framing.target);
    controls.update();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- objectsKey stands in for objects' identities
  }, [controlsReady, getThreeState, objectsKey, focusUuid, size.width, size.height]);

  return null;
}

interface PlacedAvatarProps {
  slotId: string;
  transform: AvatarTransform;
  onDrag: (position: [number, number, number]) => void;
  onScale: (scale: number) => void;
  /** Clean LEFT-CLICK (no drag) on the avatar: the contextual "bring this one
   *  front and center" action — also the recovery move when an avatar got lost. */
  onFocus?: (slotId: string) => void;
  avatarProps: Omit<AvatarProps, 'onReady'>;
  onReady: (scene: THREE.Object3D) => void;
}

/** ALL avatars share ONE OrbitControls, so "disable on my drag start / enable on my drag
 *  end" from two avatars can race: A's drag-end re-enabled orbit while B was mid-drag,
 *  and the camera fought B's drag -- the measured "janky" half of the bug. Depth-count
 *  instead: orbit comes back only when the LAST active drag ends. Module-level is fine;
 *  one canvas per window (solo windows are separate processes with their own module). */
const orbitSuspend = { depth: 0 };
function suspendOrbit(orbit: { enabled?: boolean } | null) {
  if (orbit && orbitSuspend.depth++ === 0) orbit.enabled = false;
}
function resumeOrbit(orbit: { enabled?: boolean } | null) {
  orbitSuspend.depth = Math.max(0, orbitSuspend.depth - 1);
  if (orbit && orbitSuspend.depth === 0) orbit.enabled = true;
}

/** Wraps one Avatar in its OWN draggable/scalable group -- fixes "they just get put into
 *  the same box and rotate together, no individual movement or setting". Left-drag ON
 *  the avatar moves it across the ground plane; the shared OrbitControls camera still
 *  owns left-drag on EMPTY space (rotate). Scroll while hovering an avatar scales that
 *  one avatar only.
 *
 *  De-jank: during a drag the group is moved IMPERATIVELY via a ref every pointermove --
 *  the previous version setState'd per move, forcing a full React re-render between the
 *  pointer moving and the avatar following it (the "janky as fuck" stutter). The
 *  position is committed to persisted layout state ONCE, on pointerup. All live values
 *  (y, scale) are read through refs so a re-render mid-drag can never strand the drag on
 *  a stale closure. */
function PlacedAvatar({ slotId, transform, onDrag, onScale, onFocus, avatarProps, onReady }: PlacedAvatarProps) {
  const getThreeState = useThree((state) => state.get);
  const groupRef = useRef<THREE.Group>(null);
  const transformRef = useRef(transform);
  transformRef.current = transform;
  const draggingRef = useRef(false);
  // Where the left button went down, so pointerup can tell a CLICK (focus the
  // avatar) from a DRAG (move/rotate) — the same 5-6px band the drag hook uses.
  const clickStartRef = useRef<{ x: number; y: number } | null>(null);

  // Committed transform -> group, EXCEPT while a drag owns the group imperatively.
  useLayoutEffect(() => {
    if (draggingRef.current) return;
    const group = groupRef.current;
    if (!group) return;
    group.position.set(...transform.position);
    group.scale.setScalar(transform.scale);
  }, [transform]);

  const { beginDrag } = useAvatarDrag(
    (nx, nz) => {
      const group = groupRef.current;
      if (group) group.position.set(nx, transformRef.current.position[1], nz);
    },
    // Where the avatar IS when the pointer goes down: the drag's start, so the
    // screen-space delta applies on top of the real position, never a jump.
    () => ({
      x: groupRef.current?.position.x ?? transformRef.current.position[0],
      z: groupRef.current?.position.z ?? transformRef.current.position[2],
    }),
  );

  // ALL pointer interaction (grab, scale, wheel) lives on ONE invisible proxy box,
  // never on the group itself. R3F raycasts its whole interaction list on every
  // pointermove whenever any object carries move/over/out handlers -- and a
  // VRM-bearing group in that list makes every pointermove recurse tens of
  // thousands of triangles: the measured "laggy when moving it around"
  // (2026-08-25). A box that approximates the body is one raycast per move; the
  // VRM stays OUT of the interaction layer entirely. The proxy mounts only once
  // the VRM reports ready, preserving the "no grab cursor = still loading" tell.
  // opacity-0 material rather than visible=false so the proxy is unambiguously
  // raycastable on every three.js version.
  const [ready, setReady] = useState(false);
  const handleReady = useCallback(
    (scene: THREE.Object3D) => {
      setReady(true);
      onReady(scene);
    },
    [onReady],
  );

  return (
    <group
      ref={groupRef}
      position={transform.position}
      scale={transform.scale}
    >
      {ready ? (
        <mesh
          position={[0, 1.05, 0]}
          onPointerDown={(event) => {
            // Tell the preload's window-level right-click handler this click hit an
            // AVATAR (dataset flag on the canvas) so it opens the per-avatar menu via
            // main instead of the deck. R3F delivers every button to this handler, so
            // non-right clicks clear any stale flag from a drag that ended elsewhere.
            const canvasTarget = event.nativeEvent.target as HTMLElement | null;
            if (canvasTarget?.dataset) {
              if (event.button === 2) canvasTarget.dataset.rightOnAvatar = slotId;
              else delete canvasTarget.dataset.rightOnAvatar;
            }
            if (event.button === 0) {
              clickStartRef.current = {
                x: event.nativeEvent.clientX,
                y: event.nativeEvent.clientY,
              };
            }
            if (event.button !== 0) return; // left button only -- right-click stays the context menu
            // Gesture split, FINAL iteration (2026-08-25): v1 move-only, v2
            // Shift-move and v3 Shift-rotate all failed with the owner, because
            // one button cannot serve two intents on the same pixels and every
            // hidden modifier is undiscoverable. The intent is now EXPLICIT,
            // VISIBLE state: the drag-mode toggle (useDragMode; bead + panel
            // row). Default rotate — plain drag falls through to OrbitControls
            // and the avatar swivels exactly like every 3D surface on earth.
            // In move mode the same plain drag repositions it. Empty space
            // always rotates, whatever the mode.
            if (getDragMode() !== 'move') return;
            event.stopPropagation();
            const { controls } = getThreeState();
            const orbit = controls as { enabled?: boolean } | null;
            suspendOrbit(orbit);
            draggingRef.current = true;
            beginDrag(event.nativeEvent.clientX, event.nativeEvent.clientY, () => {
              draggingRef.current = false;
              resumeOrbit(orbit);
              const group = groupRef.current;
              if (group) {
                // Single commit: persists the final spot (localStorage-backed)
                // without a re-render storm during the gesture.
                onDrag([group.position.x, transformRef.current.position[1], group.position.z]);
              }
            });
          }}
          onPointerOver={() => {
            document.body.style.cursor = 'grab';
          }}
          onPointerOut={() => {
            document.body.style.cursor = '';
          }}
          onWheel={(event) => {
            event.stopPropagation();
            onScale(clampScale(transformRef.current.scale - event.nativeEvent.deltaY * 0.001));
          }}
          onPointerUp={(event) => {
            // Click vs drag: a left-click that never left the 6px band is the
            // contextual FOCUS action (center this avatar), whatever the drag
            // mode. A drag's pointerup either misses this handler (window-level
            // listener owns it) or travels >6px and falls through.
            if (event.button !== 0 || !clickStartRef.current) return;
            const travelled = Math.hypot(
              event.nativeEvent.clientX - clickStartRef.current.x,
              event.nativeEvent.clientY - clickStartRef.current.y,
            );
            clickStartRef.current = null;
            if (travelled < 6) onFocus?.(slotId);
          }}
          onContextMenu={(event) => {
            // OrbitControls preventDefault()s contextmenu (right-drag pans), which kills
            // Electron's own menu event — so the per-avatar menu goes through the bridge,
            // same pattern the deck trigger uses. A plain right-CLICK lands here; a
            // right-DRAG pans and never does.
            event.stopPropagation();
            window.deskBridge?.avatarContextMenu(slotId);
          }}
        >
          <boxGeometry args={[1.8, 2.1, 1.0]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      ) : null}
      <Avatar {...avatarProps} onReady={handleReady} />
    </group>
  );
}

export function Scene(props: SceneProps) {
  const [avatarScene, setAvatarScene] = useState<THREE.Object3D | null>(null);
  const handleAvatarReady = useCallback((scene: THREE.Object3D) => {
    setAvatarScene(scene);
  }, []);

  const { extraSlots = [] } = props;

  const defaultTransform = useCallback(
    (slotId: string): AvatarTransform => {
      if (slotId === 'slot0') return { position: [0, 0, 0], scale: 1 };
      const index = extraSlots.findIndex((slot) => slot.slotId === slotId);
      const xOffset = (index >= 0 ? index + 1 : 1) * 1.6;
      return { position: [xOffset, 0, 0], scale: 1 };
    },
    [extraSlots],
  );
  const { getTransform, setPosition, setScale, clearSlot } = useAvatarLayout(defaultTransform);
  // A removed slot's stored spot must not leak onto whatever LATER slot reuses that id
  // (nextFreeSlotId() reuses freed ids), so clear it the moment it drops out of extraSlots.
  const previousExtraIdsRef = useState(() => new Set<string>())[0];
  useLayoutEffect(() => {
    const liveIds = new Set(extraSlots.map((s) => s.slotId));
    for (const id of previousExtraIdsRef) {
      if (!liveIds.has(id)) clearSlot(id);
    }
    previousExtraIdsRef.clear();
    liveIds.forEach((id) => previousExtraIdsRef.add(id));
  }, [extraSlots, clearSlot, previousExtraIdsRef]);

  // Every avatar's ready scene object, slot 0 plus each spawned extra — this is what
  // FullBodyCamera unions to frame all of them, not just slot 0. A plain object keyed by
  // slotId (not an array pushed to) so a slot that unmounts (remove_avatar) cleanly drops
  // out rather than leaving a stale entry.
  const [extraScenes, setExtraScenes] = useState<Record<string, THREE.Object3D>>({});
  const handleExtraReady = useCallback((slotId: string, scene: THREE.Object3D) => {
    setExtraScenes((current) => ({ ...current, [slotId]: scene }));
  }, []);
  // Drop scenes for slots that no longer exist (remove_avatar) — otherwise a removed
  // avatar's LAST bounding box keeps being unioned into the camera framing forever.
  useLayoutEffect(() => {
    setExtraScenes((current) => {
      const liveIds = new Set(extraSlots.map((s) => s.slotId));
      const next: Record<string, THREE.Object3D> = {};
      let changed = false;
      for (const [id, scene] of Object.entries(current)) {
        if (liveIds.has(id)) next[id] = scene;
        else changed = true;
      }
      return changed ? next : current;
    });
  }, [extraSlots]);

  const allObjects = avatarScene
    ? [avatarScene, ...Object.values(extraScenes)]
    : [];

  // Per-avatar context-menu actions, delivered by main over the same desk:event wire
  // spawn/remove use. Subscribing HERE (not App) keeps every camera/layout write next
  // to the state it mutates; App's own subscription handles the spawn/remove half and
  // both listeners coexist (the preload subscribe returns its own unsubscribe).
  const [focusUuid, setFocusUuid] = useState<string | null>(null);
  // One focus entry point for both surfaces: the context menu's "Focus camera here"
  // (main -> desk:event) and the left-CLICK on an avatar (PlacedAvatar onFocus).
  const focusSlot = useCallback(
    (slotId: string | null) => {
      if (!slotId) {
        setFocusUuid(null);
      } else if (slotId === 'slot0') {
        setFocusUuid(avatarScene?.uuid ?? null);
      } else {
        setFocusUuid(extraScenes[slotId]?.uuid ?? null);
      }
    },
    [avatarScene, extraScenes],
  );
  useEffect(() => {
    const bridge = window.deskBridge;
    if (!bridge) return;
    return bridge.subscribe((event) => {
      if (event.type === 'focus-avatar') {
        focusSlot(event.slotId);
      } else if (event.type === 'reset-avatar-layout') {
        clearSlot(event.slotId);
      }
    });
  }, [focusSlot, clearSlot]);

  return (
    <Canvas
      camera={{ position: [0, 2, 4.8], fov: 20 }}
      // dpr capped at 1: this scene previously rendered at up to 1.5x device pixels,
      // i.e. ~2.25x the fill-rate, for an anti-aliased overlay nobody reads text in.
      // On a loaded box that supersampling is the difference between smooth and janky.
      dpr={1}
      gl={{
        antialias: true,
        alpha: true,
        powerPreference: 'high-performance',
        toneMapping: THREE.NoToneMapping,
        outputColorSpace: THREE.SRGBColorSpace,
      }}
      style={{ background: 'transparent' }}
    >
      <directionalLight
        color={[1, 1, 1]}
        position={[-3, 3, 3]}
        intensity={Math.PI}
      />
      <ambientLight
        color={[
          0.0036765073221525194,
          0.0036765073221525194,
          0.0036765073221525194,
        ]}
        intensity={Math.PI}
      />
      <Environment files={dawnEnvironment} />
      <FullBodyCamera objects={allObjects} focusUuid={focusUuid} />
      {/* Slot 0: default avatar, drives voice/animation/audio — unchanged. Now individually
          draggable/scalable like every other slot; camera framing unions ALL avatars. */}
      <PlacedAvatar
        slotId="slot0"
        transform={getTransform('slot0')}
        onDrag={(position) => setPosition('slot0', position)}
        onScale={(scale) => setScale('slot0', scale)}
        onFocus={focusSlot}
        avatarProps={props}
        onReady={handleAvatarReady}
      />
      {/* Extra slots: spawned avatars, each independently draggable/scalable — no longer
          pinned to a fixed side-by-side offset once the owner has moved one. */}
      {extraSlots.map((slot) => {
        const avatarProps: Omit<AvatarProps, 'onReady'> = {
          animation: 'IDLE',
          animationRequest: 0,
          audioLevel: 0,
          onAnimationComplete: () => {},
          playback: 'loop',
          speaking: false,
          modelUrl: slot.modelUrl,
        };
        return (
          <PlacedAvatar
            key={slot.slotId}
            slotId={slot.slotId}
            transform={getTransform(slot.slotId)}
            onDrag={(position) => setPosition(slot.slotId, position)}
            onScale={(scale) => setScale(slot.slotId, scale)}
            onFocus={focusSlot}
            avatarProps={avatarProps}
            onReady={(scene) => handleExtraReady(slot.slotId, scene)}
          />
        );
      })}
      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.08}
        enablePan
        enableZoom
        minDistance={1.4}
        maxDistance={12}
        panSpeed={0.7}
        rotateSpeed={0.45}
        screenSpacePanning
        zoomSpeed={0.8}
      />
    </Canvas>
  );
}
