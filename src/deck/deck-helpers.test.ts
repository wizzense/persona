import { describe, expect, it } from 'vitest';
import {
  cardWhere,
  formatAge,
  primaryChoice,
  secondaryChoice,
  type DeckDecision,
} from './deck-types';

function card(overrides: Partial<DeckDecision> = {}): DeckDecision {
  return {
    id: 'd-1',
    title: 'Waiting on you',
    summary: '…',
    urgency: 'low',
    createdAt: 0,
    options: [],
    defaultKey: '',
    tab: '',
    cwd: '',
    agent: '',
    ...overrides,
  };
}

describe('cardWhere', () => {
  it('names the tab first, then cwd, then agent', () => {
    expect(cardWhere(card({ tab: 'pipeline', cwd: 'C:\\x', agent: 'bot' }))).toBe('pipeline');
    expect(cardWhere(card({ cwd: 'C:\\x', agent: 'bot' }))).toBe('C:\\x');
    expect(cardWhere(card({ agent: 'bot' }))).toBe('bot');
    expect(cardWhere(card())).toBe('');
  });
});

describe('formatAge', () => {
  const now = 10_000_000;
  it('renders human wall-clock age, not a date', () => {
    expect(formatAge(now, now * 1000)).toBe('just now');
    expect(formatAge(now - 4 * 60, now * 1000)).toBe('4m');
    expect(formatAge(now - 2 * 3600, now * 1000)).toBe('2h');
    expect(formatAge(now - 3 * 86400, now * 1000)).toBe('3d');
  });
  it('never goes negative on a clock-skewed createdAt', () => {
    expect(formatAge(now + 500, now * 1000)).toBe('just now');
  });
});

describe('primaryChoice / secondaryChoice', () => {
  const ackLater = card({
    options: [
      { key: 'ack', label: 'I am looking now', recommended: true },
      { key: 'later', label: 'Not now', recommended: false },
    ],
    defaultKey: 'ack',
  });

  it('prefers the raiser’s default key for the primary button', () => {
    expect(primaryChoice(ackLater)).toEqual({ key: 'ack', label: 'I am looking now' });
  });

  it('falls back to recommended, then first, and null on no options', () => {
    const noDefault = card({
      options: [
        { key: 'a', label: 'A', recommended: false },
        { key: 'b', label: 'B', recommended: true },
      ],
    });
    expect(primaryChoice(noDefault)).toEqual({ key: 'b', label: 'B' });

    const nothingRecommended = card({
      options: [{ key: 'a', label: 'A', recommended: false }],
    });
    expect(primaryChoice(nothingRecommended)).toEqual({ key: 'a', label: 'A' });
    expect(primaryChoice(card())).toBeNull();
  });

  it('secondary is the defer path: first non-recommended option', () => {
    expect(secondaryChoice(ackLater)).toEqual({ key: 'later', label: 'Not now' });
    // all-recommended or single-option cards have no defer button
    expect(secondaryChoice(card({
      options: [
        { key: 'a', label: 'A', recommended: true },
        { key: 'b', label: 'B', recommended: true },
      ],
    }))).toBeNull();
    expect(secondaryChoice(card({
      options: [{ key: 'a', label: 'A', recommended: true }],
    }))).toBeNull();
    expect(secondaryChoice(card())).toBeNull();
  });
});
