"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  CHAT_TYPES,
  DEFAULT_TIMEOUT_MS,
  RoomPublisher,
  STEER_TIMEOUT_MS,
  replyEvent,
  requestEvent,
  shapeChat,
  shapeReceipts,
  steerEvent,
} = require("./room-publisher.cjs");

test("requestEvent / replyEvent are valid AitherEvent envelopes the daemon room accepts", () => {
  const req = requestEvent({ id: "c1", text: "fleet status", source: "command-window" });
  assert.equal(req.type, "command_request");
  assert.equal(req.pillar, "intent");
  assert.equal(req.actor.kind, "human");
  assert.equal(req.correlation_id, "c1");
  assert.equal(req.payload.text, "fleet status");
  const rep = replyEvent({ id: "c1", text: "fleet status", reply: "DOWN — 0", kind: "fleet", ok: true, verdict: { ok: true, error: null }, source: "command-window" });
  assert.equal(rep.type, "command_reply");
  assert.equal(rep.pillar, "orchestration");
  assert.deepEqual(rep.actor, { kind: "service", id: "awdesk", name: "awdesk" });
  assert.equal(rep.causation_id, "c1");
  assert.equal(rep.payload.reply, "DOWN — 0");
  assert.equal(rep.payload.ok, true);
});

test("shapeChat keeps the chat-like events, drops tool traffic, and reads a reply's text from its payload", () => {
  const events = [
    { id: "e1", seq: 1, ts: 1700000000.5, type: "tool_call", actor: { kind: "claude_code", id: "s1", name: "AitherOS" }, payload: { tool: "Bash" } },
    { id: "e2", seq: 2, ts: 1700000001, type: "command_request", actor: { kind: "human", id: "david", name: "david" }, payload: { text: "fleet status" }, correlation_id: "c1" },
    { id: "e3", seq: 3, ts: 1700000002, type: "command_reply", actor: { kind: "service", id: "awdesk", name: "awdesk" }, payload: { reply: "DOWN — 0 containers" }, correlation_id: "c1" },
    { id: "e4", seq: 4, ts: 1700000003, type: "command_reply", actor: { kind: "service", id: "awdesk", name: "awdesk" }, payload: {} },
    null,
  ];
  const rows = shapeChat({ events });
  assert.deepEqual(rows.map((r) => [r.id, r.author, r.text, r.agent, r.correlationId]), [
    ["e2", "david", "fleet status", false, "c1"],
    ["e3", "awdesk", "DOWN — 0 containers", true, "c1"],
  ]);
  assert.equal(rows[0].at, 1700000001);
  assert.deepEqual(shapeChat(null), []);
  assert.equal(shapeChat({ events: Array.from({ length: 100 }, (_, i) => ({ id: `x${i}`, seq: i, ts: i, type: "chat", actor: { kind: "human", id: "d" }, payload: { text: "hi" } })) }, { limit: 5 }).length, 5);
});

test("RoomPublisher.publish / recentChat never throw; a down daemon is a reason, not a crash", async () => {
  const calls = [];
  const pub = new RoomPublisher({
    requestImpl: async (method, path, body) => {
      calls.push([method, path, body]);
      if (method === "POST") return { status: 200, body: { ok: true, seq: 42, pillar: "intent" } };
      return { status: 200, body: { events: [{ id: "e1", seq: 9, ts: 5, type: "chat", actor: { kind: "human", id: "d", name: "d" }, payload: { text: "yo" } }] } };
    },
  });
  const r = await pub.publish(requestEvent({ id: "c1", text: "x" }));
  assert.deepEqual(r, { ok: true, seq: 42, pillar: "intent" });
  assert.equal(calls[0][1], "/events");
  assert.equal(calls[0][2].room, "main");
  const rows = await pub.recentChat({ limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(pub.lastSeq, 9);
  assert.match(calls[1][1], /^\/rooms\/main\/events\?/);

  const down = new RoomPublisher({ requestImpl: async () => ({ status: 0, body: null }) });
  assert.deepEqual(await down.publish(requestEvent({ id: "c2", text: "x" })), { ok: false, error: "daemon unreachable" });
  assert.deepEqual(await down.recentChat(), []);
  const refused = new RoomPublisher({ requestImpl: async () => ({ status: 400, body: { detail: "unknown actor.kind" } }) });
  assert.match((await refused.publish({ type: "x" })).error, /HTTP 400: unknown actor\.kind/);
  const thrower = new RoomPublisher({ requestImpl: async () => { throw new Error("boom"); } });
  assert.equal((await thrower.publish({})).error, "boom");
  assert.deepEqual(await thrower.recentChat(), []);
});

test("RoomPublisher.attach mirrors a CommandAgent's request, reply and failure into the room with the request text", async () => {
  const published = [];
  const pub = new RoomPublisher({ requestImpl: async (_m, _p, body) => { published.push(body); return { status: 200, body: { ok: true, seq: published.length } }; } });
  const agent = new EventEmitter();
  const detach = pub.attach(agent, { actorFor: (p) => (p.source === "command-window" ? { kind: "human", id: "david", name: "david" } : null) });
  agent.emit("request", { id: "c1", text: "fleet status", source: "command-window" });
  agent.emit("complete", { id: "c1", ok: true, reply: "DOWN", kind: "fleet", verdict: { ok: true } });
  agent.emit("request", { id: "c2", text: "explode", source: "relay:#command:m9" });
  agent.emit("failed", { id: "c2", error: new Error("spawn ENOENT") });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(published.length, 4);
  assert.equal(published[0].type, "command_request");
  assert.equal(published[0].actor.id, "david");
  assert.equal(published[1].type, "command_reply");
  assert.equal(published[1].payload.text, "fleet status", "the reply names what it answered");
  assert.equal(published[1].payload.reply, "DOWN");
  assert.equal(published[2].actor.id, "owner", "no actorFor answer -> the default owner actor");
  assert.equal(published[3].payload.ok, false);
  assert.equal(published[3].payload.reply, "spawn ENOENT");
  assert.equal(published[3].payload.text, "explode");
  detach();
  agent.emit("request", { id: "c3", text: "after detach" });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(published.length, 4);
});

test("steerEvent's envelope is pinned: EXPLICIT pillar, `to` as an array, hops, and the addressed payload", () => {
  const ev = steerEvent({ id: "s1", text: "run the gates", to: ["sess-a", "sess-b"], label: "AitherOS-Fresh · gates", source: "chat-window", hops: 1 });
  assert.equal(ev.type, "steering");
  // rooms._normalise REFUSES an unknown pillar with a 400 rather than coercing
  // it, so the pillar must be on the envelope, not left to derivation.
  assert.equal(ev.pillar, "orchestration");
  assert.equal(ev.tier, "host");
  assert.equal(ev.correlation_id, "s1");
  assert.ok(Array.isArray(ev.to), "`to` is always an array — the spine's field is a list");
  assert.deepEqual(ev.to, ["sess-a", "sess-b"]);
  assert.equal(ev.hops, 1);
  assert.equal(ev.payload.text, "run the gates");
  assert.equal(ev.payload.source, "chat-window");
  assert.equal(ev.payload.address_label, "AitherOS-Fresh · gates");
  assert.deepEqual(ev.actor, { kind: "human", id: "owner", name: "owner" });

  // A bare string, empties and whitespace all normalise; hops defaults to 0.
  const one = steerEvent({ id: "s2", text: "hi", to: " sess-a " });
  assert.deepEqual(one.to, ["sess-a"]);
  assert.equal(one.hops, 0);
  assert.deepEqual(steerEvent({ id: "s3", text: "hi", to: ["", null, "x"] }).to, ["x"]);
  assert.deepEqual(steerEvent({ id: "s4", text: "hi" }).to, []);
  // Trimmed to the 8 the spine accepts, so a refusal is never about a list the
  // owner did not knowingly build.
  assert.equal(steerEvent({ id: "s5", text: "hi", to: Array.from({ length: 12 }, (_, i) => `s${i}`) }).to.length, 8);
  assert.equal(steerEvent({ id: "s6", text: "x".repeat(5000), to: ["a"] }).payload.text.length, 4000);
});

test("publishSteer spends 25 s, NOT the 4 s read default — a slow room must not read as a dead daemon", async () => {
  const opts = [];
  const pub = new RoomPublisher({
    requestImpl: async (_m, _p, _b, options) => {
      opts.push(options);
      return { status: 200, body: { ok: true, seq: 7, pillar: "orchestration" } };
    },
  });
  const r = await pub.publishSteer(steerEvent({ id: "s1", text: "go", to: ["sess-a"] }));
  assert.deepEqual(r, { ok: true, seq: 7, pillar: "orchestration" });
  assert.equal(opts[0].timeoutMs, STEER_TIMEOUT_MS);
  assert.equal(opts[0].timeoutMs, 25000);
  assert.notEqual(opts[0].timeoutMs, DEFAULT_TIMEOUT_MS, "the 4 s default is the trap this method exists to avoid");

  // A plain publish still inherits the default (no override passed down).
  await pub.publish(requestEvent({ id: "c1", text: "x" }));
  assert.ok(!opts[1] || opts[1].timeoutMs === undefined);
  // And a refusal is still a reason, not a throw.
  const refused = new RoomPublisher({ requestImpl: async () => ({ status: 400, body: { detail: "to[0] names the sender; an actor cannot address itself" } }) });
  assert.match((await refused.publishSteer(steerEvent({ id: "s2", text: "x", to: ["me"] }))).error, /cannot address itself/);
});

test("shapeReceipts picks ONLY steering_receipt rows and preserves the correlation id", () => {
  const events = [
    { id: "e1", seq: 1, ts: 10, type: "steering", actor: { kind: "human", id: "owner" }, correlation_id: "s1", payload: { text: "go" } },
    { id: "e2", seq: 2, ts: 11, type: "steering_receipt", actor: { kind: "service", id: "awdk" }, correlation_id: "s1", payload: { target: "sess-a", target_kind: "claude_code", channel: "mailbox", queued: true, landed_now: false, detail: "queued — lands at that session's next turn boundary", address_label: "gates" } },
    { id: "e3", seq: 3, ts: 12, type: "tool_call", actor: { kind: "claude_code", id: "sess-a" }, payload: { tool: "Bash" } },
    { id: "e4", seq: 4, ts: 13, type: "steering_receipt", actor: { kind: "service", id: "awdk" }, correlation_id: "s2", payload: { target: "sess-b", channel: "none", queued: false, detail: "hops 2 exceeds the limit" } },
    null,
    "nope",
  ];
  const rows = shapeReceipts({ events });
  assert.equal(rows.length, 2, "the steer itself and the tool call are not receipts");
  assert.deepEqual(rows[0], {
    correlationId: "s1",
    target: "sess-a",
    channel: "mailbox",
    queued: true,
    detail: "queued — lands at that session's next turn boundary",
    at: 11,
  });
  assert.equal(rows[1].correlationId, "s2");
  assert.equal(rows[1].channel, "none");
  assert.equal(rows[1].queued, false, "queued is a fact of its own — a refusal is not queued");
  assert.deepEqual(shapeReceipts(null), []);
  assert.deepEqual(shapeReceipts({ events: [{ seq: 1, type: "chat", payload: { text: "hi" } }] }), []);
});

test("recentReceipts filters on seq itself and never throws on a dead daemon", async () => {
  const calls = [];
  const rows = [
    { id: "e1", seq: 5, ts: 1, type: "steering_receipt", correlation_id: "old", payload: { target: "a", channel: "mailbox", queued: true } },
    { id: "e2", seq: 9, ts: 2, type: "steering_receipt", correlation_id: "new", payload: { target: "b", channel: "pty", queued: false, landed_now: true } },
  ];
  const pub = new RoomPublisher({
    requestImpl: async (method, path) => {
      calls.push(path);
      return { status: 200, body: { events: rows } };
    },
  });
  // A daemon that ignores `since` must not be able to replay an old receipt.
  const fresh = await pub.recentReceipts({ sinceSeq: 6 });
  assert.deepEqual(fresh.map((r) => r.correlationId), ["new"]);
  assert.equal(pub.lastReceiptSeq, 9);
  assert.match(calls[0], /^\/rooms\/main\/events\?.*since=6/);

  const down = new RoomPublisher({ requestImpl: async () => ({ status: 0, body: null }) });
  assert.deepEqual(await down.recentReceipts(), []);
  assert.equal(down.lastError, "daemon unreachable");
  const thrower = new RoomPublisher({ requestImpl: async () => { throw new Error("boom"); } });
  assert.deepEqual(await thrower.recentReceipts(), []);
  assert.equal(thrower.lastError, "boom");
});

test("sessionTitles joins session id -> title, caches 15 s, and degrades to {} without throwing", async () => {
  let clock = 1_000_000;
  let gets = 0;
  const pub = new RoomPublisher({
    now: () => clock,
    requestImpl: async (method, path) => {
      assert.equal(path, "/sessions/unified");
      gets += 1;
      return {
        status: 200,
        body: {
          sessions: [
            { id: "sess-a", title: "AitherOS-Fresh · gates", origin: "discovered" },
            { id: "sess-b", title: "AitherOS-Fresh · room", origin: "discovered" },
            { id: "sess-c", title: "  ", origin: "discovered" },
            { title: "no id" },
            null,
          ],
        },
      };
    },
  });
  // The title is the only thing that tells two tabs apart: both actors in room
  // main are named "AitherOS-Fresh".
  assert.deepEqual(await pub.sessionTitles(), { "sess-a": "AitherOS-Fresh · gates", "sess-b": "AitherOS-Fresh · room" });
  assert.equal(gets, 1);
  clock += 14_999;
  await pub.sessionTitles();
  assert.equal(gets, 1, "inside the 15 s window the cache answers — the stage polls every 2 s");
  clock += 2;
  await pub.sessionTitles();
  assert.equal(gets, 2, "past 15 s it refetches");

  const bad = new RoomPublisher({ requestImpl: async () => ({ status: 401, body: { detail: "nope" } }) });
  assert.deepEqual(await bad.sessionTitles(), {}, "no titles, no throw");
  assert.equal(bad.lastError, "HTTP 401");
  const thrower = new RoomPublisher({ requestImpl: async () => { throw new Error("socket hang up"); } });
  assert.deepEqual(await thrower.sessionTitles(), {});
  assert.equal(thrower.lastError, "socket hang up");
  const garbage = new RoomPublisher({ requestImpl: async () => ({ status: 200, body: { sessions: "not a list" } }) });
  assert.deepEqual(await garbage.sessionTitles(), {});
});

test("CHAT_TYPES still excludes steering_receipt — admitting it would make receipts voiceable", () => {
  // 🚨 REGRESSION ARM, not a style check. room-stage voices what recentChat()
  // returns, so this set is the boundary between "the room" and the owner's
  // speakers. `steering` is in (the owner's own steer is chat); a receipt is
  // the dispatcher talking about delivery and must never be spoken or re-read
  // as a message and re-dispatched.
  assert.ok(CHAT_TYPES.has("steering"));
  assert.equal(CHAT_TYPES.has("steering_receipt"), false);
  assert.deepEqual(
    [...CHAT_TYPES].sort(),
    ["agent_message", "chat", "command_reply", "command_request", "message", "steering"],
    "adding a type here puts another surface's text on the speakers with no other code change",
  );
  // And the chat reader drops a receipt even when one is handed to it.
  const receipt = { id: "e1", seq: 1, ts: 1, type: "steering_receipt", actor: { kind: "service", id: "awdk", name: "awdk" }, correlation_id: "s1", payload: { text: "queued", target: "sess-a", channel: "mailbox", queued: true } };
  assert.deepEqual(shapeChat({ events: [receipt] }), []);
});

test("status() carries the transport verdict, so it stops reaching only the renderer", async () => {
  let clock = 5_000;
  const pub = new RoomPublisher({ now: () => clock, requestImpl: async () => ({ status: 401, body: { detail: "missing bearer" } }) });
  assert.deepEqual(pub.status(), { room: "main", lastSeq: 0, lastReceiptSeq: 0, lastError: null, lastErrorAt: null, sessionsTitled: 0 });
  await pub.publishSteer(steerEvent({ id: "s1", text: "go", to: ["sess-a"] }));
  // "HTTP 401" and "daemon unreachable" are DIFFERENT owner-facing verdicts:
  // one is a credential, the other a dead process.
  assert.equal(pub.status().lastError, "HTTP 401: missing bearer");
  assert.equal(pub.status().lastErrorAt, 5_000);

  const ok = new RoomPublisher({ requestImpl: async () => ({ status: 200, body: { ok: true, seq: 1 } }) });
  ok.setError("stale");
  await ok.publish(requestEvent({ id: "c1", text: "x" }));
  assert.equal(ok.status().lastError, null, "a successful publish clears the verdict");
  assert.equal(ok.status().lastErrorAt, null);

  const down = new RoomPublisher({ requestImpl: async () => ({ status: 0, body: null }) });
  await down.publish(requestEvent({ id: "c1", text: "x" }));
  assert.equal(down.status().lastError, "daemon unreachable");
});
