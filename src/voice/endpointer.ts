/**
 * Voice activity endpointing -- the part of open mic and hands-free talk that
 * decides when the owner STARTED and STOPPED speaking (owner, 2026-09-22:
 * "turn on full two way where mic is just open").
 *
 * Pure: it is fed an RMS level (0..1) and a clock, and says 'start' / 'end'.
 * The mic, the analyser and the recorder live elsewhere, so this can be tested
 * without audio -- the failure modes worth pinning are a cough cutting a clip,
 * a pause mid-sentence splitting one utterance in two, and a clip that never
 * ends because the room is never perfectly silent.
 */

export interface EndpointOptions {
  /** RMS above this counts as voice. Room tone on a desk mic sits ~0.005-0.01. */
  threshold: number;
  /** Voice must hold this long before it counts as speech (drops clicks, coughs). */
  minSpeechMs: number;
  /** Quiet this long after speech ends the utterance (a mid-sentence pause is shorter). */
  silenceMs: number;
  /** Hard ceiling: an utterance ends here even if the room never goes quiet. */
  maxUtteranceMs: number;
}

export const DEFAULT_ENDPOINT: EndpointOptions = Object.freeze({
  threshold: 0.02,
  minSpeechMs: 180,
  silenceMs: 1100,
  maxUtteranceMs: 30000,
});

export type EndpointEvent = 'start' | 'end' | null;

export function createEndpointer(options: Partial<EndpointOptions> = {}) {
  const opts: EndpointOptions = { ...DEFAULT_ENDPOINT, ...options };
  let inSpeech = false;
  let voiceSince: number | null = null;   // first loud frame of a candidate onset
  let lastVoice = 0;                      // last loud frame inside an utterance
  let startedAt = 0;

  function reset() {
    inSpeech = false;
    voiceSince = null;
  }

  /** Feed one level sample; returns 'start' / 'end' on a transition, else null. */
  function feed(level: number, now: number): EndpointEvent {
    const loud = Number.isFinite(level) && level >= opts.threshold;
    if (!inSpeech) {
      if (!loud) {
        voiceSince = null;
        return null;
      }
      if (voiceSince === null) voiceSince = now;
      if (now - voiceSince >= opts.minSpeechMs) {
        inSpeech = true;
        startedAt = voiceSince;
        lastVoice = now;
        return 'start';
      }
      return null;
    }
    if (loud) lastVoice = now;
    if (now - lastVoice >= opts.silenceMs || now - startedAt >= opts.maxUtteranceMs) {
      reset();
      return 'end';
    }
    return null;
  }

  return {
    feed,
    reset,
    get speaking() {
      return inSpeech;
    },
  };
}

/** RMS of a time-domain frame from AnalyserNode.getFloatTimeDomainData. */
export function rms(frame: ArrayLike<number>): number {
  if (!frame.length) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}
