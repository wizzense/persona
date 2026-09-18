import { describe, expect, it } from 'vitest';
import {
  CHAT_TARGET_KEY,
  DEFAULT_CHAT_TARGET,
  ROOM_VALUE,
  chatPickerGroups,
  chatTargetFromValue,
  chatTargetValue,
  decodeChatTarget,
  directEmptyText,
  encodeChatTarget,
  loadChatTarget,
  saveChatTarget,
  type TargetStorage,
} from './chat-target';

function memoryStorage(
  initial: Record<string, string> = {},
): TargetStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

describe('chat target persistence', () => {
  it('round-trips a direct target through storage', () => {
    const storage = memoryStorage();
    expect(saveChatTarget(storage, { source: 'relay', agent: 'aither' })).toBe(true);
    expect(loadChatTarget(storage)).toEqual({ source: 'relay', agent: 'aither' });
    expect(storage.data[CHAT_TARGET_KEY]).toBe(encodeChatTarget({ source: 'relay', agent: 'aither' }));
  });

  it('round-trips the local room and the whole channel', () => {
    const storage = memoryStorage();
    saveChatTarget(storage, { source: 'room', agent: 'aither' });
    expect(loadChatTarget(storage)).toEqual({ source: 'room', agent: null });
    saveChatTarget(storage, { source: 'relay', agent: null });
    expect(loadChatTarget(storage)).toEqual({ source: 'relay', agent: null });
  });

  it('falls back to the company room on missing, malformed or hostile input', () => {
    expect(loadChatTarget(null)).toEqual(DEFAULT_CHAT_TARGET);
    expect(loadChatTarget(memoryStorage())).toEqual(DEFAULT_CHAT_TARGET);
    expect(loadChatTarget(memoryStorage({ [CHAT_TARGET_KEY]: '{not json' }))).toEqual(DEFAULT_CHAT_TARGET);
    expect(decodeChatTarget('{"source":"relay","agent":"<script>"}')).toBeNull();
    expect(decodeChatTarget('{"source":"other","agent":"aither"}')).toBeNull();
    expect(decodeChatTarget('{"source":"relay","agent":42}')).toBeNull();
    expect(decodeChatTarget('[]')).toBeNull();
  });

  it('survives a storage that throws (blocked file:// storage)', () => {
    const throwing: TargetStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(loadChatTarget(throwing)).toEqual(DEFAULT_CHAT_TARGET);
    expect(saveChatTarget(throwing, { source: 'relay', agent: 'aither' })).toBe(false);
  });
});

describe('select value mapping', () => {
  it('maps every target to a value and back', () => {
    for (const target of [
      { source: 'relay' as const, agent: null },
      { source: 'relay' as const, agent: 'hydra' },
      { source: 'room' as const, agent: null },
    ]) {
      expect(chatTargetFromValue(chatTargetValue(target))).toEqual(target);
    }
    expect(chatTargetValue({ source: 'room', agent: null })).toBe(ROOM_VALUE);
  });
});

describe('chatPickerGroups', () => {
  const input = {
    relayChannel: '#agents',
    agents: ['aeon', 'aither', 'hydra', 'lyra'],
    slots: [{ agent: 'hydra' }, { agent: '' }, { agent: 'hydra' }, { agent: 'zed' }],
  };

  it('leads with the company room and the local room', () => {
    const [rooms] = chatPickerGroups(input);
    expect(rooms.label).toBe('Rooms');
    expect(rooms.options.map((o) => o.value)).toEqual(['', ROOM_VALUE]);
    expect(rooms.options[0].label).toBe('company room (#agents)');
  });

  it('puts spawned agents first, deduped, unassigned slots skipped, non-roster spawn kept', () => {
    const groups = chatPickerGroups(input);
    const desk = groups.find((g) => g.label === 'On the desk');
    expect(desk?.options.map((o) => o.value)).toEqual(['hydra', 'zed']);
    expect(desk?.options[0].label).toBe('hydra — direct');
  });

  it('lists the rest of the roster without the spawned ones', () => {
    const groups = chatPickerGroups(input);
    const roster = groups.find((g) => g.label === 'Agents');
    expect(roster?.options.map((o) => o.value)).toEqual(['aeon', 'aither', 'lyra']);
  });

  it('keeps a remembered agent that left the roster selectable', () => {
    const groups = chatPickerGroups({ ...input, current: 'ghost' });
    const roster = groups.find((g) => g.label === 'Agents');
    expect(roster?.options.map((o) => o.value)).toContain('ghost');
    // ...but never duplicates one that is already there.
    const twice = chatPickerGroups({ ...input, current: 'hydra' }).flatMap((g) => g.options.map((o) => o.value));
    expect(twice.filter((v) => v === 'hydra')).toHaveLength(1);
  });

  it('omits empty groups', () => {
    const groups = chatPickerGroups({ relayChannel: '#agents', agents: [], slots: [] });
    expect(groups.map((g) => g.label)).toEqual(['Rooms']);
  });

  it('keeps every option value unique (two equal values would select the wrong row)', () => {
    const values = chatPickerGroups(input).flatMap((g) => g.options.map((o) => o.value));
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('directEmptyText', () => {
  it('names where the message goes when there is no thread yet', () => {
    expect(directEmptyText('aither', '#agents', false)).toContain('@aither');
    expect(directEmptyText('aither', '#agents', false)).toContain('#agents');
    expect(directEmptyText('aither', '#agents', true)).toContain('aither');
    expect(directEmptyText('aither', '#agents', true)).not.toContain('@aither');
  });
});
