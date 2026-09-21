"use strict";

/**
 * relay-poller — a message typed ANYWHERE in the relay reaches the desk's
 * executor, and the outcome goes back where it was asked.
 *
 * Integration-map gap 1 (docs/plans/2026-09-08-command-and-control-unification.md):
 * `#agents` was a dead-letter channel — the desk, awsh, awconnect and the Veil
 * chat all POST there, and the only consumers that executed anything were
 * cloud-side and workspace-scoped. The CommandAgent is the local executor;
 * this poller is the missing wire.
 *
 *   #command  every message that is not an ack/finding/alert is a work order
 *   #agents   a message addressed to the desk — "@desk …", "@aither …",
 *             "@awdesk …" or "/do …" — is a work order (the rest is the
 *             sessions coordinating; the desk stays out of it)
 *
 *   work order ──▶ CommandAgent.run(text, {source: "relay:<channel>:<id>"})
 *              ──▶ thread reply under the message: "[ack] <reply>"
 *
 * Loop guards, because the desk posts as the OWNER identity (same bearer, same
 * nick — the relay refuses any other nick): an `[ack]`/`[finding]`/`[alert]`
 * envelope is never a work order (the desk's own mirror always carries `[ack]`);
 * a `system` row is the channel narrating itself, never an order; and the cursor
 * file makes every message id run at most ONCE across desk restarts. On the very
 * first run everything already in the channel is marked seen — a restart must
 * never replay yesterday's history into the fleet.
 *
 * 🚩 The guard that is NOT here, and why. The first version also skipped every
 * row with `agent: true`, which looked like the obvious anti-loop rule and was
 * measured wrong the first time it ran live (2026-09-08): the desk's own
 * `POST /v1/agent/join` — the join that lets it read an agent-only channel at
 * all — registers the OWNER's nick as an agent in that channel, so from the
 * next message on the relay stamps `agent: true` on what the owner types. The
 * owner's second message was silently skipped while the first had run. Author
 * identity cannot separate the desk from the owner here (one nick, by the
 * relay's own rule), so the discriminator is the CONTENT envelope, which the
 * desk controls and a human does not accidentally type.
 *
 * READ goes through the awrelay CLI (relay-feed.fetchHistory), WRITE through
 * relay-feed.postThreadReply — one transport story, no second relay client.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

// THE one place a desk relay channel is spelled. Every other file imports from
// here, and check_relay_broadcast_deliverable.py derives what it asserts from
// this file rather than carrying a second copy — a checker holding its own list
// keeps asserting the old channel long after someone repoints the desk, and
// passes while the real lane is mute. That is the exact failure that gate
// exists for: #awrun was its only entry, so #command not existing for most of
// 2026-09-08 was invisible to it.
const CHANNELS = Object.freeze({ "#command": "all", "#agents": "addressed" });
/** Where the CommandAgent mirrors its [ack] — read side and write side, one name. */
const MIRROR_CHANNEL = "#command";
const ADDRESS_RE = /^\s*(?:@(?:desk|awdesk|aither)\b[:,]?\s*|\/do\s+)/i;
const ENVELOPE_RE = /^\s*\[(ack|finding|alert)\]/i;
const DEFAULT_INTERVAL_MS = 20_000;
const SEEN_KEEP = 400;

function cursorPath() {
  return path.join(os.homedir(), ".aither", "desk-relay-cursor.json");
}

/** Pure: which rows are work orders, given the channel policy and what was seen. */
function pickWorkOrders(rows, { channel, seen, policy = CHANNELS[channel] || "addressed" }) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== "object" || !row.id || !row.text) continue;
    if (seen.has(row.id)) continue;
    // Only a real message is an order: join/part/system/topic rows are the
    // channel talking about itself.
    if (row.type && row.type !== "message" && row.type !== "action") continue;
    // The desk's own mirror (and any awrelay ack/finding/alert) — never re-run.
    // Test the WIRE text: shapeRows splits the envelope off into `kind` for
    // display, so for an `[ack] ...` row `text` is the body alone and this guard
    // saw nothing to skip -- the desk then executed an envelope-prefixed probe as
    // an owner command and spawned a headless session (RBD004, measured
    // 2026-09-20/21). `raw` is the row as the relay sent it; a caller that hands
    // over unshaped rows still gets `text` tested.
    if (ENVELOPE_RE.test(String(row.raw ?? row.text))) continue;
    // A thread reply is a conversation under a message, not a new order.
    if (row.threadId) continue;
    let text = String(row.text);
    if (policy === "addressed") {
      if (!ADDRESS_RE.test(text)) continue;
      text = text.replace(ADDRESS_RE, "");
    }
    text = text.trim();
    if (!text) continue;
    out.push({ id: row.id, channel: row.channel || channel, author: row.author || "", text, at: Number(row.at) || 0 });
  }
  return out;
}

/** Pure: the thread reply body for a finished command. */
function ackText(result) {
  const reply = String(result?.reply || (result?.ok ? "done" : "failed")).trim();
  const head = result?.ok === false ? "[ack] FAILED — " : "[ack] ";
  return (head + reply).slice(0, 3800);
}

class RelayPoller extends EventEmitter {
  constructor({
    agent,
    fetchHistory,
    postThreadReply,
    cursorFile = cursorPath(),
    channels = Object.keys(CHANNELS),
    intervalMs = DEFAULT_INTERVAL_MS,
    historyLimit = 30,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
  }) {
    super();
    if (!agent || typeof agent.run !== "function") throw new Error("RelayPoller needs a CommandAgent");
    this.agent = agent;
    this.fetchHistory = fetchHistory;
    this.postThreadReply = postThreadReply;
    this.cursorFile = cursorFile;
    this.channels = channels;
    this.intervalMs = intervalMs;
    this.historyLimit = historyLimit;
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;
    this.timer = null;
    this.polling = false;
    this.seen = new Map(); // channel -> Set(ids)
    this.primed = new Set(); // channels whose backlog was marked seen once
    this.lastPollAt = 0;
    this.lastError = null;
    this.executed = 0;
    this._loadCursor();
  }

  _loadCursor() {
    try {
      const doc = JSON.parse(fs.readFileSync(this.cursorFile, "utf8"));
      for (const [channel, ids] of Object.entries(doc?.seen || {})) {
        this.seen.set(channel, new Set(Array.isArray(ids) ? ids.map(String) : []));
        this.primed.add(channel);
      }
    } catch {
      /* first run: no cursor yet */
    }
  }

  _saveCursor() {
    try {
      const seen = {};
      for (const [channel, ids] of this.seen) seen[channel] = [...ids].slice(-SEEN_KEEP);
      fs.mkdirSync(path.dirname(this.cursorFile), { recursive: true });
      fs.writeFileSync(this.cursorFile, JSON.stringify({ seen, savedAt: new Date().toISOString() }));
    } catch (error) {
      this.lastError = `cursor: ${error?.message || error}`;
    }
  }

  _seenFor(channel) {
    if (!this.seen.has(channel)) this.seen.set(channel, new Set());
    return this.seen.get(channel);
  }

  /** One pass over every channel. Resolves the executed work orders. */
  async poll() {
    if (this.polling) return [];
    this.polling = true;
    const executed = [];
    try {
      for (const channel of this.channels) {
        let rows;
        try {
          rows = await this.fetchHistory(channel, this.historyLimit);
        } catch (error) {
          this.lastError = error?.message || String(error);
          continue;
        }
        if (!Array.isArray(rows) || rows.length === 0) continue;
        const seen = this._seenFor(channel);
        if (!this.primed.has(channel)) {
          // First sight of this channel: the backlog is history, not orders.
          for (const row of rows) if (row?.id) seen.add(String(row.id));
          this.primed.add(channel);
          this._saveCursor();
          this.emit("primed", { channel, count: rows.length });
          continue;
        }
        const orders = pickWorkOrders(rows, { channel, seen });
        // Mark EVERYTHING seen (orders and non-orders) so a message never re-qualifies.
        for (const row of rows) if (row?.id) seen.add(String(row.id));
        if (seen.size > SEEN_KEEP * 2) {
          const keep = [...seen].slice(-SEEN_KEEP);
          seen.clear();
          for (const id of keep) seen.add(id);
        }
        this._saveCursor();
        for (const order of orders) {
          this.emit("order", order);
          let result;
          try {
            result = await this.agent.run(order.text, { source: `relay:${order.channel}:${order.id}` });
          } catch (error) {
            result = { ok: false, reply: error?.message || String(error) };
          }
          this.executed += 1;
          const ack = ackText(result);
          let posted = { ok: false };
          try {
            posted = (await this.postThreadReply(order.channel, order.id, ack)) || { ok: false };
          } catch (error) {
            posted = { ok: false, detail: error?.message || String(error) };
          }
          const record = { ...order, result, ack, posted: !!posted.ok, postDetail: posted.detail || null };
          executed.push(record);
          this.emit("executed", record);
        }
      }
      this.lastPollAt = Date.now();
    } finally {
      this.polling = false;
    }
    return executed;
  }

  start() {
    if (this.timer) return;
    this.timer = this.setIntervalImpl(() => void this.poll(), this.intervalMs);
    this.timer.unref?.();
    void this.poll();
  }

  stop() {
    if (this.timer) this.clearIntervalImpl(this.timer);
    this.timer = null;
  }

  status() {
    return {
      channels: this.channels,
      intervalMs: this.intervalMs,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      executed: this.executed,
      seen: Object.fromEntries([...this.seen].map(([c, s]) => [c, s.size])),
    };
  }
}

module.exports = {
  ADDRESS_RE, CHANNELS, MIRROR_CHANNEL, RelayPoller, ackText, cursorPath, pickWorkOrders,
};
