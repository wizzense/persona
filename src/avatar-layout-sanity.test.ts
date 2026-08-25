import { describe, expect, it } from 'vitest';

import { POSITION_BOUND, sane, sanitizeLayout } from './hooks/useAvatarLayout';

/**
 * The layout store faithfully persisted a horizon-drag accident (slot0 at
 * z=-2665, measured 2026-08-25) and every boot restored it: a healthy renderer
 * showing nothing, no errors — read by the owner as "Persona is broken".
 * These tests pin the recovery: an out-of-bounds/malformed entry is DROPPED
 * (default placement returns the avatar to view), a sane one survives.
 */
describe('avatar layout sanity', () => {
  const good = { position: [-0.06, 0, 0.71] as [number, number, number], scale: 0.4 };

  it('keeps a sane stored transform', () => {
    expect(sane(good)).toBe(true);
    expect(sanitizeLayout({ slot0: good })).toEqual({ slot0: good });
  });

  it('drops the measured horizon-drag artifact so the avatar comes back', () => {
    const artifact = { position: [-119.3, 0, -2665.3], scale: 1.3 };
    expect(sane(artifact)).toBe(false);
    expect(sanitizeLayout({ slot0: artifact })).toEqual({});
  });

  it('drops NaN/Infinity positions and degenerate scales', () => {
    expect(sane({ position: [NaN, 0, 0], scale: 1 })).toBe(false);
    expect(sane({ position: [0, 0, Infinity], scale: 1 })).toBe(false);
    expect(sane({ position: [0, 0, 0], scale: 0 })).toBe(false);
    expect(sane({ position: [0, 0, 0], scale: 1000 })).toBe(false);
  });

  it('drops malformed shapes without taking the rest of the layout down', () => {
    const layout = sanitizeLayout({
      slot0: good,
      slot1: { position: [0, 0], scale: 1 }, // wrong arity
      slot2: 'garbage',
      slot3: null,
    });
    expect(layout).toEqual({ slot0: good });
  });

  it('the stage boundary itself is inside; one step beyond is out', () => {
    expect(sane({ position: [POSITION_BOUND, 0, 0], scale: 1 })).toBe(true);
    expect(sane({ position: [POSITION_BOUND + 1, 0, 0], scale: 1 })).toBe(false);
  });

  it('non-object roots sanitize to an empty layout, never a throw', () => {
    expect(sanitizeLayout(null)).toEqual({});
    expect(sanitizeLayout('x')).toEqual({});
    expect(sanitizeLayout(42)).toEqual({});
  });
});
