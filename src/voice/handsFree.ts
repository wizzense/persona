/**
 * Hands-free talk: open mic, and the hotkey's "talk until I stop".
 *
 * Two shapes, one endpointer (./endpointer.ts):
 *  - OPEN: the mic stays open; every utterance the endpointer finds becomes its
 *    own recording and transcript. The owner just talks.
 *  - ONE-SHOT: recording starts NOW (a hotkey press) and stops by itself when
 *    the owner goes quiet -- Electron's global shortcuts report a key going
 *    down but never coming up, so a hotkey cannot be held the way the avatar
 *    can. If nothing is said at all, it gives up rather than recording forever.
 *
 * The recorder is the existing push-to-talk (./pushToTalk.ts): it asks for a
 * stream per clip and releases it, so this module owns ONE master stream and
 * hands the recorder clones -- stopping a clone never closes the master.
 *
 * Echo: while the avatar is speaking, the mic hears it. Levels are ignored for
 * that time (plus a short tail), or Aither would answer herself forever.
 */

import { createEndpointer, rms, type EndpointOptions } from './endpointer';

export interface TalkLike {
  start: () => Promise<void> | void;
  stop: () => void;
  readonly state: 'idle' | 'listening' | 'transcribing';
}

export interface HandsFreeDeps {
  getStream: () => Promise<MediaStream>;
  /** Start metering a stream; calls onLevel with RMS 0..1; returns a stop fn. */
  meter: (stream: MediaStream, onLevel: (level: number) => void) => () => void;
  talk: TalkLike;
  /** True while the desk itself is speaking through the speakers. */
  isEchoing: () => boolean;
  now?: () => number;
  endpoint?: Partial<EndpointOptions>;
  /** One-shot: give up after this long with no speech at all. */
  noSpeechMs?: number;
  /** Ignore the mic this long after the desk stops speaking (room reverb). */
  echoTailMs?: number;
  onError?: (message: string) => void;
}

export type HandsFreeMode = 'off' | 'open' | 'one-shot';

export function createHandsFree(deps: HandsFreeDeps) {
  const now = deps.now ?? (() => Date.now());
  const noSpeechMs = deps.noSpeechMs ?? 8000;
  const echoTailMs = deps.echoTailMs ?? 600;
  const ep = createEndpointer(deps.endpoint);
  let mode: HandsFreeMode = 'off';
  let master: MediaStream | null = null;
  let stopMeter: (() => void) | null = null;
  let armedAt = 0;
  let heardAny = false;
  let lastEcho = -Infinity;
  let generation = 0;

  function releaseMaster() {
    stopMeter?.();
    stopMeter = null;
    try {
      master?.getTracks().forEach((t) => t.stop());
    } catch {
      /* already dead */
    }
    master = null;
    ep.reset();
  }

  function onLevel(level: number) {
    const t = now();
    if (deps.isEchoing()) {
      lastEcho = t;
      ep.reset();
      return;
    }
    if (t - lastEcho < echoTailMs) return;
    const event = ep.feed(level, t);
    if (mode === 'open') {
      if (event === 'start' && deps.talk.state === 'idle') void deps.talk.start();
      else if (event === 'end' && deps.talk.state === 'listening') deps.talk.stop();
    } else if (mode === 'one-shot') {
      if (event === 'start') heardAny = true;
      const gaveUp = !heardAny && t - armedAt >= noSpeechMs;
      if (event === 'end' || gaveUp) {
        if (deps.talk.state === 'listening') deps.talk.stop();
        disable();
      }
    }
  }

  async function acquire(next: HandsFreeMode): Promise<boolean> {
    const mine = ++generation;
    releaseMaster();
    mode = next;
    try {
      const stream = await deps.getStream();
      if (mine !== generation) {
        // disable() or another enable() ran while getUserMedia was pending
        stream.getTracks().forEach((t) => t.stop());
        return false;
      }
      master = stream;
      stopMeter = deps.meter(stream, onLevel);
      return true;
    } catch (error) {
      if (mine === generation) mode = 'off';
      deps.onError?.(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  async function enableOpen() {
    if (mode === 'open') return;
    await acquire('open');
  }

  /** Record now; stop on its own when the owner goes quiet. */
  async function oneShot() {
    if (mode === 'open') {
      // Open mic is already listening for speech; a press just means "I'm
      // talking now" -- start the clip rather than open a second mic.
      if (deps.talk.state === 'idle') void deps.talk.start();
      return;
    }
    if (!(await acquire('one-shot'))) return;
    armedAt = now();
    heardAny = false;
    await deps.talk.start();
  }

  function disable() {
    generation += 1;
    mode = 'off';
    releaseMaster();
  }

  return {
    enableOpen,
    oneShot,
    disable,
    /** A clone for the recorder while hands-free holds the mic, else null. */
    cloneStream: (): MediaStream | null => (master ? master.clone() : null),
    get mode() {
      return mode;
    },
  };
}

/** The browser meter: an AnalyserNode polled every 50 ms. */
export function browserMeter(stream: MediaStream, onLevel: (level: number) => void): () => void {
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const frame = new Float32Array(analyser.fftSize);
  const id = window.setInterval(() => {
    analyser.getFloatTimeDomainData(frame);
    onLevel(rms(frame));
  }, 50);
  return () => {
    window.clearInterval(id);
    try {
      source.disconnect();
    } catch {
      /* already disconnected */
    }
    void ctx.close().catch(() => {});
  };
}
