/**
 * The chat pane's TARGET — where the composer is talking — as pure logic, so
 * the picker and the "remember where I was" rule are testable without React.
 *
 * Why this exists (owner, 2026-09-18: "the experience to like switch to
 * aither direct is clunky"): the pane came up on #agents every time, the
 * dropdown was a flat list of names with no grouping, and picking an agent
 * read as "No replies in this thread yet." -- an empty pane with no hint
 * that the next message would go out as an @mention. One motion now: the
 * last target is restored on open, the picker groups the room, the local
 * room, the agents ON the desk (spawned avatars) and the rest of the roster,
 * and the empty state says where the message will go.
 */

export type ChatSource = 'relay' | 'room' | 'channel';

export interface ChatTarget {
  /** relay = #agents (needs the fleet); room = the local awdk-daemon room. */
  source: ChatSource;
  /** null = the whole channel; a name = a direct thread with that agent. */
  agent: string | null;
  /** A LIVE SESSION CHANNEL on the relay (`#session-<8 hex>`); present ONLY
   *  when source === 'channel'. This is multiplayer attach (PRD REQ-1/9): a
   *  running Claude Code session mirrors its turns into that channel and
   *  reads steering back out of it, so joining the channel IS watching the
   *  session, and writing into it IS redirecting the agent. Any relay reader
   *  on any machine can do both. */
  channel?: string;
}

export const CHAT_TARGET_KEY = 'desk.chat-target.v1';

/** The `<select>` value for the local room. A leading space so it can never
 *  collide with an agent name (names are slugs). */
export const ROOM_VALUE = ' room';

export const DEFAULT_CHAT_TARGET: ChatTarget = { source: 'relay', agent: null };

/** The `<select>` value prefix for a live session channel. */
export const CHANNEL_PREFIX = 'chan:';

/** Only the mirror's own naming is accepted: `#session-` + 8 lowercase hex.
 *  Anything else is refused rather than posted to, so a stored or hostile
 *  value can never retarget the composer at an arbitrary channel. */
const SESSION_CHANNEL_RE = /^#session-[a-f0-9]{8}$/;

export function decodeSessionChannel(value: unknown): string | null {
  return typeof value === 'string' && SESSION_CHANNEL_RE.test(value) ? value : null;
}

function channelTarget(value: unknown): ChatTarget | null {
  const channel = decodeSessionChannel(value);
  return channel ? { source: 'channel', agent: null, channel } : null;
}

export interface PickerOption {
  value: string;
  label: string;
}

export interface PickerGroup {
  label: string;
  options: PickerOption[];
}

export interface PickerInput {
  relayChannel: string;
  /** Every known agent (roster + assigned), sorted by main. */
  agents: string[];
  /** Spawned avatars, in slot order; `agent` is '' for an unassigned one. */
  slots: Array<{ agent: string }>;
  /** The agent currently picked (a remembered one may have left the roster);
   *  it must still be an option or the select shows the wrong row. */
  current?: string | null;
  /** Live session channels the relay currently lists (`#session-*`) --
   *  every one is a running Claude Code session ANYONE can attach to. */
  sessionChannels?: readonly string[];
}

/** Validate a stored target: anything malformed becomes null, never a crash
 *  and never a half-target (a source with an agent from another world). */
export function decodeChatTarget(raw: string | null | undefined): ChatTarget | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const source = (parsed as { source?: unknown }).source;
  const agent = (parsed as { agent?: unknown }).agent;
  if (source !== 'relay' && source !== 'room' && source !== 'channel') return null;
  if (source === 'room') return { source: 'room', agent: null };
  if (source === 'channel') return channelTarget((parsed as { channel?: unknown }).channel);
  if (agent === null || agent === undefined || agent === '') return { source: 'relay', agent: null };
  if (typeof agent !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(agent)) return null;
  return { source: 'relay', agent };
}

export function encodeChatTarget(target: ChatTarget): string {
  if (target.source === 'channel') {
    const channel = decodeSessionChannel(target.channel);
    // Never persist what decode would refuse: a bad value stores the default.
    return JSON.stringify(channel ? { source: 'channel', agent: null, channel } : DEFAULT_CHAT_TARGET);
  }
  return JSON.stringify(
    target.source === 'room'
      ? { source: 'room', agent: null }
      : { source: 'relay', agent: target.agent || null },
  );
}

/** A storage that may be absent or throwing (a file:// iframe with storage
 *  blocked, a private profile): every path fails soft to the default. */
export interface TargetStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadChatTarget(storage: TargetStorage | null | undefined): ChatTarget {
  try {
    return decodeChatTarget(storage?.getItem(CHAT_TARGET_KEY)) ?? DEFAULT_CHAT_TARGET;
  } catch {
    return DEFAULT_CHAT_TARGET;
  }
}

export function saveChatTarget(storage: TargetStorage | null | undefined, target: ChatTarget): boolean {
  try {
    if (!storage) return false;
    storage.setItem(CHAT_TARGET_KEY, encodeChatTarget(target));
    return true;
  } catch {
    return false;
  }
}

/** Target -> the `<select>` value. */
export function chatTargetValue(target: ChatTarget): string {
  if (target.source === 'room') return ROOM_VALUE;
  if (target.source === 'channel') {
    const channel = decodeSessionChannel(target.channel);
    return channel ? `${CHANNEL_PREFIX}${channel}` : '';
  }
  return target.agent ?? '';
}

/** `<select>` value -> target. A malformed channel value falls back to the
 *  company room: picking it sends nothing and the header names #agents. */
export function chatTargetFromValue(value: string): ChatTarget {
  if (value === ROOM_VALUE) return { source: 'room', agent: null };
  if (value.startsWith(CHANNEL_PREFIX)) {
    return channelTarget(value.slice(CHANNEL_PREFIX.length)) ?? DEFAULT_CHAT_TARGET;
  }
  return { source: 'relay', agent: value || null };
}

/**
 * The picker, grouped. Spawned agents come first because they are the ones
 * the owner is looking at; the rest of the roster follows so any agent is one
 * pick away without needing an avatar on screen. A spawned agent missing from
 * the roster still appears (the slot is the truth of what is on the desk).
 */
export function chatPickerGroups(input: PickerInput): PickerGroup[] {
  const spawned: string[] = [];
  for (const slot of input.slots) {
    const name = (slot.agent || '').trim();
    if (name && !spawned.includes(name)) spawned.push(name);
  }
  const roster = input.agents.filter((name) => name && !spawned.includes(name));
  const current = (input.current || '').trim();
  if (current && !spawned.includes(current) && !roster.includes(current)) roster.push(current);
  const groups: PickerGroup[] = [
    {
      label: 'Rooms',
      options: [
        { value: '', label: `company room (${input.relayChannel})` },
        { value: ROOM_VALUE, label: 'local room — runs it here (fleet up or down)' },
      ],
    },
  ];
  // Live sessions come first after the rooms: this is the multiplayer
  // attach point, and it is the one group whose rows exist on the FLEET,
  // not on this desk -- a second human on another machine sees the same
  // list. Only the mirror's own channel shape is offered.
  const live = (input.sessionChannels ?? [])
    .map((name) => decodeSessionChannel(name))
    .filter((name): name is string => Boolean(name));
  if (live.length) {
    groups.push({
      label: 'Live sessions',
      options: live.map((name) => ({
        value: `${CHANNEL_PREFIX}${name}`,
        label: `${name.slice('#session-'.length)} — live session (watch & steer)`,
      })),
    });
  }
  if (spawned.length) {
    groups.push({
      label: 'On the desk',
      options: spawned.map((name) => ({ value: name, label: `${name} — direct` })),
    });
  }
  if (roster.length) {
    groups.push({
      label: 'Agents',
      options: roster.map((name) => ({ value: name, label: `${name} — direct` })),
    });
  }
  return groups;
}

/** The text the empty pane shows for a direct target: it names where the next
 *  message goes, so an empty thread does not read as a broken one. */
export function directEmptyText(agent: string, relayChannel: string, hasAnchor: boolean): string {
  if (hasAnchor) return `No replies in this thread with ${agent} yet — say something.`;
  return `Nothing between you and ${agent} yet. Your message goes to ${relayChannel} as @${agent}; the reply opens the thread.`;
}

/** The empty text for a live session channel: says what watching means and
 *  what typing does, because both are new to whoever just attached. */
export function channelEmptyText(channel: string): string {
  return `Attached to ${channel}. Its turns appear here as they happen; anything you type steers the agent's next turn.`;
}
