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

/** The only clips that may LOOP are the voice-driven pair. Every other clip
 *  (GREETING walks in from off-screen, HAPPY, DANCE, FILE: packs) is a
 *  one-shot. Measured 2026-09-10: a bridge-posted GREETING (the decision-card
 *  escalation nudge) landed in voiceAnimation with playback 'loop', and with no
 *  voice state to ever reset it the avatar walked in from the left edge every
 *  ~4.5 s for hours ("why does the avatar keep walking in over and over"). */
export function isLoopingAnimation(animation: AnimationValue): boolean {
  return animation === 'IDLE' || animation === 'TALK';
}

/** A bridge animation event without an MCP requestId: loop-class clips drive
 *  voiceAnimation; anything else becomes a one-shot override that clears itself
 *  on completion, exactly like an MCP play_animation. */
export function bridgeAnimationOverride(
  animation: AnimationValue,
): BodyAnimationOverride | null {
  if (isLoopingAnimation(animation)) return null;
  return { animation, requestId: Math.random() };
}

export function finishBodyAnimationOverride(
  override: BodyAnimationOverride | null,
  requestId: number,
): BodyAnimationOverride | null {
  return override?.requestId === requestId ? null : override;
}
