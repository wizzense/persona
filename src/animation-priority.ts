import type { AnimationType } from './animation-catalog';

export type AnimationValue = AnimationType | string;

export interface BodyAnimationOverride {
  animation: AnimationValue;
  requestId: number;
}

export function resolveBodyAnimation(
  voiceAnimation: AnimationType,
  override: BodyAnimationOverride | null,
): AnimationValue {
  return override?.animation ?? voiceAnimation;
}

export function finishBodyAnimationOverride(
  override: BodyAnimationOverride | null,
  requestId: number,
): BodyAnimationOverride | null {
  return override?.requestId === requestId ? null : override;
}
