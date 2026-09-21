"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { RelayPoller, ackText, pickWorkOrders } = require("./relay-poller.cjs");
const { shapeRows } = require("./relay-feed.cjs");

const row = (id, text, extra = {}) => ({ id, text, author: "david", at: 100 + Number(String(id).replace(/\D/g, "") || 0), channel: "#command", threadId: null, replyCount: 0, agent: false, ...extra });

function tmpCursor(context) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-relay-poller-"));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "cursor.json");
}

test("pickWorkOrders: #command takes every plain message; acks, findings, system rows, thread replies and seen ids never qualify", () => {
  const rows = [
    row("m1", "fleet status"),
    row("m2", "[ack] DOWN — 0 containers"),
    row("m3", "[finding] something"),
    row("m4", "[ack] the desk's own mirror", { agent: true }),
    row("m8", "Channel #command created by david", { type: "system" }),
    row("m5", "reply in thread", { threadId: "m1" }),
    row("m6", "already ran"),
    row("m7", "   "),
  ];
  const orders = pickWorkOrders(rows, { channel: "#command", seen: new Set(["m6"]) });
  assert.deepEqual(orders.map((o) => o.id), ["m1"]);
  assert.equal(orders[0].text, "fleet status");
});

test("an agent-flagged row IS an order: the desk's own join makes the relay stamp the OWNER as an agent", () => {
  // Measured live 2026-09-08: POST /v1/agent/join (how the desk reads an
  // agent-only channel at all) registers the owner's nick as an agent in that
  // channel, so every later message the owner TYPES arrives with agent:true.
  // A blanket agent-skip silenced the owner's second message. The envelope is
  // the discriminator, not the author flag.
  const rows = [
    row("a1", "fleet status", { agent: true }),
    row("a2", "[ack] DOWN -- 0 containers", { agent: true }),
  ];
  const orders = pickWorkOrders(rows, { channel: "#command", seen: new Set() });
  assert.deepEqual(orders.map((o) => o.id), ["a1"]);
});

test("pickWorkOrders: #agents only takes messages addressed to the desk, and strips the address", () => {
  const rows = [
    row("a1", "@desk fleet status", { channel: "#agents" }),
    row("a2", "@aither: reply with PONG", { channel: "#agents" }),
    row("a3", "/do adopt", { channel: "#agents" }),
    row("a4", "sessions coordinating among themselves", { channel: "#agents" }),
    row("a5", "@lyra please review", { channel: "#agents" }),
  ];
  const orders = pickWorkOrders(rows, { channel: "#agents", seen: new Set() });
  assert.deepEqual(orders.map((o) => [o.id, o.text]), [["a1", "fleet status"], ["a2", "reply with PONG"], ["a3", "adopt"]]);
});

test("ackText prefixes [ack], marks failures, and caps length", () => {
  assert.equal(ackText({ ok: true, reply: "PONG" }), "[ack] PONG");
  assert.equal(ackText({ ok: false, reply: "spawn ENOENT" }), "[ack] FAILED — spawn ENOENT");
  assert.equal(ackText({ ok: true }), "[ack] done");
  assert.ok(ackText({ ok: true, reply: "x".repeat(9000) }).length <= 3800);
});

test("RelayPoller: the first sight of a channel primes the cursor and executes NOTHING; the next new message runs and is acked in-thread", async (context) => {
  const cursorFile = tmpCursor(context);
  const runs = [];
  const posts = [];
  let history = [row("m1", "fleet down"), row("m2", "fleet status")];
  const agent = { run: async (text, opts) => { runs.push([text, opts.source]); return { ok: true, id: "c1", reply: `ran ${text}`, kind: "fleet" }; } };
  const poller = new RelayPoller({
    agent,
    cursorFile,
    channels: ["#command"],
    fetchHistory: async (channel) => history.map((r) => ({ ...r, channel })),
    postThreadReply: async (channel, id, text) => { posts.push([channel, id, text]); return { ok: true }; },
  });
  const first = await poller.poll();
  assert.deepEqual(first, [], "the backlog is history, not orders");
  assert.deepEqual(runs, [], "nothing from yesterday reached the fleet");
  assert.ok(fs.existsSync(cursorFile));

  history = [...history, row("m3", "Reply with PONG")];
  const second = await poller.poll();
  assert.equal(second.length, 1);
  assert.deepEqual(runs, [["Reply with PONG", "relay:#command:m3"]]);
  assert.deepEqual(posts, [["#command", "m3", "[ack] ran Reply with PONG"]]);
  assert.equal(second[0].posted, true);

  // Same history again: nothing re-runs.
  const third = await poller.poll();
  assert.deepEqual(third, []);
  assert.equal(runs.length, 1);

  // A NEW poller on the same cursor file (desk restart) does not replay m3 either.
  const restarted = new RelayPoller({ agent, cursorFile, channels: ["#command"], fetchHistory: async (c) => history.map((r) => ({ ...r, channel: c })), postThreadReply: async () => ({ ok: true }) });
  assert.deepEqual(await restarted.poll(), []);
  assert.equal(runs.length, 1);
  assert.equal(restarted.status().seen["#command"], 3);
});

test("RelayPoller: a failing run is acked as FAILED; a relay that refuses the ack or the read never throws", async (context) => {
  const cursorFile = tmpCursor(context);
  fs.writeFileSync(cursorFile, JSON.stringify({ seen: { "#command": ["old"] } }));
  const posts = [];
  const poller = new RelayPoller({
    agent: { run: async () => { throw new Error("claude ENOENT"); } },
    cursorFile,
    channels: ["#command", "#agents"],
    fetchHistory: async (channel) => {
      if (channel === "#agents") throw new Error("relay down");
      return [row("old", "x"), row("n1", "do the thing")];
    },
    postThreadReply: async (_c, _id, text) => { posts.push(text); return { ok: false, detail: "403 agent-only" }; },
  });
  const executed = await poller.poll();
  assert.equal(executed.length, 1);
  assert.equal(executed[0].result.ok, false);
  assert.equal(posts[0], "[ack] FAILED — claude ENOENT");
  assert.equal(executed[0].posted, false);
  assert.equal(executed[0].postDetail, "403 agent-only");
  assert.equal(poller.lastError, "relay down");
  assert.equal(poller.status().executed, 1);
});

test("RelayPoller: start/stop schedule on the injected timer and a poll in flight is not doubled", async (context) => {
  const cursorFile = tmpCursor(context);
  let scheduled = null;
  let cleared = 0;
  const poller = new RelayPoller({
    agent: { run: async () => ({ ok: true, reply: "ok" }) },
    cursorFile,
    channels: ["#command"],
    intervalMs: 5,
    fetchHistory: async () => [],
    postThreadReply: async () => ({ ok: true }),
    setIntervalImpl: (fn, ms) => { scheduled = { fn, ms }; return { unref() {} }; },
    clearIntervalImpl: () => { cleared += 1; },
  });
  poller.start();
  assert.equal(scheduled.ms, 5);
  poller.polling = true;
  assert.deepEqual(await poller.poll(), [], "a second poll during one in flight is a no-op");
  poller.polling = false;
  poller.stop();
  assert.equal(cleared, 1);
});

test("RBD004: a relay row that ARRIVED with an envelope is never a work order, even after shapeRows strips the envelope for display", () => {
  // Measured 2026-09-20/21: the RBD gate posts `[ack] [check_relay_broadcast_deliverable] probe`
  // so the desk SKIPS it (ENVELOPE_RE, above), and the desk executed it anyway --
  // 5 rows in the last 50 of #command carry its own `[ack] ...` thread receipt,
  // each one a headless session spawned by a message addressed to no one. The
  // seam is the bug: shapeRows() splits the envelope off into `kind` (right for
  // the panel) and the poller was handed THAT text, so this guard tested a body
  // whose envelope was already gone. Asserted here because neither module alone
  // shows it -- this is the test that would have caught it.
  const wire = [{
    id: "p1",
    channel: "#command",
    nick: "awrun",
    content: "[ack] [check_relay_broadcast_deliverable] probe",
    timestamp: "2026-09-21T18:15:10Z",
  }];
  const shaped = shapeRows(wire, "#command", 50);
  assert.equal(shaped.length, 1);
  assert.equal(shaped[0].text, "[check_relay_broadcast_deliverable] probe", "the panel keeps the human body");
  assert.equal(shaped[0].kind, "ack", "the envelope is a chip, not text");
  assert.equal(shaped[0].raw, wire[0].content, "the wire text survives shaping");
  assert.deepEqual(pickWorkOrders(shaped, { channel: "#command", seen: new Set() }), []);
});

test("RBD004: an UNKNOWN bracket is not an envelope -- the guard did not widen", () => {
  // The tempting one-line fix is to skip any `[bracketed]` row. That would
  // silently stop the desk executing a legitimate order that opens with one.
  const rows = [row("o1", "[fleet] status"), row("o2", "plain order")];
  const orders = pickWorkOrders(rows, { channel: "#command", seen: new Set() });
  assert.deepEqual(orders.map((o) => o.id), ["o1", "o2"]);
});
