import { useRef,
  Component,
  Suspense,
  useEffect,
  useLayoutEffect,
  type ReactNode,
} from 'react';
import { useFrame } from '@react-three/fiber';
import type * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import { useVrmLoader } from '../hooks/useVrmLoader';
import { getLevel } from '../hooks/voiceLevels';
import { useVrmAnimation } from '../hooks/useVrmAnimation';
import { useAmplitudeLipSync } from '../hooks/useAmplitudeLipSync';
import { useBlink } from '../hooks/useBlink';
import type { AnimationType } from '../animation-catalog';

export interface AvatarProps {
  animation: AnimationType | string;
  animationRequest: number;
  audioLevel: number;
  onAnimationComplete: () => void;
  playback: 'loop' | 'once';
  speaking: boolean;
  /** The loaded scene and, second, the VRM itself — the placement layer needs
   *  the spring manager (applySpringScale) and must not reach it by mutation. */
  onReady?: (scene: THREE.Object3D, vrm?: VRM) => void;
  modelUrl?: string;
  /** Which body this is; its mouth level is read from voiceLevels by this id. */
  slotId?: string;
}

function AvatarModel({
  animation,
  animationRequest,
  audioLevel,
  onAnimationComplete,
  playback,
  speaking,
  onReady,
  modelUrl,
  slotId,
}: AvatarProps) {
  const vrm = useVrmLoader(modelUrl ?? './assets/model.vrm');
  const { play, update: updateAnimation } = useVrmAnimation(vrm);
  const updateLipSync = useAmplitudeLipSync(vrm);
  const updateBlink = useBlink(vrm);

  // The completion callback rides a ref: for a stage body the parent hands a
  // fresh `() => {}` on every render, and as an effect dependency that re-fired
  // play() -- and rebuilt the clip -- on EVERY render of the scene.
  const onCompleteRef = useRef(onAnimationComplete);
  onCompleteRef.current = onAnimationComplete;
  useEffect(() => {
    void play(animation, { onComplete: () => onCompleteRef.current(), playback });
  }, [animation, animationRequest, play, playback]);

  useLayoutEffect(() => {
    if (vrm) onReady?.(vrm.scene, vrm);
  }, [onReady, vrm]);

  useFrame((_, delta) => {
    if (!vrm) return;
    // CLAMP the physics step (owner report, 2026-09-11: "hair and tools hang
    // horizontally"). This box shares one GPU with the whole fleet, so the
    // avatar's rAF stalls for a second or more while something else renders
    // (measured: the 62-avatar preview backfill). three-vrm's spring bones
    // integrate the RAW delta, and a single second-sized step overshoots every
    // hair/tool chain into a horizontal smear that barely recovers — it reads
    // as broken physics, not as a stall. 1/30 s is the largest step that still
    // integrates stably; anything longer is a stall, not elapsed time.
    const step = Math.min(delta, 1 / 30);
    // The level is a per-frame signal read from the store (voiceLevels.ts), not a
    // prop: as React state it re-rendered the whole scene every frame. The RATE
    // is the frame governor's job (Scene.tsx: 30 Hz idle, 60 Hz while anyone
    // speaks or is being handled), so there is no per-body frame skipping here.
    const level = Math.max(audioLevel, getLevel(slotId ?? 'slot0'));
    updateAnimation(step);
    updateBlink(step);
    updateLipSync(step, level, speaking || level > 0.02);
    vrm.update(step);
  });

  return vrm ? <primitive object={vrm.scene} /> : null;
}

/** A missing or broken VRM must cost the AVATAR, not the app. A fresh checkout
 *  has no model at all — Desk ships none (ASSET_LICENSES.md) — so the loader's
 *  404 throws, and with no boundary that error unmounts the whole tree,
 *  renderer IPC included: every deck event after it reads as "the app is
 *  broken", with an empty window as the only clue. Caught here, the scene
 *  renders empty and the tray/deck/character picker keep working, which is
 *  exactly the state a user needs to go enroll a character. Keyed by URL so a
 *  later enrollment (a new modelUrl) retries instead of staying failed. */
class AvatarLoadBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.warn(
      '[desk] character model failed to load — enroll one from the tray (Characters ▸ Get a model from VRoid Hub…)',
      error,
    );
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function Avatar(props: AvatarProps) {
  return (
    <AvatarLoadBoundary key={props.modelUrl ?? 'default'}>
      <Suspense fallback={null}>
        <AvatarModel {...props} />
      </Suspense>
    </AvatarLoadBoundary>
  );
}
