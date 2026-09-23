import { describe, expect, it } from 'vitest';

import { createEndpointer, rms } from './endpointer';

/** Drive the endpointer with [level, durationMs] segments at 50 ms frames. */
function run(segments: Array<[number, number]>, opts = {}) {
  const ep = createEndpointer({ threshold: 0.02, minSpeechMs: 150, silenceMs: 1000, maxUtteranceMs: 10000, ...opts });
  const events: Array<[string, number]> = [];
  let t = 0;
  for (const [level, ms] of segments) {
    for (let elapsed = 0; elapsed < ms; elapsed += 50) {
      const e = ep.feed(level, t);
      if (e) events.push([e, t]);
      t += 50;
    }
  }
  return events.map(([e]) => e);
}

describe('endpointer', () => {
  it('a sentence is one start and one end', () => {
    expect(run([[0.001, 500], [0.1, 1500], [0.001, 1500]])).toEqual(['start', 'end']);
  });

  it('a click or cough shorter than minSpeech is not speech', () => {
    expect(run([[0.001, 300], [0.2, 100], [0.001, 2000]])).toEqual([]);
  });

  it('a mid-sentence pause shorter than silenceMs does not split the utterance', () => {
    expect(run([[0.1, 800], [0.001, 600], [0.1, 800], [0.001, 1500]])).toEqual(['start', 'end']);
  });

  it('a room that never goes quiet still ends at maxUtterance', () => {
    expect(run([[0.1, 4000]], { maxUtteranceMs: 2000 })).toEqual(['start', 'end', 'start']);
  });

  it('silence alone and NaN levels never start anything', () => {
    expect(run([[0, 3000], [Number.NaN, 1000]])).toEqual([]);
  });

  it('two sentences with a real gap are two utterances', () => {
    expect(run([[0.1, 800], [0.001, 1500], [0.1, 800], [0.001, 1500]])).toEqual(['start', 'end', 'start', 'end']);
  });
});

describe('rms', () => {
  it('is 0 for an empty or silent frame and the amplitude for a square wave', () => {
    expect(rms([])).toBe(0);
    expect(rms([0, 0, 0])).toBe(0);
    expect(rms([0.5, -0.5, 0.5, -0.5])).toBeCloseTo(0.5);
  });
});
