import { useCallback, useEffect, useRef } from 'react';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  VRMAnimationLoaderPlugin,
  VRMLookAtQuaternionProxy,
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
  // ONE clip per animation file per body. createVRMAnimationClip rebuilds every
  // humanoid track (it maps over every keyframe value) and the mixer keeps an
  // action per clip object, so re-creating the clip on each play() cost 1.7 s of
  // every 6 s with three bodies on stage and grew the mixer without bound
  // (measured 2026-09-18, CDP profile: createVRMAnimationHumanoidTracks on top).
  const clips = useRef(new Map<string, THREE.AnimationClip>());
  const currentPath = useRef<string | null>(null);
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
    // createVRMAnimationClip looks for this proxy as a DIRECT child of the scene
    // on every call and warns + adds one when it is missing; make it once.
    if (vrm.lookAt && !vrm.scene.children.some((o) => o instanceof VRMLookAtQuaternionProxy)) {
      const proxy = new VRMLookAtQuaternionProxy(vrm.lookAt);
      proxy.name = 'VRMLookAtQuaternionProxy';
      vrm.scene.add(proxy);
    }
    const clipCache = clips.current;
    return () => {
      animationMixer.removeEventListener('finished', handleFinished);
      animationMixer.stopAllAction();
      animationMixer.uncacheRoot(vrm.scene);
      clipCache.clear();
      currentPath.current = null;
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

        // Idempotent: asking for the loop that is already playing is a no-op, so
        // a re-render (or a re-fired effect) cannot restart or re-fade it.
        if (
          playback === 'loop' &&
          current.current?.isRunning() &&
          currentPath.current === path
        ) {
          return;
        }
        const animation = await load(path);
        if (generation !== requestGeneration.current || !mixer.current) return;
        let clip = clips.current.get(path);
        if (!clip) {
          clip = createVRMAnimationClip(animation, vrm);
          clips.current.set(path, clip);
        }
        const action = mixer.current.clipAction(clip);
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
        currentPath.current = path;
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
