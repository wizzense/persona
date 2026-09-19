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
 *  6. MIRRORING GRANTS NOTHING. A channel is mirrored for PRESENCE and HISTORY
 *     by default and is audible only where cast.json says
 *     channels["#chan"].voiced === true. 🚩 The relay's `agent` flag cannot
 *     carry this decision: /v1/agent/join puts the OWNER's nick in the trusted
 *     set, so agent === true on #agents for the owner's own messages. Anyone
 *     who can post in a mirrored channel would otherwise have a voice on the
 *     owner's speakers; the grant is local (U01's cast.json, authored in the
 *     Cast pane), never a field of the row.
 *
 * WHAT IS LOCALLY STAMPED (and therefore trustworthy): payload.source
 * "awrelay", payload.channel (the channel WE polled, never row.channel — that
 * one is relay-supplied) and the namespaced actor id `relay:<nick>`. Those
 * three are the only discriminators an echo may key on, and they are also what
 * the cast resolver derives its origin key from (`relay:<channel>[:<nick>]`).
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
//: recognisable even when it comes back under a different nick. publishOut()
//: below is its WRITER: until this unit the marker had a reader in selectRows
//: and nothing that ever wrote it, which is a guard that cannot fire.
const ROOM_MARKER = "[room]";

//: 🚩 FAIL CLOSED ON AUDIBILITY, not on presence. An unknown channel is
//: mirrored (bodies, history) and MUTE. Silencing the whole desk until a file
//: exists would be a regression nobody asked for; handing a voice to whoever
//: can post in a relay channel is a privilege the mirror must not grant.
//: `presence: null` means "fall through to cast.json defaults.presence".
const DEFAULT_CHANNEL_POLICY = Object.freeze({ voiced: false, presence: null });
const PRESENCE_VALUES = new Set(["off", "quiet", "normal", "chatty"]);

/** A cast.json channel entry as a policy. Per-field drop-not-clamp, never throws. */
function normalisePolicy(raw) {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_CHANNEL_POLICY };
  const presence = typeof raw.presence === "string" && PRESENCE_VALUES.has(raw.presence)
    ? raw.presence
    : null;
  // `voiced === true` and nothing else: a truthy string from a hand-edited
  // file must not read as a grant.
  return { voiced: raw.voiced === true, presence };
}

/**
 * The channel's policy from cast-config (U01), or the closed default.
 *
 * A SOFT require on purpose: this module ships in the same wave as
 * cast-config.cjs and must work before it exists, in a packaged build where
 * app.getPath is not ready, and against a malformed cast.json — every one of
 * those is "no grant", never a throw on the poll path.
 */
function castChannelPolicy(channel) {
  try {
     
    const cast = require("./cast-config.cjs");
    const snapshot = typeof cast.current === "function"
      ? cast.current()
      : typeof cast.load === "function" ? (cast.load() || {}).snapshot : null;
    const channels = snapshot && typeof snapshot.channels === "object" ? snapshot.channels : null;
    if (!channels) return { ...DEFAULT_CHANNEL_POLICY };
    const key = String(channel || "");
    return normalisePolicy(channels[key] || channels[key.replace(/^#/, "")]);
  } catch {
    return { ...DEFAULT_CHANNEL_POLICY };
  }
}

/**
 * Text going OUT of the room into relay, stamped so the next poll recognises
 * the round trip even when the relay stores it under the owner's nick.
 * Idempotent: re-stamping a marked line would double the marker in the panel.
 */
function stampOutbound(text) {
  const body = String(text == null ? "" : text).trim();
  if (!body) return "";
  return body.includes(ROOM_MARKER) ? body : `${ROOM_MARKER} ${body}`;
}

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
 * The rows this tick should MIRROR, newest last, each carrying whether the
 * channel's policy makes it audible (`voiceable`).
 *
 * `state` is {watermark, seen} and is MUTATED by the caller, not here — the
 * decision must be testable without a clock or a daemon.
 *
 * The policy gate refuses HERE, early, and that placement is the point: a gate
 * applied downstream (at publish time, or by the room stage refusing an event)
 * would leave the rows unpublished, the watermark unmoved, and the same rows
 * re-selected every 2 s poll forever. Refusing here lets mirror() treat them as
 * handled and step the watermark past them.
 */
function selectRows(
  rows,
  state,
  { maxPerTick = MAX_PER_TICK, selfNicks = SELF_NICKS, ourIds = null, policy = DEFAULT_CHANNEL_POLICY } = {},
) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const pol = normalisePolicy(policy);
  // presence "off" is the owner saying this channel takes no part in the room
  // at all: no body, no history, nothing queued.
  if (pol.presence === "off") return [];
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
    // Rule 6: audibility is granted by cast.json, per channel, and "quiet"
    // means a body that never speaks. Everything else about the row still
    // travels — presence and history are not a privilege.
    const voiceable = pol.voiced === true
      && pol.presence !== "quiet"
      && row.agent === true
      && !HUMAN_NICKS.has(author.toLowerCase());
    fresh.push({ ...row, text: text.slice(0, MAX_TEXT), voiceable });
  }
  fresh.sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
  // Rule 4: a ceiling, keeping the NEWEST rows — an old row that missed the
  // cut is stale by the time it would be spoken.
  return fresh.slice(-Math.max(1, maxPerTick));
}

/**
 * One relay row as one room event the stage already knows how to render.
 *
 * `channel` is the channel WE polled and it WINS over row.channel: the row's
 * own channel field arrived from the relay, and the cast resolver derives its
 * origin key (`relay:<channel>`) from payload.channel — a key read out of a
 * payload the poster influences is a grant list you do not control. payload
 * .channel is therefore always present, even when the row carries none.
 */
function toEvent(row, { room = "main", channel = "", voiceable } = {}) {
  const author = String(row.author || "someone");
  const stampedChannel = String(channel || row.channel || "");
  // Rules 3 and 6: a voice is GRANTED, never assumed. The room stage keys
  // voicing off actor.kind (room-publisher.shapeChat: agent = kind !== "human"),
  // so until the cast resolver lands in room-stage this one field is the whole
  // enforcement — and it must default to silence when nobody said otherwise.
  const granted = voiceable === true || row.voiceable === true;
  const kind = granted && row.agent === true && !HUMAN_NICKS.has(author.toLowerCase())
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
      channel: stampedChannel,
      source: "awrelay",
      relay_message_id: row.id || null,
      // The decision, stated so the Cast pane and the resolver can SEE it, and
      // so "why is this agent mute" has an answer in the event itself.
      voiceable: kind === "adk_agent",
      // The relay's own class flag, kept apart from the voice decision: it is
      // true for the owner on #agents (see rule 6) and so cannot mean "bot".
      relay_agent: row.agent === true,
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
  constructor({
    publisher = patientPublisher(),
    log = () => {},
    channels,
    selfNicks,
    statusFile,
    channelPolicy = castChannelPolicy,
    relayPost = null,
  } = {}) {
    this.publisher = publisher;
    //: Injected so a test never depends on the owner's real cast.json (and so
    //: this file does not hard-require a module landing in the same wave).
    this.channelPolicy = typeof channelPolicy === "function" ? channelPolicy : castChannelPolicy;
    //: How publishOut() reaches relay. Lazy by default: requiring relay-feed at
    //: module load would close the require cycle (relay-feed requires US).
    this.relayPost = typeof relayPost === "function" ? relayPost : null;
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

  /** This channel's audibility policy, closed by default. Never throws. */
  policyFor(channel) {
    try {
      return normalisePolicy(this.channelPolicy(channel));
    } catch {
      return { ...DEFAULT_CHANNEL_POLICY };
    }
  }

  /**
   * Publish a line from the ROOM back OUT into a relay channel.
   *
   * Both halves of loop protection are applied here, because this is the only
   * place the desk creates a row it will later read back: the text is stamped
   * with ROOM_MARKER (survives a nick change, works even when the relay tells
   * us nothing) and the id the relay assigned is recorded with noteOurs (works
   * even when a peer strips the marker). Returns relay-feed's {ok, detail, id}
   * verdict; never throws and never awaits the room.
   */
  async publishOut(channel, text, { post = null } = {}) {
    const body = stampOutbound(text);
    if (!body) return { ok: false, detail: "empty message" };
    let send = post || this.relayPost;
    if (!send) {
      try {
         
        send = require("./relay-feed.cjs").post;
      } catch {
        return { ok: false, detail: "relay-feed unavailable" };
      }
    }
    let result;
    try {
      result = await send(channel, body);
    } catch (error) {
      return { ok: false, detail: (error && error.message) || "relay post threw" };
    }
    const verdict = result && typeof result === "object" ? result : { ok: false, detail: "no verdict" };
    if (verdict.ok && typeof verdict.id === "string") this.noteOurs(verdict.id);
    return verdict;
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
    // 🚩 MEASURED (U08 test suite): policyFor() existed with nothing calling
    // it — a guard with no lane reaching it, same class as the ROOM_MARKER
    // that once had a reader and no writer. Without this the channel's
    // cast.json policy (voiced/presence) never reached selectRows and every
    // channel fell back to whatever selectRows' OWN default parameter was.
    const picked = selectRows(rows, state, {
      selfNicks: this.selfNicks,
      ourIds: this.ours,
      policy: this.policyFor(channel),
    });
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
