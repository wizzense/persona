import { useCallback, useEffect, useRef } from 'react';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  VRMAnimationLoaderPlugin,
  createVRMAnimationClip,
  type VRMAnimation,
} from '@pixiv/three-vrm-animation';
import type { VRM } from '@pixiv/three-vrm';
import * as THREE from 'three';
import {
  nextAnimation,
  type AnimationType,
  isFileAnimation,
  parseFileAnimation,
} from '../animation-catalog';
import {
  configureAnimationAction,
  crossFadeAnimationActions,
  type AnimationPlayback,
} from '../animation-action';

interface PlayOptions {
  onComplete?: () => void;
  playback?: AnimationPlayback;
}

interface PendingCompletion {
  action: THREE.AnimationAction;
  callback: () => void;
  generation: number;
}

function transitionSeconds(previous: AnimationType | null, next: AnimationType): number {
  if (previous === 'TALK' && next === 'IDLE') return 1.15;
  if (next === 'TALK') return 0.85;
  return 0.7;
}

export function useVrmAnimation(vrm: VRM | null) {
  const mixer = useRef<THREE.AnimationMixer | null>(null);
  const current = useRef<THREE.AnimationAction | null>(null);
  const currentType = useRef<AnimationType | null>(null);
  const cache = useRef(new Map<string, VRMAnimation>());
  const previousAnimation = useRef(new Map<AnimationType, string>());
  const requestGeneration = useRef(0);
  const pendingCompletion = useRef<PendingCompletion | null>(null);

  useEffect(() => {
    if (!vrm) return;
    const animationHistory = previousAnimation.current;
    const animationMixer = new THREE.AnimationMixer(vrm.scene);
    const handleFinished = ({ action }: { action: THREE.AnimationAction }) => {
      const pending = pendingCompletion.current;
      if (
        pending?.action !== action ||
        pending.generation !== requestGeneration.current
      ) {
        return;
      }
      pendingCompletion.current = null;
      pending.callback();
    };
    animationMixer.addEventListener('finished', handleFinished);
    mixer.current = animationMixer;
    return () => {
      animationMixer.removeEventListener('finished', handleFinished);
      animationMixer.stopAllAction();
      mixer.current = null;
      current.current = null;
      currentType.current = null;
      pendingCompletion.current = null;
      animationHistory.clear();
    };
  }, [vrm]);

  const load = useCallback(async (path: string) => {
    const cached = cache.current.get(path);
    if (cached) return cached;
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
    const gltf = await loader.loadAsync(`./assets/animations/${path}`);
    const animation = gltf.userData.vrmAnimations?.[0] as VRMAnimation | undefined;
    if (!animation) throw new Error(`No VRM animation found in ${path}`);
    cache.current.set(path, animation);
    return animation;
  }, []);

  const play = useCallback(
    async (
      typeOrFile: AnimationType | string,
      { onComplete, playback = 'loop' }: PlayOptions = {},
    ) => {
      if (!vrm || !mixer.current) {
        if (playback === 'once') onComplete?.();
        return;
      }
      const generation = ++requestGeneration.current;
      pendingCompletion.current = null;
      try {
        let path: string;
        let type: AnimationType | null = null;

        if (isFileAnimation(typeOrFile)) {
          const filename = parseFileAnimation(typeOrFile);
          if (!filename) {
            if (playback === 'once') onComplete?.();
            return;
          }
          path = filename;
        } else {
          type = typeOrFile as AnimationType;
          path = nextAnimation(
            type,
            previousAnimation.current.get(type) ?? null,
          );
          previousAnimation.current.set(type, path);
        }

        const animation = await load(path);
        if (generation !== requestGeneration.current || !mixer.current) return;
        const action = mixer.current.clipAction(createVRMAnimationClip(animation, vrm));
        const fadeSeconds =
          type !== null ? transitionSeconds(currentType.current, type) : 0.3;
        action.reset();
        configureAnimationAction(action, playback);
        if (playback === 'once') {
          if (onComplete) {
            pendingCompletion.current = {
              action,
              callback: onComplete,
              generation,
            };
          }
        }
        crossFadeAnimationActions(current.current, action, fadeSeconds);
        current.current = action;
        currentType.current = type;
      } catch (error) {
        console.warn('[desk] animation load failed', error);
        if (generation === requestGeneration.current && playback === 'once') {
          onComplete?.();
        }
      }
    },
    [load, vrm],
  );

  const update = useCallback((delta: number) => mixer.current?.update(delta), []);
  return { play, update };
}
