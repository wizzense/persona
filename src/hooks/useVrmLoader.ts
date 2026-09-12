import { useMemo } from 'react';
import { useLoader } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRM, VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

/** VRoid exports routinely omit gravityPower — VRM 1.0's default is 0 — and a
 *  zero-gravity spring keeps its chain's AUTHORED rest direction forever. The
 *  active demon model authors its fox tail straight back and LEVEL (joint
 *  translations z +0.16… +0.38, y ≈ 0), so with no gravity the tail never
 *  drooped and hung horizontally on screen (owner, 2026-09-11: "hair and
 *  tools hang horizontally"). Joints that carry no gravity get a Studio-like
 *  default so every chain settles downward; an authored pull is respected
 *  untouched. Measured with an offscreen spring probe on the real models:
 *  gravity 0.6 → tail y −0.80, 1.0 → tail y −0.92, hair hangs at both; 1.0
 *  matches VRoid Studio's own default.
 *
 *  🚩 THE THRESHOLD IS 0.1, NOT 0, and the demon model is why (2026-09-12,
 *  owner: "hair is floating/sticking up"): its two rear hair chains author
 *  gravityPower 0.06 while the other ten author 0 — believing that epsilon
 *  ("a non-zero value is authored intent") left those two strands at ~zero
 *  gravity, FLOATING beside neighbours pulled down at 1.0. Measured by
 *  parsing VRMC_springBone directly: 0.06 appears on exactly 5 of 6 joints in
 *  two chains and nowhere else — a rounding artifact, not design. A value
 *  below 0.1 is noise; a value at or above it is authored intent. */
const DEFAULT_SPRING_GRAVITY = 1.0;
const AUTHORED_GRAVITY_FLOOR = 0.1;

export function applyDefaultSpringGravity(vrm: VRM) {
  const manager = vrm.springBoneManager as unknown as {
    joints?: Set<{
      settings?: { gravityPower?: number; gravityDir?: THREE.Vector3 };
    }>;
  } | null;
  if (!manager?.joints) return;
  for (const joint of manager.joints) {
    const settings = joint.settings;
    if (settings && !(Number(settings.gravityPower) >= AUTHORED_GRAVITY_FLOOR)) {
      settings.gravityPower = DEFAULT_SPRING_GRAVITY;
      settings.gravityDir = settings.gravityDir ?? new THREE.Vector3(0, -1, 0);
    }
  }
}

export function useVrmLoader(url: string): VRM | null {
  const gltf = useLoader(GLTFLoader, url, (loader) => {
    loader.register((parser) => new VRMLoaderPlugin(parser));
  });

  return useMemo(() => {
    const vrm = gltf.userData.vrm as VRM | undefined;
    if (!vrm) return null;
    VRMUtils.removeUnnecessaryVertices(vrm.scene);
    VRMUtils.combineSkeletons(vrm.scene);
    VRMUtils.combineMorphs(vrm);
    VRMUtils.rotateVRM0(vrm);
    applyDefaultSpringGravity(vrm);
    // A diagnostic seam: the avatar window is a transparent overlay whose
    // renderer exposes nothing else, so "why does the hair do that" was
    // unanswerable without a live handle. CDP (electron
    // --remote-debugging-port + scripts/cdp-shot.cjs) can now read spring
    // state and toggle settings per chain and screenshot the result.
    (window as unknown as { __deskVrm?: VRM }).__deskVrm = vrm;
    return vrm;
  }, [gltf]);
}
