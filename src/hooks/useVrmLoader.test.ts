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
