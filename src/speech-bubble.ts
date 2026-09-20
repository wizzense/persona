/** What a speech bubble shows, and for how long. Pure, so the two decisions that
 *  make a caption readable are tested without a DOM.
 *
 *  The bubble exists for the case with NO audio: a muted room the owner still
 *  wants to read. That decides the timing rule. With audio, the caption lives as
 *  long as the voice does. Without it there is nothing to time against, so it is
 *  paced by reading speed -- and a fixed "3 seconds" would be both too long for
 *  "ok" and far too short for two sentences. */

export const BUBBLE_MAX_CHARS = 280;
const MIN_MS = 2500;
const MAX_MS = 14000;
/** ~17 characters a second is a comfortable silent-reading pace for short
 *  on-screen text; the base gives the eye time to find the bubble at all. */
const BASE_MS = 1200;
const MS_PER_CHAR = 60;
/** A caption outlives its audio slightly, so the last words are not yanked away
 *  on the same frame the mouth stops. */
const AUDIO_TAIL_MS = 900;

export interface SpeechBubble {
  text: string;
  muted: boolean;
  /** Monotonic id, so a repeat of the SAME sentence still restarts its timer. */
  seq: number;
}

/** Collapse whitespace and cut at a word boundary. A caption is one glance, not
 *  a transcript: the full text is already in the room feed. */
export function bubbleText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const text = raw.replace(/\s+/g, ' ').trim();
  if (text.length <= BUBBLE_MAX_CHARS) return text;
  const cut = text.slice(0, BUBBLE_MAX_CHARS - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > BUBBLE_MAX_CHARS * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** How long the bubble stays. `audioMs` is the synthesized clip's length, or 0
 *  when there is no audio (muted, or the voice service is down). */
export function bubbleDurationMs(text: string, audioMs: unknown): number {
  const reading = BASE_MS + text.length * MS_PER_CHAR;
  const audio = typeof audioMs === 'number' && Number.isFinite(audioMs) && audioMs > 0
    ? audioMs + AUDIO_TAIL_MS
    : 0;
  // Audio wins when there is any: the caption belongs to the voice. Both paths
  // share one floor and one ceiling, so a runaway clip cannot pin a caption.
  return Math.min(MAX_MS, Math.max(MIN_MS, audio || reading));
}

export interface Box { left: number; top: number; right: number; bottom: number }

/** The nudge that brings a bubble fully inside the window.
 *
 *  The avatar window is framed TIGHT to the body: the top of the head sits a few
 *  dozen pixels under the window edge, so "above the head" is mostly outside the
 *  window. Measured on first contact with the real app: a correctly-anchored bubble
 *  drew entirely off-screen and every test still passed. A caption nobody can see
 *  is worse than none, so visibility wins over placement -- when there is no room
 *  above, the bubble overlaps the top of the head rather than leaving the window.
 *
 *  `rect` is the bubble's NATURAL box (before any nudge). When the bubble is larger
 *  than the window on an axis it pins to the leading edge, so the START of the
 *  text is what stays readable. */
export function clampIntoViewport(
  rect: Box,
  viewport: { width: number; height: number },
  margin = 8,
): { dx: number; dy: number } {
  const axis = (lo: number, hi: number, size: number) => {
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !Number.isFinite(size)) return 0;
    if (hi - lo > size - margin * 2 || lo < margin) return margin - lo;
    if (hi > size - margin) return size - margin - hi;
    return 0;
  };
  return {
    dx: axis(rect.left, rect.right, viewport.width),
    dy: axis(rect.top, rect.bottom, viewport.height),
  };
}
