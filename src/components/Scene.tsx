import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Canvas, createPortal } from '@react-three/fiber';
import { useThree } from '@react-three/fiber';
import { Environment, Html, OrbitControls } from '@react-three/drei';
import dawnEnvironment from '@pmndrs/assets/hdri/dawn.exr';
import * as THREE from 'three';
import { Avatar, type AvatarProps } from './Avatar';
import type { AnimationType } from '../animation-catalog';
import { calculateFullBodyFraming } from '../camera-framing';
import { POSITION_BOUND, useAvatarLayout, type AvatarTransform } from '../hooks/useAvatarLayout';
import { arrange, isArrangement } from '../stage/arrangements';
import { useAvatarDrag } from '../hooks/useAvatarDrag';
import { authoredFields, freeSpot } from '../hooks/stagePlacement';
import { anyoneAudible } from '../hooks/voiceLevels';
import type { VRM } from '@pixiv/three-vrm';
import { applySpringScale, applyCustomise, sanitizeSpringTuning, DEFAULT_SPRING_TUNING, type DeskSpringTuning, type DeskCustomise } from '../hooks/useVrmLoader';
import type { SpeechBubble } from '../speech-bubble';
import { SpeechBubbleView } from './SpeechBubbleView';

/** How long an authored placement waits for its slot to go live (see applyPlace).
 *  One render is all it needs; a second is generous and keeps a placement for a
 *  slot that never spawns from lingering into the next body that reuses the id. */
const PLACE_PENDING_MS = 1000;
const MIN_SCALE = 0.3;
const MAX_SCALE = 3;
const clampScale = (value: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
/** The caption's anchor, in the HEAD BONE's own space: just over the crown.
 *  It used to be a guessed height in the avatar group's units (1.78, "a VRM is
 *  about 1.6 tall"), and on the real desk that landed ~290 px above the head and
 *  outside the window entirely -- the group's units are not the model's metres.
 *  A bone is: normalized humanoid bones are in metres whatever the group scale,
 *  and parenting to it makes the caption follow a head tilt for free. */
const BUBBLE_OVER_HEAD = 0.2;
/** Only until the model has loaded and there is a head to anchor to. */
const BUBBLE_FALLBACK_HEIGHT = 1.2;

interface SceneProps {
  animation: AnimationType | string;
  animationRequest: number;
  audioLevel: number;
  onAnimationComplete: () => void;
  playback: 'loop' | 'once';
  speaking: boolean;
  extraSlots?: Array<{ slotId: string; modelUrl: string }>;
  /** Mouth state per spawned slot (the room stage speaks through these). */
  slotVoices?: Record<string, { level: number; speaking: boolean }>;
  /** What each body is saying, as text -- shown over its head, and the ONLY
   *  trace of a line when that speaker (or the whole room) is muted. */
  bubbles?: Record<string, SpeechBubble>;
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
  // Measured: this used to guard on `framedObject.current === object` and
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

    // 🚩 ZOOM FILLS THE FRAME WITH ONE PERSON; A GROUP MUST FIT. zoom 1.5 moves
    // the camera a third closer than "everything fits", which is right for the
    // resident alone and wrong the moment there are two: the union box is wide,
    // a portrait overlay is width-bound, and the third that gets cropped is a
    // BODY at the edge. Measured 2026-09-19 over CDP with three bodies in a
    // 430x680 window: one clipped to a sliver, one entirely outside the frame,
    // while the layout said all three stood within x = ±1.6.
    const framing = calculateFullBodyFraming(
      box,
      camera.fov,
      camera.aspect,
      1.12,
      framed.length > 1 ? 1 : 1.5,
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

/** Frames per second the stage renders at. The display here runs rAF at ~95 Hz
 *  and R3F's default loop rendered (and ran every body's physics) at that rate
 *  whether or not anything moved: measured 2026-09-18 with three bodies, 5.5 s
 *  of script per 6 s. The loop is now on DEMAND and this governor asks for
 *  frames: 60 Hz while anyone is audible or the stage is being handled, 30 Hz
 *  otherwise -- idle animation and hair read the same at 30. */
const ACTIVE_FPS = 60;
const IDLE_FPS = 30;
/** Keep full rate this long after the last pointer/wheel input (orbit damping, drags). */
const INTERACTION_TAIL_MS = 1500;

/** Pure: the frame interval the governor wants right now. */
function frameIntervalMs(active: boolean): number {
  return 1000 / (active ? ACTIVE_FPS : IDLE_FPS);
}

function FrameGovernor() {
  const invalidate = useThree((state) => state.invalidate);
  const gl = useThree((state) => state.gl);
  useEffect(() => {
    let raf = 0;
    let last = 0;
    let lastInput = -Infinity;
    const onInput = () => {
      lastInput = performance.now();
    };
    const el = gl.domElement;
    el.addEventListener('pointerdown', onInput);
    el.addEventListener('pointermove', onInput);
    el.addEventListener('wheel', onInput, { passive: true });
    const loop = (t: number) => {
      const active =
        anyoneAudible() || orbitSuspend.depth > 0 || t - lastInput < INTERACTION_TAIL_MS;
      if (t - last >= frameIntervalMs(active) - 1) {
        last = t;
        invalidate();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('pointerdown', onInput);
      el.removeEventListener('pointermove', onInput);
      el.removeEventListener('wheel', onInput);
    };
  }, [gl, invalidate]);
  return null;
}

interface PlacedAvatarProps {
  slotId: string;
  transform: AvatarTransform;
  onDrag: (position: [number, number, number]) => void;
  onScale: (scale: number) => void;
  /** Committed yaw after a ROT-mode drag on THIS avatar (radians). */
  onRotate: (yaw: number) => void;
  /** Clean LEFT-CLICK (no drag) on the avatar: the contextual "bring this one
   *  front and center" action — also the recovery move when an avatar got lost. */
  avatarProps: Omit<AvatarProps, 'onReady'>;
  onReady: (scene: THREE.Object3D) => void;
  bubble?: SpeechBubble;
  /** The owner's physics knobs for THIS body (cast.json `physics`, via a
   *  `tune-avatar` event). Multipliers over the model's authored springs. */
  physics?: DeskSpringTuning;
  /** A forked character's recipe (character.json `customise`, via a
   *  `customise-avatar` event): this body renders its BASE's mesh with these
   *  deltas applied. Absent for an ordinary character. */
  customise?: DeskCustomise;
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
 *  pointer moving and the avatar following it (the "janky" stutter). The
 *  position is committed to persisted layout state ONCE, on pointerup. All live values
 *  (y, scale) are read through refs so a re-render mid-drag can never strand the drag on
 *  a stale closure. */
function PlacedAvatar({ slotId, transform, onDrag, onScale, onRotate, avatarProps, onReady, bubble, physics, customise }: PlacedAvatarProps) {
  const getThreeState = useThree((state) => state.get);
  const groupRef = useRef<THREE.Group>(null);
  const transformRef = useRef(transform);
  transformRef.current = transform;
  const physicsRef = useRef(physics ?? DEFAULT_SPRING_TUNING);
  physicsRef.current = physics ?? DEFAULT_SPRING_TUNING;
  const customiseRef = useRef(customise);
  customiseRef.current = customise;
  const draggingRef = useRef(false);
  // Where the left button went down, so pointerup can tell a CLICK (focus the
  // avatar) from a DRAG (move/rotate) — the same 5-6px band the drag hook uses.
  const clickStartRef = useRef<{ x: number; y: number } | null>(null);
  // Plan: click/hold-to-talk on the avatar (owner 2026-09-22: "let you click
  // on the avatar... hold a button to talk"). Scoped to slot0 (Aither's own
  // resident body) -- the mic is ONE global stream, not per-avatar, so only
  // the body that answers by voice should trigger it; another session's
  // avatar is a future "steer that session" gesture, not this one.
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdingTalkRef = useRef(false);
  const TALK_HOLD_MS = 260;
  const TALK_CLICK_PX = 8;
  // How far a right-button press travelled: a right-DRAG turns the body and
  // must not also open the menu on release; a right-CLICK (no travel) does.
  const rightTravelRef = useRef(0);

  // The VRM behind this slot, once loaded: the spring compensation below needs
  // it, and only the loader hangs it on the scene (scene.userData.vrm).
  const vrmRef = useRef<VRM | null>(null);
  // The head bone the caption is parented to. STATE, not a ref: the bubble has to
  // re-render into the bone the moment the model lands.
  const [headBone, setHeadBone] = useState<THREE.Object3D | null>(null);

  // Committed transform -> group, EXCEPT while a drag owns the group imperatively.
  useLayoutEffect(() => {
    if (draggingRef.current) return;
    const group = groupRef.current;
    if (!group) return;
    group.position.set(...transform.position);
    group.scale.setScalar(transform.scale);
    group.rotation.y = transform.yaw ?? 0;
    // The layout scale is what the springs cannot see (applySpringScale): a
    // persisted 0.4 shoved every hair chain out over a 2.5x-too-big head
    // collider on every boot (owner, 2026-09-13). Re-derive the spring
    // constants from the SAME number that scaled the group, in the same effect.
    if (vrmRef.current) applySpringScale(vrmRef.current, transform.scale, physicsRef.current);
    // Keyed on the VALUES: a slot with no stored layout gets a fresh default
    // object every render, and an identity dep re-ran this (and the spring
    // rescale over every joint) on each one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transform.position[0], transform.position[1], transform.position[2], transform.scale, transform.yaw]);

  // The physics knobs change on their own clock (a fader in the Cast pane, a
  // cast.json edit): re-derive the springs from the SAME scale the group has,
  // without touching the layout. Keyed on the values for the same reason as above.
  const p = physics ?? DEFAULT_SPRING_TUNING;
  useEffect(() => {
    if (vrmRef.current) applySpringScale(vrmRef.current, transformRef.current.scale, physicsRef.current);
  }, [p.enabled, p.weight, p.stiffness, p.damping, p.jiggle]);

  // The recipe changes on its own clock (a fork edited while the desk runs).
  // applyCustomise is idempotent over the AUTHORED values, so re-applying a
  // changed recipe does not compound.
  const recipeKey = customise ? JSON.stringify(customise) : '';
  useEffect(() => {
    if (vrmRef.current) applyCustomise(vrmRef.current, customiseRef.current);
  }, [recipeKey]);

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
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const handleReady = useCallback(
    (scene: THREE.Object3D, vrm?: VRM) => {
      // The model usually lands AFTER the layout effect restored the scale, so
      // the compensation must also run here, with the scale the group already has.
      vrmRef.current = vrm ?? null;
      if (vrm) applySpringScale(vrm, transformRef.current.scale, physicsRef.current);
      // The fork's own look, on the shared mesh. Before onReady, so nothing
      // downstream measures the body at its un-customised proportions.
      if (vrm) applyCustomise(vrm, customiseRef.current);
      setHeadBone(vrm?.humanoid?.getNormalizedBoneNode('head') ?? null);
      setReady(true);
      onReadyRef.current(scene);
    },
    [],
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
              if (slotId === 'slot0') {
                holdingTalkRef.current = false;
                if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
                holdTimerRef.current = setTimeout(() => {
                  holdTimerRef.current = null;
                  if (!clickStartRef.current) return; // already released -> was a tap, not a hold
                  holdingTalkRef.current = true;
                  void window.deskBridge?.runCommand?.('voice.talk'); // toggle idle -> listening
                }, TALK_HOLD_MS);
              }
            }
            if (event.button !== 0 && event.button !== 2) return;
            // Gestures, v5 (2026-09-18, owner: the right-click move was
            // broken and confusing; make it intuitive). No
            // mode, no modifier: each button means ONE thing on a body.
            //   left-drag  = MOVE this body      right-drag = TURN this body
            //   wheel      = size this body      right-CLICK = its menu
            // Empty space: left-drag orbits the camera. Camera pan is OFF
            // (OrbitControls enablePan=false) -- a right-drag that shoved the
            // whole scene sideways was what read as "moving one moves all".
            const { controls } = getThreeState();
            const orbit = controls as { enabled?: boolean } | null;
            if (event.button === 2) {
              // Right-DRAG turns THIS avatar (yaw). A right-click that never
              // travels reaches onContextMenu below and opens the menu instead.
              event.stopPropagation();
              suspendOrbit(orbit);
              draggingRef.current = true;
              const startX = event.nativeEvent.clientX;
              const startYaw = groupRef.current?.rotation.y ?? transformRef.current.yaw ?? 0;
              rightTravelRef.current = 0;
              const onMove = (move: PointerEvent) => {
                rightTravelRef.current = Math.max(rightTravelRef.current, Math.abs(move.clientX - startX));
                const group = groupRef.current;
                if (group) group.rotation.y = startYaw + (move.clientX - startX) * 0.012;
              };
              const onUp = () => {
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                draggingRef.current = false;
                resumeOrbit(orbit);
                const group = groupRef.current;
                if (group) onRotate(group.rotation.y);
              };
              window.addEventListener('pointermove', onMove);
              window.addEventListener('pointerup', onUp);
              return;
            }
            event.stopPropagation();
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
            // 🚩 A LEFT-CLICK DOES NOTHING TO THE CAMERA (2026-09-19, owner: "with
            // multiple avatars on stage, clicking or interacting suddenly makes
            // one or more of them completely disappear"). Until today a click
            // that travelled <6px was "Focus camera here": FullBodyCamera then
            // framed ONLY that body, and every other body fell out of the frame.
            // Reproduced over CDP with three bodies -- one synthetic left click,
            // two bodies gone. A vanish with no undo the owner can find ("Frame
            // everyone" lives in a menu) is not a gesture; focus stays available
            // where it is explicit, the per-avatar context menu.
            if (event.button !== 0 || !clickStartRef.current) return;
            if (slotId === 'slot0') {
              if (holdTimerRef.current) {
                clearTimeout(holdTimerRef.current);
                holdTimerRef.current = null;
              }
              const start = clickStartRef.current;
              const travel = Math.hypot(
                event.nativeEvent.clientX - start.x,
                event.nativeEvent.clientY - start.y,
              );
              if (holdingTalkRef.current) {
                // A completed hold ALWAYS stops on release, even if the
                // avatar also moved -- the mic must never be left stuck open.
                holdingTalkRef.current = false;
                void window.deskBridge?.runCommand?.('voice.talk');
              } else if (travel <= TALK_CLICK_PX) {
                // A quick tap that never triggered the hold timer: toggle,
                // same as the hotkey.
                void window.deskBridge?.runCommand?.('voice.talk');
              }
              // travel > TALK_CLICK_PX with no completed hold: a genuine
              // drag, already handled by beginDrag/onDrag -- no talk action.
            }
            clickStartRef.current = null;
          }}
          onContextMenu={(event) => {
            // OrbitControls preventDefault()s contextmenu (right-drag pans), which kills
            // Electron's own menu event — so the per-avatar menu goes through the bridge,
            // same pattern the deck trigger uses. A plain right-CLICK lands here; a
            // right-DRAG turns the body (pointerdown above) and never does.
            event.stopPropagation();
            if (rightTravelRef.current >= 6) return;
            window.deskBridge?.avatarContextMenu(slotId);
          }}
        >
          <boxGeometry args={[1.8, 2.1, 1.0]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      ) : null}
      <Avatar {...avatarProps} onReady={handleReady} />
      {bubble ? (() => {
        // pointer-events are off end to end: the caption sits right where the
        // owner grabs an avatar, and one that eats the drag would make a talking
        // agent impossible to move.
        const html = (
          <Html
            key={bubble.seq}
            position={[0, headBone ? BUBBLE_OVER_HEAD : BUBBLE_FALLBACK_HEIGHT, 0]}
            center
            zIndexRange={[30, 0]}
            style={{ pointerEvents: 'none' }}
          >
            <SpeechBubbleView bubble={bubble} />
          </Html>
        );
        return headBone ? createPortal(html, headBone) : html;
      })() : null}
    </group>
  );
}

export function Scene(props: SceneProps) {
  const [avatarScene, setAvatarScene] = useState<THREE.Object3D | null>(null);
  const handleAvatarReady = useCallback((scene: THREE.Object3D) => {
    setAvatarScene(scene);
  }, []);

  const { extraSlots = [] } = props;

  // The live layout, readable from the placement default without a dependency
  // cycle (the hook that owns the layout takes the default as its input).
  const layoutRef = useRef<Record<string, AvatarTransform>>({});
  const defaultTransform = useCallback(
    (slotId: string): AvatarTransform => {
      if (slotId === 'slot0') return { position: [0, 0, 0], scale: 1 };
      // The nearest FREE spot, never an index: two spawned bodies used to land
      // on the same point after a removal (see stagePlacement.ts).
      //
      // A slot that has never been dragged has NO layout entry, and reading
      // only stored entries dropped it from `occupied` entirely -- so every
      // freshly spawned body computed the SAME first free spot and they landed
      // exactly on top of each other. Overlapping bodies share one raycast
      // target, so a click moves the front one and the rest read as having
      // disappeared (owner, 2026-09-19). Walking the roster in order and
      // assigning each unplaced slot the spot it WOULD take keeps the
      // computation deterministic and every body its own x.
      const occupied = [0];
      for (const slot of extraSlots) {
        if (slot.slotId === slotId) break;
        const stored = layoutRef.current[slot.slotId]?.position[0];
        occupied.push(typeof stored === 'number' ? stored : freeSpot(occupied, POSITION_BOUND));
      }
      for (const slot of extraSlots) {
        // Slots after this one in the roster can still hold a STORED position,
        // which this slot must not sit on; their defaults are decided above.
        if (slot.slotId === slotId) continue;
        const stored = layoutRef.current[slot.slotId]?.position[0];
        if (typeof stored === 'number' && !occupied.includes(stored)) occupied.push(stored);
      }
      return { position: [freeSpot(occupied, POSITION_BOUND), 0, 0], scale: 1 };
    },
    [extraSlots],
  );
  const { layout, getTransform, setPosition, setScale, setYaw, clearSlot } = useAvatarLayout(defaultTransform);
  layoutRef.current = layout;
  // An authored placement (`place-avatar`, the cast file via main) goes through the
  // SAME setters a drag does, one component at a time: an omitted or rejected field
  // leaves that component alone, so a defaulted slot keeps its free-spot placement
  // instead of having the default frozen into the stored layout. authoredFields()
  // has already dropped anything outside the stage bounds (drop, never clamp).
  const applyPlace = useCallback(
    (slotId: string, fields: ReturnType<typeof authoredFields>) => {
      if (fields.position) setPosition(slotId, fields.position);
      if (fields.scale !== undefined) setScale(slotId, fields.scale);
      if (fields.yaw !== undefined) setYaw(slotId, fields.yaw);
    },
    [setPosition, setScale, setYaw],
  );
  // 🚩 spawn-avatar is handled by App and reaches Scene as a PROP one render later,
  // so a place-avatar main sends right behind its spawn can arrive while the slot is
  // not yet in extraSlots. Dropping it would read as "the setting does nothing";
  // writing it straight into the layout would let a slot that never spawns leave a
  // spot for whatever later body reuses the id (the leak cleared just below). So it
  // waits here, briefly, and is applied the moment the slot goes live.
  const pendingPlaceRef = useRef(new Map<string, { fields: ReturnType<typeof authoredFields>; at: number }>());
  // Per-slot physics knobs (tune-avatar). Kept for slots that are not live yet
  // too -- main sends the tune right behind the spawn -- and dropped with the
  // slot below, so a reused id never inherits the last body's feel.
  const [physicsBySlot, setPhysicsBySlot] = useState<Record<string, DeskSpringTuning>>({});
  const [customiseBySlot, setCustomiseBySlot] = useState<Record<string, DeskCustomise>>({});
  // A removed slot's stored spot must not leak onto whatever LATER slot reuses that id
  // (nextFreeSlotId() reuses freed ids), so clear it the moment it drops out of extraSlots.
  const previousExtraIdsRef = useState(() => new Set<string>())[0];
  useLayoutEffect(() => {
    const liveIds = new Set(extraSlots.map((s) => s.slotId));
    for (const id of previousExtraIdsRef) {
      if (!liveIds.has(id)) {
        clearSlot(id);
        setPhysicsBySlot((current) => {
          if (!(id in current)) return current;
          const next = { ...current };
          delete next[id];
          return next;
        });
      }
    }
    previousExtraIdsRef.clear();
    liveIds.forEach((id) => previousExtraIdsRef.add(id));
    const now = Date.now();
    for (const [id, pending] of pendingPlaceRef.current) {
      if (now - pending.at > PLACE_PENDING_MS) pendingPlaceRef.current.delete(id);
      else if (liveIds.has(id)) {
        pendingPlaceRef.current.delete(id);
        applyPlace(id, pending.fields);
      }
    }
  }, [extraSlots, clearSlot, previousExtraIdsRef, applyPlace]);

  // Every avatar's ready scene object, slot 0 plus each spawned extra — this is what
  // FullBodyCamera unions to frame all of them, not just slot 0. A plain object keyed by
  // slotId (not an array pushed to) so a slot that unmounts (remove_avatar) cleanly drops
  // out rather than leaving a stale entry.
  const [extraScenes, setExtraScenes] = useState<Record<string, THREE.Object3D>>({});
  const handleExtraReady = useCallback((slotId: string, scene: THREE.Object3D) => {
    // BAIL OUT when nothing changed. This used to return a fresh object every
    // call, and it is called from a ready-effect that re-fired on every render
    // (the inline onReady below was a new closure each time): render -> effect
    // -> setState(new object) -> render, forever. Measured 2026-09-18 with three
    // stage bodies idle: R3F's commitUpdate/configure/deep-equal plus
    // applySpringScale burned ~1.4 s of every 6 s doing nothing.
    setExtraScenes((current) => (current[slotId] === scene ? current : { ...current, [slotId]: scene }));
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
  // The one focus entry point: the context menu's "Focus camera here" (main ->
  // desk:event). A left-click used to be a second one and it made bodies vanish.
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
      } else if (event.type === 'stage-arrange') {
        // Plan 40 slice G. Main names an ARRANGEMENT; the geometry lives here,
        // beside the bounds it has to respect (src/stage/arrangements.ts).
        const name = event.arrangement;
        if (!isArrangement(name)) return;
        const ids = ['slot0', ...extraSlots.map((slot) => slot.slotId)];
        if (name === 'reset') {
          ids.forEach((id) => clearSlot(id));
          return;
        }
        const placed = arrange(name, ids, {
          focus: event.slotId ?? null,
          pair: Array.isArray(event.pair) ? event.pair : [],
        });
        for (const [id, transform] of Object.entries(placed)) {
          setPosition(id, transform.position);
          setScale(id, transform.scale);
          setYaw(id, transform.yaw ?? 0);
        }
      } else if (event.type === 'tune-avatar') {
        // The owner's physics knobs for one body (cast.json `physics`, resolved
        // by main). Sanitised here: a dropped field is "as authored", never 0.
        const id = event.slotId;
        if (typeof id !== 'string' || !id) return;
        const tuning = sanitizeSpringTuning(event.physics);
        setPhysicsBySlot((current) => ({ ...current, [id]: tuning }));
      } else if (event.type === 'customise-avatar') {
        const id = event.slotId;
        if (typeof id !== 'string' || !id) return;
        setCustomiseBySlot((current) => ({ ...current, [id]: event.customise || {} }));
      } else if (event.type === 'place-avatar') {
        // One AUTHORED body, from the cast file via main: an exact spot for a named
        // agent, which is what the single free lane per side cannot express (see
        // stagePlacement's STAGE_STEP note). Same bounds as every other write.
        const id = event.slotId;
        if (typeof id !== 'string' || !id) return;
        const fields = authoredFields(event);
        if (id === 'slot0' || extraSlots.some((slot) => slot.slotId === id)) {
          applyPlace(id, fields);
        } else {
          pendingPlaceRef.current.set(id, { fields, at: Date.now() });
        }
      }
    });
  }, [focusSlot, clearSlot, extraSlots, setPosition, setScale, setYaw, applyPlace]);

  return (
    <Canvas
      camera={{ position: [0, 2, 4.8], fov: 20 }}
      frameloop="demand"
      // dpr capped at 1: this scene previously rendered at up to 1.5x device pixels,
      // i.e. ~2.25x the fill-rate, for an anti-aliased overlay nobody reads text in.
      // On a loaded box that supersampling is the difference between smooth and janky.
      dpr={1}
      gl={{
        // MSAA stays ON: off saves ~1.1 s of GL wait per 6 s under software present
        // (3.8 -> 2.65, measured 2026-09-18) and visibly staircases every outline.
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
      <FrameGovernor />
      <FullBodyCamera objects={allObjects} focusUuid={focusUuid} />
      {/* Slot 0: default avatar, drives voice/animation/audio — unchanged. Now individually
          draggable/scalable like every other slot; camera framing unions ALL avatars. */}
      <PlacedAvatar
        slotId="slot0"
        transform={getTransform('slot0')}
        onDrag={(position) => setPosition('slot0', position)}
        onScale={(scale) => setScale('slot0', scale)}
        onRotate={(yaw) => setYaw('slot0', yaw)}
        avatarProps={props}
        onReady={handleAvatarReady}
        bubble={props.bubbles?.slot0}
        physics={physicsBySlot.slot0}
        customise={customiseBySlot.slot0}
      />
      {/* Extra slots: spawned avatars, each independently draggable/scalable — no longer
          pinned to a fixed side-by-side offset once the owner has moved one. */}
      {extraSlots.map((slot) => {
        const mouth = props.slotVoices?.[slot.slotId];
        const avatarProps: Omit<AvatarProps, 'onReady'> = {
          animation: mouth?.speaking ? 'TALK' : 'IDLE',
          animationRequest: 0,
          audioLevel: mouth?.level ?? 0,
          onAnimationComplete: () => {},
          playback: 'loop',
          speaking: Boolean(mouth?.speaking),
          modelUrl: slot.modelUrl,
          slotId: slot.slotId,
        };
        return (
          <PlacedAvatar
            key={slot.slotId}
            slotId={slot.slotId}
            transform={getTransform(slot.slotId)}
            onDrag={(position) => setPosition(slot.slotId, position)}
            onScale={(scale) => setScale(slot.slotId, scale)}
            onRotate={(yaw) => setYaw(slot.slotId, yaw)}
            avatarProps={avatarProps}
            onReady={(scene) => handleExtraReady(slot.slotId, scene)}
            bubble={props.bubbles?.[slot.slotId]}
            physics={physicsBySlot[slot.slotId]}
            customise={customiseBySlot[slot.slotId]}
          />
        );
      })}
      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.08}
        enablePan={false}
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
