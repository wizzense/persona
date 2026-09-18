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
 */

const DEFAULT_ROOM = "main";
const DEFAULT_IDLE_MS = 10 * 60 * 1000;
const DEFAULT_POLL_MS = 2000;
const MAX_QUEUE = 6;
const MAX_UTTERANCE_CHARS = 320;
const GAP_MS = 350;
const DEFAULT_COOLDOWN_MS = 20000;

//: AitherVoice voices, and who sounds like what. The eight core agents get a
//: fixed voice so the owner learns them; anyone else hashes onto the six.
const VOICES = ["nova", "alloy", "echo", "fable", "onyx", "shimmer"];
const AGENT_VOICES = {
  aither: "nova",
  atlas: "onyx",
  demiurge: "echo",
  lyra: "shimmer",
  hydra: "fable",
  athena: "alloy",
  apollo: "echo",
  prometheus: "onyx",
  scribe: "fable",
  awdesk: "nova",
};

//: Actors that speak from the resident avatar (slot0), not their own slot.
const RESIDENT_ACTORS = new Set(["awdesk", "desk", "aither"]);

function slug(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "agent";
}

/** The slot an author speaks from: slot0 for the resident, "room-<slug>" for others. */
function slotFor(author) {
  const key = String(author || "").toLowerCase();
  if (RESIDENT_ACTORS.has(key)) return "slot0";
  return `room-${slug(author)}`;
}

/** The voice an author speaks with (stable across runs). */
function voiceFor(author, overrides = {}) {
  const key = String(author || "").toLowerCase();
  if (overrides[key]) return overrides[key];
  if (AGENT_VOICES[key]) return AGENT_VOICES[key];
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return VOICES[h % VOICES.length];
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

function shouldVoice(row) {
  if (!row.agent) return false;
  const kind = String(row.kind || "");
  if (kind === "agent_message" || kind === "chat" || kind === "command_reply") return true;
  return readsLikeSpeech(String(row.text || "").trim());
}

/**
 * The rows worth voicing out of a recentChat() batch: newer than `sinceSeq`,
 * from an agent (never a human), with text that reads like speech. Oldest
 * first, and capped — a burst of fifty messages becomes the LAST few, not a
 * monologue.
 */
function selectUtterances(rows, sinceSeq, { max = MAX_QUEUE } = {}) {
  const picked = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== "object") continue;
    if (!(Number(row.seq) > sinceSeq)) continue;
    if (!shouldVoice(row)) continue;
    const text = String(row.text || "").trim();
    if (!text) continue;
    picked.push({
      seq: Number(row.seq),
      author: String(row.author || "agent"),
      text: text.length > MAX_UTTERANCE_CHARS ? text.slice(0, MAX_UTTERANCE_CHARS - 1) + "…" : text,
      kind: String(row.kind || ""),
    });
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

/**
 * Pick a character for an agent that has no assigned avatar: a deterministic
 * choice from the SAFE roster (content-rating already filtered), skipping the
 * resident character and anything already on stage, so two agents do not
 * share a body. Pure.
 */
function pickCharacter(agent, roster, { taken = [], resident = null } = {}) {
  const pool = (Array.isArray(roster) ? roster : []).filter(
    (name) => name && name !== resident && !taken.includes(name),
  );
  if (pool.length === 0) return null;
  const key = String(agent || "").toLowerCase();
  let h = 7;
  for (let i = 0; i < key.length; i += 1) h = (h * 33 + key.charCodeAt(i)) >>> 0;
  return pool[h % pool.length];
}

class RoomStage {
  /**
   * @param {object} io
   * @param {() => Promise<Array>} io.recentChat  rows as room-publisher.shapeChat emits
   * @param {(slotId, character, agent) => boolean} io.spawn
   * @param {(slotId) => boolean} io.remove
   * @param {(text, voice, slotId) => Promise<{ok:boolean, durationMs?:number}>} io.speak
   * @param {() => string[]} io.roster            SAFE character names
   * @param {(agent) => string|null} io.assignedAvatar
   * @param {() => string|null} io.residentCharacter
   */
  constructor(io, { idleMs = DEFAULT_IDLE_MS, pollMs = DEFAULT_POLL_MS, gapMs = GAP_MS, cooldownMs = DEFAULT_COOLDOWN_MS, now = Date.now, voices = {}, log = () => {} } = {}) {
    this.io = io;
    this.idleMs = idleMs;
    this.pollMs = pollMs;
    this.gapMs = gapMs;
    this.cooldownMs = cooldownMs;
    this.lastVoiced = {}; // slotId -> ms of the last voiced transcript line
    this.now = now;
    this.voices = voices;
    this.log = log;
    this.lastSeq = 0;
    this.primed = false;
    this.slots = new Map(); // slotId -> { agent, character }
    this.lastSeen = {}; // slotId -> ms
    this.queue = [];
    this.speaking = false;
    this.timer = null;
    this.lastError = null;
    this.spoken = 0;
  }

  status() {
    return {
      room: true,
      lastSeq: this.lastSeq,
      onStage: [...this.slots.entries()].map(([slotId, s]) => ({ slotId, agent: s.agent, character: s.character })),
      queued: this.queue.length,
      speaking: this.speaking,
      spoken: this.spoken,
      lastError: this.lastError,
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

  enqueue(u) {
    const slotId = this.ensureSlot(u.author);
    if (!slotId) return;
    const now = this.now();
    // A chatty actor is heard once per cooldown; the body stays, the stream of
    // lines does not. Addressed messages are exempt: a reply is never dropped.
    const addressed = u.kind === "agent_message" || u.kind === "chat";
    if (!addressed && now - (this.lastVoiced[slotId] || 0) < this.cooldownMs) {
      this.lastSeen[slotId] = now;
      return;
    }
    this.lastVoiced[slotId] = now;
    this.lastSeen[slotId] = now;
    this.queue.push({ ...u, slotId, voice: voiceFor(u.author, this.voices) });
    while (this.queue.length > MAX_QUEUE) this.queue.shift();
  }

  ensureSlot(author) {
    const slotId = slotFor(author);
    if (slotId === "slot0") return slotId;
    if (this.slots.has(slotId)) return slotId;
    const taken = [...this.slots.values()].map((s) => s.character);
    const character =
      this.io.assignedAvatar(author) ||
      pickCharacter(author, this.io.roster(), { taken, resident: this.io.residentCharacter() });
    if (!character) {
      this.lastError = `no character available for ${author}`;
      return null;
    }
    if (!this.io.spawn(slotId, character, author)) {
      this.lastError = `could not spawn ${character} for ${author}`;
      return null;
    }
    this.slots.set(slotId, { agent: author, character });
    this.log("room-stage: on stage", author, "as", character, "in", slotId);
    return slotId;
  }

  retireIdle() {
    for (const slotId of idleSlots(this.lastSeen, this.now(), this.idleMs)) {
      if (this.slots.has(slotId)) {
        this.io.remove(slotId);
        this.slots.delete(slotId);
        this.log("room-stage: off stage", slotId);
      }
      delete this.lastSeen[slotId];
    }
  }

  async drain() {
    if (this.speaking) return;
    this.speaking = true;
    try {
      while (this.queue.length > 0) {
        const u = this.queue.shift();
        const verdict = await this.io.speak(u.text, u.voice, u.slotId);
        if (verdict && verdict.ok) {
          this.spoken += 1;
          await new Promise((r) => setTimeout(r, Math.max(0, Number(verdict.durationMs) || 0) + this.gapMs));
        } else {
          this.lastError = (verdict && verdict.reason) || "speak failed";
        }
      }
    } finally {
      this.speaking = false;
    }
  }
}

module.exports = {
  AGENT_VOICES,
  DEFAULT_IDLE_MS,
  DEFAULT_ROOM,
  MAX_QUEUE,
  MAX_UTTERANCE_CHARS,
  RoomStage,
  VOICES,
  idleSlots,
  readsLikeSpeech,
  shouldVoice,
  pickCharacter,
  selectUtterances,
  slotFor,
  voiceFor,
};
