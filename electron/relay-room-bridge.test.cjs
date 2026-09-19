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
  MAX_TEXT,
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

test("MAX_TEXT bounds a single row too — 3 rows x 320 chars is the real ceiling, not one line", () => {
  // A 500-char relay row is a paragraph: the room-stage BODY says a sentence,
  // the panel keeps the whole text (module header, MAX_TEXT comment).
  assert.equal(MAX_TEXT, 320);
  const long = "x".repeat(500);
  const picked = selectRows([row({ text: long, id: "long" })], freshState());
  assert.equal(picked[0].text.length, 320);
  assert.equal(picked[0].text, long.slice(0, 320));
});

test("an agent gets a voice ONLY once the channel policy grants it — the relay's agent flag alone never does", () => {
  // Rule 6: MIRRORING GRANTS NOTHING. toEvent's `granted` comes from the
  // `voiceable` selectRows already computed against cast.json, never from
  // row.agent by itself — /v1/agent/join puts the OWNER's own nick in the
  // trusted set, so agent===true on #agents for the owner's own messages too.
  // A row with no policy attached (as a caller who skipped selectRows would
  // pass) must land as `human`: presence, never a voice.
  assert.strictEqual(toEvent(row({ agent: true })).actor.kind, "human",
    "agent:true with no explicit grant must NOT be voiced");
  assert.strictEqual(toEvent(row({ agent: true }), { voiceable: true }).actor.kind, "adk_agent",
    "an explicit grant (from selectRows' policy gate) is what actually voices a row");
  assert.strictEqual(toEvent(row({ agent: false, author: "david" }), { voiceable: true }).actor.kind, "human",
    "the room stage refuses to voice actor kind `human` regardless of the channel grant");
});

test("an author keeps one body: the actor id is stable and namespaced", () => {
  const a = toEvent(row({ author: "Demiurge" }));
  const b = toEvent(row({ author: "demiurge", id: "m2", at: 2000 }));
  assert.strictEqual(a.actor.id, b.actor.id);
  assert.strictEqual(a.actor.id, "relay:demiurge");
  assert.strictEqual(a.payload.source, "awrelay");
  assert.strictEqual(a.type, "agent_message");
});

test("toEvent always stamps payload.channel — the polled channel wins, never the row's own", () => {
  // The origin key the cast resolver derives (`relay:<channel>[:<nick>]`) is
  // keyed on payload.channel. It must be present even when the row carries no
  // channel field, and the CALLER's channel (what we actually polled) must
  // win over a channel value that arrived inside a payload the poster
  // influences — a key read out of that field is a grant list you do not
  // control (module header, "WHAT IS LOCALLY STAMPED").
  const noChannelOnRow = toEvent(row({ channel: undefined }), { channel: "#agents" });
  assert.strictEqual(noChannelOnRow.payload.channel, "#agents");
  const rowClaimsAnother = toEvent(row({ channel: "#spoofed" }), { channel: "#agents" });
  assert.strictEqual(rowClaimsAnother.payload.channel, "#agents",
    "the polled channel wins over whatever the row itself claims");
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

test("a channel with no grant yields rows for presence/history, and none marked voiceable", () => {
  // Rule 6 / the DEFAULT_CHANNEL_POLICY: mirroring is not a privilege escalation.
  // selectRows' default policy (no cast.json entry) is {voiced:false}, so the
  // rows still travel — the body and the panel need them — but each is
  // stamped voiceable:false, which is what keeps them off the speakers.
  const rows = [row({ agent: true, id: "a" }), row({ agent: true, id: "b", at: 1100 })];
  const picked = selectRows(rows, freshState());
  assert.strictEqual(picked.length, 2, "presence/history still get the rows");
  assert.ok(picked.every((r) => r.voiceable === false), "none are marked voiceable");
  assert.ok(picked.every((r) => toEvent(r, { channel: "#agents" }).actor.kind === "human"),
    "and toEvent, fed that flag honestly, never grants a voice");
});

test("presence:'off' takes no part in the room, and does not re-queue the same rows every tick", async () => {
  // The policy gate refuses in selectRows, EARLY — that placement is the
  // point (selectRows' own docstring): a gate applied only at publish time
  // would leave the watermark unmoved and re-select the same ungranted rows
  // on every 2 s poll forever.
  const publisher = fakePublisher();
  const bridge = new RelayRoomBridge({
    publisher,
    statusFile,
    channelPolicy: () => ({ voiced: false, presence: "off" }),
  });
  await bridge.mirror("#agents", []); // prime cold
  const first = await bridge.mirror("#agents", [row({ at: 7000, id: "silenced" })]);
  assert.strictEqual(first.mirrored, 0);
  assert.strictEqual(publisher.sent.length, 0);
  // The SAME row, offered again on the next tick, is not attempted a second
  // time: the watermark already moved past it, unlike the daemon-refusal case
  // above where the row stays pending.
  const second = await bridge.mirror("#agents", [row({ at: 7000, id: "silenced" })]);
  assert.strictEqual(second.skipped, 1, "handled, not re-queued as pending");
  assert.strictEqual(publisher.sent.length, 0);
});

test("publishOut stamps ROOM_MARKER on the way out, and records the id so the round trip is recognised", async () => {
  const bridge = new RelayRoomBridge({ publisher: fakePublisher(), statusFile });
  const posted = [];
  const fakePost = async (channel, text) => {
    posted.push({ channel, text });
    return { ok: true, detail: "", id: "out-1" };
  };
  const verdict = await bridge.publishOut("#agents", "the fix landed", { post: fakePost });
  assert.strictEqual(verdict.ok, true);
  assert.strictEqual(posted[0].text, `${ROOM_MARKER} the fix landed`);
  assert.ok(bridge.ours.has("out-1"),
    "the id the relay returned is recorded so mirror() recognises the round trip");
  // AND the marker itself is what protects a bridge that never learns the id
  // (a relay that answers 2xx with no parseable body): selectRows drops it.
  const picked = selectRows(
    [row({ id: "z", text: `${ROOM_MARKER} the fix landed` })],
    freshState(),
  );
  assert.deepStrictEqual(picked, [], "a marked row is skipped inbound even with no id to match");
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
