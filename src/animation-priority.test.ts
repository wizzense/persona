import { describe, expect, it } from 'vitest';
import {
  bridgeAnimationOverride,
  finishBodyAnimationOverride,
  isLoopingAnimation,
  resolveBodyAnimation,
  type BodyAnimationOverride,
} from './animation-priority';

describe('MCP body animation priority', () => {
  it('keeps the override visible while voice state changes, then restores voice state', () => {
    const override: BodyAnimationOverride = {
      animation: 'DANCE',
      requestId: 1,
    };

    expect(resolveBodyAnimation('IDLE', override)).toBe('DANCE');
    expect(resolveBodyAnimation('TALK', override)).toBe('DANCE');

    const finished = finishBodyAnimationOverride(override, 1);
    expect(resolveBodyAnimation('TALK', finished)).toBe('TALK');
  });

  it('ignores completion from an override replaced by a newer MCP request', () => {
    const newerOverride: BodyAnimationOverride = {
      animation: 'FINGER_GUN',
      requestId: 2,
    };

    expect(finishBodyAnimationOverride(newerOverride, 1)).toBe(newerOverride);
    expect(resolveBodyAnimation('IDLE', newerOverride)).toBe('FINGER_GUN');
    expect(finishBodyAnimationOverride(newerOverride, 2)).toBeNull();
  });
});

describe('bridge-posted animations (no MCP requestId)', () => {
  it('lets only the voice-driven pair loop', () => {
    expect(isLoopingAnimation('IDLE')).toBe(true);
    expect(isLoopingAnimation('TALK')).toBe(true);
    for (const clip of ['GREETING', 'HAPPY', 'DANCE', 'FINGER_GUN', 'FILE:wave.vrma']) {
      expect(isLoopingAnimation(clip)).toBe(false);
    }
  });

  it('turns a bridge GREETING into a one-shot override that clears on completion', () => {
    // The 2026-09-10 loop: escalate_decision_cards.py posts GREETING to /events;
    // as a voiceAnimation it looped (walk-in root motion) until the next voice
    // state, which never came. As an override it plays once and falls back.
    const override = bridgeAnimationOverride('GREETING');
    expect(override).not.toBeNull();
    expect(resolveBodyAnimation('IDLE', override)).toBe('GREETING');
    expect(resolveBodyAnimation('IDLE', finishBodyAnimationOverride(override, override!.requestId))).toBe('IDLE');
  });

  it('routes IDLE and TALK to the voice slot, not an override', () => {
    expect(bridgeAnimationOverride('IDLE')).toBeNull();
    expect(bridgeAnimationOverride('TALK')).toBeNull();
  });
});
