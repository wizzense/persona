import { describe, expect, it } from 'vitest';
import { SPEECH_GAIN_MAX, speechGain } from './speech-gain';

describe('speechGain', () => {
  it('passes an in-range fader through untouched', () => {
    expect(speechGain(0.35)).toBe(0.35);
    expect(speechGain(1)).toBe(1);
    expect(speechGain(1.4)).toBe(1.4);
  });

  it('treats an absent volume as FULL, so an older main process is unchanged', () => {
    expect(speechGain(undefined)).toBe(1);
    expect(speechGain(null)).toBe(1);
  });

  it('never hands a GainNode a value that would throw', () => {
    // gain.value = NaN throws inside playSpoken's fail-soft catch, which reads
    // as a dead voice service rather than a bad number.
    expect(speechGain(Number.NaN)).toBe(1);
    expect(speechGain(Number.POSITIVE_INFINITY)).toBe(1);
    expect(speechGain('0.5')).toBe(1);
  });

  it('clamps to the boost ceiling and floors at silence', () => {
    expect(speechGain(9)).toBe(SPEECH_GAIN_MAX);
    expect(speechGain(-1)).toBe(0);
    expect(speechGain(0)).toBe(0);
  });
});
