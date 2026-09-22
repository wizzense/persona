/**
 * Desk-panel types + pure helpers — the shared shape of what main's
 * `deckState()` sends and what the deck renders. Kept dependency-free so the
 * vitest arms exercise exactly this logic.
 */

export interface DeckDecision {
  id: string;
  title: string;
  summary: string;
  urgency: string;
  createdAt: number;
  options: Array<{ key: string; label: string; recommended: boolean }>;
  defaultKey: string;
  tab: string;
  cwd: string;
  agent: string;
}

export interface DeckSlot {
  slotId: string;
  name: string;
  agent: string;
}

export interface RelayRow {
  channel: string;
  author: string;
  text: string;
  at: number;
  /** The relay message id — the anchor for the per-agent chat THREAD. */
  id: string | null;
  threadId: string | null;
  replyCount: number;
  /** True when the author is an agent (not a session/human). */
  agent: boolean;
  /** awrelay's message kind (request | finding | alert | ack ...), lifted out of the
   *  routing envelope main strips from the body. '' for a plain message. */
  kind?: string;
  /** Who it was addressed to, from the same envelope. */
  to?: string[];
}

/** One awrise scheduled job, as main's wakes-feed shapes it. */
export interface WakeRow {
  name: string;
  enabled: boolean;
  every: string;
  intervalS: number | null;
  run: string;
  at: string | null;
  lastState: string;
  /** WHY it ended that way ("exit 1", "timeout after 300s"). The row is nearly
   *  useless without it: "failure" alone sends the owner to a terminal. */
  lastReason: string;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastWakeId: string | null;
  consecutiveFailures: number;
  running: boolean;
  runningSince: string | null;
  nextDueAt: string | null;
  /** The decision card awrise raised for this failing streak, when it did. */
  cardId: string;
  error: string;
}

/** The wake snapshot + whether it is LIVE. `source` is the honesty field:
 *  "daemon" = just read, "stale" = the last good snapshot while the daemon is
 *  unreachable, "none" = nothing polled yet. */
export interface WakesFeed {
  source: 'none' | 'daemon' | 'stale';
  /** true/false once known; null while unknown (no token, daemon down). */
  installed: boolean | null;
  schema: number | null;
  migration: string | null;
  wakes: WakeRow[];
  count: number;
  failing: number;
  disabled: number;
  running: number;
  /** The newest clock tick awrise wrote. null = it has never ticked. */
  lastTickAt: string | null;
  /** True when the scheduler's clock is silent — the failure that hides itself. */
  clockStale: boolean;
  /** When this snapshot first went stale (ms), so the chip can age it. */
  staleSince: number | null;
  error: string | null;
}

export interface DeckState {
  decisions: DeckDecision[];
  /** Cards that need a DECISION -- the one number every surface calls "waiting". */
  openCount: number;
  /** Every open card, FYI ones included. Optional: an older main does not send it. */
  totalCount?: number;
  deskVisible: boolean;
  slots: DeckSlot[];
  agents: string[];
  characters: string[];
  /** name -> file:// URL of that character's model.vrm (for preview renders).
   *  Only main knows the real roster root; the deck never builds these. */
  characterModels: Record<string, string>;
  activeCharacter: string;
  agentCharacters: Record<string, string>;
  relay: RelayRow[];
  relayChannel: string;
  /** The local room (awdk daemon :8362): command requests/replies and agent
   *  messages — the half of the company room that works with the fleet down. */
  room: RoomRow[];
  roomStatus: string;
  /** awrise's scheduled jobs and whether its clock is still ticking. */
  wakes: WakesFeed;
}

export interface RoomRow {
  id: string;
  seq: number;
  at: number;
  author: string;
  text: string;
  /** command_request | command_reply | agent_message | chat */
  kind: string;
  agent: boolean;
  correlationId: string;
}

export const EMPTY_DECK_STATE: DeckState = {
  decisions: [],
  openCount: 0,
  deskVisible: false,
  slots: [],
  agents: [],
  characters: [],
  characterModels: {},
  activeCharacter: '',
  agentCharacters: {},
  relay: [],
  relayChannel: '#agents',
  room: [],
  roomStatus: 'not started',
  wakes: {
    source: 'none',
    installed: null,
    schema: null,
    migration: null,
    wakes: [],
    count: 0,
    failing: 0,
    disabled: 0,
    running: 0,
    lastTickAt: null,
    clockStale: false,
    staleSince: null,
    error: null,
  },
};

/** WHERE a card came from, so a row can name it — a toast with no identity is
 *  noise the owner cannot act on when a dozen sessions are open. */
export function cardWhere(card: DeckDecision): string {
  return card.tab || card.cwd || card.agent;
}

/** "just now" / "4m" / "2h" / "3d" — wall-clock age, not a timestamp, because
 *  the queue sorts oldest-first and the owner reads "how long have I kept this
 *  session waiting", not a date. */
export function formatAge(createdAtSec: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor(nowMs / 1000) - createdAtSec);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** The one button the owner is most likely to want: the raiser's default key
 *  wins, then a recommended option, then the first option. */
export function primaryChoice(
  card: DeckDecision,
): { key: string; label: string } | null {
  const first = card.options[0];
  if (!first) return null;
  const byKey = (key: string) => card.options.find((o) => o.key === key);
  const pick = byKey(card.defaultKey) ?? card.options.find((o) => o.recommended) ?? first;
  return { key: pick.key, label: pick.label };
}

/** The defer path: the first NON-recommended option, so a card's "ack / later"
 *  pair renders as [ack (primary)] [Not now]. Falls back to the first option
 *  when every option is recommended (a card with nothing but strong choices). */
export function secondaryChoice(
  card: DeckDecision,
): { key: string; label: string } | null {
  return otherChoices(card)[0] ?? null;
}

/**
 * Every option that is NOT the primary one, the defer path first.
 *
 * 🚩 The card used to render "primary" and "the first non-recommended option" as
 * two independent picks, so a card whose DEFAULT was itself not recommended drew
 * the same option twice -- "Keep owner-only" / "Keep owner-only" on the owner's
 * screen, 2026-09-20 -- and the option that was actually different (the one the
 * card existed to offer) had no button at all. A card with three options lost its
 * third the same way. The others are defined AGAINST the primary's key, so a
 * duplicate is impossible, and all of them are returned, so none is hidden.
 *
 * Labels that collide are disambiguated with the key: two buttons reading the
 * same thing is a coin toss with the owner's decision.
 */
export function otherChoices(
  card: DeckDecision,
): Array<{ key: string; label: string }> {
  const primary = primaryChoice(card);
  if (!primary) return [];
  const rest = card.options.filter((o) => o.key !== primary.key);
  const ordered = [...rest.filter((o) => !o.recommended), ...rest.filter((o) => o.recommended)];
  const seen = new Set([primary.label.trim().toLowerCase()]);
  return ordered.map((o) => {
    const plain = o.label.trim().toLowerCase();
    const label = seen.has(plain) ? `${o.label} (${o.key})` : o.label;
    seen.add(plain);
    return { key: o.key, label };
  });
}


/**
 * When a wake is next due, as a human reads a clock: "in 12m", "overdue 4h".
 *
 * The row printed the raw field -- "next 2026-09-20T13:48:02.563442+00:00" -- which
 * makes the owner do timezone arithmetic to learn the one thing he wanted: is this
 * about to run, or is it four hours LATE? Overdue is said out loud, because a job
 * whose next run is in the past is the symptom of a stopped clock.
 */
export function dueLabel(iso: string | null, nowMs: number): string {
  if (!iso) return 'not scheduled';
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return 'next run unknown';
  const secs = Math.round((at - nowMs) / 1000);
  const span = (n: number) => (n < 90 ? `${n}s` : n < 5400 ? `${Math.round(n / 60)}m`
    : n < 129600 ? `${Math.round(n / 3600)}h` : `${Math.round(n / 86400)}d`);
  return secs >= 0 ? `next in ${span(secs)}` : `overdue ${span(-secs)}`;
}

/**
 * A machine reason token as a phrase: "exit_0" -> "exited 0",
 * "spawned_pid_34284" -> "running as pid 34284",
 * "awask_timed_out_after_30s" -> "awask timed out after 30 s".
 * Anything it does not recognise only loses its underscores -- never its content.
 */
export function reasonLabel(reason: string): string {
  const text = String(reason || '').trim();
  const exit = text.match(/^exit_(-?\d+)$/);
  if (exit) return `exited ${exit[1]}`;
  const pid = text.match(/^spawned_pid_(\d+)$/);
  if (pid) return `running as pid ${pid[1]}`;
  return text.replace(/_/g, ' ').replace(/(\d+)s\b/g, '$1 s');
}

/** What listens on a loopback port here, so an error can NAME it. */
const KNOWN_PORTS: Record<string, string> = {
  '8182': 'the MCP gateway',
  '8362': 'the adk daemon',
  '47931': 'the desk bridge',
  '8205': 'the relay',
};

/**
 * A transport error as a sentence.
 *
 * Five rows of "ERROR: connect ECONNREFUSED 127.0.0.1:8182" (owner screenshot,
 * 2026-09-20) is one fact printed five times in a dialect only its author reads:
 * the MCP gateway is down. Name the thing, say what state it is in. Unrecognised
 * text passes through minus its "ERROR:" prefix -- never swallowed.
 */
export function transportNote(note: string): string {
  const text = String(note || '').replace(/^ERROR:\s*/, '').trim();
  // The port is what follows the LAST colon of the address token: an IPv6 host
  // ("::1:8182") is itself full of colons, and a lazy match read its port as "1".
  const address = text.match(/ECONNREFUSED\s+(\S+)/i);
  const port = address ? address[1].slice(address[1].lastIndexOf(':') + 1).replace(/\D/g, '') : '';
  if (port) return `${KNOWN_PORTS[port] ?? `port ${port}`} is not answering (:${port})`;
  if (/ETIMEDOUT|timed? ?out|aborted/i.test(text)) return `no answer in time — ${text}`;
  if (/\b401\b|unauthor/i.test(text)) return 'not signed in (401) — re-mint the session bearer';
  return text;
}

/** The ONE cause behind every failing source, when there is one. */
export function sharedCause(notes: string[]): string | null {
  const failing = notes.filter((note) => /not answering|no answer in time|not signed in/.test(note));
  if (failing.length < 2 || failing.length !== notes.length) return null;
  return failing.every((note) => note === failing[0]) ? failing[0] : null;
}

/** The streak card's id, or why there is none ("unavailable:<reason>"). */
export function cardLabel(cardId: string): string {
  const text = String(cardId || '');
  if (!text) return '';
  if (text.startsWith('unavailable:')) return `no card raised — ${reasonLabel(text.slice('unavailable:'.length))}`;
  return `card ${text}`;
}

/** The chip a wake row wears. RUNNING beats FAILING: a job that is executing
 *  right now is not "broken", whatever its last streak said, and showing it as
 *  failing sends the owner to kill something that is already fixing itself. */
export function wakeBadge(wake: WakeRow): 'running' | 'failing' | 'disabled' | 'ok' {
  if (wake.running) return 'running';
  if (wake.consecutiveFailures >= 1) return 'failing';
  if (!wake.enabled) return 'disabled';
  return 'ok';
}

/** "3m" / "2h" / "never" for an ISO timestamp — the same wall-clock age the
 *  card rows use, so one panel does not mix ages and dates. */
export function isoAgeLabel(iso: string | null, nowMs: number): string {
  if (!iso) return 'never';
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return 'unknown';
  return formatAge(Math.floor(at / 1000), nowMs);
}

/** What a row says about its own timing: how long it has been running, or when
 *  it last ran. `next_due_at` is null for at-anchored and never-run jobs by
 *  design (awrise owns due-ness), so the row says "—" rather than guessing. */
export function wakeAgeLabel(wake: WakeRow, nowMs: number): string {
  if (wake.running) return `running ${isoAgeLabel(wake.runningSince, nowMs)}`;
  if (wake.lastFinishedAt) return `ran ${isoAgeLabel(wake.lastFinishedAt, nowMs)} ago`;
  if (wake.lastStartedAt) return `started ${isoAgeLabel(wake.lastStartedAt, nowMs)} ago`;
  return 'never run';
}

/** Did this snapshot actually MEASURE the scheduler's clock? Only a live daemon
 *  read that did not error, on a host where awrise is known installed, did. A
 *  cached ('stale') snapshot carries a clock_stale flag frozen at whatever the
 *  daemon last said, and an errored read carries the EMPTY default (false) —
 *  neither is evidence. This predicate is why the panel can no longer fabricate
 *  health out of an absence. */
function clockWasMeasured(feed: WakesFeed): boolean {
  return feed.source === 'daemon' && feed.installed === true && !feed.error;
}

/** The three ways the clock line can read. `ok` is reserved for a live read of a
 *  clock that has actually ticked; everything else is `stale` (measured silent)
 *  or `unknown` (not measured). The renderer styles on this, so an unmeasured
 *  clock cannot wear the healthy class either. */
export function clockTone(feed: WakesFeed): 'ok' | 'stale' | 'unknown' {
  if (!clockWasMeasured(feed)) return 'unknown';
  if (feed.clockStale) return 'stale';
  return feed.lastTickAt ? 'ok' : 'unknown';
}

/** The CLOCK line, rendered before any job row. A green list of enabled jobs
 *  with a clock that has not ticked is the scheduler failure that looks
 *  healthy; this is the sentence that stops it reading that way.
 *
 *  It must never say "ok" from an ABSENCE. A feed whose fetch failed (no token,
 *  401/403, HTTP 500, unparseable JSON, "daemon has no /wakes window") arrives
 *  with clockStale=false and lastTickAt=null purely because those are the empty
 *  defaults — it learned nothing, and says so. */
export function clockLabel(feed: WakesFeed, nowMs: number): string {
  if (feed.installed === false) return 'awrise not installed';
  if (!clockWasMeasured(feed)) {
    return feed.lastTickAt
      ? `clock liveness unknown — last known tick ${isoAgeLabel(feed.lastTickAt, nowMs)} ago`
      : 'clock liveness unknown';
  }
  if (feed.clockStale) {
    return feed.lastTickAt ? `clock silent since ${feed.lastTickAt}` : 'clock silent — never ticked';
  }
  return feed.lastTickAt
    ? `clock ok — last tick ${isoAgeLabel(feed.lastTickAt, nowMs)} ago`
    : 'clock never ticked';
}

/** The staleness chip: how old the shown snapshot is, or that there is none. */
export function staleLabel(feed: WakesFeed, nowMs: number): string {
  if (feed.source !== 'stale') return '';
  if (feed.staleSince === null) return 'daemon down — showing a cached snapshot';
  if (feed.wakes.length === 0) return 'daemon down — nothing cached';
  return `daemon down — showing snapshot from ${formatAge(Math.floor(feed.staleSince / 1000), nowMs)} ago`;
}

/** Main sends the raw feed object wakes-feed.cjs built (snake_case for the
 *  snapshot-level fields it mirrors from the daemon). This is the ONE place
 *  that translates it; a field forgotten here is a field the panel silently
 *  drops, which is why it is a pure function with its own arms. */
export function normalizeWakes(raw: unknown): WakesFeed {
  const base = EMPTY_DECK_STATE.wakes;
  if (!raw || typeof raw !== 'object') return base;
  const value = raw as Record<string, unknown>;
  const rows = Array.isArray(value.wakes) ? (value.wakes as WakeRow[]) : [];
  const source = value.source === 'daemon' || value.source === 'stale' ? value.source : 'none';
  return {
    source,
    installed: typeof value.installed === 'boolean' ? value.installed : null,
    schema: typeof value.schema === 'number' ? value.schema : null,
    migration: typeof value.migration === 'string' ? value.migration : null,
    wakes: rows,
    count: typeof value.count === 'number' ? value.count : rows.length,
    failing: typeof value.failing === 'number' ? value.failing : 0,
    disabled: typeof value.disabled === 'number' ? value.disabled : 0,
    running: typeof value.running === 'number' ? value.running : 0,
    lastTickAt: typeof value.last_tick_at === 'string' ? value.last_tick_at : null,
    clockStale: value.clock_stale === true,
    staleSince: typeof value.stale_since === 'number' ? value.stale_since : null,
    error: typeof value.error === 'string' ? value.error : null,
  };
}

export interface WakeActionResult {
  ok?: boolean;
  status?: number;
  detail?: string;
  exitCode?: number | null;
  started?: boolean;
  pid?: number | null;
}

/** One line the row shows after an action. Every branch says something: a
 *  silent button is indistinguishable from a broken one, and `run` usually
 *  returns BEFORE the wake finishes (202), which must not read as success. */
export function wakeActionMessage(verb: string, result: WakeActionResult | boolean | null): string {
  if (result === null || result === undefined) return `${verb}: no answer from the desk`;
  if (typeof result === 'boolean') return result ? `${verb}: ok` : `${verb}: refused`;
  if (result.started) return `started (pid ${result.pid ?? '?'}) — outcome in the list`;
  if (result.ok) return `${verb}: ${result.detail || 'ok'}`;
  const code = result.exitCode === null || result.exitCode === undefined ? '' : ` (exit ${result.exitCode})`;
  return `${verb} failed: ${result.detail || 'refused'}${code}`;
}
