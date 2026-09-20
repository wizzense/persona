import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';

import { applyDefaultSpringGravity } from './useVrmLoader';

/** A VRM whose spring manager carries exactly these joint settings. */
function vrmWith(settings: Array<{ gravityPower?: number; gravityDir?: THREE.Vector3 }>): VRM {
  const joints = new Set(settings.map((s) => ({ settings: s })));
  return { springBoneManager: { joints } } as unknown as VRM;
}

describe('applyDefaultSpringGravity', () => {
  it('defaults a missing or zero gravity, and supplies the down direction', () => {
    const vrm = vrmWith([{}, { gravityPower: 0 }]);
    applyDefaultSpringGravity(vrm);
    for (const joint of (vrm.springBoneManager as unknown as { joints: Set<{ settings: { gravityPower: number; gravityDir: THREE.Vector3 } }> }).joints) {
      expect(joint.settings.gravityPower).toBe(1.0);
      expect(joint.settings.gravityDir.y).toBe(-1);
    }
  });

  it('treats a sub-0.1 epsilon as noise, not authored intent (the demon hair 0.06 case)', () => {
    // Measured 2026-09-12: two demon hair chains author 0.06 on 5 of 6 joints
    // while every sibling authors 0. Respecting the epsilon left those strands
    // floating beside neighbours at 1.0 -- a rounding artifact must not read
    // as design.
    const vrm = vrmWith([{ gravityPower: 0.06 }]);
    applyDefaultSpringGravity(vrm);
    const joints = (vrm.springBoneManager as unknown as { joints: Set<{ settings: { gravityPower: number } }> }).joints;
    for (const joint of joints) expect(joint.settings.gravityPower).toBe(1.0);
  });

  it('leaves an authored pull alone, direction included', () => {
    const authoredDir = new THREE.Vector3(0.5, -1, 0);
    const vrm = vrmWith([{ gravityPower: 0.35, gravityDir: authoredDir }]);
    applyDefaultSpringGravity(vrm);
    const joint = [...(vrm.springBoneManager as unknown as { joints: Set<{ settings: { gravityPower: number; gravityDir: THREE.Vector3 } }> }).joints][0];
    expect(joint.settings.gravityPower).toBe(0.35);
    expect(joint.settings.gravityDir).toBe(authoredDir);
  });

  it('never pulls a body jiggle chain down — its zero gravity is design (2026-09-18 bust regression)', () => {
    // gold-kitsune authors bust_root.L/R at stiffness 2, gravityPower 0, four
    // joints per side pointing FORWARD. Flooring that to 1.0 deflects every
    // joint ~26 degrees down and the deflections compound: "hanging straight
    // down and swinging, super stretched". VRM 1.0 models omit the field on the
    // same chains (J_Sec_L_Bust), so the chain name, not the file version, is
    // the discriminator.
    const bust = { name: 'bust_root.L' };
    const bustTip = { name: 'bust.L.001_end', parent: { name: 'bust.L.001', parent: bust } };
    const vroidBust = { name: 'J_Sec_L_Bust1' };
    const butt = { name: 'Butt_L_4' };
    const hair = { name: 'J_Sec_Hair1_03', parent: { name: 'J_Bip_C_Head' } };
    const joints = new Set([
      { bone: bust, settings: { gravityPower: 0 } as { gravityPower?: number } },
      { bone: bustTip, settings: {} as { gravityPower?: number } },
      { bone: vroidBust, settings: {} as { gravityPower?: number } },
      { bone: butt, settings: { gravityPower: 0 } as { gravityPower?: number } },
      { bone: hair, settings: { gravityPower: 0 } as { gravityPower?: number } },
    ]);
    const vrm = { springBoneManager: { joints } } as unknown as VRM;
    applyDefaultSpringGravity(vrm);
    const byName = Object.fromEntries([...joints].map((j) => [j.bone.name, j.settings.gravityPower]));
    expect(byName['bust_root.L']).toBe(0);
    expect(byName['bust.L.001_end']).toBeUndefined();
    expect(byName['J_Sec_L_Bust1']).toBeUndefined();
    expect(byName['Butt_L_4']).toBe(0);
    expect(byName['J_Sec_Hair1_03']).toBe(1.0);
  });

  /** `chains` chains of `perChain` joints each, every joint at `gravityPower`. */
  function chainsOf(prefix: string, chains: number, perChain: number, gravityPower: number) {
    interface Bone { name: string; parent?: Bone }
    const joints: Array<{ bone: Bone; settings: { gravityPower: number } }> = [];
    for (let c = 0; c < chains; c += 1) {
      let parent: Bone | undefined = { name: `${prefix}_anchor${c}` }; // head/hips: not a spring bone
      for (let j = 0; j < perChain; j += 1) {
        const bone: Bone = { name: `${prefix}${c}_${j}`, parent };
        joints.push({ bone, settings: { gravityPower } });
        parent = bone;
      }
    }
    return joints;
  }

  it('inherits the gravity the MODEL authors widely, instead of forcing 1.0 (2026-09-18 hair regression)', () => {
    // smg-1-0-vrm-1 authors 0.05 on 40 hair chains (0.77 of its joints) against
    // stiffness 0.95: the strands are modelled hanging and barely swing. Forcing
    // 1.0 put gravity above the stiffness holding their shape and the curls
    // collapsed into a stretched curtain. Chains with no gravity inherit the
    // model's own value, so nothing hangs at 0.05 beside a neighbour at 1.0.
    const joints = new Set([
      ...chainsOf('BCHair', 8, 8, 0.05),
      ...chainsOf('hair_Back', 2, 4, 0),
    ]);
    const vrm = { springBoneManager: { joints } } as unknown as VRM;
    applyDefaultSpringGravity(vrm);
    for (const joint of joints) expect(joint.settings.gravityPower).toBeCloseTo(0.05);
  });

  it('still lifts an epsilon that only TWO chains carry (the demon 0.06)', () => {
    // 12 joints of 65 (0.15) on 2 chains — below both the 0.2 share and the
    // 3-chain floor, so it stays an artifact and the model falls back to 1.0.
    const joints = new Set([
      ...chainsOf('J_Sec_Hair1_1', 2, 6, 0.06),
      ...chainsOf('J_Sec_Hair1_0', 10, 5, 0),
    ]);
    const vrm = { springBoneManager: { joints } } as unknown as VRM;
    applyDefaultSpringGravity(vrm);
    for (const joint of joints) expect(joint.settings.gravityPower).toBe(1.0);
  });

  it('keeps body jiggle chains out of the model vote as well as out of the default', () => {
    // tfw-2-0-vrm1 carries 0.1 on its bust/butt chains. Those must not become
    // the model's house gravity for the hair that authors none.
    const joints = new Set([
      ...chainsOf('Breast_L_', 3, 4, 0.1),
      ...chainsOf('hair_side', 3, 4, 0),
    ]);
    const vrm = { springBoneManager: { joints } } as unknown as VRM;
    applyDefaultSpringGravity(vrm);
    for (const joint of joints) {
      const expected = joint.bone.name.startsWith('Breast') ? 0.1 : 1.0;
      expect(joint.settings.gravityPower).toBe(expected);
    }
  });

  it('never invents a gravity stronger than the stiffness holding the chain (2026-09-18 tail)', () => {
    // gold-kitsune's tail authors stiffness 0.1. At the 1.0 default that is
    // atan(10) ~= 84 degrees of deflection per joint, compounding over seven
    // joints: the tail lost its backward arc and fell through the buttocks.
    // The demon tail (stiffness 0.64) is unaffected — 0.64 still droops it.
    const joints = new Set([
      { bone: { name: 'tail_1' }, settings: { gravityPower: 0, stiffness: 0.1 } },
      { bone: { name: 'J_Opt_C_FoxTail1_01' }, settings: { gravityPower: 0, stiffness: 0.64 } },
      { bone: { name: 'J_Sec_Hair1_04' }, settings: { gravityPower: 0, stiffness: 2 } },
      { bone: { name: 'rope_1' }, settings: { gravityPower: 0, stiffness: 0 } },
    ]);
    const vrm = { springBoneManager: { joints } } as unknown as VRM;
    applyDefaultSpringGravity(vrm);
    const byName = Object.fromEntries([...joints].map((j) => [j.bone.name, j.settings.gravityPower]));
    expect(byName['tail_1']).toBeCloseTo(0.1);
    expect(byName['J_Opt_C_FoxTail1_01']).toBeCloseTo(0.64);
    expect(byName['J_Sec_Hair1_04']).toBe(1.0); // cap above the default: unchanged
    expect(byName['rope_1']).toBe(1.0); // no stiffness at all: a rope, full default
  });

  it('is a no-op on a vrm with no manager or no joints', () => {
    expect(() => applyDefaultSpringGravity({} as VRM)).not.toThrow();
    expect(() => applyDefaultSpringGravity({ springBoneManager: {} } as unknown as VRM)).not.toThrow();
  });
});

import { applySpringScale } from './useVrmLoader';

/** A VRM with joints AND colliders, the two things applySpringScale rescales. */
function scaledVrm() {
  const joints = new Set([
    { settings: { stiffness: 1.0, gravityPower: 1.0, hitRadius: 0.02 } },
    { settings: { stiffness: 0.5, gravityPower: 0.3, hitRadius: 0 } },
  ]);
  const colliderGroups = [
    { colliders: [{ shape: { radius: 0.1 } }, { shape: { radius: 0.05 } }] },
    { colliders: [{ shape: {} }] }, // a plane collider: no radius, must be skipped
  ];
  return { springBoneManager: { joints, colliderGroups } } as unknown as VRM;
}
type Manager = {
  joints: Set<{ settings: { stiffness: number; gravityPower: number; hitRadius: number } }>;
  colliderGroups: Array<{ colliders: Array<{ shape: { radius?: number } }> }>;
};

describe('applySpringScale', () => {
  it('scales collider radii, hitRadius, stiffness and gravity by the world scale', () => {
    // The 2026-09-13 reboot regression: a persisted layout scale of 0.4 with
    // three-vrm comparing MODEL-unit radii against WORLD-unit distances.
    const vrm = scaledVrm();
    applySpringScale(vrm, 0.4);
    const m = vrm.springBoneManager as unknown as Manager;
    const [j0, j1] = [...m.joints];
    expect(j0.settings.stiffness).toBeCloseTo(0.4);
    expect(j0.settings.gravityPower).toBeCloseTo(0.4);
    expect(j0.settings.hitRadius).toBeCloseTo(0.008);
    expect(j1.settings.gravityPower).toBeCloseTo(0.12);
    expect(m.colliderGroups[0].colliders[0].shape.radius).toBeCloseTo(0.04);
    expect(m.colliderGroups[0].colliders[1].shape.radius).toBeCloseTo(0.02);
    expect(m.colliderGroups[1].colliders[0].shape.radius).toBeUndefined();
  });

  it('is idempotent: every call derives from the AUTHORED values, never the last call', () => {
    const vrm = scaledVrm();
    applySpringScale(vrm, 0.4);
    applySpringScale(vrm, 0.4);
    applySpringScale(vrm, 2);
    applySpringScale(vrm, 1);
    const m = vrm.springBoneManager as unknown as Manager;
    const [j0] = [...m.joints];
    expect(j0.settings.stiffness).toBe(1.0);
    expect(j0.settings.gravityPower).toBe(1.0);
    expect(m.colliderGroups[0].colliders[0].shape.radius).toBe(0.1);
  });

  it('records the authored values AFTER the gravity floor, so a floored 1.0 scales, not the 0 it replaced', () => {
    const vrm = vrmWith([{ gravityPower: 0 }]);
    applyDefaultSpringGravity(vrm);
    applySpringScale(vrm, 1);
    applySpringScale(vrm, 0.5);
    const joint = [...(vrm.springBoneManager as unknown as { joints: Set<{ settings: { gravityPower: number } }> }).joints][0];
    expect(joint.settings.gravityPower).toBeCloseTo(0.5);
  });

  it('treats a degenerate scale as 1 and tolerates a vrm without a manager', () => {
    const vrm = scaledVrm();
    applySpringScale(vrm, 0);
    applySpringScale(vrm, Number.NaN);
    const m = vrm.springBoneManager as unknown as Manager;
    expect([...m.joints][0].settings.stiffness).toBe(1.0);
    expect(() => applySpringScale({} as VRM, 0.4)).not.toThrow();
  });
});

import { DEFAULT_SPRING_TUNING, sanitizeSpringTuning } from './useVrmLoader';

/** Hair and a bust chain, with an authored drag, at scale 1. */
function tunableVrm() {
  const joints = new Set([
    { bone: { name: 'J_Sec_Hair1_01' }, settings: { stiffness: 1.0, gravityPower: 0.5, hitRadius: 0.02, dragForce: 0.4 } },
    { bone: { name: 'J_Sec_L_Bust' }, settings: { stiffness: 2.0, gravityPower: 0, hitRadius: 0.02, dragForce: 0.4 } },
    { bone: { name: 'tail_1' }, settings: { stiffness: 0.1, gravityPower: 0.1, hitRadius: 0 } }, // no authored drag
  ]);
  return { springBoneManager: { joints, colliderGroups: [] } } as unknown as VRM;
}
type TunedManager = {
  joints: Set<{ bone: { name: string }; settings: { stiffness: number; gravityPower: number; dragForce: number } }>;
};
const jointsOf = (vrm: VRM) => [...(vrm.springBoneManager as unknown as TunedManager).joints];

describe('applySpringScale with the owner\'s physics knobs', () => {
  it('the default tuning is the model as authored: identical to no tuning at all', () => {
    const a = tunableVrm();
    const b = tunableVrm();
    applySpringScale(a, 0.7);
    applySpringScale(b, 0.7, DEFAULT_SPRING_TUNING);
    expect(jointsOf(a).map((j) => j.settings)).toEqual(jointsOf(b).map((j) => j.settings));
    // three-vrm's own default drag (0.4) is what an unauthored chain keeps.
    expect(jointsOf(b)[2].settings.dragForce).toBeCloseTo(0.4);
  });

  it('weight, stiffness and damping multiply the authored values (on top of the scale), damping clamped to 1', () => {
    const vrm = tunableVrm();
    applySpringScale(vrm, 0.5, { ...DEFAULT_SPRING_TUNING, weight: 0.5, stiffness: 2, damping: 3 });
    const [hair] = jointsOf(vrm);
    expect(hair.settings.gravityPower).toBeCloseTo(0.5 * 0.5 * 0.5); // authored x weight x scale
    expect(hair.settings.stiffness).toBeCloseTo(1.0 * 2 * 0.5);
    expect(hair.settings.dragForce).toBe(1); // 0.4 x 3 = 1.2 -> three-vrm's ceiling
  });

  it('jiggle reaches ONLY the body chains: 0 pins them at rest, 2 loosens them, hair is untouched', () => {
    const still = tunableVrm();
    applySpringScale(still, 1, { ...DEFAULT_SPRING_TUNING, jiggle: 0 });
    const [hairStill, bustStill] = jointsOf(still);
    expect(bustStill.settings.dragForce).toBe(1);
    expect(bustStill.settings.gravityPower).toBe(0);
    expect(bustStill.settings.stiffness).toBeGreaterThanOrEqual(5);
    expect(hairStill.settings.dragForce).toBeCloseTo(0.4);
    expect(hairStill.settings.stiffness).toBeCloseTo(1.0);

    const loose = tunableVrm();
    applySpringScale(loose, 1, { ...DEFAULT_SPRING_TUNING, jiggle: 2 });
    const [hairLoose, bustLoose] = jointsOf(loose);
    expect(bustLoose.settings.stiffness).toBeCloseTo(1.0); // 2.0 / 2
    expect(bustLoose.settings.dragForce).toBe(0); // keeps twice the 0.6 it kept: 1 - 1.2, floored at 0
    expect(hairLoose.settings.stiffness).toBeCloseTo(1.0);
  });

  it('enabled:false pins EVERY chain, and re-enabling restores the authored feel (idempotent over the knobs too)', () => {
    const vrm = tunableVrm();
    applySpringScale(vrm, 1, { ...DEFAULT_SPRING_TUNING, enabled: false });
    for (const j of jointsOf(vrm)) {
      expect(j.settings.dragForce).toBe(1);
      expect(j.settings.gravityPower).toBe(0);
    }
    applySpringScale(vrm, 1, DEFAULT_SPRING_TUNING);
    const [hair, , tail] = jointsOf(vrm);
    expect(hair.settings.gravityPower).toBeCloseTo(0.5);
    expect(hair.settings.dragForce).toBeCloseTo(0.4);
    expect(tail.settings.stiffness).toBeCloseTo(0.1);
  });
});

describe('sanitizeSpringTuning', () => {
  it('a missing, non-finite or negative knob is 1 (as authored) -- never 0, which would read as "hair off"', () => {
    expect(sanitizeSpringTuning(undefined)).toEqual(DEFAULT_SPRING_TUNING);
    expect(sanitizeSpringTuning({ weight: 'x', stiffness: -1, damping: NaN })).toEqual(DEFAULT_SPRING_TUNING);
    expect(sanitizeSpringTuning({ enabled: false, jiggle: 0, weight: 9 })).toEqual({ ...DEFAULT_SPRING_TUNING, enabled: false, jiggle: 0, weight: 3 });
  });
});
