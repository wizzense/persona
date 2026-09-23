import { describe, expect, it } from 'vitest';

import { createHandsFree, type TalkLike } from './handsFree';

function fakeStream() {
  const stopped: string[] = [];
  const stream = {
    getTracks: () => [{ stop: () => stopped.push('master') }],
    clone: () => ({ getTracks: () => [{ stop: () => stopped.push('clone') }] }),
  } as unknown as MediaStream;
  return { stream, stopped };
}

function harness(opts: { echo?: () => boolean } = {}) {
  const { stream, stopped } = fakeStream();
  let t = 0;
  let levelSink: ((l: number) => void) | null = null;
  let meterStopped = 0;
  const log: string[] = [];
  const talk: TalkLike & { state: 'idle' | 'listening' | 'transcribing' } = {
    state: 'idle',
    start() { this.state = 'listening'; log.push('start'); },
    stop() { this.state = 'idle'; log.push('stop'); },
  };
  const hf = createHandsFree({
    getStream: async () => stream,
    meter: (_s, onLevel) => { levelSink = onLevel; return () => { meterStopped += 1; levelSink = null; }; },
    talk,
    isEchoing: opts.echo ?? (() => false),
    now: () => t,
    endpoint: { threshold: 0.02, minSpeechMs: 100, silenceMs: 500, maxUtteranceMs: 10000 },
    noSpeechMs: 2000,
    echoTailMs: 300,
  });
  /** Feed a level for `ms` at 50 ms frames. */
  const feed = (level: number, ms: number) => {
    for (let e = 0; e < ms; e += 50) { levelSink?.(level); t += 50; }
  };
  return { hf, talk, log, feed, stopped, meterStops: () => meterStopped, metering: () => levelSink !== null };
}

describe('open mic', () => {
  it('each utterance is its own clip', async () => {
    const h = harness();
    await h.hf.enableOpen();
    h.feed(0.001, 300); h.feed(0.1, 600); h.feed(0.001, 700);
    h.feed(0.1, 600); h.feed(0.001, 700);
    expect(h.log).toEqual(['start', 'stop', 'start', 'stop']);
    expect(h.hf.mode).toBe('open');
  });

  it('never records the desk talking, nor its reverb tail', async () => {
    let speaking = true;
    const h = harness({ echo: () => speaking });
    await h.hf.enableOpen();
    h.feed(0.3, 2000);           // the avatar's own voice through the speakers
    speaking = false;
    h.feed(0.3, 250);            // reverb inside the tail
    expect(h.log).toEqual([]);
  });

  it('does not start a second clip while the last one is still transcribing', async () => {
    const h = harness();
    await h.hf.enableOpen();
    h.feed(0.1, 400); h.feed(0.001, 600);
    h.talk.state = 'transcribing';
    h.feed(0.1, 400);
    expect(h.log).toEqual(['start', 'stop']);
  });

  it('disable releases the mic and the meter', async () => {
    const h = harness();
    await h.hf.enableOpen();
    h.hf.disable();
    expect(h.stopped).toContain('master');
    expect(h.meterStops()).toBe(1);
    expect(h.hf.mode).toBe('off');
    expect(h.hf.cloneStream()).toBeNull();
  });
});

describe('one-shot (the hotkey)', () => {
  it('records at once and stops by itself when the owner goes quiet', async () => {
    const h = harness();
    await h.hf.oneShot();
    expect(h.log).toEqual(['start']);
    h.feed(0.1, 800); h.feed(0.001, 600);
    expect(h.log).toEqual(['start', 'stop']);
    expect(h.hf.mode).toBe('off');
    expect(h.metering()).toBe(false);
  });

  it('gives up when nothing is said, instead of recording forever', async () => {
    const h = harness();
    await h.hf.oneShot();
    h.feed(0.001, 2100);
    expect(h.log).toEqual(['start', 'stop']);
    expect(h.hf.mode).toBe('off');
  });

  it('under open mic a press starts a clip on the SAME mic', async () => {
    const h = harness();
    await h.hf.enableOpen();
    await h.hf.oneShot();
    expect(h.log).toEqual(['start']);
    expect(h.hf.mode).toBe('open');
  });
});
