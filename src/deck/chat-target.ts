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

export type ChatSource = 'relay' | 'room';

export interface ChatTarget {
  /** relay = #agents (needs the fleet); room = the local awdk-daemon room. */
  source: ChatSource;
  /** null = the whole channel; a name = a direct thread with that agent. */
  agent: string | null;
}

export const CHAT_TARGET_KEY = 'desk.chat-target.v1';

/** The `<select>` value for the local room. A leading space so it can never
 *  collide with an agent name (names are slugs). */
export const ROOM_VALUE = ' room';

export const DEFAULT_CHAT_TARGET: ChatTarget = { source: 'relay', agent: null };

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
  if (source !== 'relay' && source !== 'room') return null;
  if (source === 'room') return { source: 'room', agent: null };
  if (agent === null || agent === undefined || agent === '') return { source: 'relay', agent: null };
  if (typeof agent !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(agent)) return null;
  return { source: 'relay', agent };
}

export function encodeChatTarget(target: ChatTarget): string {
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
  return target.agent ?? '';
}

/** `<select>` value -> target. */
export function chatTargetFromValue(value: string): ChatTarget {
  if (value === ROOM_VALUE) return { source: 'room', agent: null };
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
