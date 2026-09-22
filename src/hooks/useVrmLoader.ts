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
 *  (owner, 2026-09-18: the chest chains hung straight down, swinging and
 *  stretched). A chest or hip chain is authored AT its rest shape
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
 *  it has none (owner, 2026-09-18, minutes after the chest-chain fix: the hair
 *  physics broke). The 0.1 floor above was generalised from ONE model:
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
 *  (owner, 2026-09-18: the fox tail no longer rested on the hips -- it fell
 *  straight through the body). three-vrm adds `stiffness * dt`
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
  // tfw the chest and hip chains alone carry a third of the authored values.
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
interface DeskSpringAuthored {
  stiffness: number; gravityPower: number; hitRadius: number; dragForce: number;
  /** A chest/hip chain (BODY_JIGGLE_CHAIN) — the `jiggle` knob's subjects. */
  jiggle: boolean;
}

/** The owner's per-avatar physics knobs (cast.json `physics`, resolved by
 *  cast-config.cjs and delivered as a `tune-avatar` event). Every number is a
 *  MULTIPLIER over what the model authored — 1 everywhere is the model as its
 *  author meant it, which is what made "a little too much" tunable without a
 *  per-model table: the same 0.5 tames a floppy tail and a soft chest chain alike.
 *  three-vrm's step (three-vrm-springbone 3.5.5, VRMSpringBoneJoint.update):
 *    next = tail + (tail - prevTail) * (1 - dragForce)
 *                + boneAxis * stiffness * dt + gravityDir * gravityPower * dt
 *  so `damping` scales how much velocity survives a frame, `stiffness` how
 *  hard the chain is pulled back to its authored shape, `weight` how hard it
 *  hangs. `jiggle` touches ONLY the body chains: 0 pins them at rest (drag 1,
 *  no gravity, a firm pull to shape), 2 halves their stiffness and doubles the
 *  velocity they keep. `enabled: false` pins EVERY chain the same way. */
export interface DeskSpringTuning {
  enabled: boolean;
  weight: number;
  stiffness: number;
  damping: number;
  jiggle: number;
}

export const DEFAULT_SPRING_TUNING: DeskSpringTuning = Object.freeze({
  enabled: true, weight: 1, stiffness: 1, damping: 1, jiggle: 1,
});

/** A pinned chain is pulled to its rest shape at least this hard (in authored
 *  units, before the scale compensation): a rope (stiffness 0) would otherwise
 *  never return once a collider had pushed it. */
const PINNED_MIN_STIFFNESS = 5;

/** The event payload is whatever cast-config resolved; a missing or non-finite
 *  knob falls back to 1 (as authored), never to 0 — a dropped field must not
 *  read as "hair off". */
export function sanitizeSpringTuning(raw: unknown): DeskSpringTuning {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof DeskSpringTuning, unknown>>;
  const num = (v: unknown, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : 1;
  };
  return {
    enabled: src.enabled !== false,
    weight: num(src.weight, 3),
    stiffness: num(src.stiffness, 3),
    damping: num(src.damping, 3),
    jiggle: num(src.jiggle, 2),
  };
}

export function applySpringScale(vrm: VRM, worldScale: number, tuning: DeskSpringTuning = DEFAULT_SPRING_TUNING) {
  const s = Number.isFinite(worldScale) && worldScale > 0 ? worldScale : 1;
  const manager = vrm.springBoneManager as unknown as {
    joints?: Set<{
      bone?: DeskNamedNode;
      settings?: {
        stiffness?: number; gravityPower?: number; hitRadius?: number; dragForce?: number;
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
        // three-vrm's own default when the file omits it (loader line 585).
        dragForce: Number.isFinite(Number(settings.dragForce)) ? Number(settings.dragForce) : 0.4,
        jiggle: isBodyJiggleChain(joint.bone),
      };
    }
    const a = settings.__deskAuthored;
    // The body knob only reaches body chains; every other chain sees 1 here.
    const jiggle = a.jiggle ? tuning.jiggle : 1;
    const pinned = !tuning.enabled || jiggle <= 0;
    if (pinned) {
      settings.stiffness = Math.max(a.stiffness, PINNED_MIN_STIFFNESS) * s;
      settings.gravityPower = 0;
      settings.dragForce = 1;
    } else {
      settings.stiffness = (a.stiffness * tuning.stiffness / jiggle) * s;
      settings.gravityPower = a.gravityPower * tuning.weight * s;
      // `damping` scales the drag itself; `jiggle` scales the velocity that
      // SURVIVES it (1 - drag). Both land inside three-vrm's 0..1.
      const drag = Math.min(1, a.dragForce * tuning.damping);
      settings.dragForce = Math.min(1, Math.max(0, 1 - (1 - drag) * jiggle));
    }
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

/** A fork's recipe: what makes <base>-<variant> look different from <base>.
 *  Written by character-roster.forkCharacter into the variant's character.json
 *  and merged down the base chain, so the mesh is never copied -- the deltas are
 *  applied here, on the shared model, at load. Same seam as the physics knobs.
 *
 *  `blendshapes` are three-vrm expression names (happy, angry, blink, aa, ...);
 *  a value is clamped 0..1. `boneScale` names NORMALIZED humanoid bones
 *  (head, hips, leftUpperArm, ...) and scales that bone's node, which moves its
 *  children with it -- that is how a bigger head or longer legs works without
 *  touching a vertex. `materials` carries whole-model tweaks that do not need a
 *  per-material editor yet: a colour tint and an outline width. */
export interface DeskCustomise {
  blendshapes?: Record<string, number>;
  boneScale?: Record<string, number>;
  materials?: { tint?: string; tintStrength?: number; outlineWidth?: number };
}

const CUSTOMISE_BONE_MIN = 0.5;
const CUSTOMISE_BONE_MAX = 2;

/** Apply a fork's recipe to a freshly loaded VRM. Idempotent over the AUTHORED
 *  values (recorded on first call) so re-applying a changed recipe does not
 *  compound, exactly like applySpringScale -- a slider dragged twice must not
 *  end up twice as far. Every arm fails soft: a recipe naming a bone or
 *  expression this model does not have costs that one line, never the load. */
export function applyCustomise(vrm: VRM, recipe: DeskCustomise | null | undefined) {
  if (!recipe || typeof recipe !== 'object') return;

  const expressions = vrm.expressionManager;
  if (expressions && recipe.blendshapes) {
    for (const [name, raw] of Object.entries(recipe.blendshapes)) {
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      try {
        expressions.setValue(name, Math.min(1, Math.max(0, value)));
      } catch {
        /* an expression this model does not author */
      }
    }
  }

  if (recipe.boneScale && vrm.humanoid) {
    for (const [bone, raw] of Object.entries(recipe.boneScale)) {
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0) continue;
      let node: THREE.Object3D | null;
      try {
        node = vrm.humanoid.getNormalizedBoneNode(bone as never);
      } catch {
        // A recipe naming a bone this model does not author.
        continue;
      }
      if (!node) continue;
      const holder = node as THREE.Object3D & { __deskAuthoredScale?: THREE.Vector3 };
      if (!holder.__deskAuthoredScale) holder.__deskAuthoredScale = node.scale.clone();
      const clamped = Math.min(CUSTOMISE_BONE_MAX, Math.max(CUSTOMISE_BONE_MIN, value));
      node.scale.copy(holder.__deskAuthoredScale).multiplyScalar(clamped);
    }
  }

  const materials = recipe.materials;
  if (materials && (materials.tint || materials.outlineWidth != null)) {
    const tint = materials.tint ? new THREE.Color(materials.tint) : null;
    const strength = Number.isFinite(Number(materials.tintStrength))
      ? Math.min(1, Math.max(0, Number(materials.tintStrength)))
      : 1;
    vrm.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.material) return;
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of list) {
        const m = material as THREE.Material & {
          color?: THREE.Color;
          outlineWidthFactor?: number;
          __deskAuthoredColor?: THREE.Color;
          __deskAuthoredOutline?: number;
        };
        if (tint && m.color) {
          if (!m.__deskAuthoredColor) m.__deskAuthoredColor = m.color.clone();
          m.color.copy(m.__deskAuthoredColor).lerp(tint, strength);
        }
        if (materials.outlineWidth != null && typeof m.outlineWidthFactor === 'number') {
          if (m.__deskAuthoredOutline == null) m.__deskAuthoredOutline = m.outlineWidthFactor;
          const width = Number(materials.outlineWidth);
          if (Number.isFinite(width)) m.outlineWidthFactor = Math.max(0, width);
        }
      }
    });
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
