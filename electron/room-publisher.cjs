"use strict";

/**
 * room-publisher — the desk's seat in the AitherAeon room (awdk daemon :8362).
 *
 * "aitherroom" today IS two things, measured 2026-09-08: the AitherRoom app
 * (:8350) retired into AitherRelay (`relay_room_features` mounts into the relay
 * app; no container exists), and the awdk harness daemon carries the local
 * room spine — `GET /rooms/{id}/events`, `POST /events` — where every Claude
 * Code tab, adk loop and kernel tick already lands, fleet up OR down (it is a
 * host process, not a container). The owner asked for the company room chat
 * inside awdesk so that typing there gets things done; this is the half that
 * does not depend on the fleet:
 *
 *   owner types in the Command/Chat window ──▶ CommandAgent runs it
 *        └─▶ `command_request` event (actor: the owner)          into room "main"
 *   CommandAgent replies ──▶ `command_reply` event (actor: awdesk)  into room "main"
 *
 * so awsh `/room`, `adk` and anything tailing the room see the request and the
 * outcome beside the tool calls that produced it. The read side (`recentChat`)
 * shapes the room's chat-like events for the desk's chat window.
 *
 * The RETURN path (2026-09-19) is the other half: the owner addresses a body
 * on stage and the words reach THAT session's tab.
 *
 *   owner addresses a body ──▶ `steering` event carrying `to` + `hops`
 *        └─▶ the daemon's steer dispatcher delivers it (pty, else mailbox)
 *             └─▶ `steering_receipt` event, correlated to the steer
 *
 *   - `to` is a ROUTING HINT, never authorization: actor.kind/id/name are
 *     echoed verbatim from the payload, so a room field is the sender's claim.
 *     Authority travels in the mailbox file's `aither-steer v1
 *     authority="owner|peer"` header, which the daemon stamps, not us.
 *   - a receipt is NOT chat — see CHAT_TYPES.
 *   - a steer publish is SLOW — see STEER_TIMEOUT_MS.
 *   - the only label that tells parallel tabs apart is the /sessions/unified
 *     title — see sessionTitles().
 *
 * Bearer: the same harness token the daemon's other routes take
 * (AITHER_HARNESS_TOKEN, else ~/.aither/harness_token) — the file the daemon
 * writes at first start, which the desk bridge now also requires.
 */

const http = require("node:http");
const { readBridgeToken } = require("./bridge-server.cjs");

const DEFAULT_URL = "http://127.0.0.1:8362";
const ROOM = "main";
// Event types the chat window shows (everything else in the room is tool
// traffic, which the awsh /room panel renders by pillar).
//
// 🚨 SECURITY BOUNDARY, not a display filter. room-stage voices what
// recentChat() returns, so admitting a type here — or teeing another surface
// (a genesis stream, a relay channel) into one of these types — puts that
// surface's text on the owner's SPEAKERS with no other code change and no
// review of who may speak. `steering` is here because the owner's own steer
// is a line of chat. `steering_receipt` is deliberately NOT: a receipt is the
// dispatcher talking about delivery, and a voiceable receipt is one step from
// a receipt that is re-read as a message and re-dispatched. Receipts have their
// own reader (recentReceipts). A test pins this set.
const CHAT_TYPES = new Set(["command_request", "command_reply", "agent_message", "chat", "message", "steering"]);

//: Transport timeouts. The 4 s default is right for a read the stage polls
//: every 2 s; it is WRONG for a steer. The dispatcher runs in Room.publish's
//: listener fan-out, and a 554 MB room was measured taking ~25 s to answer a
//: publish (plan U18, 2026-09-18). At 4 s a healthy-but-slow spine reads as a
//: dead one: the owner is told "daemon unreachable" while his message is being
//: delivered. 🚨 publishSteer MUST pass STEER_TIMEOUT_MS; a test pins it.
const DEFAULT_TIMEOUT_MS = 4000;
const STEER_TIMEOUT_MS = 25000;
//: /sessions/unified walks every discovered tab's transcript; the titles change
//: when a session is renamed, not per poll. 15 s keeps the stage's 2 s loop off it.
const TITLES_TTL_MS = 15000;
//: The spine refuses more than 8 addressees (rooms._normalise); trim here so
//: the refusal is never about a list the owner did not knowingly build.
const MAX_ADDRESSEES = 8;

function daemonUrl() {
  return (process.env.AITHER_HARNESS_URL || process.env.AWSH_DAEMON_URL || DEFAULT_URL).replace(/\/+$/, "");
}

/** GET/POST JSON against the daemon; resolves { status, body } — status 0 on transport failure. */
function defaultRequest(method, path, body, { timeoutMs = DEFAULT_TIMEOUT_MS, token = readBridgeToken(), base = daemonUrl() } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (status, text) => {
      if (settled) return;
      settled = true;
      let parsed;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      resolve({ status, body: parsed, text: text || "" });
    };
    let target;
    try {
      target = new URL(path, base + "/");
    } catch {
      done(0, "");
      return;
    }
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request(
      target,
      {
        method,
        timeout: timeoutMs,
        headers: {
          accept: "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => done(res.statusCode || 0, Buffer.concat(chunks).toString("utf8")));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => done(0, ""));
    req.end(payload);
  });
}

/** The transport verdict for a failed response, in the words the owner sees. */
function transportError(r, { detail = true } = {}) {
  if (!r || r.status === 0) return "daemon unreachable";
  return `HTTP ${r.status}${detail && r.body && r.body.detail ? `: ${r.body.detail}` : ""}`;
}

/** Pure: the event envelope for a command request. Pillar is explicit — the
 *  room derives pillars only for its known vocabulary and these types are ours. */
function requestEvent({ id, text, source, actor }) {
  return {
    type: "command_request",
    room: ROOM,
    pillar: "intent",
    tier: "host",
    actor: actor || { kind: "human", id: "owner", name: "owner" },
    session: "awdesk",
    correlation_id: String(id || ""),
    payload: { id: String(id || ""), text: String(text || "").slice(0, 4000), source: String(source || "") },
  };
}

/** Pure: the event envelope for an ADDRESSED steer — the owner's words to one
 *  or more bodies. Sibling of requestEvent, and like it the pillar is set
 *  EXPLICITLY: rooms._normalise refuses an unknown pillar with a 400 rather
 *  than coercing it, so leaving it to derivation bets the send on the daemon's
 *  vocabulary. `to` is always an array (1..8 ids, empties dropped); whether an
 *  id is valid, or names the sender, is the spine's call — it answers with a
 *  reason and that reason is what the owner should read, not ours. */
function steerEvent({ id, text, to, label, source, actor, hops = 0 }) {
  const targets = (Array.isArray(to) ? to : to == null ? [] : [to])
    .map((t) => String(t == null ? "" : t).trim())
    .filter(Boolean)
    .slice(0, MAX_ADDRESSEES);
  return {
    type: "steering",
    room: ROOM,
    pillar: "orchestration",
    tier: "host",
    actor: actor || { kind: "human", id: "owner", name: "owner" },
    session: "awdesk",
    correlation_id: String(id || ""),
    to: targets,
    hops: Math.max(0, Math.floor(Number(hops) || 0)),
    payload: {
      id: String(id || ""),
      text: String(text || "").slice(0, 4000),
      source: String(source || ""),
      // The human label the owner addressed ("the second one", a session
      // title) — the receipt echoes it so "queued for X" names what he typed.
      address_label: String(label || ""),
    },
  };
}

/** Pure: the event envelope for a command reply. */
function replyEvent({ id, text, reply, kind, ok, verdict, source }) {
  return {
    type: "command_reply",
    room: ROOM,
    pillar: "orchestration",
    tier: "host",
    actor: { kind: "service", id: "awdesk", name: "awdesk" },
    session: "awdesk",
    correlation_id: String(id || ""),
    causation_id: String(id || ""),
    payload: {
      id: String(id || ""),
      text: String(text || "").slice(0, 400),
      reply: String(reply || "").slice(0, 8000),
      kind: String(kind || ""),
      ok: ok !== false,
      source: String(source || ""),
      ...(verdict && typeof verdict === "object" ? { verdict: { ok: verdict.ok, error: verdict.error ?? null } } : {}),
    },
  };
}

function eventList(events) {
  return Array.isArray(events) ? events : Array.isArray(events?.events) ? events.events : [];
}

/** Pure: room events -> chat rows [{id, seq, at, author, text, kind, agent, correlationId}]. */
function shapeChat(events, { limit = 60 } = {}) {
  const list = eventList(events);
  const rows = [];
  for (const ev of list) {
    if (!ev || typeof ev !== "object" || !CHAT_TYPES.has(String(ev.type))) continue;
    const payload = ev.payload && typeof ev.payload === "object" ? ev.payload : {};
    const actor = ev.actor && typeof ev.actor === "object" ? ev.actor : {};
    const text = ev.type === "command_reply"
      ? String(payload.reply || "")
      : String(payload.text || payload.content || payload.message || "");
    if (!text) continue;
    rows.push({
      id: String(ev.id || `${ev.seq}`),
      seq: Number(ev.seq) || 0,
      at: Math.floor(Number(ev.ts) || 0),
      author: String(actor.name || actor.id || "?"),
      // What that actor is working on, in the human's own words, when the
      // producer knows it (transcript_bridge sets it from the session's last
      // prompt). Empty is normal and must render as nothing, never "undefined".
      title: String(actor.title || "").slice(0, 120),
      // Who exactly: parallel Claude Code tabs used to carry the same NAME
      // (the repo); the bridge now suffixes the session, and this stays the
      // identity a stage keys bodies on either way.
      actorId: String(actor.id || ""),
      actorKind: String(actor.kind || ""),
      text: text.slice(0, 2000),
      kind: String(ev.type),
      agent: actor.kind !== "human",
      correlationId: String(ev.correlation_id || ""),
    });
  }
  return rows.slice(-limit);
}

/** Pure: room events -> receipt rows [{correlationId, target, channel, queued, detail, at}].
 *  Only `steering_receipt` rows; everything else — including the steer itself —
 *  is ignored. `queued` is kept apart from the channel on purpose: "the agent
 *  has it now" (channel pty) and "queued for its next turn boundary" (channel
 *  mailbox) are different facts, and on this box every live session is
 *  origin=discovered, so the mailbox is the channel that actually lands. */
function shapeReceipts(events) {
  const rows = [];
  for (const ev of eventList(events)) {
    if (!ev || typeof ev !== "object" || String(ev.type) !== "steering_receipt") continue;
    const payload = ev.payload && typeof ev.payload === "object" ? ev.payload : {};
    rows.push({
      correlationId: String(ev.correlation_id || ""),
      target: String(payload.target || ""),
      channel: String(payload.channel || "none"),
      queued: payload.queued === true,
      detail: String(payload.detail || "").slice(0, 1000),
      at: Math.floor(Number(ev.ts) || 0),
    });
  }
  return rows;
}

class RoomPublisher {
  constructor({ requestImpl = defaultRequest, room = ROOM, now = Date.now } = {}) {
    this.requestImpl = requestImpl;
    this.room = room;
    this.now = now;
    this.lastError = null;
    this.lastErrorAt = null;
    this.lastSeq = 0;
    this.lastReceiptSeq = 0;
    this.titles = {};
    this.titlesAt = null;
  }

  /** Record (or clear) the transport verdict. One place, so status() and the
   *  renderer never disagree about whether the daemon answered. */
  setError(message) {
    this.lastError = message || null;
    this.lastErrorAt = message ? this.now() : null;
    return this.lastError;
  }

  /**
   * What the stage status reads. Before 2026-09-19 `lastError` ("daemon
   * unreachable" vs "HTTP 401") reached only the renderer's roomStatus string,
   * so RoomStage.status() — the object an operator and the checkers read —
   * showed an idle stage that was in fact deaf. The caller merges this in.
   */
  status() {
    return {
      room: this.room,
      lastSeq: this.lastSeq,
      lastReceiptSeq: this.lastReceiptSeq,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
      sessionsTitled: Object.keys(this.titles).length,
    };
  }

  /** POST one event. Resolves {ok, seq?, error?}; never rejects. */
  async publish(event, { timeoutMs } = {}) {
    try {
      const opts = timeoutMs ? { timeoutMs } : undefined;
      const r = await this.requestImpl("POST", "/events", { ...event, room: this.room }, opts);
      if (r.status === 200 && r.body && r.body.ok) {
        this.setError(null);
        return { ok: true, seq: r.body.seq, pillar: r.body.pillar };
      }
      return { ok: false, error: this.setError(transportError(r)) };
    } catch (error) {
      return { ok: false, error: this.setError(error?.message || String(error)) };
    }
  }

  /** POST an addressed steer (from steerEvent) with the 25 s budget. The
   *  answer is "the spine took it", NOT "the session has it" — that is the
   *  receipt's job; read it with recentReceipts(). */
  async publishSteer(event) {
    return this.publish(event, { timeoutMs: STEER_TIMEOUT_MS });
  }

  /** Recent chat-like rows from the room. [] when the daemon does not answer. */
  async recentChat({ limit = 60, since = 0 } = {}) {
    try {
      const q = new URLSearchParams({ limit: String(Math.max(limit * 20, 200)) });
      if (since > 0) q.set("since", String(since));
      const r = await this.requestImpl("GET", `/rooms/${encodeURIComponent(this.room)}/events?${q}`, null);
      if (r.status !== 200 || !r.body) {
        this.setError(transportError(r, { detail: false }));
        return [];
      }
      const rows = shapeChat(r.body, { limit });
      for (const row of rows) if (row.seq > this.lastSeq) this.lastSeq = row.seq;
      return rows;
    } catch (error) {
      this.setError(error?.message || String(error));
      return [];
    }
  }

  /** Steering receipts newer than `sinceSeq`. [] when the daemon does not
   *  answer — a missing receipt is "not yet known", never "delivered". */
  async recentReceipts({ sinceSeq = 0, limit = 200 } = {}) {
    try {
      const q = new URLSearchParams({ limit: String(Math.max(Number(limit) || 0, 50)) });
      if (sinceSeq > 0) q.set("since", String(sinceSeq));
      const r = await this.requestImpl("GET", `/rooms/${encodeURIComponent(this.room)}/events?${q}`, null);
      if (r.status !== 200 || !r.body) {
        this.setError(transportError(r, { detail: false }));
        return [];
      }
      // The daemon's `since` is advisory to us: filter on seq here too, so a
      // daemon that ignores it cannot replay an old receipt as a new one.
      const fresh = eventList(r.body).filter((ev) => ev && Number(ev.seq) > sinceSeq);
      for (const ev of fresh) {
        if (ev.type === "steering_receipt" && Number(ev.seq) > this.lastReceiptSeq) this.lastReceiptSeq = Number(ev.seq);
      }
      return shapeReceipts(fresh);
    } catch (error) {
      this.setError(error?.message || String(error));
      return [];
    }
  }

  /**
   * {<session id>: <title>} from GET /sessions/unified, cached 15 s.
   *
   * The title IS the Claude Code SendMessage address, and it is the ONLY label
   * that distinguishes parallel sessions: every claude_code actor in room
   * "main" is named "AitherOS-Fresh" (the repo), and a claude_code actor's
   * room actor.id IS the session id, so this map is the join from a body on
   * stage to a name the owner recognises. Never throws; a failed GET keeps
   * the last good map (or {} before the first) and is itself cached, so a dead
   * daemon costs one request per TTL, not one per stage poll.
   */
  async sessionTitles() {
    const now = this.now();
    if (this.titlesAt != null && now - this.titlesAt < TITLES_TTL_MS) return { ...this.titles };
    this.titlesAt = now;
    try {
      const r = await this.requestImpl("GET", "/sessions/unified", null);
      const list = r && r.status === 200 && r.body && Array.isArray(r.body.sessions) ? r.body.sessions : null;
      if (!list) {
        this.setError(transportError(r, { detail: false }));
        return { ...this.titles };
      }
      const map = {};
      for (const s of list) {
        if (!s || typeof s !== "object" || !s.id) continue;
        const title = String(s.title || "").trim();
        if (title) map[String(s.id)] = title.slice(0, 200);
      }
      this.titles = map;
      return { ...map };
    } catch (error) {
      this.setError(error?.message || String(error));
      return { ...this.titles };
    }
  }

  /** Wire a CommandAgent: every request and every reply lands in the room. */
  attach(agent, { actorFor = null } = {}) {
    if (!agent || typeof agent.on !== "function") return () => {};
    // "complete" carries {id, ok, reply, kind, verdict} and no text — remember
    // the request so the reply event names what it answered.
    const pending = new Map();
    const onRequest = (payload) => {
      pending.set(payload.id, { text: payload.text, source: payload.source });
      if (pending.size > 200) pending.delete(pending.keys().next().value);
      const actor = actorFor ? actorFor(payload) : null;
      void this.publish(requestEvent({ ...payload, actor }));
    };
    const onComplete = (payload) => {
      const req = pending.get(payload.id) || {};
      pending.delete(payload.id);
      void this.publish(replyEvent({ ...req, ...payload }));
    };
    const onFailed = (payload) => {
      const req = pending.get(payload.id) || {};
      pending.delete(payload.id);
      void this.publish(replyEvent({ ...req, id: payload.id, reply: payload.error?.message || String(payload.error || "failed"), ok: false, kind: "error" }));
    };
    agent.on("request", onRequest);
    agent.on("complete", onComplete);
    agent.on("failed", onFailed);
    return () => {
      agent.off("request", onRequest);
      agent.off("complete", onComplete);
      agent.off("failed", onFailed);
    };
  }
}

module.exports = {
  CHAT_TYPES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_URL,
  ROOM,
  RoomPublisher,
  STEER_TIMEOUT_MS,
  TITLES_TTL_MS,
  daemonUrl,
  defaultRequest,
  replyEvent,
  requestEvent,
  shapeChat,
  shapeReceipts,
  steerEvent,
};
