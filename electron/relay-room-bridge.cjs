"use strict";

/**
 * relay-room-bridge — AitherRelay's channels, spoken by the room's avatars.
 *
 * Owner, 2026-09-18: "make the whole digital avatar room more connected and
 * integrated to the Claude Code sessions + awrelay + AitherRelay + awdesk +
 * awdk/awsh + the company room."
 *
 * Three planes already existed and NONE of them met:
 *
 *   Claude Code sessions ──aeon-emit spool──▶ awdk room "main" ──▶ BODIES that speak
 *   AitherRelay #agents  ──relay-feed.cjs──▶ a text panel nobody looks at
 *   awsh / awdk agents   ──relay──────────▶ the same text panel
 *
 * So a session's tool calls got an avatar while the channel the same agents
 * actually coordinate in stayed mute. This bridge puts relay traffic on the
 * SAME spine the stage already renders: one relay row becomes one room event,
 * and the room stage does the rest (a body per author, its own voice, the
 * existing queue, cooldown and body cap). No second renderer path, no second
 * voice queue, no second idea of who is on stage.
 *
 * FIVE RULES, each a pure function with a test:
 *
 *  1. THE FIRST TICK MIRRORS NOTHING. It only sets the watermark. Otherwise
 *     every desk start would read the last fifty messages aloud — the failure
 *     mode that makes a feature like this get switched off on day one.
 *  2. NEVER MIRROR OURSELVES. Anything the desk or the room already published
 *     into relay comes back on the next poll; mirroring it would loop the room
 *     and the channel into each other. Rows from our own nicks, and rows whose
 *     text still carries the room marker, are dropped.
 *  3. HUMANS KEEP THEIR SILENCE. A human row still gets presence (the author
 *     is on stage) but is published with actor kind `human`, which the room
 *     stage already refuses to voice — the owner's own words are never read
 *     back to him.
 *  4. A TICK HAS A CEILING. At most MAX_PER_TICK rows go through, newest kept.
 *     A burst in the channel must not become five minutes of monologue.
 *  5. SYSTEM ROWS ARE NOT SPEECH. join/part/system rows narrate the channel;
 *     they are presence, not something an avatar says.
 *
 * Failure is always silent and total: no daemon, no token, no relay — the
 * panel keeps working and nothing speaks. The bridge never throws into its
 * caller and never makes the caller wait for the daemon.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RoomPublisher, defaultRequest } = require("./room-publisher.cjs");

//: 🚩 THE ROOM CAN BE SLOW, AND SLOW IS NOT DOWN. Measured 2026-09-18: room
//: "main" had grown a 554 MB JSONL transcript and one POST /events against it
//: took over 25 SECONDS, while the same call on a fresh room answered in
//: 0.23 s. The desk's default publisher gives up at 4 s and reports "daemon
//: unreachable" — a producer reading a slow spine as a dead one. The mirror is
//: fire-and-forget and off the render path, so it can afford to WAIT; nothing
//: the owner sees is blocked by it. (The size itself is fixed in the spine:
//: adk.harnesses.rooms rotates the transcript at 64 MB from this date, so a
//: restarted daemon is fast again — this timeout is what keeps the mirror
//: working on a daemon that has not restarted yet.)
const PUBLISH_TIMEOUT_MS = 25000;

function patientPublisher() {
  return new RoomPublisher({
    requestImpl: (method, path, body) =>
      defaultRequest(method, path, body, { timeoutMs: PUBLISH_TIMEOUT_MS }),
  });
}

//: Channels worth a voice. #agents is where sessions coordinate; the rest of
//: the relay (alerts, business escalations) is a firehose that belongs in a
//: panel, not in the room. DESK_RELAY_ROOM_CHANNELS overrides, comma separated.
const DEFAULT_CHANNELS = ["#agents"];

//: At most this many rows per poll become speech (rule 4).
const MAX_PER_TICK = 3;

//: The room stage truncates too, but a 500-char relay row is a paragraph: cut
//: it here so the BODY says a sentence and the panel keeps the whole text.
const MAX_TEXT = 320;

//: Nicks whose rows are ours (rule 2): the desk's own service voices, never a
//: person. 🚩 The desk POSTS to relay under the owner's own nick ("david"), so
//: a nick-based self-check silenced the owner entirely -- measured 2026-09-19,
//: the bridge saw every proof message, advanced its watermark and mirrored
//: nothing. Loop protection is by MESSAGE ID (noteOurs) because that is the
//: only thing that actually identifies what WE wrote; a shared nick does not.
const SELF_NICKS = new Set(["awdesk", "desk", "aither-room"]);

//: Nicks that are the owner, whatever the relay's `agent` flag says about the
//: client that posted for them. They get a body (presence) and no voice: the
//: relay CLI marks everything agent=true, so the flag alone would read the
//: owner's own words back to him -- the one thing the room must never do.
const HUMAN_NICKS = new Set(["david"]);

//: Stamped on anything the room publishes OUT to relay, so a round trip is
//: recognisable even when it comes back under a different nick.
const ROOM_MARKER = "[room]";

function normaliseChannels(raw) {
  if (typeof raw !== "string" || !raw.trim()) return DEFAULT_CHANNELS;
  const out = raw
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => (c.startsWith("#") ? c : `#${c}`));
  return out.length ? out : DEFAULT_CHANNELS;
}

/**
 * The rows this tick should speak, newest last.
 *
 * `state` is {watermark, seen} and is MUTATED by the caller, not here — the
 * decision must be testable without a clock or a daemon.
 */
function selectRows(rows, state, { maxPerTick = MAX_PER_TICK, selfNicks = SELF_NICKS, ourIds = null } = {}) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const fresh = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const text = typeof row.text === "string" ? row.text.trim() : "";
    if (!text) continue;
    // Rule 5: only real messages are speech.
    if (row.type && row.type !== "message") continue;
    // Rule 2: our own voice, coming back around.
    const author = typeof row.author === "string" ? row.author : "";
    if (!author || selfNicks.has(author.toLowerCase())) continue;
    if (text.includes(ROOM_MARKER)) continue;
    // Rule 2, the reliable half: a row THIS desk posted, by its id.
    if (ourIds && row.id && ourIds.has(row.id)) continue;
    const at = Number(row.at) || 0;
    if (at <= state.watermark) continue;
    if (row.id && state.seen.has(row.id)) continue;
    fresh.push({ ...row, text: text.slice(0, MAX_TEXT) });
  }
  fresh.sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
  // Rule 4: a ceiling, keeping the NEWEST rows — an old row that missed the
  // cut is stale by the time it would be spoken.
  return fresh.slice(-Math.max(1, maxPerTick));
}

/** One relay row as one room event the stage already knows how to render. */
function toEvent(row, { room = "main" } = {}) {
  const author = String(row.author || "someone");
  // Rule 3: a human is presence, never a voice. The room stage keys voicing
  // off actor.kind, so this single field is the whole policy.
  const kind = row.agent === true && !HUMAN_NICKS.has(author.toLowerCase())
    ? "adk_agent"
    : "human";
  return {
    room,
    type: "agent_message",
    actor: {
      kind,
      // Stable per author so the same nick keeps the same body across polls,
      // and namespaced so a relay nick can never collide with a session id.
      id: `relay:${author.toLowerCase()}`,
      name: author,
    },
    payload: {
      text: row.text,
      channel: row.channel || "",
      source: "awrelay",
      relay_message_id: row.id || null,
    },
  };
}

/**
 * The bridge itself: hand it rows, it publishes the ones that qualify.
 *
 * It owns its own RoomPublisher because the alternative is threading main's
 * instance through the relay panel's fetch path — a wiring change in the one
 * file three other sessions are editing this evening. The publisher is an
 * HTTP client with no state worth sharing.
 */
class RelayRoomBridge {
  constructor({ publisher = patientPublisher(), log = () => {}, channels, selfNicks, statusFile } = {}) {
    this.publisher = publisher;
    //: Where the operator trace lands. A test MUST pass its own path: a suite
    //: that writes the live status file makes the desk look like it mirrored
    //: something it never saw (measured on this file's first run).
    this.statusFile = statusFile || statusPath();
    this.log = log;
    this.channels = new Set(normaliseChannels(channels ?? process.env.DESK_RELAY_ROOM_CHANNELS));
    this.selfNicks = new Set([...SELF_NICKS, ...(selfNicks || [])].map((n) => String(n).toLowerCase()));
    //: Per channel: {watermark, seen}. A channel this desk has never polled
    //: starts cold, which is rule 1.
    this.state = new Map();
    this.mirrored = 0;
    this.lastError = null;
    //: Message ids THIS desk posted into relay. relay-feed calls noteOurs with
    //: the id the relay returns, so the next poll recognises the row as ours
    //: even though it carries the owner's nick.
    this.ours = new Set();
  }

  /** Remember a message this desk just posted, so the mirror never speaks it back. */
  noteOurs(messageId) {
    if (typeof messageId !== "string" || !messageId) return;
    this.ours.add(messageId);
    if (this.ours.size > 200) this.ours = new Set([...this.ours].slice(-100));
  }

  enabled(channel) {
    if (String(process.env.DESK_RELAY_ROOM || "1").trim() === "0") return false;
    return this.channels.has(channel);
  }

  stateFor(channel) {
    let s = this.state.get(channel);
    if (!s) {
      s = { watermark: 0, seen: new Set(), primed: false };
      this.state.set(channel, s);
    }
    return s;
  }

  /**
   * Mirror what is new in `rows` (as shaped by relay-feed) into the room.
   * Resolves {mirrored, skipped} and NEVER rejects.
   */
  async mirror(channel, rows) {
    if (!this.enabled(channel)) return { mirrored: 0, skipped: 0, reason: "disabled" };
    const state = this.stateFor(channel);
    const newest = (Array.isArray(rows) ? rows : []).reduce(
      (max, row) => Math.max(max, Number(row?.at) || 0),
      0,
    );
    // Rule 1: the first sight of a channel only sets the watermark.
    if (!state.primed) {
      state.primed = true;
      state.watermark = newest;
      for (const row of rows || []) if (row?.id) state.seen.add(row.id);
      this.writeStatus();
      return { mirrored: 0, skipped: (rows || []).length, reason: "primed" };
    }
    const picked = selectRows(rows, state, { selfNicks: this.selfNicks, ourIds: this.ours });
    let mirrored = 0;
    for (const row of picked) {
      const result = await this.publisher.publish(toEvent(row));
      if (result && result.ok) {
        mirrored += 1;
        this.mirrored += 1;
        this.lastError = null;
        this.log("relay-room: mirrored", channel, row.author, `${row.text.slice(0, 60)}…`);
      } else {
        // A daemon that will not take the event must not advance the
        // watermark past the row: the next tick retries it.
        this.lastError = (result && result.error) || "publish failed";
        this.log("relay-room: publish failed", this.lastError);
        this.writeStatus();
        return { mirrored, skipped: picked.length - mirrored, error: this.lastError };
      }
      if (row.id) state.seen.add(row.id);
      state.watermark = Math.max(state.watermark, Number(row.at) || 0);
    }
    // Rows we deliberately skipped (ours, humans' system rows, over the cap)
    // still move the watermark: they are handled, not pending.
    state.watermark = Math.max(state.watermark, newest);
    if (state.seen.size > 500) state.seen = new Set([...state.seen].slice(-200));
    this.writeStatus();
    return { mirrored, skipped: (rows || []).length - mirrored };
  }

  status() {
    return {
      channels: [...this.channels],
      mirrored: this.mirrored,
      lastError: this.lastError,
      primed: [...this.state.entries()].map(([channel, s]) => ({ channel, watermark: s.watermark })),
    };
  }

  /** Write the status where an operator can read it.
   *
   *  A mirror that fails silently is indistinguishable from a quiet channel —
   *  the failure mode this whole evening was spent on. The desk's relay poll
   *  runs in the main process with no console anyone reads, so the bridge
   *  leaves its own trace: who it primed, how many rows it has spoken, and the
   *  last error verbatim. Best-effort: a status file that cannot be written
   *  must never stop the room from hearing the channel. */
  writeStatus(file = this.statusFile) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        JSON.stringify({ ...this.status(), at: new Date().toISOString() }, null, 2),
        "utf8",
      );
    } catch {
      /* observability is not worth a thrown poll */
    }
  }
}

function statusPath() {
  return path.join(os.homedir(), ".aither", "relay-room-bridge.json");
}

//: One bridge per process: the relay panel polls from several places and they
//: must share a watermark or the same row speaks twice.
let shared = null;
function sharedBridge(options) {
  if (!shared) shared = new RelayRoomBridge(options);
  return shared;
}
function _resetSharedForTests() {
  shared = null;
}

module.exports = {
  RelayRoomBridge,
  statusPath,
  sharedBridge,
  selectRows,
  toEvent,
  normaliseChannels,
  _resetSharedForTests,
  DEFAULT_CHANNELS,
  MAX_PER_TICK,
  MAX_TEXT,
  ROOM_MARKER,
  SELF_NICKS,
  HUMAN_NICKS,
};
