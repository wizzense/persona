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
