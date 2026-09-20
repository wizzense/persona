import { describe, expect, it } from 'vitest';
import { BUBBLE_MAX_CHARS, bubbleDurationMs, bubbleText } from './speech-bubble';

describe('bubbleText', () => {
  it('collapses whitespace and leaves a short line alone', () => {
    expect(bubbleText('  build   is\ngreen  ')).toBe('build is green');
  });

  it('cuts a long line at a word boundary, inside the limit, with an ellipsis', () => {
    const long = 'the quick brown fox jumps over the lazy dog '.repeat(20);
    const out = bubbleText(long);
    expect(out.length).toBeLessThanOrEqual(BUBBLE_MAX_CHARS);
    expect(out.endsWith('…')).toBe(true);
    // A word boundary: the character before the ellipsis is a whole word's end.
    expect(long.replace(/\s+/g, ' ').startsWith(out.slice(0, -1))).toBe(true);
    expect(out.slice(0, -1).endsWith(' ')).toBe(false);
  });

  it('never throws on a non-string from across the IPC boundary', () => {
    expect(bubbleText(undefined)).toBe('');
    expect(bubbleText(42)).toBe('');
    expect(bubbleText(null)).toBe('');
  });
});

describe('bubbleDurationMs', () => {
  it('with NO audio, paces by reading speed -- longer text stays longer', () => {
    const short = bubbleDurationMs('ok', 0);
    const long = bubbleDurationMs('x'.repeat(120), 0);
    expect(short).toBe(2500); // the floor: long enough to find the bubble at all
    expect(long).toBeGreaterThan(short);
    expect(long).toBe(1200 + 120 * 60);
  });

  it('with audio, outlives the clip slightly instead of vanishing with it', () => {
    expect(bubbleDurationMs('hello there', 4000)).toBe(4900);
  });

  it('is bounded, and a garbage duration reads as "no audio"', () => {
    expect(bubbleDurationMs('x'.repeat(5000), 0)).toBe(14000);
    expect(bubbleDurationMs('hi', 999999)).toBe(14000);
    expect(bubbleDurationMs('hi', Number.NaN)).toBe(2500);
    expect(bubbleDurationMs('hi', -5)).toBe(2500);
  });
});
