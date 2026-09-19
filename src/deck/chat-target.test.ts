import { describe, expect, it } from 'vitest';
import {
  BODIES_GROUP_LABEL,
  CHAT_TARGET_KEY,
  DEFAULT_CHAT_TARGET,
  ROOM_VALUE,
  SESSION_PREFIX,
  chatPickerGroups,
  chatTargetFromValue,
  chatTargetValue,
  decodeChatTarget,
  decodeSessionId,
  decodeTargetValue,
  directEmptyText,
  encodeChatTarget,
  loadChatTarget,
  saveChatTarget,
  sessionTarget,
  stageBodyOptions,
  type StageBody,
  type TargetStorage,
} from './chat-target';

/** A discovered Claude Code tab's id (canonical UUID) and a daemon-owned
 *  session's id (uuid4().hex[:16], adk/harnesses/session.py:119). */
const TAB_ID = 'a345ec92-9f90-4f8d-80f9-a77f30b3d8de';
const TAB_ID_2 = 'b7d1c0f2-1111-4222-8333-444455556666';
const DAEMON_ID = '0123456789abcdef';

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

describe('session targets', () => {
  it('round-trips a session target through encode/decode and through storage', () => {
    const target = sessionTarget(TAB_ID);
    expect(target).toEqual({ source: 'session', agent: null, session: TAB_ID });
    expect(decodeChatTarget(encodeChatTarget(target!))).toEqual(target);
    // A daemon-owned session (16 hex) is addressable too, or every session
    // the daemon itself owns would be unpickable.
    const daemon = sessionTarget(DAEMON_ID)!;
    expect(decodeChatTarget(encodeChatTarget(daemon))).toEqual(daemon);
    const storage = memoryStorage();
    expect(saveChatTarget(storage, daemon)).toBe(true);
    expect(loadChatTarget(storage)).toEqual(daemon);
  });

  it('refuses every malformed id instead of half-building a target', () => {
    for (const bad of [
      '',
      'session:',
      'a345ec92-9f90-4f8d-80f9',                   // truncated uuid
      'a345ec92-9f90-4f8d-80f9-a77f30b3d8dz',      // non-hex tail
      'a345ec92 9f90 4f8d 80f9 a77f30b3d8de',      // spaces for dashes
      ` ${TAB_ID}`,                                // leading space
      `${TAB_ID}\n`,
      '0123456789abcde',                           // 15 hex
      '0123456789abcdef0',                         // 17 hex
      'adk-0123456789ab',
      '../../etc/passwd',
      '*',
    ]) {
      expect(decodeSessionId(bad), bad).toBeNull();
      expect(sessionTarget(bad), bad).toBeNull();
      expect(decodeChatTarget(JSON.stringify({ source: 'session', session: bad })), bad).toBeNull();
      expect(decodeTargetValue(`${SESSION_PREFIX}${bad}`), bad).toBeNull();
    }
    expect(decodeSessionId(undefined)).toBeNull();
    expect(decodeSessionId(42)).toBeNull();
    // A session source with NO session key at all is not a target either.
    expect(decodeChatTarget('{"source":"session","agent":"aither"}')).toBeNull();
    // ...and a stored one that cannot be decoded lands on the company room,
    // never on a target with nowhere to deliver.
    expect(loadChatTarget(memoryStorage({ [CHAT_TARGET_KEY]: '{"source":"session","session":"nope"}' })))
      .toEqual(DEFAULT_CHAT_TARGET);
  });

  it('never persists or offers a value that decode would refuse', () => {
    const bogus = { source: 'session' as const, agent: null, session: 'nope' };
    expect(decodeChatTarget(encodeChatTarget(bogus))).toEqual(DEFAULT_CHAT_TARGET);
    expect(chatTargetValue(bogus)).toBe('');
  });

  it('maps a session target to its select value and back', () => {
    const target = sessionTarget(TAB_ID)!;
    expect(chatTargetValue(target)).toBe(`${SESSION_PREFIX}${TAB_ID}`);
    expect(decodeTargetValue(chatTargetValue(target))).toEqual(target);
    expect(chatTargetFromValue(chatTargetValue(target))).toEqual(target);
    // The value grammar cannot collide with an agent name (no colons allowed).
    expect(decodeChatTarget(JSON.stringify({ source: 'relay', agent: `${SESSION_PREFIX}${TAB_ID}` }))).toBeNull();
  });
});

describe('stageBodyOptions', () => {
  const bodies: StageBody[] = [
    { slotId: 'slot-1', agent: 'AitherOS-Fresh', actorKind: 'claude_code', sessionId: TAB_ID, title: 'room spine' },
    { slotId: 'slot-2', agent: 'AitherOS-Fresh', actorKind: 'claude_code', sessionId: TAB_ID_2, title: 'plan 40' },
  ];

  it('offers one option per session, valued session:<id>', () => {
    expect(stageBodyOptions(bodies).map((o) => o.value)).toEqual([
      `${SESSION_PREFIX}${TAB_ID}`,
      `${SESSION_PREFIX}${TAB_ID_2}`,
    ]);
    expect(stageBodyOptions([])).toEqual([]);
    expect(stageBodyOptions(undefined)).toEqual([]);
  });

  it('gives two same-named bodies DISTINCT labels', () => {
    // The measured case: every claude_code actor in room main is named
    // "AitherOS-Fresh", so the agent name alone makes the rows identical.
    const labels = stageBodyOptions(bodies).map((o) => o.label);
    expect(new Set(labels).size).toBe(2);
    expect(labels[0]).toContain('room spine');
    expect(labels[1]).toContain('plan 40');

    // Same name AND same title: the short session id separates them, and
    // neither row reads as the canonical one.
    const twins = stageBodyOptions([
      { slotId: 'slot-1', agent: 'AitherOS-Fresh', sessionId: TAB_ID, title: 'AitherOS-Fresh' },
      { slotId: 'slot-2', agent: 'AitherOS-Fresh', sessionId: TAB_ID_2, title: 'AitherOS-Fresh' },
    ]);
    expect(new Set(twins.map((o) => o.label)).size).toBe(2);
    expect(twins[0].label).toContain(TAB_ID.slice(0, 8));
    expect(twins[1].label).toContain(TAB_ID_2.slice(0, 8));

    // Titleless bodies fall back to the agent name and are still distinct.
    const untitled = stageBodyOptions([
      { slotId: 'slot-1', agent: 'AitherOS-Fresh', sessionId: TAB_ID },
      { slotId: 'slot-2', agent: 'AitherOS-Fresh', sessionId: TAB_ID_2 },
    ]);
    expect(new Set(untitled.map((o) => o.label)).size).toBe(2);
  });

  it('skips a body with no addressable session and dedupes one on two slots', () => {
    const mixed = stageBodyOptions([
      { slotId: 'slot-1', agent: 'hydra', sessionId: null, title: 'no session' },
      { slotId: 'slot-2', agent: 'hydra', sessionId: 'not-a-session', title: 'bad id' },
      { slotId: 'slot-3', agent: 'hydra', sessionId: TAB_ID, title: 'real' },
      { slotId: 'slot-4', agent: 'hydra', sessionId: TAB_ID, title: 'real again' },
    ]);
    expect(mixed.map((o) => o.value)).toEqual([`${SESSION_PREFIX}${TAB_ID}`]);
    expect(mixed[0].label).toContain('real');
  });

  it('clamps a long title but keeps the rows distinguishable', () => {
    const long = 'a'.repeat(200);
    const opts = stageBodyOptions([
      { slotId: 's1', sessionId: TAB_ID, title: long },
      { slotId: 's2', sessionId: TAB_ID_2, title: long },
    ]);
    expect(opts[0].label.length).toBeLessThan(100);
    expect(new Set(opts.map((o) => o.label)).size).toBe(2);
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

  it('renders "Bodies on stage" right after Rooms, or not at all', () => {
    // Regression arm: no bodies passed = exactly today's groups.
    expect(chatPickerGroups(input).map((g) => g.label)).toEqual(['Rooms', 'On the desk', 'Agents']);
    const withBodies = chatPickerGroups({
      ...input,
      bodies: [
        { slotId: 'slot-1', agent: 'AitherOS-Fresh', sessionId: TAB_ID, title: 'room spine' },
        { slotId: 'slot-2', agent: 'AitherOS-Fresh', sessionId: TAB_ID_2, title: 'plan 40' },
      ],
    });
    expect(withBodies.map((g) => g.label)).toEqual([
      'Rooms',
      BODIES_GROUP_LABEL,
      'On the desk',
      'Agents',
    ]);
    const stage = withBodies.find((g) => g.label === BODIES_GROUP_LABEL)!;
    expect(stage.options.map((o) => o.value)).toEqual([
      `${SESSION_PREFIX}${TAB_ID}`,
      `${SESSION_PREFIX}${TAB_ID_2}`,
    ]);
    expect(new Set(stage.options.map((o) => o.label)).size).toBe(2);
    // Every value across every group still unique, bodies included.
    const values = withBodies.flatMap((g) => g.options.map((o) => o.value));
    expect(new Set(values).size).toBe(values.length);
    // A body with no session id contributes no group at all.
    expect(chatPickerGroups({ ...input, bodies: [{ slotId: 'slot-1', agent: 'hydra' }] }).map((g) => g.label))
      .not.toContain(BODIES_GROUP_LABEL);
  });

  it('keeps a remembered session selectable after its body leaves the stage', () => {
    const groups = chatPickerGroups({ ...input, currentSession: TAB_ID });
    const stage = groups.find((g) => g.label === BODIES_GROUP_LABEL)!;
    expect(stage.options.map((o) => o.value)).toEqual([`${SESSION_PREFIX}${TAB_ID}`]);
    expect(stage.options[0].label).toContain('no longer on stage');
    // ...but never twice when it IS on stage.
    const live = chatPickerGroups({
      ...input,
      currentSession: TAB_ID,
      bodies: [{ slotId: 'slot-1', agent: 'aither', sessionId: TAB_ID, title: 'room spine' }],
    });
    const values = live.flatMap((g) => g.options.map((o) => o.value));
    expect(values.filter((v) => v === `${SESSION_PREFIX}${TAB_ID}`)).toHaveLength(1);
    // A malformed remembered session adds nothing.
    expect(chatPickerGroups({ ...input, currentSession: 'nope' }).map((g) => g.label))
      .not.toContain(BODIES_GROUP_LABEL);
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

// ── live session channels (multiplayer attach, 2026-09-19) ─────────────────

import {
  CHANNEL_PREFIX,
  channelEmptyText,
  decodeSessionChannel,
} from './chat-target';

describe('live session channels', () => {
  it('accepts only the mirror\'s own channel shape', () => {
    expect(decodeSessionChannel('#session-77db6255')).toBe('#session-77db6255');
    expect(decodeSessionChannel('#session-DEADBEEF')).toBeNull();   // upper-case hex refused
    expect(decodeSessionChannel('#session-77db625')).toBeNull();    // 7 chars
    expect(decodeSessionChannel('#agents')).toBeNull();
    expect(decodeSessionChannel('#session-77db6255/../x')).toBeNull();
    expect(decodeSessionChannel(42)).toBeNull();
  });

  it('round-trips through storage and the <select> value', () => {
    const target = { source: 'channel' as const, agent: null, channel: '#session-77db6255' };
    const stored = encodeChatTarget(target);
    expect(decodeChatTarget(stored)).toEqual(target);
    const value = chatTargetValue(target);
    expect(value).toBe(`${CHANNEL_PREFIX}#session-77db6255`);
    expect(chatTargetFromValue(value)).toEqual(target);
    expect(decodeTargetValue(value)).toEqual(target);
  });

  it('refuses a malformed stored channel instead of retargeting the composer', () => {
    expect(decodeChatTarget(JSON.stringify({ source: 'channel', agent: null, channel: '#general' }))).toBeNull();
    // Encoding a bad one stores the DEFAULT, never the bad value.
    expect(encodeChatTarget({ source: 'channel', agent: null, channel: '#general' }))
      .toBe(JSON.stringify(DEFAULT_CHAT_TARGET));
    expect(chatTargetFromValue(`${CHANNEL_PREFIX}#general`)).toEqual(DEFAULT_CHAT_TARGET);
  });

  it('lists live sessions as their own picker group, right after the rooms', () => {
    const groups = chatPickerGroups({
      relayChannel: '#agents',
      agents: ['hydra'],
      slots: [],
      sessionChannels: ['#session-77db6255', '#session-deadbeef', '#agents', 'junk'],
    });
    expect(groups[0].label).toBe('Rooms');
    expect(groups[1].label).toBe('Live sessions');
    expect(groups[1].options.map((o) => o.value)).toEqual([
      `${CHANNEL_PREFIX}#session-77db6255`,
      `${CHANNEL_PREFIX}#session-deadbeef`,
    ]);
    expect(groups[1].options[0].label).toContain('77db6255');
    expect(groups[1].options[0].label).toContain('watch & steer');
  });

  it('omits the group entirely when the relay lists no sessions', () => {
    const groups = chatPickerGroups({ relayChannel: '#agents', agents: [], slots: [], sessionChannels: [] });
    expect(groups.map((g) => g.label)).not.toContain('Live sessions');
  });

  it('empty text says what attaching and typing do', () => {
    const text = channelEmptyText('#session-77db6255');
    expect(text).toContain('#session-77db6255');
    expect(text).toContain('steers');
  });
});
