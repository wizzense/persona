"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

//: Every bridge in this suite writes its status HERE, never to the operator's
//: ~/.aither/relay-room-bridge.json: a test run that overwrites the live trace
//: makes the desk look like it mirrored rows it never saw.
const statusFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relay-room-")), "status.json");

const {
  RelayRoomBridge,
  selectRows,
  toEvent,
  normaliseChannels,
  ROOM_MARKER,
} = require("./relay-room-bridge.cjs");

function row(over = {}) {
  return {
    channel: "#agents",
    author: "demiurge",
    text: "landed the fix on develop",
    at: 1000,
    id: "m1",
    agent: true,
    type: "message",
    ...over,
  };
}

function freshState(watermark = 0) {
  return { watermark, seen: new Set(), primed: true };
}

/** A publisher that records events and can be told to refuse. */
function fakePublisher(ok = true) {
  const sent = [];
  return {
    sent,
    ok,
    publish(event) {
      if (!this.ok) return Promise.resolve({ ok: false, error: "daemon unreachable" });
      sent.push(event);
      return Promise.resolve({ ok: true, seq: sent.length });
    },
  };
}

test("only rows newer than the watermark are spoken", () => {
  const picked = selectRows([row({ at: 900, id: "old" }), row({ at: 1100, id: "new" })], freshState(1000));
  assert.deepStrictEqual(picked.map((r) => r.id), ["new"]);
});

test("the OWNER's nick is a person in the room, not the desk's own voice", () => {
  // 2026-09-19: the desk posts to relay AS the owner ("david"), so treating that
  // nick as "ours" dropped every message the owner wrote — the bridge saw them,
  // advanced its watermark and mirrored nothing. He gets a body; he is not voiced.
  const picked = selectRows([row({ author: "david", id: "owner", agent: true })], freshState());
  assert.deepStrictEqual(picked.map((r) => r.id), ["owner"]);
  assert.strictEqual(toEvent(picked[0]).actor.kind, "human");
});

test("a row THIS desk posted is skipped by its id, not by its nick", () => {
  const ourIds = new Set(["posted-by-us"]);
  const picked = selectRows(
    [row({ author: "david", id: "posted-by-us" }), row({ author: "david", id: "someone-else", at: 1200 })],
    freshState(),
    { ourIds },
  );
  assert.deepStrictEqual(picked.map((r) => r.id), ["someone-else"]);
});

test("our own service voice never comes back around", () => {
  // The desk posts into #agents under its own nick; the next poll reads it
  // back. Mirroring that would loop the channel and the room into each other.
  const picked = selectRows(
    [
      row({ author: "awdesk", id: "self" }),
      row({ author: "aither-room", id: "self2" }),
      row({ author: "scribe", id: "keep", text: "docs are up" }),
      row({ author: "hydra", id: "marked", text: `${ROOM_MARKER} echoed from the room` }),
    ],
    freshState(),
  );
  assert.deepStrictEqual(picked.map((r) => r.id), ["keep"]);
});

test("system rows are presence, not speech", () => {
  const picked = selectRows([row({ type: "system", id: "sys" }), row({ id: "msg" })], freshState());
  assert.deepStrictEqual(picked.map((r) => r.id), ["msg"]);
});

test("a burst is capped, newest kept", () => {
  const rows = [1, 2, 3, 4, 5].map((n) => row({ at: 1000 + n, id: `m${n}` }));
  const picked = selectRows(rows, freshState());
  assert.deepStrictEqual(picked.map((r) => r.id), ["m3", "m4", "m5"]);
});

test("an agent gets a voice, a human gets only presence", () => {
  // The room stage refuses to voice actor kind `human` — that single field is
  // the whole "never read the owner's words back to him" policy.
  assert.strictEqual(toEvent(row({ agent: true })).actor.kind, "adk_agent");
  assert.strictEqual(toEvent(row({ agent: false, author: "david" })).actor.kind, "human");
});

test("an author keeps one body: the actor id is stable and namespaced", () => {
  const a = toEvent(row({ author: "Demiurge" }));
  const b = toEvent(row({ author: "demiurge", id: "m2", at: 2000 }));
  assert.strictEqual(a.actor.id, b.actor.id);
  assert.strictEqual(a.actor.id, "relay:demiurge");
  assert.strictEqual(a.payload.source, "awrelay");
  assert.strictEqual(a.type, "agent_message");
});

test("the FIRST sight of a channel speaks nothing — it only sets the watermark", async () => {
  // Otherwise every desk start reads the last fifty messages aloud, which is
  // how a feature like this gets switched off on its first day.
  const publisher = fakePublisher();
  const bridge = new RelayRoomBridge({ publisher, statusFile });
  const first = await bridge.mirror("#agents", [row({ at: 5000 })]);
  assert.strictEqual(first.mirrored, 0);
  assert.strictEqual(first.reason, "primed");
  assert.strictEqual(publisher.sent.length, 0);

  const second = await bridge.mirror("#agents", [row({ at: 5000 }), row({ at: 6000, id: "m2" })]);
  assert.strictEqual(second.mirrored, 1);
  assert.strictEqual(publisher.sent[0].payload.text, "landed the fix on develop");
});

test("a channel nobody voices is left to the panel", async () => {
  const publisher = fakePublisher();
  const bridge = new RelayRoomBridge({ publisher, channels: "#agents", statusFile });
  await bridge.mirror("#ops-alerts", [row({ channel: "#ops-alerts" })]);
  const out = await bridge.mirror("#ops-alerts", [row({ channel: "#ops-alerts", at: 9000, id: "x" })]);
  assert.strictEqual(out.reason, "disabled");
  assert.strictEqual(publisher.sent.length, 0);
});

test("a refused publish does NOT advance the watermark — the next tick retries", async () => {
  const publisher = fakePublisher();
  const bridge = new RelayRoomBridge({ publisher, statusFile });
  await bridge.mirror("#agents", []); // prime cold
  publisher.ok = false;
  const failed = await bridge.mirror("#agents", [row({ at: 7000, id: "pending" })]);
  assert.strictEqual(failed.mirrored, 0);
  assert.strictEqual(failed.error, "daemon unreachable");

  publisher.ok = true;
  const retried = await bridge.mirror("#agents", [row({ at: 7000, id: "pending" })]);
  assert.strictEqual(retried.mirrored, 1);
});

test("channels come from config, with or without the hash", () => {
  assert.deepStrictEqual(normaliseChannels("agents, #dev"), ["#agents", "#dev"]);
  assert.deepStrictEqual(normaliseChannels(""), ["#agents"]);
  assert.deepStrictEqual(normaliseChannels(undefined), ["#agents"]);
});

test("the status file is an operator trace, and a test never writes the live one", async () => {
  const publisher = fakePublisher();
  const bridge = new RelayRoomBridge({ publisher, statusFile });
  await bridge.mirror("#agents", []);
  const written = JSON.parse(fs.readFileSync(statusFile, "utf8"));
  assert.deepStrictEqual(written.channels, ["#agents"]);
  assert.strictEqual(written.mirrored, 0);
  assert.ok(written.at, "status carries a timestamp");
  assert.notStrictEqual(bridge.statusFile, require("./relay-room-bridge.cjs").statusPath());
});
