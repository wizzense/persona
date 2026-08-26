"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { systemSnapshot } = require("./system-client.cjs");

function fakeCall(calls) {
  return async (name, args) => {
    calls.push({ name, args });
    if (name === "get_system_status") {
      return JSON.stringify({ services: 9, gpu: { ok: true }, healthy: true });
    }
    if (name === "active_agents") {
      return JSON.stringify({ activities: [{ agent: "athena", task: "review" }] });
    }
    if (name === "flux_context") {
      return "prose, not json";
    }
    throw new Error(`unexpected tool ${name}`);
  };
}

test("systemSnapshot aggregates the three awareness sources", async () => {
  const calls = [];
  const snap = await systemSnapshot(fakeCall(calls));
  assert.equal(snap.ok, true);
  assert.equal(snap.system.services, 9);
  assert.equal(snap.system.gpu.ok, true);
  assert.equal(snap.agents.activities[0].agent, "athena");
  // Prose sources fall back to a note, never a thrown parse.
  assert.equal(typeof snap.flux.note, "string");
  assert.ok(snap.at > 0);
  assert.deepEqual(
    calls.map((c) => c.name),
    ["get_system_status", "active_agents", "flux_context"],
  );
});

test("a failing source degrades to an ERROR note, not a failed snapshot", async () => {
  const snap = await systemSnapshot(async (name) => {
    if (name === "get_system_status") throw new Error("gateway down");
    return JSON.stringify({ ok: true });
  });
  assert.equal(snap.ok, true, "the snapshot survives one dead source");
  assert.match(snap.system.note, /gateway down/);
});

test("a dead transport degrades every source to an ERROR note", async () => {
  // Per-source catches mean the snapshot itself never throws — a down
  // gateway yields ok:true with ERROR notes the UI renders as
  // "unavailable", never a failed call.
  const snap = await systemSnapshot(async () => {
    throw new Error("no session bearer");
  });
  assert.equal(snap.ok, true);
  assert.match(snap.system.note, /no session bearer/);
  assert.match(snap.agents.note, /no session bearer/);
  assert.match(snap.flux.note, /no session bearer/);
});
