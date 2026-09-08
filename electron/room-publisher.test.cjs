"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { RoomPublisher, replyEvent, requestEvent, shapeChat } = require("./room-publisher.cjs");

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
