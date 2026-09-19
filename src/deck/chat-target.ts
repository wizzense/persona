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
 *
 * 2026-09-19 adds a FOURTH kind of target: one live session — a body on the
 * stage — addressed as `session:<id>` and steered through the room spine.
 * The reason it is its own kind and not an agent name: an agent name reaches
 * whoever answers #agents, while a session reaches the tab the owner is
 * looking at. Every kind fails to null on malformed input, including this
 * one, because sending a private steer to the wrong place (or to nothing) is
 * worse than landing back on the company room.
 */

export type ChatSource = 'relay' | 'room' | 'session' | 'channel';

export interface ChatTarget {
  /** relay = #agents (needs the fleet); room = the local awdk-daemon room;
   *  session = ONE live session (a body on stage), steered through the room. */
  source: ChatSource;
  /** null = the whole channel; a name = a direct thread with that agent.
   *  Always null for room and session targets. */
  agent: string | null;
  /** The addressed session id; present ONLY when source === 'session'.
   *  Optional so every `{ source, agent }` literal already in the tree
   *  (ChatView builds one per render) still type-checks unchanged. */
  session?: string;
  /** A LIVE SESSION CHANNEL on the relay (`#session-<8 hex>`); present ONLY
   *  when source === 'channel'. This is multiplayer attach (PRD REQ-1/9): a
   *  running Claude Code session mirrors its turns into that channel and
   *  reads steering back out of it, so joining the channel IS watching the
   *  session, and writing into it IS redirecting the agent. Any relay reader
   *  on any machine can do both -- unlike `session`, which is a body on THIS
   *  desk's local stage. */
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

/** The `<select>` value prefix for a session target. A colon can never occur
 *  in an agent name (the slug rule in decodeChatTarget refuses it), so a
 *  session value cannot collide with a direct-agent value. */
export const SESSION_PREFIX = 'session:';

/**
 * Session ids come in exactly TWO shapes on this box, measured 2026-09-19 in
 * awdk/adk/harnesses: a discovered Claude Code tab is its transcript's
 * canonical UUID (discovery.py reads `sessionId`), and a daemon-owned session
 * is `uuid.uuid4().hex[:16]` (session.py:119). Accept both, refuse the rest.
 * 🚨 A UUID-only rule would make every daemon session unaddressable, and a
 * looser one would let a truncated or hand-typed id become a target that
 * silently addresses nothing.
 */
const SESSION_ID_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16})$/i;

/** A session id, verbatim, or null when it is not one of the two real
 *  shapes. Not normalised: the dispatcher keys sessions case-sensitively,
 *  so a rewritten id could address a different (or no) session. */
export function decodeSessionId(raw: unknown): string | null {
  if (typeof raw !== 'string' || !SESSION_ID_RE.test(raw)) return null;
  return raw;
}

/** The only way to build a session target: a bad id yields null, never a
 *  `{ source: 'session' }` with no session to deliver to. */
export function sessionTarget(id: unknown): ChatTarget | null {
  const session = decodeSessionId(id);
  return session ? { source: 'session', agent: null, session } : null;
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
  /** Bodies on stage (RoomStage.status().onStage joined with sessionTitles()).
   *  Optional: absent = no "Bodies on stage" group, exactly as before. */
  bodies?: readonly StageBody[];
  /** The session currently picked; kept selectable after its body leaves,
   *  for the same reason as `current`. */
  currentSession?: string | null;
  /** Live session channels the relay currently lists (`#session-*`) --
   *  every one is a running Claude Code session ANYONE can attach to. */
  sessionChannels?: readonly string[];
}

/**
 * One body on the stage, as the picker needs it. Declared HERE, not imported
 * from deck-types.ts: that file is held by a peer session (plan U20), and the
 * fields are the same ones electron/room-address.cjs takes for its bodies, so
 * both ends of the address path read one shape.
 */
export interface StageBody {
  slotId: string;
  /** The actor/agent name. For claude_code actors this is the CWD basename
   *  ("AitherOS-Fresh" for every tab in room main) — never a unique label. */
  agent?: string | null;
  actorId?: string | null;
  actorKind?: string | null;
  /** The addressed session id; a body without a valid one is not offered. */
  sessionId?: string | null;
  /** The /sessions/unified title — the one label that tells parallel
   *  sessions apart (it is also the SendMessage address). */
  title?: string | null;
}

export const BODIES_GROUP_LABEL = 'Bodies on stage';

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
  if (source !== 'relay' && source !== 'room' && source !== 'session' && source !== 'channel') return null;
  if (source === 'room') return { source: 'room', agent: null };
  if (source === 'channel') return channelTarget((parsed as { channel?: unknown }).channel);
  // A session target with a missing or malformed id is REFUSED, not demoted
  // to the company room: the caller picked one tab, and quietly retargeting
  // #agents would post a private steer to a public channel.
  if (source === 'session') return sessionTarget((parsed as { session?: unknown }).session);
  if (agent === null || agent === undefined || agent === '') return { source: 'relay', agent: null };
  if (typeof agent !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(agent)) return null;
  return { source: 'relay', agent };
}

export function encodeChatTarget(target: ChatTarget): string {
  if (target.source === 'channel') {
    const channel = decodeSessionChannel(target.channel);
    return JSON.stringify(channel ? { source: 'channel', agent: null, channel } : DEFAULT_CHAT_TARGET);
  }
  if (target.source === 'session') {
    // Never persist what decode would refuse: a bad id stores the default,
    // so the next launch opens on the company room, not on a dead target.
    const session = decodeSessionId(target.session);
    return JSON.stringify(session ? { source: 'session', agent: null, session } : DEFAULT_CHAT_TARGET);
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
  if (target.source === 'session') {
    const session = decodeSessionId(target.session);
    return session ? `${SESSION_PREFIX}${session}` : '';
  }
  return target.agent ?? '';
}

/** `<select>` value -> target, or null when a `session:` value carries no
 *  valid id. Agent values are passed through exactly as before (roster
 *  names are not re-validated here; that would drop a legacy name the
 *  picker itself offered). Prefer this over chatTargetFromValue anywhere a
 *  session could be SENT to: null means refuse, not "use the default". */
export function decodeTargetValue(value: string | null | undefined): ChatTarget | null {
  if (value === null || value === undefined) return null;
  if (value === ROOM_VALUE) return { source: 'room', agent: null };
  if (value.startsWith(SESSION_PREFIX)) return sessionTarget(value.slice(SESSION_PREFIX.length));
  if (value.startsWith(CHANNEL_PREFIX)) return channelTarget(value.slice(CHANNEL_PREFIX.length));
  return { source: 'relay', agent: value || null };
}

/** `<select>` value -> target, total. A malformed session value falls back
 *  to the company room VIEW: picking a row sends nothing, and the header
 *  names #agents before the owner types. The picker only ever emits
 *  validated ids (stageBodyOptions), so this fallback is a bug path. */
export function chatTargetFromValue(value: string): ChatTarget {
  return decodeTargetValue(value) ?? DEFAULT_CHAT_TARGET;
}

const BODY_LABEL_MAX = 60;

function clampLabel(text: string): string {
  return text.length > BODY_LABEL_MAX ? `${text.slice(0, BODY_LABEL_MAX - 1)}…` : text;
}

/**
 * The "Bodies on stage" options: one per addressable session, labelled by its
 * session TITLE. Why the title: every claude_code actor in room main is named
 * "AitherOS-Fresh", so two bodies routinely share an agent name, and a picker
 * of identical rows makes the owner guess which tab he is steering — which is
 * worse than no picker. Rules:
 *  - a body with no valid session id is skipped (it cannot be addressed, and
 *    guessing its session is exactly what room-address.cjs refuses to do);
 *  - one option per session (a session on two slots is still one target);
 *  - labels are made DISTINCT after clamping: every body sharing a label gets
 *    its short session id, and an ordinal if even that collides, so no row
 *    reads as "the real one" of a pair.
 */
export function stageBodyOptions(bodies: readonly StageBody[] | null | undefined): PickerOption[] {
  const seen = new Set<string>();
  const rows: Array<{ session: string; base: string }> = [];
  for (const body of bodies ?? []) {
    const session = decodeSessionId(body?.sessionId);
    if (!session || seen.has(session)) continue;
    seen.add(session);
    const name =
      (body.title || '').trim() || (body.agent || '').trim() || (body.actorId || '').trim() || (body.slotId || '').trim();
    rows.push({ session, base: clampLabel(name || 'session') });
  }
  const count = new Map<string, number>();
  for (const row of rows) count.set(row.base, (count.get(row.base) ?? 0) + 1);
  const labels = rows.map((row) =>
    (count.get(row.base) ?? 0) > 1 ? `${row.base} (${row.session.slice(0, 8)})` : row.base,
  );
  const used = new Map<string, number>();
  return rows.map((row, i) => {
    const n = (used.get(labels[i]) ?? 0) + 1;
    used.set(labels[i], n);
    const label = n > 1 ? `${labels[i]} #${n}` : labels[i];
    return { value: `${SESSION_PREFIX}${row.session}`, label: `${label} — session` };
  });
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
  // Bodies come before the name-only groups: a body is a session that can
  // actually be steered, where an agent row is only an @mention.
  const bodies = stageBodyOptions(input.bodies);
  const currentSession = decodeSessionId(input.currentSession);
  if (currentSession && !bodies.some((o) => o.value === `${SESSION_PREFIX}${currentSession}`)) {
    bodies.push({
      value: `${SESSION_PREFIX}${currentSession}`,
      label: `${currentSession.slice(0, 8)} — session (no longer on stage)`,
    });
  }
  if (bodies.length) groups.push({ label: BODIES_GROUP_LABEL, options: bodies });
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

/** The empty text for a live session channel: says what watching means and
 *  what typing does, because both are new to whoever just attached. */
export function channelEmptyText(channel: string): string {
  return `Attached to ${channel}. Its turns appear here as they happen; anything you type steers the agent's next turn.`;
}

/** The text the empty pane shows for a direct target: it names where the next
 *  message goes, so an empty thread does not read as a broken one. */
export function directEmptyText(agent: string, relayChannel: string, hasAnchor: boolean): string {
  if (hasAnchor) return `No replies in this thread with ${agent} yet — say something.`;
  return `Nothing between you and ${agent} yet. Your message goes to ${relayChannel} as @${agent}; the reply opens the thread.`;
}
