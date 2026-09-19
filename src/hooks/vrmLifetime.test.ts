import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { holdModel, holderCount, releaseModel, resetLifetimes } from './vrmLifetime';

describe('vrmLifetime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetLifetimes();
  });
  afterEach(() => vi.useRealTimers());

  it('frees once, after the grace period, when the last holder leaves', () => {
    const free = vi.fn();
    holdModel('a.vrm');
    releaseModel('a.vrm', free, 100);
    expect(free).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(free).toHaveBeenCalledTimes(1);
  });

  it('a remount inside the grace period cancels the free (StrictMode, Suspense retry)', () => {
    const free = vi.fn();
    holdModel('a.vrm');
    releaseModel('a.vrm', free, 100);
    holdModel('a.vrm');
    vi.advanceTimersByTime(500);
    expect(free).not.toHaveBeenCalled();
    expect(holderCount('a.vrm')).toBe(1);
  });

  it('does not free while another body still shows the same url', () => {
    const free = vi.fn();
    holdModel('a.vrm');
    holdModel('a.vrm');
    releaseModel('a.vrm', free, 100);
    vi.advanceTimersByTime(500);
    expect(free).not.toHaveBeenCalled();
    releaseModel('a.vrm', free, 100);
    vi.advanceTimersByTime(100);
    expect(free).toHaveBeenCalledTimes(1);
  });

  it('urls are independent, and an unmatched release cannot go negative', () => {
    const freeA = vi.fn();
    const freeB = vi.fn();
    holdModel('b.vrm');
    releaseModel('a.vrm', freeA, 10);
    vi.advanceTimersByTime(10);
    expect(freeA).toHaveBeenCalledTimes(1);
    expect(freeB).not.toHaveBeenCalled();
    expect(holderCount('b.vrm')).toBe(1);
    expect(holderCount('a.vrm')).toBe(0);
  });
});
