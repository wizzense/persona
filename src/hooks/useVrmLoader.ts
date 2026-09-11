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
 *  default so every chain settles downward; an authored non-zero value is
 *  respected untouched. Measured with an offscreen spring probe on the real
 *  models: gravity 0.6 → tail y −0.80, 1.0 → tail y −0.92, hair hangs at
 *  both; 1.0 matches VRoid Studio's own default. */
const DEFAULT_SPRING_GRAVITY = 1.0;

function applyDefaultSpringGravity(vrm: VRM) {
  const manager = vrm.springBoneManager as unknown as {
    joints?: Set<{
      settings?: { gravityPower?: number; gravityDir?: THREE.Vector3 };
    }>;
  } | null;
  if (!manager?.joints) return;
  for (const joint of manager.joints) {
    const settings = joint.settings;
    if (settings && !(Number(settings.gravityPower) > 0)) {
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
    return vrm;
  }, [gltf]);
}
