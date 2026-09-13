import {
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
}: AvatarProps) {
  const vrm = useVrmLoader(modelUrl ?? './assets/model.vrm');
  const { play, update: updateAnimation } = useVrmAnimation(vrm);
  const updateLipSync = useAmplitudeLipSync(vrm);
  const updateBlink = useBlink(vrm);

  useEffect(() => {
    void play(animation, { onComplete: onAnimationComplete, playback });
  }, [animation, animationRequest, onAnimationComplete, play, playback]);

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
    updateAnimation(step);
    updateBlink(step);
    updateLipSync(step, audioLevel, speaking);
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
