import { useCallback, useLayoutEffect, useRef, useState } from 'react';
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
function FullBodyCamera({ objects }: { objects: THREE.Object3D[] }) {
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

  useLayoutEffect(() => {
    const { camera, controls } = getThreeState();
    if (
      objects.length === 0 ||
      !(camera instanceof THREE.PerspectiveCamera) ||
      !supportsTarget(controls)
    ) {
      return;
    }

    const box = new THREE.Box3();
    for (const object of objects) {
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
  }, [controlsReady, getThreeState, objectsKey, size.width, size.height]);

  return null;
}

interface PlacedAvatarProps {
  slotId: string;
  transform: AvatarTransform;
  onDrag: (position: [number, number, number]) => void;
  onScale: (scale: number) => void;
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
function PlacedAvatar({ slotId, transform, onDrag, onScale, avatarProps, onReady }: PlacedAvatarProps) {
  const getThreeState = useThree((state) => state.get);
  const groupRef = useRef<THREE.Group>(null);
  const transformRef = useRef(transform);
  transformRef.current = transform;
  const draggingRef = useRef(false);

  // Committed transform -> group, EXCEPT while a drag owns the group imperatively.
  useLayoutEffect(() => {
    if (draggingRef.current) return;
    const group = groupRef.current;
    if (!group) return;
    group.position.set(...transform.position);
    group.scale.setScalar(transform.scale);
  }, [transform]);

  const { beginDrag } = useAvatarDrag(
    () => transformRef.current.position[1],
    (nx, nz) => {
      const group = groupRef.current;
      if (group) group.position.set(nx, transformRef.current.position[1], nz);
    },
  );

  return (
    <group
      ref={groupRef}
      position={transform.position}
      scale={transform.scale}
      onPointerDown={(event) => {
        if (event.button !== 0) return; // left button only -- right-click stays the context menu
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
            // Single commit: persists the final spot (localStorage-backed) without a
            // re-render storm during the gesture.
            onDrag([group.position.x, transformRef.current.position[1], group.position.z]);
          }
        });
      }}
      // Cursor feedback doubles as the "is this one ready yet?" tell: a VRM still
      // loading has no meshes to hover, so no grab cursor -- visibly not-ready instead
      // of silently ignoring the drag (the "the added one won't drag" report).
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
    >
      <Avatar {...avatarProps} onReady={onReady} />
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
      <FullBodyCamera objects={allObjects} />
      {/* Slot 0: default avatar, drives voice/animation/audio — unchanged. Now individually
          draggable/scalable like every other slot; camera framing unions ALL avatars. */}
      <PlacedAvatar
        slotId="slot0"
        transform={getTransform('slot0')}
        onDrag={(position) => setPosition('slot0', position)}
        onScale={(scale) => setScale('slot0', scale)}
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
