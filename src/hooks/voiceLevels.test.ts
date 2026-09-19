import { beforeEach, describe, expect, it } from 'vitest';
import { AUDIBLE, anyoneAudible, clearLevel, getLevel, resetLevels, setLevel } from './voiceLevels';

describe('voiceLevels', () => {
  beforeEach(() => resetLevels());

  it('a body nobody wrote is silent', () => {
    expect(getLevel('slot0')).toBe(0);
    expect(anyoneAudible()).toBe(false);
  });

  it('levels are per body and clamped', () => {
    setLevel('slot0', 0.4);
    setLevel('room-atlas', 7);
    setLevel('room-lyra', Number.NaN);
    expect(getLevel('slot0')).toBe(0.4);
    expect(getLevel('room-atlas')).toBe(1);
    expect(getLevel('room-lyra')).toBe(0);
  });

  it('an audible sample makes the stage active; silence alone does not', () => {
    setLevel('slot0', AUDIBLE / 2);
    expect(anyoneAudible()).toBe(false);
    setLevel('room-atlas', 0.3);
    expect(anyoneAudible()).toBe(true);
  });

  it('a removed body forgets its level', () => {
    setLevel('room-atlas', 0.3);
    clearLevel('room-atlas');
    expect(getLevel('room-atlas')).toBe(0);
  });
});
