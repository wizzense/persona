import { useEffect, useMemo } from 'react';
import { useLoader } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRM, VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { holdModel, releaseModel } from './vrmLifetime';

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

/** 🚩 THE DEFAULT IS FOR CHAINS THAT HANG — NOT FOR BODY JIGGLE CHAINS
 *  (owner, 2026-09-18: "the breasts are hanging straight down and swinging,
 *  super stretched"). A bust/breast/butt chain is authored AT its rest shape
 *  and its zero gravity is DESIGN, not omission: the author gives it a high
 *  stiffness so it returns to that shape and only wobbles. Measured on the
 *  on-stage gold-kitsune (VRM 0.x): `bust_root.L/R`, stiffness 2, gravityPower
 *  0, four joints per side authored FORWARD (z +0.27, +0.17, +0.11, +0.11).
 *  Flooring that to 1.0 deflects every joint ~atan(1/2) ≈ 26° downward and the
 *  deflections COMPOUND down the chain — the tip ends up near-vertical and the
 *  skin stretches with it. The same chains exist on the VRM 1.0 models, which
 *  omit gravityPower outright (`J_Sec_L_Bust`, `J_Sec_R_Bust` — 252 omitting
 *  joints across the roster), so this cannot be decided by VRM version: hair
 *  chains author 0 on VRM 0.x models too (dozens of `J_Sec_Hair1_*`) and still
 *  need the default. The chain's identity is the only honest discriminator. */
const BODY_JIGGLE_CHAIN = /bust|breast|boob|mune|oppai|chichi|pectoral|butt|oshiri|胸|尻/i;
const BODY_JIGGLE_ANCESTRY = 3;

interface DeskNamedNode { name?: string; parent?: DeskNamedNode | null }

function isBodyJiggleChain(bone: DeskNamedNode | undefined | null): boolean {
  let node = bone;
  for (let hop = 0; node && hop <= BODY_JIGGLE_ANCESTRY; hop += 1) {
    if (BODY_JIGGLE_CHAIN.test(node.name ?? '')) return true;
    node = node.parent;
  }
  return false;
}

/** 🚩 THE DEFAULT IS THE MODEL'S OWN GRAVITY WHEN IT HAS ONE — 1.0 only when
 *  it has none (owner, 2026-09-18, minutes after the bust fix: "hair physics
 *  are fucked up now"). The 0.1 floor above was generalised from ONE model:
 *  the demon authors 0.06 on 2 chains of 14 and 0 everywhere else, so that
 *  epsilon really was a rounding artifact. Measured across the roster, a
 *  sub-floor value is far more often a model-wide authored choice:
 *
 *    model                  joints  mode  share  chains
 *    smg-1-0-vrm-1             365  0.05   0.77      40   → authored, respect
 *    tfw-2-0-vrm1              156  0.10   0.21       6   → authored, respect
 *    demon-vrm-1-0              65  0.06   0.15       2   → artifact, lift
 *    gold-kitsune                7  none      -       0   → nothing, lift
 *
 *  smg's hair is authored to hang at 0.05 against stiffness 0.95; forcing 1.0
 *  put gravity ABOVE the stiffness that holds the strand's shape (equilibrium
 *  deflection per joint is atan(gravity/stiffness), and it compounds down an
 *  8-joint chain) — the curls collapsed into a stretched curtain. A value the
 *  model uses widely (>= 20% of its joints AND on >= 3 separate chains) is its
 *  house default: chains with NO gravity inherit THAT, not 1.0, so a model
 *  never ends up with 0.05 strands hanging beside 1.0 ones. Only a model with
 *  no such value falls back to VRoid Studio's 1.0 — which is the demon tail
 *  case the default was written for (2026-09-11) and it still measures the
 *  same there. */
const MODEL_GRAVITY_MIN_SHARE = 0.2;
const MODEL_GRAVITY_MIN_CHAINS = 3;

interface DeskSpringJoint {
  bone?: DeskNamedNode;
  settings?: { gravityPower?: number; gravityDir?: THREE.Vector3; stiffness?: number };
}

/** 🚩 A DEFAULT MAY NEVER OUT-PULL THE STIFFNESS THAT HOLDS THE CHAIN'S SHAPE
 *  (owner, 2026-09-18: the fox tail is "not properly resting on the buttocks,
 *  it's like completely in the butt cheeks"). three-vrm adds `stiffness * dt`
 *  along the chain's rest direction and `gravityPower * dt` downward, so a
 *  joint settles atan(gravity / stiffness) off its authored pose, and that
 *  angle compounds down the chain. gold-kitsune's tail authors stiffness 0.1:
 *  against a 1.0 default that is atan(10) ≈ 84° per joint — the tail loses its
 *  authored backward arc entirely and falls vertically THROUGH the body. Capped
 *  at 1x stiffness it droops ~45° per joint and keeps the arc. The cap is
 *  measured against the result the owner accepted on 2026-09-11: the demon tail
 *  authors stiffness 0.64, and 0.6 gravity put its tip at y −0.80 — a real
 *  droop. It applies ONLY to a value we invent; an authored pull is never
 *  capped, and a chain with no stiffness at all is a rope, so it takes the
 *  full default. */
const MAX_DEFAULT_GRAVITY_PER_STIFFNESS = 1.0;

/** The gravity this model authors for itself, or null when it authors none. */
export function modelAuthoredGravity(joints: DeskSpringJoint[]): number | null {
  const bones = new Set(joints.map((joint) => joint.bone).filter(Boolean));
  const share = new Map<number, number>();
  const chains = new Map<number, number>();
  for (const joint of joints) {
    const gravity = Number(joint.settings?.gravityPower);
    if (!(gravity > 0)) continue;
    share.set(gravity, (share.get(gravity) ?? 0) + 1);
    // A chain ROOT is a joint whose bone's parent is not itself a spring bone.
    if (!bones.has(joint.bone?.parent as DeskNamedNode)) {
      chains.set(gravity, (chains.get(gravity) ?? 0) + 1);
    }
  }
  let best: number | null = null;
  for (const [gravity, count] of share) {
    if (count < joints.length * MODEL_GRAVITY_MIN_SHARE) continue;
    if ((chains.get(gravity) ?? 0) < MODEL_GRAVITY_MIN_CHAINS) continue;
    if (best === null || count > (share.get(best) ?? 0)) best = gravity;
  }
  return best;
}

export function applyDefaultSpringGravity(vrm: VRM) {
  const manager = vrm.springBoneManager as unknown as {
    joints?: Set<DeskSpringJoint>;
  } | null;
  if (!manager?.joints) return;
  // Body jiggle chains are out of the vote as well as out of the default: on
  // tfw the bust and butt chains alone carry a third of the authored values.
  const joints = [...manager.joints].filter((joint) => joint.settings && !isBodyJiggleChain(joint.bone));
  const modelGravity = modelAuthoredGravity(joints);
  const fallback = modelGravity ?? DEFAULT_SPRING_GRAVITY;
  for (const joint of joints) {
    const settings = joint.settings!;
    const gravity = Number(settings.gravityPower);
    if (gravity >= AUTHORED_GRAVITY_FLOOR) continue;
    if (modelGravity !== null && gravity === modelGravity) continue;
    const stiffness = Number(settings.stiffness);
    const cap = stiffness > 0 ? stiffness * MAX_DEFAULT_GRAVITY_PER_STIFFNESS : Infinity;
    settings.gravityPower = Math.min(fallback, cap);
    settings.gravityDir = settings.gravityDir ?? new THREE.Vector3(0, -1, 0);
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

  // Free the model when the last body showing this url leaves (vrmLifetime.ts):
  // GPU buffers and textures through deepDispose, the parsed GLB through the
  // loader cache -- which is also what lets a re-cast slot id load its NEW model.
  useEffect(() => {
    holdModel(url);
    return () => {
      releaseModel(url, () => {
        if (vrm) VRMUtils.deepDispose(vrm.scene);
        useLoader.clear(GLTFLoader, url);
      });
    };
  }, [url, vrm]);

  return vrm;
}
