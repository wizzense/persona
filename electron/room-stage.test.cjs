"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_MAX_BODIES,
  MAX_QUEUE,
  MAX_UTTERANCE_CHARS,
  RoomStage,
  VOICES,
  idleSlots,
  pickCharacter,
  readsLikeSpeech,
  selectUtterances,
  shouldVoice,
  slotFor,
  truncateText,
  voiceFor,
} = require("./room-stage.cjs");
const { originOf, stableVoice } = require("./cast-config.cjs");

test("slotFor: the resident speaks from slot0, everyone else from their own slot", () => {
  assert.equal(slotFor("awdesk"), "slot0");
  assert.equal(slotFor("Aither"), "slot0");
  assert.equal(slotFor("atlas"), "room-atlas");
  assert.equal(slotFor("Dr. Demiurge (v2)"), "room-dr-demiurge-v2");
  assert.equal(slotFor(""), "room-agent");
});

test("slotFor: parallel terminal sessions with one name get separate bodies", () => {
  const a = slotFor("AitherOS-Fresh", { actorKind: "claude_code", actorId: "25bb0788-7d30" });
  const b = slotFor("AitherOS-Fresh", { actorKind: "claude_code", actorId: "9f1e44aa-11c2" });
  assert.notEqual(a, b);
  assert.match(a, /^room-aitheros-fresh-25bb$/);
  assert.equal(slotFor("atlas", { actorKind: "adk_agent", actorId: "x" }), "room-atlas");
});

test("voiceFor: resolution.voice wins outright; with none, the ORIGIN-KEY seed hashes onto a real, stable voice", () => {
  assert.equal(voiceFor("claude_code:aaaa", { voice: "onyx" }), "onyx");
  assert.equal(voiceFor("claude_code:aaaa", { voice: "  " }), stableVoice("claude_code:aaaa", VOICES), "blank voice is not a real override");
  const a = voiceFor("claude_code:aaaa", null);
  assert.ok(VOICES.includes(a));
  assert.equal(voiceFor("claude_code:aaaa", null), a, "stable across calls");
  assert.equal(voiceFor("claude_code:aaaa", undefined), a, "no resolution at all still hashes, never throws");
});

test("pickCharacter: deterministic per seed, skips the resident and whatever is already taken (delegates to cast-config.stableCharacter)", () => {
  const roster = ["a", "b", "c", "d"];
  const first = pickCharacter("atlas-seed", roster, { resident: "a" });
  assert.notEqual(first, "a", "never hands out the resident's own character");
  assert.equal(pickCharacter("atlas-seed", roster, { resident: "a" }), first, "stable across calls with the same roster");
  // Another body gets taken: the seed's pick should SKIP it, not collide.
  const second = pickCharacter("atlas-seed", roster, { resident: "a", taken: [first] });
  assert.notEqual(second, first);
  assert.equal(pickCharacter("atlas-seed", roster, { resident: "a", taken: [first] }), second, "stable");
  assert.equal(pickCharacter("solo-seed", ["only"], { resident: "only" }), null, "nothing free to wear");
  // A name is ADDED to the roster. For THIS seed/roster pair "z-unrelated"
  // happens not to outrank the existing pick (verified once, not asserted in
  // general -- rendezvous hashing only makes a move LESS likely, 1-in-(n+1),
  // never impossible for an arbitrary seed; cast-config.test.cjs (U01) is
  // where the general HASH STABILITY property is actually proven). This arm
  // exists to catch a regression to a `sorted[hash % len]` MODULO index
  // (today's old, pre-delegation pickCharacter), which would move almost
  // every seed on a roster growth, not just an occasional rank-loser.
  const grown = pickCharacter("atlas-seed", [...roster, "z-unrelated"], { resident: "a" });
  assert.equal(grown, first, "stable for this seed across a roster growth");
});

test("truncateText: truncates to the given limit with an ellipsis, and falls back to MAX_UTTERANCE_CHARS when maxChars is not usable", () => {
  assert.equal(truncateText("hello", 10), "hello");
  const long = truncateText("x".repeat(100), 10);
  assert.equal(long.length, 10);
  assert.ok(long.endsWith("…"));
  assert.equal(truncateText("x".repeat(400), null).length, MAX_UTTERANCE_CHARS);
  assert.equal(truncateText("x".repeat(400), 0).length, MAX_UTTERANCE_CHARS);
  assert.equal(truncateText("x".repeat(400), -5).length, MAX_UTTERANCE_CHARS);
});

test("shouldVoice: addressed messages always; a transcript line only when it reads like speech (editorial only -- no trust here)", () => {
  assert.equal(shouldVoice({ agent: true, kind: "agent_message", text: "`code` is fine here" }), true);
  assert.equal(shouldVoice({ agent: false, kind: "agent_message", text: "the owner" }), false);
  assert.equal(shouldVoice({ agent: true, kind: "message", text: "Pushed: origin/develop = 7713e4d. Build is on the pulse stage." }), true);
  assert.equal(shouldVoice({ agent: true, kind: "message", text: "`text=True` on Windows turns the stdin into CRLF" }), false);
  assert.equal(shouldVoice({ agent: true, kind: "message", text: "line one\nline two" }), false);
  assert.equal(shouldVoice({ agent: true, kind: "message", text: "x".repeat(300) }), false);
  assert.equal(readsLikeSpeech("a {json} blob"), false);
});

test("selectUtterances: only NEW agent rows with text, oldest first, capped, each carrying its origin", () => {
  const rows = [
    { seq: 10, agent: true, author: "atlas", text: "old" },
    { seq: 12, agent: false, author: "david", text: "the owner is never read back" },
    { seq: 13, agent: true, author: "lyra", text: "" },
    { seq: 15, agent: true, author: "lyra", text: "second" },
    { seq: 14, agent: true, author: "atlas", text: "first" },
  ];
  const picked = selectUtterances(rows, 10);
  assert.deepEqual(picked.map((u) => [u.seq, u.author, u.text]), [[14, "atlas", "first"], [15, "lyra", "second"]]);
  for (const u of picked) {
    assert.ok(u.origin && typeof u.origin.key === "string" && u.origin.key.length > 0);
  }
});

test("selectUtterances: a burst keeps the LAST few (a per-actor maxChars, not this function, does the real truncation now)", () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ seq: i + 1, agent: true, author: "atlas", kind: "agent_message", text: "m" + i }));
  const picked = selectUtterances(rows, 0);
  assert.equal(picked.length, MAX_QUEUE);
  assert.equal(picked[picked.length - 1].seq, 20);
});

test("selectUtterances: a relay-mirrored row carries its channel and a relay origin key", () => {
  const rows = [
    { seq: 5, agent: true, author: "relay-bot", kind: "chat", text: "hi from relay", actorKind: "relay", channel: "#agents", nick: "atlas" },
  ];
  const picked = selectUtterances(rows, 0);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].channel, "#agents");
  assert.equal(picked[0].origin.kind, "relay");
  assert.equal(picked[0].origin.channel, "#agents");
  assert.equal(picked[0].origin.key, "relay:#agents:atlas");
});

test("selectUtterances: falls back to payload.channel when a row has not been flattened", () => {
  const rows = [{ seq: 5, agent: true, author: "relay-bot", kind: "chat", text: "hi", actorKind: "relay", payload: { channel: "#ops" } }];
  const picked = selectUtterances(rows, 0);
  assert.equal(picked[0].channel, "#ops");
});

test("idleSlots: silent slots retire, slot0 never does", () => {
  const seen = { slot0: 0, "room-atlas": 1000, "room-lyra": 9000 };
  assert.deepEqual(idleSlots(seen, 10000, 5000), ["room-atlas"]);
});

// ─── RoomStage integration harness ──────────────────────────────────────────
//
// io.resolve stands in for the real thing (cast-config.resolveActor, wired by
// room-stage-host.cjs / U07). `resolveOverrides` is keyed by ORIGIN KEY first
// (e.g. "claude_code:aaaa1111"), falling back to the bare author name -- most
// arms below only need the second form. Fields left unset behave the way
// cast-config's own built-in tier would (presence "normal", speak/body true).

const ROSTER = ["resident", "bob", "cara", "dee"];
const RESIDENT_CHARACTER = "resident";

function harness({ rows = [], durationMs = 0, resolveOverrides = {} } = {}) {
  const calls = { spawn: [], remove: [], speak: [], evict: [] };
  let clock = 100000;
  const assignedAvatar = { lyra: "cara" };
  let stage; // closed over by buildResolution, assigned once RoomStage exists

  function buildResolution(u) {
    const key = (u.origin && u.origin.key) || `unknown:${u.author}`;
    const override = resolveOverrides[key] || resolveOverrides[u.author] || {};
    const taken = [...stage.slots.values()].map((s) => s.character);
    const character =
      override.character !== undefined
        ? override.character
        : assignedAvatar[u.author] || pickCharacter(key, ROSTER, { taken, resident: RESIDENT_CHARACTER });
    const presence = override.presence || "normal";
    const speak = override.speak !== undefined ? override.speak : true;
    const body = override.body !== undefined ? override.body : true;
    const resolution = {
      key,
      character,
      voice: override.voice !== undefined ? override.voice : null,
      speed: override.speed !== undefined ? override.speed : null,
      maxChars: override.maxChars !== undefined ? override.maxChars : null,
      place: override.place !== undefined ? override.place : null,
      presence,
      speak,
      body,
      cooldownSeconds: presence === "chatty" ? 0 : override.cooldownSeconds !== undefined ? override.cooldownSeconds : null,
      dropped: presence === "off",
      bodied: presence !== "off" && body !== false,
      voiced: true,
      voicedReason: null,
    };
    if (speak === false) {
      resolution.voiced = false;
      resolution.voicedReason = "speak=false";
    } else if (presence === "off") {
      resolution.voiced = false;
      resolution.voicedReason = "presence=off";
    } else if (presence === "quiet") {
      resolution.voiced = false;
      resolution.voicedReason = "presence=quiet";
    }
    return resolution;
  }

  const io = {
    recentChat: async () => rows.splice(0),
    resolve: (u) => buildResolution(u),
    spawn: (slotId, character, agent, place) => {
      calls.spawn.push([slotId, character, agent, place]);
      return true;
    },
    remove: (slotId) => {
      calls.remove.push(slotId);
      return true;
    },
    speak: async (text, voice, slotId, speed) => {
      calls.speak.push([text, voice, slotId, speed]);
      return { ok: true, durationMs };
    },
    onEvict: (slotId) => {
      calls.evict.push(slotId);
    },
  };
  stage = new RoomStage(io, { idleMs: 5000, gapMs: 0, cooldownMs: 1000, maxBodies: 2, now: () => clock });
  /** Resolve once `calls.speak` holds `n` utterances, or fail loudly after 3 s. */
  const drained = async (n) => {
    const deadline = Date.now() + 3000;
    while (calls.speak.length < n) {
      if (Date.now() > deadline) throw new Error(`only ${calls.speak.length}/${n} utterances spoken after 3 s`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return {
    stage,
    calls,
    io,
    drained,
    tick: (ms) => {
      clock += ms;
    },
  };
}

test("RoomStage: the first look primes the watermark and reads nothing aloud", async () => {
  const h = harness({ rows: [{ seq: 5, agent: true, author: "atlas", text: "history" }] });
  await h.stage.tick();
  assert.equal(h.stage.lastSeq, 5);
  assert.deepEqual(h.calls.speak, []);
  assert.deepEqual(h.calls.spawn, []);
  assert.equal(h.stage.status().primed, true);
  assert.equal(h.stage.status().polls, 1);
});

test("RoomStage: a new agent gets a body, speaks in its voice, and the resident uses slot0", async () => {
  const h = harness({ resolveOverrides: { atlas: { voice: "onyx" }, lyra: { voice: "shimmer" }, awdesk: { voice: "nova" } } });
  await h.stage.tick();
  h.io.recentChat = async () => [
    { seq: 6, agent: true, author: "atlas", actorKind: "adk_agent", actorId: "a1", kind: "agent_message", text: "hello" },
    { seq: 7, agent: true, author: "lyra", actorKind: "adk_agent", actorId: "l1", kind: "agent_message", text: "hi" },
    { seq: 8, agent: true, author: "awdesk", kind: "agent_message", text: "done" },
  ];
  await h.stage.tick();
  // Wait for the QUEUE to drain, not for a fixed 50 ms: node --test runs every
  // file as a parallel child process, and under that contention the third
  // utterance landed after the sleep -- green alone, red in the full run
  // (measured 2026-09-19 in the publish worktree: 437/1, the same file 30/0 by
  // itself three times). A deadline keeps a real hang visible.
  await h.drained(3);
  assert.deepEqual(h.calls.spawn.map((c) => [c[0], c[2]]), [["room-atlas", "atlas"], ["room-lyra", "lyra"]]);
  assert.equal(h.calls.spawn[1][1], "cara", "an assignedAvatar-style resolution is honoured");
  assert.notEqual(h.calls.spawn[0][1], RESIDENT_CHARACTER);
  assert.deepEqual(h.calls.speak.map((c) => [c[0], c[1], c[2]]), [
    ["hello", "onyx", "room-atlas"],
    ["hi", "shimmer", "room-lyra"],
    ["done", "nova", "slot0"],
  ]);
  assert.equal(h.stage.status().spoken, 3);
});

test("RoomStage: utterances are serialised — one at a time, in order", async () => {
  const h = harness({ durationMs: 30 });
  await h.stage.tick();
  const order = [];
  h.io.speak = async (text) => {
    order.push("start " + text);
    await new Promise((r) => setTimeout(r, 10));
    order.push("end " + text);
    return { ok: true, durationMs: 0 };
  };
  h.io.recentChat = async () => [
    { seq: 6, agent: true, author: "atlas", actorKind: "adk_agent", actorId: "a1", kind: "agent_message", text: "a" },
    { seq: 7, agent: true, author: "atlas", actorKind: "adk_agent", actorId: "a1", kind: "agent_message", text: "b" },
  ];
  await h.stage.tick();
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(order, ["start a", "end a", "start b", "end b"]);
});

test("RoomStage: a silent agent leaves the stage via the idle sweep (built on evict)", async () => {
  const h = harness();
  await h.stage.tick();
  h.io.recentChat = async () => [{ seq: 6, agent: true, author: "atlas", actorKind: "adk_agent", actorId: "a1", kind: "agent_message", text: "hello" }];
  await h.stage.tick();
  h.io.recentChat = async () => [];
  h.tick(6000);
  await h.stage.tick();
  assert.deepEqual(h.calls.remove, ["room-atlas"]);
  assert.deepEqual(h.calls.evict, ["room-atlas"]);
  assert.equal(h.stage.status().onStage.length, 0);
});

test("RoomStage: a speak failure is classified separately and outlives a later, different error class", async () => {
  const h = harness();
  await h.stage.tick();
  h.io.speak = async () => ({ ok: false, reason: "voice down" });
  h.io.recentChat = async () => [{ seq: 6, agent: true, author: "atlas", actorKind: "adk_agent", actorId: "a1", kind: "agent_message", text: "hello" }];
  await h.stage.tick();
  await new Promise((r) => setTimeout(r, 30));
  let status = h.stage.status();
  assert.equal(status.speakFailures, 1);
  assert.equal(status.lastSpeakError, "voice down");
  assert.equal(status.lastErrorClass, "speak-failed");

  // A DIFFERENT error class fires next (stage full, forced by hand); today's
  // single shared lastError would make "voice down" unrecoverable -- the
  // classified fields must not. Voice service recovers first, so THIS row's
  // failure is purely the stage-full one, not another speak failure.
  h.io.speak = async (text, voice, slotId, speed) => {
    h.calls.speak.push([text, voice, slotId, speed]);
    return { ok: true, durationMs: 0 };
  };
  h.stage.slots.set("room-lyra", { agent: "lyra", character: "cara", actorId: "", actorKind: "" });
  h.stage.maxBodies = 1;
  h.io.recentChat = async () => [{ seq: 7, agent: true, author: "hydra", actorKind: "adk_agent", actorId: "h1", kind: "agent_message", text: "hi" }];
  await h.stage.tick();
  await new Promise((r) => setTimeout(r, 30));
  status = h.stage.status();
  assert.equal(status.lastErrorClass, "stage-full");
  assert.equal(status.speakFailures, 1, "unchanged by the unrelated stage-full error");
  assert.equal(status.lastSpeakError, "voice down", "still visible even though lastError/lastErrorClass moved on");
});

test("RoomStage: two claude_code sessions of ONE author get DIFFERENT voices — the seed is the origin key, not the bare author", async () => {
  // Fails against a voiceFor(author, overrides) that keys on the author
  // alone: both rows below share author "AitherOS-Fresh" and would collapse
  // onto one voice.
  const h = harness({
    resolveOverrides: {
      "claude_code:aaaa1111": { character: "bob" },
      "claude_code:bbbb2222": { character: "cara" },
    },
  });
  await h.stage.tick();
  h.io.recentChat = async () => [
    { seq: 6, agent: true, author: "AitherOS-Fresh", actorKind: "claude_code", actorId: "aaaa1111", kind: "agent_message", text: "one" },
    { seq: 7, agent: true, author: "AitherOS-Fresh", actorKind: "claude_code", actorId: "bbbb2222", kind: "agent_message", text: "two" },
  ];
  await h.stage.tick();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.calls.spawn.length, 2, "two bodies for two sessions");
  assert.notEqual(h.calls.spawn[0][0], h.calls.spawn[1][0], "different slots");
  const voiceA = h.calls.speak.find((c) => c[2] === h.calls.spawn[0][0])[1];
  const voiceB = h.calls.speak.find((c) => c[2] === h.calls.spawn[1][0])[1];
  assert.equal(voiceA, stableVoice("claude_code:aaaa1111", VOICES));
  assert.equal(voiceB, stableVoice("claude_code:bbbb2222", VOICES));
  assert.notEqual(voiceA, voiceB, "these two origin keys hash to different voices");
});

test("RoomStage: presence off is dropped entirely; quiet gets a body but is never voiced; speak:false keeps the body and mutes", async () => {
  const h = harness({
    resolveOverrides: {
      ghost: { presence: "off", character: "bob" },
      whisper: { presence: "quiet", character: "cara" },
      muted: { character: "dee", speak: false },
    },
  });
  await h.stage.tick();
  h.io.recentChat = async () => [
    { seq: 6, agent: true, author: "ghost", kind: "agent_message", text: "should never be heard" },
    { seq: 7, agent: true, author: "whisper", kind: "agent_message", text: "silent body" },
    { seq: 8, agent: true, author: "muted", kind: "agent_message", text: "hard mute" },
  ];
  await h.stage.tick();
  await new Promise((r) => setTimeout(r, 30));

  assert.deepEqual(h.calls.spawn.map((c) => c[2]), ["whisper", "muted"], "presence:off never spawns; quiet and speak:false both get a body");
  assert.deepEqual(h.calls.speak, [], "none of the three is ever heard");
  assert.equal(h.stage.status().trust.refused, 3);
  assert.equal(h.stage.status().onStage.length, 2, "the ghost never took a slot; whisper and muted still hold theirs");
});

test("RoomStage: chatty presence forces cooldown 0 — two rows inside one cooldown window are BOTH voiced", async () => {
  const h = harness({ resolveOverrides: { chatterbox: { presence: "chatty", character: "bob" } } });
  await h.stage.tick();
  h.io.recentChat = async () => [
    { seq: 6, agent: true, author: "chatterbox", kind: "message", text: "one" },
    { seq: 7, agent: true, author: "chatterbox", kind: "message", text: "two" },
  ];
  await h.stage.tick();
  await new Promise((r) => setTimeout(r, 30));
  // Fails against the room-wide 1000ms cooldown this harness otherwise uses:
  // the second line would be dropped as within-cooldown.
  assert.deepEqual(h.calls.speak.map((c) => c[0]), ["one", "two"]);
});

test("RoomStage: a chatty transcript is heard once per (non-zero) cooldown; addressed lines are never dropped", async () => {
  const h = harness();
  await h.stage.tick();
  h.io.recentChat = async () => [
    { seq: 6, agent: true, author: "AitherOS-Fresh", actorKind: "adk_agent", actorId: "s1", kind: "message", text: "Pushed one." },
    { seq: 7, agent: true, author: "AitherOS-Fresh", actorKind: "adk_agent", actorId: "s1", kind: "message", text: "Pushed two." },
    { seq: 8, agent: true, author: "AitherOS-Fresh", actorKind: "adk_agent", actorId: "s1", kind: "agent_message", text: "Atlas, your turn." },
  ];
  await h.stage.tick();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(h.calls.speak.map((c) => c[0]), ["Pushed one.", "Atlas, your turn."]);
  h.tick(1500);
  h.io.recentChat = async () => [{ seq: 9, agent: true, author: "AitherOS-Fresh", actorKind: "adk_agent", actorId: "s1", kind: "message", text: "Pushed three." }];
  await h.stage.tick();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.calls.speak[h.calls.speak.length - 1][0], "Pushed three.");
});

test("RoomStage: body:false always collapses to slot0 with NO ventriloquised wrapper — an authored choice, not a shortfall", async () => {
  const h = harness({ resolveOverrides: { narrator: { character: "bob", body: false } } });
  await h.stage.tick();
  h.io.recentChat = async () => [{ seq: 6, agent: true, author: "narrator", actorKind: "adk_agent", actorId: "n1", kind: "agent_message", text: "just words" }];
  await h.stage.tick();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(h.calls.spawn, [], "no body is spawned for an authored ventriloquist");
  assert.equal(h.calls.speak.length, 1);
  assert.equal(h.calls.speak[0][2], "slot0");
  assert.equal(h.calls.speak[0][0], "just words", "no \"X says:\" wrapper -- that is reserved for the accidental stage-full path");
});

test("RoomStage: past the body cap a newcomer is heard through the resident, not given a body, and lastError is classified stage-full", async () => {
  const h = harness();
  await h.stage.tick();
  h.io.recentChat = async () => [
    { seq: 6, agent: true, author: "atlas", actorKind: "adk_agent", actorId: "a1", kind: "agent_message", text: "one" },
    { seq: 7, agent: true, author: "lyra", actorKind: "adk_agent", actorId: "l1", kind: "agent_message", text: "two" },
    { seq: 8, agent: true, author: "hydra", actorKind: "adk_agent", actorId: "h1", kind: "agent_message", text: "three" },
  ];
  await h.stage.tick();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(h.calls.spawn.length, 2, "only two bodies");
  const last = h.calls.speak[h.calls.speak.length - 1];
  assert.equal(last[2], "slot0");
  assert.equal(last[0], "hydra says: three");
  assert.match(h.stage.status().lastError, /stage full/);
  assert.equal(h.stage.status().lastErrorClass, "stage-full");
});

test("RoomStage.enqueue: the stage-full slot0 collapse keeps the utterance's OWN origin, never slot0's", () => {
  const h = harness();
  // Fill the stage to capacity directly -- this is a whitebox test of
  // enqueue() alone, so drain() never runs and h.stage.queue is inspectable.
  h.stage.slots.set("room-atlas", { agent: "atlas", character: "bob", actorId: "", actorKind: "" });
  h.stage.slots.set("room-lyra", { agent: "lyra", character: "cara", actorId: "", actorKind: "" });
  const origin = originOf({ kind: "adk_agent", id: "hydra-1" });
  h.stage.enqueue({
    seq: 1,
    author: "hydra",
    actorId: "hydra-1",
    actorKind: "adk_agent",
    channel: "",
    nick: "",
    text: "three",
    kind: "agent_message",
    origin,
  });
  assert.equal(h.stage.queue.length, 1);
  assert.equal(h.stage.queue[0].slotId, "slot0");
  assert.equal(h.stage.queue[0].text, "hydra says: three");
  assert.deepEqual(h.stage.queue[0].origin, origin, "the queued utterance keeps hydra's own origin");
  assert.notEqual(h.stage.queue[0].origin.key, "service:awdesk", "not laundered into the resident's own identity");
});

test("RoomStage.evict: frees a slot immediately (before the idle sweep) so the same author can be re-staged, and fires io.onEvict", async () => {
  const h = harness();
  await h.stage.tick();
  h.io.recentChat = async () => [{ seq: 6, agent: true, author: "atlas", actorKind: "adk_agent", actorId: "a1", kind: "agent_message", text: "hello" }];
  await h.stage.tick();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.calls.spawn.length, 1);
  const slotId = h.stage.status().onStage[0].slotId;

  // Hand-removed (e.g. the tray), NOT the idle sweep -- no time has passed
  // (idleMs is 5000ms).
  const evicted = h.stage.evict(slotId);
  assert.equal(evicted, true);
  assert.equal(h.stage.status().onStage.length, 0, "gone immediately, not after idleMs");
  assert.deepEqual(h.calls.remove, [slotId]);
  assert.deepEqual(h.calls.evict, [slotId]);
  assert.equal(h.stage.evict("no-such-slot"), false, "evicting an unknown slot is a safe no-op");

  // The SAME author can be re-staged right away. Fails today: a dead slot
  // stays counted in this.slots and mutes the author until the idle sweep.
  h.io.recentChat = async () => [{ seq: 7, agent: true, author: "atlas", actorKind: "adk_agent", actorId: "a1", kind: "agent_message", text: "back" }];
  await h.stage.tick();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.calls.spawn.length, 2, "re-staged without waiting for idleMs");
});

test("RoomStage.status: onStage rows carry actorId/actorKind, addressFor round-trips, and the observability fields are live", async () => {
  const h = harness();
  await h.stage.tick();
  h.io.recentChat = async () => [{ seq: 6, agent: true, author: "atlas", actorKind: "adk_agent", actorId: "atlas-1", kind: "agent_message", text: "hi" }];
  await h.stage.tick();
  await new Promise((r) => setTimeout(r, 30));
  const status = h.stage.status();
  assert.equal(status.polls, 2);
  assert.equal(status.primed, true);
  assert.equal(typeof status.lastPollAt, "number");
  assert.equal(typeof status.lastSpokenAt, "number");
  assert.equal(status.speakFailures, 0);
  assert.equal(status.lastSpeakError, null);
  assert.deepEqual(status.castProblems, []);
  assert.equal(status.castError, null);
  assert.equal(status.trust.mode, "builtin", "no config was ever set");

  const row = status.onStage[0];
  assert.equal(row.actorId, "atlas-1");
  assert.equal(row.actorKind, "adk_agent");
  assert.deepEqual(h.stage.addressFor(row.slotId), { actorId: "atlas-1", actorKind: "adk_agent" });
  assert.equal(h.stage.addressFor("no-such-slot"), null);
  assert.deepEqual(status.seats, { atlas: 1 });
});

test("RoomStage.setConfig: accepts the load()/watch() {snapshot,problems,error} shape and surfaces it on status()", () => {
  const h = harness();
  h.stage.setConfig({
    snapshot: { meta: { path: "/tmp/cast.json", source: "file" }, actors: { "a:1": {} }, authors: { atlas: {} } },
    problems: [{ path: "defaults.speed", value: 9, reason: "outside 0.25..4" }],
    error: null,
  });
  let status = h.stage.status();
  assert.equal(status.castPath, "/tmp/cast.json");
  assert.equal(status.trust.mode, "file");
  assert.equal(status.trust.origins, 2);
  assert.deepEqual(status.castProblems, [{ path: "defaults.speed", value: 9, reason: "outside 0.25..4" }]);

  // A bare snapshot (no {snapshot,...} wrapper) is accepted too.
  h.stage.setConfig({ meta: { path: "/tmp/cast2.json", source: "last-good" }, actors: {}, authors: {} });
  status = h.stage.status();
  assert.equal(status.castPath, "/tmp/cast2.json");
  assert.equal(status.trust.mode, "last-good");

  h.stage.setConfig(null);
  status = h.stage.status();
  assert.equal(status.castPath, null);
  assert.equal(status.trust.mode, "builtin");
});

test("RoomStage: a per-actor maxChars truncates instead of the global default", async () => {
  const h = harness({ resolveOverrides: { verbose: { character: "bob", maxChars: 50 } } });
  await h.stage.tick();
  h.io.recentChat = async () => [{ seq: 6, agent: true, author: "verbose", actorKind: "adk_agent", actorId: "v1", kind: "agent_message", text: "x".repeat(300) }];
  await h.stage.tick();
  await new Promise((r) => setTimeout(r, 30));
  const spoken = h.calls.speak[0][0];
  assert.equal(spoken.length, 50);
  assert.ok(spoken.endsWith("…"));
});

test("RoomStage: without a configured maxChars, truncation falls back to MAX_UTTERANCE_CHARS (fails if it used the per-actor default of 2000)", async () => {
  const h = harness();
  await h.stage.tick();
  h.io.recentChat = async () => [{ seq: 6, agent: true, author: "atlas", actorKind: "adk_agent", actorId: "a1", kind: "agent_message", text: "y".repeat(400) }];
  await h.stage.tick();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.calls.speak[0][0].length, MAX_UTTERANCE_CHARS);
});

test("RoomStage: speed is threaded from the resolution through to io.speak", async () => {
  const h = harness({ resolveOverrides: { atlas: { character: "bob", speed: 1.8 } } });
  await h.stage.tick();
  h.io.recentChat = async () => [{ seq: 6, agent: true, author: "atlas", actorKind: "adk_agent", actorId: "a1", kind: "agent_message", text: "hi" }];
  await h.stage.tick();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.calls.speak[0][3], 1.8);
});

test("DEFAULT_MAX_BODIES stays at 3 (the measured 2.36GB heap ceiling) unless a test overrides maxBodies explicitly", () => {
  assert.equal(DEFAULT_MAX_BODIES, 3);
});

// Owner, 2026-09-19: the bubble said "AitherOS-Fresh says:" -- a CHECKOUT, with
// nothing about which session or what it was doing. The unbodied wrapper is the
// only place an unbodied speaker is seen, so it carries the topic when the
// producer supplies one, and stays exactly as it was when it does not.
// Owner, 2026-09-19: the bubble said "AitherOS-Fresh says:" -- a CHECKOUT, with
// nothing about which session or what it was doing. The unbodied wrapper is the
// only place an unbodied speaker is seen, so it carries the topic when the
// producer supplies one, and stays exactly as it was when it does not.
test("the ventriloquised wrapper names the speaker's work when known", () => {
  const stage = new RoomStage({
    io: {
      spawn: () => false, // no body available: every line is ventriloquised
      speak: () => true,
      resolve: () => ({ character: "x", voiced: true, body: true, cooldownSeconds: 0 }),
    },
    now: () => 1000,
  });
  stage.enqueue({ seq: 1, author: "AitherOS-Fresh#6313fc71", title: "rebuild the gateway",
                  text: "done", kind: "agent_message", actorId: "6313fc71", actorKind: "claude_code" });
  stage.enqueue({ seq: 2, author: "AitherOS-Fresh#77db6255", title: "",
                  text: "also done", kind: "agent_message", actorId: "77db6255", actorKind: "claude_code" });
  const texts = stage.queue.map((q) => q.text);
  assert.equal(texts[0], "AitherOS-Fresh#6313fc71 (rebuild the gateway) says: done");
  assert.equal(texts[1], "AitherOS-Fresh#77db6255 says: also done",
    "an absent topic must not render as \"()\" or \"undefined\"");
});
