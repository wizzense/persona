import { useEffect, useMemo } from 'react';
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

/** three-vrm's spring bones are SCALE-BLIND, and the avatar's layout scale is
 *  what made the hair "float" again after every reboot (owner, 2026-09-13 —
 *  the 09-12 "fix" was a layout reset, which only worked because it put the
 *  scale back to 1). Measured in @pixiv/three-vrm-springbone 3.5.5:
 *    - collider shapes compare `this.radius` (MODEL units) against a distance
 *      taken from world matrices, so at group scale 0.4 the head sphere is
 *      2.5x too large for the model and shoves every hair chain outward;
 *    - `stiffness * delta` and `gravityPower * delta` are world-unit
 *      displacements against a bone length that DOES scale, so the feel
 *      changes with size (snappy when small, floppy when large);
 *    - `hitRadius` is likewise unscaled.
 *  Bone length itself is recomputed from world matrices every frame, so it is
 *  the ONLY quantity the library gets right under scale. This compensates the
 *  other three. The authored values are recorded on first call (after the
 *  gravity floor above has run) so the function is idempotent — call it with
 *  every scale change, never with a delta. */
interface DeskSpringAuthored { stiffness: number; gravityPower: number; hitRadius: number }

export function applySpringScale(vrm: VRM, worldScale: number) {
  const s = Number.isFinite(worldScale) && worldScale > 0 ? worldScale : 1;
  const manager = vrm.springBoneManager as unknown as {
    joints?: Set<{
      settings?: {
        stiffness?: number; gravityPower?: number; hitRadius?: number;
        __deskAuthored?: DeskSpringAuthored;
      };
    }>;
    colliderGroups?: Array<{
      colliders?: Array<{ shape?: { radius?: number; __deskAuthoredRadius?: number } }>;
    }>;
  } | null;
  if (!manager) return;
  for (const joint of manager.joints ?? []) {
    const settings = joint.settings;
    if (!settings) continue;
    if (!settings.__deskAuthored) {
      settings.__deskAuthored = {
        stiffness: Number(settings.stiffness) || 0,
        gravityPower: Number(settings.gravityPower) || 0,
        hitRadius: Number(settings.hitRadius) || 0,
      };
    }
    const a = settings.__deskAuthored;
    settings.stiffness = a.stiffness * s;
    settings.gravityPower = a.gravityPower * s;
    settings.hitRadius = a.hitRadius * s;
  }
  for (const group of manager.colliderGroups ?? []) {
    for (const collider of group.colliders ?? []) {
      const shape = collider.shape;
      if (!shape || typeof shape.radius !== 'number') continue;
      if (shape.__deskAuthoredRadius == null) shape.__deskAuthoredRadius = shape.radius;
      shape.radius = shape.__deskAuthoredRadius * s;
    }
  }
}

export function useVrmLoader(url: string): VRM | null {
  const gltf = useLoader(GLTFLoader, url, (loader) => {
    loader.register((parser) => new VRMLoaderPlugin(parser));
  });

  const vrm = useMemo(() => {
    const loaded = gltf.userData.vrm as VRM | undefined;
    if (!loaded) return null;
    VRMUtils.removeUnnecessaryVertices(loaded.scene);
    VRMUtils.combineSkeletons(loaded.scene);
    VRMUtils.combineMorphs(loaded);
    VRMUtils.rotateVRM0(loaded);
    applyDefaultSpringGravity(loaded);
    // Record the (floored) authored spring values now, at scale 1, so the
    // placement layer (Scene.tsx, handed the VRM through Avatar's onReady)
    // can rescale them idempotently.
    applySpringScale(loaded, 1);
    return loaded;
  }, [gltf]);

  // A diagnostic seam: the avatar window is a transparent overlay whose renderer
  // exposes nothing else, so "why does the hair do that" was unanswerable
  // without a live handle. CDP (electron --remote-debugging-port +
  // scripts/cdp-shot.cjs) can read spring state, toggle settings per chain and
  // screenshot the result. Assigned in an EFFECT on purpose — the react-hooks
  // lint refuses global mutation from a hook body or useMemo, and the seam is
  // not worth a lint exception (it failed the public mirror's CI once).
  useEffect(() => {
    const w = window as unknown as { __deskVrm?: VRM | null };
    w.__deskVrm = vrm;
    return () => {
      if (w.__deskVrm === vrm) delete w.__deskVrm;
    };
  }, [vrm]);

  return vrm;
}
