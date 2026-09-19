/**
 * Who still shows a loaded model, and when it may be freed.
 *
 * R3F's `useLoader` caches a parsed GLB by URL forever, and nothing ever called
 * `VRMUtils.deepDispose`: a body that left the stage kept its geometry and
 * textures on the GPU (perf-gate 2026-09-18: desk VRAM 141 MB -> 366 MB with
 * three bodies, still 366 MB after they were removed), and a slot id re-cast as
 * a different character was handed the OLD model from the cache.
 *
 * Holders are counted per URL. The free is DEFERRED: React StrictMode (and a
 * Suspense retry) unmounts and remounts in the same tick, and disposing a model
 * that is about to be shown again blanks it.
 */

const holders = new Map<string, number>();
const pending = new Map<string, ReturnType<typeof setTimeout>>();

/** Long enough for a remount, short enough that a removed body frees promptly. */
export const FREE_AFTER_MS = 1500;

export function holdModel(url: string): void {
  holders.set(url, (holders.get(url) ?? 0) + 1);
  const timer = pending.get(url);
  if (timer !== undefined) {
    clearTimeout(timer);
    pending.delete(url);
  }
}

/** Drop one holder; when none is left after the grace period, run `free` once. */
export function releaseModel(url: string, free: () => void, delayMs = FREE_AFTER_MS): void {
  const left = Math.max(0, (holders.get(url) ?? 0) - 1);
  if (left > 0) {
    holders.set(url, left);
    return;
  }
  holders.delete(url);
  const previous = pending.get(url);
  if (previous !== undefined) clearTimeout(previous);
  pending.set(
    url,
    setTimeout(() => {
      pending.delete(url);
      if ((holders.get(url) ?? 0) === 0) free();
    }, delayMs),
  );
}

export function holderCount(url: string): number {
  return holders.get(url) ?? 0;
}

/** Test seam. */
export function resetLifetimes(): void {
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
  holders.clear();
}
