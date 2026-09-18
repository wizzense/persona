"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MAX_QUEUE,
  MAX_UTTERANCE_CHARS,
  RoomStage,
  VOICES,
  idleSlots,
  pickCharacter,
  readsLikeSpeech,
  shouldVoice,
  selectUtterances,
  slotFor,
  voiceFor,
} = require("./room-stage.cjs");

test("slotFor: the resident speaks from slot0, everyone else from their own slot", () => {
  assert.equal(slotFor("awdesk"), "slot0");
  assert.equal(slotFor("Aither"), "slot0");
  assert.equal(slotFor("atlas"), "room-atlas");
  assert.equal(slotFor("Dr. Demiurge (v2)"), "room-dr-demiurge-v2");
  assert.equal(slotFor(""), "room-agent");
});

test("voiceFor: core agents are fixed, strangers hash onto a real voice, overrides win", () => {
  assert.equal(voiceFor("atlas"), "onyx");
  assert.equal(voiceFor("Lyra"), "shimmer");
  assert.ok(VOICES.includes(voiceFor("some-new-agent")));
  assert.equal(voiceFor("some-new-agent"), voiceFor("some-new-agent"), "stable");
  assert.equal(voiceFor("atlas", { atlas: "fable" }), "fable");
});

test("selectUtterances: only NEW agent rows with text, oldest first, capped", () => {
  const rows = [
    { seq: 10, agent: true, author: "atlas", text: "old" },
    { seq: 12, agent: false, author: "david", text: "the owner is never read back" },
    { seq: 13, agent: true, author: "lyra", text: "" },
    { seq: 15, agent: true, author: "lyra", text: "second" },
    { seq: 14, agent: true, author: "atlas", text: "first" },
  ];
  const picked = selectUtterances(rows, 10);
  assert.deepEqual(picked.map((u) => [u.seq, u.author, u.text]), [[14, "atlas", "first"], [15, "lyra", "second"]]);
});

test("selectUtterances: a burst keeps the LAST few and cuts long text", () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ seq: i + 1, agent: true, author: "atlas", kind: "agent_message", text: "m" + i }));
  const picked = selectUtterances(rows, 0);
  assert.equal(picked.length, MAX_QUEUE);
  assert.equal(picked[picked.length - 1].seq, 20);
  const long = selectUtterances([{ seq: 1, agent: true, author: "a", kind: "agent_message", text: "x".repeat(1000) }], 0);
  assert.equal(long[0].text.length, MAX_UTTERANCE_CHARS);
});

test("shouldVoice: addressed messages always; a transcript line only when it reads like speech", () => {
  assert.equal(shouldVoice({ agent: true, kind: "agent_message", text: "`code` is fine here" }), true);
  assert.equal(shouldVoice({ agent: false, kind: "agent_message", text: "the owner" }), false);
  assert.equal(shouldVoice({ agent: true, kind: "message", text: "Pushed: origin/develop = 7713e4d. Build is on the pulse stage." }), true);
  assert.equal(shouldVoice({ agent: true, kind: "message", text: "`text=True` on Windows turns the stdin into CRLF" }), false);
  assert.equal(shouldVoice({ agent: true, kind: "message", text: "line one\nline two" }), false);
  assert.equal(shouldVoice({ agent: true, kind: "message", text: "x".repeat(300) }), false);
  assert.equal(readsLikeSpeech("a {json} blob"), false);
});

test("idleSlots: silent slots retire, slot0 never does", () => {
  const seen = { slot0: 0, "room-atlas": 1000, "room-lyra": 9000 };
  assert.deepEqual(idleSlots(seen, 10000, 5000), ["room-atlas"]);
});

test("pickCharacter: deterministic, skips the resident and bodies already on stage", () => {
  const roster = ["a", "b", "c", "d"];
  const first = pickCharacter("atlas", roster, { resident: "a" });
  assert.notEqual(first, "a");
  assert.equal(pickCharacter("atlas", roster, { resident: "a" }), first, "stable");
  const second = pickCharacter("atlas", roster, { resident: "a", taken: [first] });
  assert.notEqual(second, first);
  assert.equal(pickCharacter("atlas", ["a"], { resident: "a" }), null);
});

function harness({ rows = [], durationMs = 0 } = {}) {
  const calls = { spawn: [], remove: [], speak: [] };
  let clock = 100000;
  const io = {
    recentChat: async () => rows.splice(0),
    spawn: (slotId, character, agent) => { calls.spawn.push([slotId, character, agent]); return true; },
    remove: (slotId) => { calls.remove.push(slotId); return true; },
    speak: async (text, voice, slotId) => { calls.speak.push([text, voice, slotId]); return { ok: true, durationMs }; },
    roster: () => ["resident", "bob", "cara", "dee"],
    assignedAvatar: (agent) => (agent === "lyra" ? "cara" : null),
    residentCharacter: () => "resident",
  };
  const stage = new RoomStage(io, { idleMs: 5000, gapMs: 0, cooldownMs: 1000, now: () => clock });
  return { stage, calls, io, tick: (ms) => { clock += ms; } };
}

test("RoomStage: the first look primes the watermark and reads nothing aloud", async () => {
  const { stage, calls } = harness({ rows: [{ seq: 5, agent: true, author: "atlas", text: "history" }] });
  await stage.tick();
  assert.equal(stage.lastSeq, 5);
  assert.deepEqual(calls.speak, []);
  assert.deepEqual(calls.spawn, []);
});

test("RoomStage: a new agent gets a body, speaks in its voice, and the resident uses slot0", async () => {
  const h = harness();
  await h.stage.tick(); // prime
  h.io.recentChat = async () => [
    { seq: 6, agent: true, author: "atlas", text: "hello" },
    { seq: 7, agent: true, author: "lyra", text: "hi" },
    { seq: 8, agent: true, author: "awdesk", text: "done" },
  ];
  await h.stage.tick();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(h.calls.spawn.map((c) => [c[0], c[2]]), [["room-atlas", "atlas"], ["room-lyra", "lyra"]]);
  assert.equal(h.calls.spawn[1][1], "cara", "an assigned avatar is honoured");
  assert.notEqual(h.calls.spawn[0][1], "resident");
  assert.deepEqual(h.calls.speak, [["hello", "onyx", "room-atlas"], ["hi", "shimmer", "room-lyra"], ["done", "nova", "slot0"]]);
  assert.equal(h.stage.status().spoken, 3);
});

test("RoomStage: utterances are serialised — one at a time, in order", async () => {
  const h = harness({ durationMs: 30 });
  await h.stage.tick();
  const order = [];
  h.io.speak = async (text) => { order.push("start " + text); await new Promise((r) => setTimeout(r, 10)); order.push("end " + text); return { ok: true, durationMs: 0 }; };
  h.io.recentChat = async () => [
    { seq: 6, agent: true, author: "atlas", kind: "agent_message", text: "a" },
    { seq: 7, agent: true, author: "atlas", kind: "agent_message", text: "b" },
  ];
  await h.stage.tick();
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(order, ["start a", "end a", "start b", "end b"]);
});

test("RoomStage: a silent agent leaves the stage", async () => {
  const h = harness();
  await h.stage.tick();
  h.io.recentChat = async () => [{ seq: 6, agent: true, author: "atlas", text: "hello" }];
  await h.stage.tick();
  h.io.recentChat = async () => [];
  h.tick(6000);
  await h.stage.tick();
  assert.deepEqual(h.calls.remove, ["room-atlas"]);
  assert.equal(h.stage.status().onStage.length, 0);
});

test("RoomStage: a voice failure is recorded, never thrown", async () => {
  const h = harness();
  await h.stage.tick();
  h.io.speak = async () => ({ ok: false, reason: "voice down" });
  h.io.recentChat = async () => [{ seq: 6, agent: true, author: "atlas", text: "hello" }];
  await h.stage.tick();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.stage.status().lastError, "voice down");
});

test("RoomStage: a chatty transcript is heard once per cooldown; addressed lines are never dropped", async () => {
  const h = harness();
  await h.stage.tick();
  h.io.recentChat = async () => [
    { seq: 6, agent: true, author: "AitherOS-Fresh", kind: "message", text: "Pushed one." },
    { seq: 7, agent: true, author: "AitherOS-Fresh", kind: "message", text: "Pushed two." },
    { seq: 8, agent: true, author: "AitherOS-Fresh", kind: "agent_message", text: "Atlas, your turn." },
  ];
  await h.stage.tick();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(h.calls.speak.map((c) => c[0]), ["Pushed one.", "Atlas, your turn."]);
  h.tick(1500);
  h.io.recentChat = async () => [{ seq: 9, agent: true, author: "AitherOS-Fresh", kind: "message", text: "Pushed three." }];
  await h.stage.tick();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.calls.speak[h.calls.speak.length - 1][0], "Pushed three.");
});

test("slotFor: parallel terminal sessions with one name get separate bodies", () => {
  const a = slotFor("AitherOS-Fresh", { actorKind: "claude_code", actorId: "25bb0788-7d30" });
  const b = slotFor("AitherOS-Fresh", { actorKind: "claude_code", actorId: "9f1e44aa-11c2" });
  assert.notEqual(a, b);
  assert.match(a, /^room-aitheros-fresh-25bb$/);
  assert.equal(slotFor("atlas", { actorKind: "adk_agent", actorId: "x" }), "room-atlas");
});

test("RoomStage: two sessions named alike are two bodies", async () => {
  const h = harness();
  await h.stage.tick();
  h.io.recentChat = async () => [
    { seq: 6, agent: true, author: "AitherOS-Fresh", actorKind: "claude_code", actorId: "aaaa1111", kind: "agent_message", text: "one" },
    { seq: 7, agent: true, author: "AitherOS-Fresh", actorKind: "claude_code", actorId: "bbbb2222", kind: "agent_message", text: "two" },
  ];
  await h.stage.tick();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.calls.spawn.length, 2);
  assert.notEqual(h.calls.spawn[0][0], h.calls.spawn[1][0]);
  assert.notEqual(h.calls.spawn[0][1], h.calls.spawn[1][1], "different characters");
});
