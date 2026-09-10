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
const CHAT_TYPES = new Set(["command_request", "command_reply", "agent_message", "chat", "message", "steering"]);

function daemonUrl() {
  return (process.env.AITHER_HARNESS_URL || process.env.AWSH_DAEMON_URL || DEFAULT_URL).replace(/\/+$/, "");
}

/** GET/POST JSON against the daemon; resolves { status, body } — status 0 on transport failure. */
function defaultRequest(method, path, body, { timeoutMs = 4000, token = readBridgeToken(), base = daemonUrl() } = {}) {
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

/** Pure: room events -> chat rows [{id, seq, at, author, text, kind, agent, correlationId}]. */
function shapeChat(events, { limit = 60 } = {}) {
  const list = Array.isArray(events) ? events : Array.isArray(events?.events) ? events.events : [];
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
      text: text.slice(0, 2000),
      kind: String(ev.type),
      agent: actor.kind !== "human",
      correlationId: String(ev.correlation_id || ""),
    });
  }
  return rows.slice(-limit);
}

class RoomPublisher {
  constructor({ requestImpl = defaultRequest, room = ROOM } = {}) {
    this.requestImpl = requestImpl;
    this.room = room;
    this.lastError = null;
    this.lastSeq = 0;
  }

  /** POST one event. Resolves {ok, seq?, error?}; never rejects. */
  async publish(event) {
    try {
      const r = await this.requestImpl("POST", "/events", { ...event, room: this.room });
      if (r.status === 200 && r.body && r.body.ok) {
        this.lastError = null;
        return { ok: true, seq: r.body.seq, pillar: r.body.pillar };
      }
      this.lastError = r.status === 0 ? "daemon unreachable" : `HTTP ${r.status}${r.body && r.body.detail ? `: ${r.body.detail}` : ""}`;
      return { ok: false, error: this.lastError };
    } catch (error) {
      this.lastError = error?.message || String(error);
      return { ok: false, error: this.lastError };
    }
  }

  /** Recent chat-like rows from the room. [] when the daemon does not answer. */
  async recentChat({ limit = 60, since = 0 } = {}) {
    try {
      const q = new URLSearchParams({ limit: String(Math.max(limit * 20, 200)) });
      if (since > 0) q.set("since", String(since));
      const r = await this.requestImpl("GET", `/rooms/${encodeURIComponent(this.room)}/events?${q}`, null);
      if (r.status !== 200 || !r.body) {
        this.lastError = r.status === 0 ? "daemon unreachable" : `HTTP ${r.status}`;
        return [];
      }
      const rows = shapeChat(r.body, { limit });
      for (const row of rows) if (row.seq > this.lastSeq) this.lastSeq = row.seq;
      return rows;
    } catch (error) {
      this.lastError = error?.message || String(error);
      return [];
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

module.exports = { CHAT_TYPES, DEFAULT_URL, ROOM, RoomPublisher, daemonUrl, defaultRequest, replyEvent, requestEvent, shapeChat };
