import { describe, expect, it, vi } from 'vitest';

import { createPushToTalk, preferredMime } from './pushToTalk';

/** A MediaRecorder that does exactly what the real one does to us: fires
 *  ondataavailable while running, then onstop asynchronously. */
function fakeRecorderFactory() {
  const made: FakeRecorder[] = [];
  class FakeRecorder {
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    started = false;
    constructor(readonly stream: MediaStream, readonly mime: string) { made.push(this); }
    start() { this.started = true; }
    stop() {
      this.started = false;
      this.ondataavailable?.({ data: new Blob(['audio'], { type: this.mime }) });
      this.onstop?.();
    }
    stopEmpty() { this.started = false; this.onstop?.(); }
  }
  return { made, make: (s: MediaStream, m: string) => new FakeRecorder(s, m) as unknown as MediaRecorder };
}

function fakeStream() {
  const stopped: string[] = [];
  const stream = {
    getTracks: () => [{ stop: () => stopped.push('track') }],
  } as unknown as MediaStream;
  return { stream, stopped };
}

function harness(overrides: Partial<Parameters<typeof createPushToTalk>[0]> = {}) {
  const { stream, stopped } = fakeStream();
  const recorders = fakeRecorderFactory();
  const delivered: string[] = [];
  const errors: string[] = [];
  const states: string[] = [];
  const talk = createPushToTalk({
    getStream: async () => stream,
    makeRecorder: recorders.make,
    encode: async () => 'YmFzZTY0',
    transcribe: async () => 'what is waiting on me',
    deliver: (text) => delivered.push(text),
    onState: (state) => states.push(state),
    onError: (message) => errors.push(message),
    ...overrides,
  });
  return { talk, recorders, delivered, errors, states, stopped };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('push to talk', () => {
  it('captures, transcribes and delivers', async () => {
    const h = harness();
    await h.talk.start();
    expect(h.talk.state).toBe('listening');
    h.talk.stop();
    await settle();
    expect(h.delivered).toEqual(['what is waiting on me']);
    expect(h.talk.state).toBe('idle');
    expect(h.states).toEqual(['listening', 'transcribing', 'idle']);
  });

  it('ALWAYS releases the microphone', async () => {
    // A stream left open keeps the OS mic indicator lit, which reads as "it is
    // still listening to me" -- the one failure here that is alarming rather
    // than merely broken.
    const h = harness();
    await h.talk.start();
    h.talk.stop();
    await settle();
    expect(h.stopped.length).toBe(1);
  });

  it('releases the microphone when the transcriber throws', async () => {
    const h = harness({ transcribe: async () => { throw new Error('gateway down'); } });
    await h.talk.start();
    h.talk.stop();
    await settle();
    expect(h.stopped.length).toBe(1);
    expect(h.errors).toEqual(['gateway down']);
    expect(h.talk.state).toBe('idle');
  });

  it('a second start does not open a second microphone', async () => {
    const h = harness();
    await h.talk.start();
    await h.talk.start();
    expect(h.recorders.made.length).toBe(1);
  });

  it('a stop with nothing running is a no-op', () => {
    const h = harness();
    h.talk.stop();
    expect(h.errors).toEqual([]);
    expect(h.talk.state).toBe('idle');
  });

  it('a denied microphone reports and stays idle', async () => {
    const h = harness({ getStream: async () => { throw new Error('Permission denied'); } });
    await h.talk.start();
    expect(h.errors).toEqual(['Permission denied']);
    expect(h.talk.state).toBe('idle');
  });

  it('an ERROR: transcript is an error, not a message to the agents', async () => {
    const h = harness({ transcribe: async () => 'ERROR: transcribe_audio timed out' });
    await h.talk.start();
    h.talk.stop();
    await settle();
    expect(h.delivered).toEqual([]);
    expect(h.errors).toEqual(['transcribe_audio timed out']);
  });

  it('silence is reported, never delivered as an empty message', async () => {
    const h = harness({ transcribe: async () => '   ' });
    await h.talk.start();
    h.talk.stop();
    await settle();
    expect(h.delivered).toEqual([]);
    expect(h.errors).toEqual(['nothing was heard']);
  });

  it('toggle listens then delivers', async () => {
    const h = harness();
    h.talk.toggle();
    await settle();
    h.talk.toggle();
    await settle();
    expect(h.delivered.length).toBe(1);
  });

  it('prefers opus but never throws when the codec query does', () => {
    expect(preferredMime(() => true)).toBe('audio/webm;codecs=opus');
    expect(preferredMime(() => false)).toBe('audio/webm');
    expect(preferredMime(() => { throw new Error('no MediaRecorder'); })).toBe('audio/webm');
  });

  it('does not call the gateway when nothing was captured', async () => {
    const transcribe = vi.fn(async () => 'never');
    const h = harness({ transcribe });
    await h.talk.start();
    (h.recorders.made[0] as unknown as { stopEmpty: () => void }).stopEmpty();
    await settle();
    expect(transcribe).not.toHaveBeenCalled();
    expect(h.errors).toEqual(['nothing was recorded']);
  });
});
