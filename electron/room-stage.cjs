"use strict";

/**
 * room-stage — the company room, rendered as avatars that talk.
 *
 * Owner, 2026-09-18: "add multiple avatars/agents to a room or channel, load
 * them in awdesk visually and see them communicate with each other in real
 * time with voice, using the company room + awrelay/AitherRelay + Aeon."
 *
 * Every chat-like event in the room (the awdk daemon's room spine, the same
 * "main" room the desk already publishes its own commands into) becomes:
 *
 *   an AGENT the desk has not seen  ──▶ a new avatar slot for that agent
 *   a message from that agent       ──▶ that avatar SAYS it (AitherVoice, its
 *                                       own voice), one utterance at a time
 *   an agent silent for a while     ──▶ its slot is removed
 *
 * The desk's own replies (actor "awdesk") and the resident agent speak from
 * slot0 — the avatar the owner already has. Humans are never voiced: the
 * owner's own words are not read back to him.
 *
 * Every decision here is a pure function with a test: which rows to speak,
 * which slot an author gets, which voice, which slots are idle. The class only
 * sequences them against injected I/O, so the test never needs a daemon, a
 * voice service or a window.
 *
 * 2026-09-19 — cast-config.cjs (U01) became the ONE plane for who gets a body,
 * who may speak, what they sound like, and where they stand. Every decision
 * this file used to hardcode or hash for itself (AGENT_VOICES, the
 * assignedAvatar/roster/residentCharacter chain) now comes from a single
 * `io.resolve(row) -> ActorResolution` the host builds over cast-config, so a
 * two-tab session of one repo gets two voices and an origin the owner never
 * granted never takes a body — see the plan's ORIGIN KEY SOURCE and
 * ENFORCEMENT POINT conflicts. This file still owns exactly three decisions
 * cast-config does not: WHICH slot an author lands in (slotFor — a structural
 * fact, not something the owner authors), WHICH rows read like speech at all
 * (shouldVoice/readsLikeSpeech — editorial, not trust), and HOW those rows are
 * paced onto one speaker at a time (the queue/cooldown/drain loop).
 */

const { originOf, stableCharacter, stableVoice } = require("./cast-config.cjs");

const DEFAULT_ROOM = "main";
const DEFAULT_IDLE_MS = 10 * 60 * 1000;
const DEFAULT_POLL_MS = 2000;
const MAX_QUEUE = 6;
//: The fallback truncation ONLY — used when a row's resolution carries no
//: maxChars (no resolver wired, or the field genuinely unset and cast-config's
//: own BUILTIN_VOICE.maxChars of 2000 was not reached). A configured
//: `authors.<x>.maxChars` / `defaults.maxChars` (40-2000, see cast-config.cjs
//: ACTOR_FIELDS) always wins — this is what makes "per-actor maxChars
//: truncates instead of the global 320" true.
const MAX_UTTERANCE_CHARS = 320;
//: A generous PRE-resolution ceiling, applied in selectUtterances before any
//: origin/resolution exists. It only guards against an absurd single row (a
//: pasted log dump) ballooning the queue's memory; it must stay well above
//: cast-config's own maxChars ceiling (2000) so it never shadows a real
//: per-actor setting.
const RAW_TEXT_SAFETY_CHARS = 4000;
const GAP_MS = 350;
const DEFAULT_COOLDOWN_MS = 20000;
//: Bodies on stage at once, slot0 excluded. Measured 2026-09-18: one VRM per
//: parallel terminal session put four bodies up, the renderer heap reached
//: 2.36 GB and two one-second stalls landed in four seconds ("it keeps
//: freezing"). Past the cap a newcomer is still HEARD -- from the resident
//: avatar, named -- it just does not get a body until someone leaves. Do NOT
//: raise this from here; cast-config.cjs's stage.maxBodies (file-authored,
//: 0-6) is the only place that number now changes.
const DEFAULT_MAX_BODIES = 3;

//: The AitherVoice voice pool a bare hash falls back onto when a resolution
//: carries no `voice` at all (io.resolve missing, or a test stub that leaves
//: it unset). The owner-authored/authors[*].voice/hash chain lives in
//: cast-config.cjs now; this is only the floor under it.
const VOICES = ["nova", "alloy", "echo", "fable", "onyx", "shimmer"];

//: Actors that speak from the resident avatar (slot0), not their own slot.
//: This is a STRUCTURAL fact (the desk's own replies, and the resident agent,
//: are not "on stage" the way a visiting agent is) — not something cast.json
//: authors. An authored `body:false` ALSO collapses to slot0 (see ensureSlot)
//: but that is the owner's per-actor choice, and the two paths stay separate.
const RESIDENT_ACTORS = new Set(["awdesk", "desk", "aither"]);

function slug(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "agent";
}

/** The slot an author speaks from: slot0 for the resident, "room-<slug>" for
 *  agents, and "room-<slug>-<id4>" for a TERMINAL SESSION — parallel Claude
 *  Code tabs share a name (the repo) and must not share a body (owner,
 *  2026-09-18: "how does this work when I have multiple Claude Code terminal
 *  sessions running in parallel?"). */
function slotFor(author, { actorId = "", actorKind = "" } = {}) {
  const key = String(author || "").toLowerCase();
  if (RESIDENT_ACTORS.has(key)) return "slot0";
  if (actorKind === "claude_code" && actorId) return `room-${slug(author)}-${slug(actorId).slice(0, 4)}`;
  return `room-${slug(author)}`;
}

/**
 * voiceFor — the voice a row speaks with. `resolution.voice` (cast-config's
 * own precedence: actors > relay:<channel> > <kind>:* > seats[n] > authors >
 * defaults > voice.defaultVoice > hash) wins whenever it is present; the hash
 * here is only the floor for when no resolver is wired at all.
 *
 * `seed` must be the ORIGIN key (or `author:seat`), never the bare author —
 * that is precisely what let two parallel Claude Code tabs of one repo share
 * one voice before cast-config existed.
 */
function voiceFor(seed, resolution) {
  if (resolution && typeof resolution.voice === "string" && resolution.voice.trim()) {
    return resolution.voice.trim();
  }
  return stableVoice(seed, VOICES);
}

/**
 * pickCharacter — a body for a seed with no configured character. Thin
 * wrapper over cast-config.stableCharacter (rendezvous-hash, not a modulo
 * index — see that function's doc for why a modulo re-indexes every agent
 * the moment the roster or the taken set changes). Kept here, and exported,
 * because ensureSlot's tests exercise it directly; the resolver (io.resolve)
 * is the one that actually calls it in production, with the live roster.
 */
function pickCharacter(seed, roster, { taken = [], resident = null } = {}) {
  return stableCharacter(seed, roster, { taken, resident });
}

//: A terminal session's transcript line is voiced only when it reads like
//: speech. Measured 2026-09-18 on the live room: 50 of the last 54 chat rows
//: were Claude Code `message` rows -- "`text=True` on Windows turns the stdin
//: `\n` into `\r\n`" -- which no one wants read aloud, while "Pushed: origin
//: develop = 7713e4d" is exactly what the owner asked to hear. Addressed lines
//: (agent_message / chat) are always voiced; a transcript line must be short,
//: one paragraph, and carry no code.
const SPEECH_MAX_CHARS = 220;
function readsLikeSpeech(text) {
  if (text.length > SPEECH_MAX_CHARS) return false;
  if (text.includes("`") || text.includes("\n")) return false;
  if (/[{}<>[\]|\\]/.test(text)) return false;
  return true;
}

/**
 * shouldVoice — is this row a HUMAN's row, and does its text read like
 * speech. Purely editorial: it has no opinion on whether the OWNER trusts
 * this origin to speak at all — that is resolution.voiced's job, decided
 * downstream in enqueue() from cast-config's presence/speak/channel fields.
 * Keeping the two separate is what let cast-config's default-unvoiced relay
 * channels ship without this function growing a second, silent gate.
 */
function shouldVoice(row) {
  if (!row.agent) return false;
  const kind = String(row.kind || "");
  if (kind === "agent_message" || kind === "chat" || kind === "command_reply") return true;
  return readsLikeSpeech(String(row.text || "").trim());
}

/**
 * The rows worth CONSIDERING out of a recentChat() batch: newer than
 * `sinceSeq`, from an agent (never a human), with text that reads like
 * speech. Oldest first, and capped — a burst of fifty messages becomes the
 * LAST few, not a monologue. Every picked row carries `origin` (derived with
 * cast-config.originOf — pure, no file I/O) so the caller can resolve trust
 * and pace the queue by the same key a relay nick or a terminal session was
 * actually stamped with. This function does NOT know presence/speak/voice —
 * that is resolved per-row, later, once a resolver is available (see
 * RoomStage.enqueue).
 */
function selectUtterances(rows, sinceSeq, { max = MAX_QUEUE } = {}) {
  const picked = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== "object") continue;
    if (!(Number(row.seq) > sinceSeq)) continue;
    if (!shouldVoice(row)) continue;
    const text = String(row.text || "").trim();
    if (!text) continue;
    const actorId = String(row.actorId || "");
    const actorKind = String(row.actorKind || "");
    // payload.channel for a relay-mirrored row; already flattened onto the
    // row by room-publisher/relay-room-bridge, with payload.channel kept as a
    // fallback in case a caller hands us the raw envelope.
    const channel = row.channel != null ? String(row.channel) : row.payload && row.payload.channel ? String(row.payload.channel) : "";
    const nick = row.nick != null ? String(row.nick) : "";
    const utterance = {
      seq: Number(row.seq),
      author: String(row.author || "agent"),
      // What that speaker is working on (room-publisher carries it from
      // actor.title). Only the ventriloquised wrapper uses it, and only when
      // present: the owner could not tell which of ten identical-looking
      // sessions was talking, or about what (2026-09-19).
      title: String(row.title || "").slice(0, 80),
      actorId,
      actorKind,
      channel,
      nick,
      text: text.length > RAW_TEXT_SAFETY_CHARS ? text.slice(0, RAW_TEXT_SAFETY_CHARS) : text,
      kind: String(row.kind || ""),
    };
    // 🚩 originOf({kind, id, ...}) is passed a NARROW object, never `utterance`
    // itself: `utterance.kind` is the MESSAGE kind ("agent_message"/"chat"),
    // and originOf's own precedence is `src.kind ?? src.actorKind` — handing
    // it the whole utterance would let a message kind silently masquerade as
    // the actor kind ("agent_message:aaaa1111" instead of
    // "claude_code:aaaa1111"), collapsing every kind of row that happens to
    // share a message kind onto one origin.
    utterance.origin = originOf({ kind: actorKind, id: actorId, channel, nick });
    picked.push(utterance);
  }
  picked.sort((a, b) => a.seq - b.seq);
  return picked.slice(-max);
}

/** Slots whose last message is older than idleMs (never slot0). */
function idleSlots(lastSeen, now, idleMs = DEFAULT_IDLE_MS) {
  const out = [];
  for (const [slotId, at] of Object.entries(lastSeen)) {
    if (slotId === "slot0") continue;
    if (now - at >= idleMs) out.push(slotId);
  }
  return out;
}

/** Truncate to `maxChars` with an ellipsis, falling back to the room-wide
 *  default when the resolution did not specify one. Never throws, never
 *  clamps a value that already fits. */
function truncateText(text, maxChars) {
  const s = String(text == null ? "" : text);
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : MAX_UTTERANCE_CHARS;
  return s.length > limit ? s.slice(0, Math.max(0, limit - 1)) + "…" : s;
}

class RoomStage {
  /**
   * @param {object} io
   * @param {() => Promise<Array>} io.recentChat  rows as room-publisher.shapeChat emits
   * @param {(row) => object|null} io.resolve  cast-config's ActorResolution for
   *   this row (character, voice, speed, maxChars, place, presence, speak,
   *   body, cooldownSeconds, dropped, bodied, voiced, key, ...). REQUIRED for
   *   a body or a voice to be assigned at all — there is no more local
   *   assignedAvatar/roster/residentCharacter fallback; that logic now lives
   *   once, in cast-config.cjs, behind whatever the host wires this to.
   * @param {(slotId, character, agent, place) => boolean} io.spawn
   * @param {(slotId) => boolean} io.remove
   * @param {(text, voice, slotId, speed) => Promise<{ok:boolean, durationMs?:number, reason?:string}>} io.speak
   * @param {(slotId) => void} [io.onEvict]  best-effort notification fired
   *   whenever a slot leaves the stage, whether by the idle sweep or an
   *   explicit evict() — e.g. so the Cast pane's "on stage" list updates.
   */
  constructor(io, { idleMs = DEFAULT_IDLE_MS, pollMs = DEFAULT_POLL_MS, gapMs = GAP_MS, cooldownMs = DEFAULT_COOLDOWN_MS, maxBodies = DEFAULT_MAX_BODIES, now = Date.now, config = null, log = () => {} } = {}) {
    this.io = io;
    this.idleMs = idleMs;
    this.pollMs = pollMs;
    this.gapMs = gapMs;
    this.cooldownMs = cooldownMs;
    this.maxBodies = maxBodies;
    this.lastVoiced = {}; // slotId -> ms of the last voiced transcript line
    this.now = now;
    this.log = log;
    this.lastSeq = 0;
    this.primed = false;
    this.slots = new Map(); // slotId -> { agent, character, actorId, actorKind }
    this.lastSeen = {}; // slotId -> ms
    this.queue = [];
    this.speaking = false;
    this.timer = null;
    this.lastError = null;
    this.lastErrorClass = null; // "stage-full" | "no-character" | "spawn-failed" | "speak-failed"
    this.spoken = 0;
    this.speakFailures = 0;
    this.lastSpeakError = null;
    this.lastSpokenAt = null;
    this.polls = 0;
    this.lastPollAt = null;
    this.refused = 0; // rows dropped (presence off) or muted (speak:false / unvoiced channel)
    this.lastRefusedKey = null;
    this.setConfig(config);
  }

  /**
   * setConfig — hot-reload hook. room-stage-host's cast-config.watch callback
   * hands us its onChange argument verbatim ({snapshot, problems, error}, the
   * exact shape cast-config.load()/watch() return); a caller that already
   * unwrapped it may hand us a bare snapshot instead — both are accepted so
   * this cannot silently go dark on a refactor of the calling convention.
   * Stores it for status() only: the numeric stage knobs (idleMs/maxBodies/…)
   * are still passed as constructor options by the host, which already
   * resolved them through cast-config.resolveStage before building this.
   */
  setConfig(result) {
    if (result && typeof result === "object" && "snapshot" in result) {
      this.config = {
        snapshot: result.snapshot || null,
        problems: Array.isArray(result.problems) ? result.problems : [],
        error: result.error || null,
      };
    } else if (result && typeof result === "object") {
      this.config = { snapshot: result, problems: [], error: null };
    } else {
      this.config = null;
    }
  }

  /** Which actor is behind a slot, for the avatar menu / chat picker to
   *  resolve an address through. null for an empty or unknown slot. */
  addressFor(slotId) {
    const s = this.slots.get(slotId);
    if (!s) return null;
    return { actorId: s.actorId || "", actorKind: s.actorKind || "" };
  }

  /** How many slots each author currently occupies — the parallel-session
   *  count the Cast pane's provenance view reads (`authors.x.seats[n]` is
   *  cast-config's; this is simply "how many of those seats are ON STAGE
   *  right now", derived from live state, no extra bookkeeping). */
  seats() {
    const out = {};
    for (const s of this.slots.values()) {
      const key = String(s.agent || "").toLowerCase();
      if (!key) continue;
      out[key] = (out[key] || 0) + 1;
    }
    return out;
  }

  status() {
    const snapshot = this.config && this.config.snapshot;
    return {
      room: true,
      lastSeq: this.lastSeq,
      onStage: [...this.slots.entries()].map(([slotId, s]) => ({
        slotId,
        agent: s.agent,
        character: s.character,
        actorId: s.actorId || "",
        actorKind: s.actorKind || "",
      })),
      queued: this.queue.length,
      speaking: this.speaking,
      spoken: this.spoken,
      lastError: this.lastError,
      lastErrorClass: this.lastErrorClass,
      // cast-config observability: a malformed file must never read as a
      // silent default (cast-config.cjs header, FAIL SOFT rule) — the pane's
      // red banner keys on castError/castProblems being non-empty.
      castPath: (snapshot && snapshot.meta && snapshot.meta.path) || null,
      castError: (this.config && this.config.error) || null,
      castProblems: (this.config && this.config.problems) || [],
      lastPollAt: this.lastPollAt,
      polls: this.polls,
      primed: this.primed,
      lastSpokenAt: this.lastSpokenAt,
      speakFailures: this.speakFailures,
      lastSpeakError: this.lastSpeakError,
      seats: this.seats(),
      trust: {
        // "file" | "last-good" | "builtin" — cast-config.load()'s own
        // vocabulary for meta.source, surfaced verbatim so the pane can say
        // "you are NOT looking at your file" honestly.
        mode: (snapshot && snapshot.meta && snapshot.meta.source) || "builtin",
        origins: snapshot ? Object.keys(snapshot.actors || {}).length + Object.keys(snapshot.authors || {}).length : 0,
        refused: this.refused,
        lastRefusedKey: this.lastRefusedKey,
      },
    };
  }

  start() {
    if (this.timer) return;
    const loop = async () => {
      try {
        await this.tick();
      } catch (error) {
        this.lastError = error?.message || String(error);
      }
      this.timer = setTimeout(loop, this.pollMs);
      if (typeof this.timer.unref === "function") this.timer.unref();
    };
    void loop();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** One poll: prime on first sight (do not narrate history), then voice the new rows. */
  async tick() {
    const rows = await this.io.recentChat({ since: this.lastSeq, limit: 40 });
    this.polls += 1;
    this.lastPollAt = this.now();
    if (!this.primed) {
      // The first look sets the watermark: a desk that boots into a room with
      // 700k events must not read the last hour aloud.
      for (const row of rows) if (Number(row.seq) > this.lastSeq) this.lastSeq = Number(row.seq);
      this.primed = true;
      return;
    }
    const utterances = selectUtterances(rows, this.lastSeq);
    for (const row of rows) if (Number(row.seq) > this.lastSeq) this.lastSeq = Number(row.seq);
    for (const u of utterances) this.enqueue(u);
    this.retireIdle();
    void this.drain();
  }

  _recordError(cls, message) {
    this.lastError = message;
    this.lastErrorClass = cls;
  }

  _refuse(u, resolution) {
    this.refused += 1;
    this.lastRefusedKey = (u.origin && u.origin.key) || (resolution && resolution.key) || null;
  }

  /**
   * enqueue — the three trust decisions cast-config's resolution drives:
   *   dropped  (presence "off")   -> never spawns, never queues, gone.
   *   !bodied  (body:false)       -> always the resident (ensureSlot), no
   *                                  "X says:" wrapper — an authored choice,
   *                                  not a resource shortfall.
   *   !voiced  (speak:false /
   *             presence "quiet" /
   *             an unvoiced relay channel) -> body stays, never queued.
   * A stage-full or no-character/spawn failure is DIFFERENT from all three: it
   * is accidental, so the resident narrates it ("X says: ...") instead of the
   * words being silently lost — and per resolveConflicts #4, that fallback
   * keeps the row's ORIGINAL origin, not the resident's.
   */
  enqueue(u) {
    const resolution = typeof this.io.resolve === "function" ? this.io.resolve(u) || null : null;
    if (resolution && resolution.dropped) {
      this._refuse(u, resolution);
      return;
    }
    let slotId = this.ensureSlot(u.author, u, resolution);
    let text = u.text;
    if (!slotId) {
      // No body available (stage full / no character / spawn failed): the
      // resident says it on their behalf, so the words are never lost — and
      // the origin travels WITH the ventriloquised line (see u below).
      slotId = "slot0";
      // "<who> (<what they are working on>) says: ..." -- the wrapper is the
      // ONLY place the owner sees an unbodied speaker, so it is the one place
      // the context has to be.
      const who = u.title ? `${u.author} (${u.title})` : u.author;
      text = `${who} says: ${u.text}`;
    }
    u = { ...u, text };
    const now = this.now();
    if (resolution && resolution.voiced === false) {
      // Muted: the body (if any) stays on stage; the line is simply never
      // queued. speak:false, presence "quiet", and an unvoiced relay channel
      // all land here — resolution.voicedReason already names which.
      this.lastSeen[slotId] = now;
      this._refuse(u, resolution);
      return;
    }
    // A chatty actor is heard once per cooldown; the body stays, the stream
    // of lines does not. Addressed messages are exempt: a reply is never
    // dropped. `chatty` presence resolves cooldownSeconds to 0 already (see
    // cast-config.resolveActor), so no special-casing is needed here.
    const cooldownMs =
      resolution && Number.isFinite(resolution.cooldownSeconds) ? Math.max(0, resolution.cooldownSeconds * 1000) : this.cooldownMs;
    const addressed = u.kind === "agent_message" || u.kind === "chat";
    if (!addressed && now - (this.lastVoiced[slotId] || 0) < cooldownMs) {
      this.lastSeen[slotId] = now;
      return;
    }
    this.lastVoiced[slotId] = now;
    this.lastSeen[slotId] = now;
    // The seed for BOTH the character and the voice hash is the origin key
    // (or `author:seat`) — never the bare author. Two parallel claude_code
    // tabs of one repo must sound different even when the resolution itself
    // supplies no explicit voice.
    const seed = (u.origin && u.origin.key) || u.author;
    const maxChars = resolution && Number.isFinite(resolution.maxChars) ? resolution.maxChars : MAX_UTTERANCE_CHARS;
    const speed = resolution && Number.isFinite(resolution.speed) ? resolution.speed : null;
    this.queue.push({
      ...u,
      text: truncateText(text, maxChars),
      slotId,
      voice: voiceFor(seed, resolution),
      speed,
    });
    while (this.queue.length > MAX_QUEUE) this.queue.shift();
  }

  /**
   * ensureSlot — which slot (if any) an author's row speaks from, consulting
   * the resolution BEFORE spawning so an origin granted neither voice nor
   * body never takes one of the three bodies. `body:false` always collapses
   * to slot0 (an authored ventriloquism, distinct from the stage-full
   * fallback enqueue() adds its own wrapper for). Returns null only for a
   * genuine failure (stage full / no character / spawn failed).
   */
  ensureSlot(author, { actorId = "", actorKind = "" } = {}, resolution = null) {
    const slotId = slotFor(author, { actorId, actorKind });
    if (slotId === "slot0") return slotId;
    if (resolution && resolution.body === false) return "slot0";
    if (this.slots.has(slotId)) return slotId;
    if (this.slots.size >= this.maxBodies) {
      this._recordError("stage-full", `stage full (${this.maxBodies}); ${author} speaks through the resident`);
      return null;
    }
    const character = resolution && resolution.character ? resolution.character : null;
    if (!character) {
      this._recordError("no-character", `no character available for ${author}`);
      return null;
    }
    const place = resolution && resolution.place ? resolution.place : null;
    const physics = resolution && resolution.physics ? resolution.physics : null;
    if (!this.io.spawn(slotId, character, author, place, physics)) {
      this._recordError("spawn-failed", `could not spawn ${character} for ${author}`);
      return null;
    }
    this.slots.set(slotId, { agent: author, character, actorId: actorId || "", actorKind: actorKind || "" });
    this.log("room-stage: on stage", author, "as", character, "in", slotId);
    return slotId;
  }

  /**
   * evict — take a slot off stage NOW, on demand (the owner hand-removed an
   * avatar via the tray/Cast pane), rather than waiting for the idle sweep.
   * Frees the bookkeeping (slots/lastSeen/lastVoiced) so the same author can
   * be re-staged immediately; calls io.remove so the desk-side avatar goes
   * away too, then io.onEvict so anything else tracking "who is on stage"
   * (the Cast pane, an address book) learns about it the same way an idle
   * retirement already does — retireIdle is built on this, not a sibling of it.
   */
  evict(slotId) {
    const had = this.slots.has(slotId);
    if (had) {
      this.io.remove(slotId);
      this.slots.delete(slotId);
      this.log("room-stage: off stage", slotId);
    }
    delete this.lastSeen[slotId];
    delete this.lastVoiced[slotId];
    if (had && typeof this.io.onEvict === "function") {
      try {
        this.io.onEvict(slotId);
      } catch {
        /* a throwing hook must not break eviction */
      }
    }
    return had;
  }

  retireIdle() {
    for (const slotId of idleSlots(this.lastSeen, this.now(), this.idleMs)) {
      this.evict(slotId);
    }
  }

  async drain() {
    if (this.speaking) return;
    this.speaking = true;
    try {
      while (this.queue.length > 0) {
        const u = this.queue.shift();
        const verdict = await this.io.speak(u.text, u.voice, u.slotId, u.speed);
        if (verdict && verdict.ok) {
          this.spoken += 1;
          this.lastSpokenAt = this.now();
          await new Promise((r) => setTimeout(r, Math.max(0, Number(verdict.durationMs) || 0) + this.gapMs));
        } else {
          const message = (verdict && verdict.reason) || "speak failed";
          this.speakFailures += 1;
          this.lastSpeakError = message;
          this._recordError("speak-failed", message);
        }
      }
    } finally {
      this.speaking = false;
    }
  }
}

module.exports = {
  DEFAULT_COOLDOWN_MS,
  DEFAULT_IDLE_MS,
  DEFAULT_MAX_BODIES,
  DEFAULT_POLL_MS,
  DEFAULT_ROOM,
  GAP_MS,
  MAX_QUEUE,
  MAX_UTTERANCE_CHARS,
  RoomStage,
  VOICES,
  idleSlots,
  pickCharacter,
  readsLikeSpeech,
  selectUtterances,
  shouldVoice,
  slotFor,
  truncateText,
  voiceFor,
};
