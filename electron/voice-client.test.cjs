"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { voiceSnapshot, listVoices, synthesize } = require("./voice-client.cjs");

function fakeCall(calls) {
  return async (name, args) => {
    calls.push({ name, args });
    if (name === "get_voice_status") {
      return JSON.stringify({ service: "aither-voice", healthy: true });
    }
    if (name === "get_available_voices") {
      return JSON.stringify({ voices: [{ id: "v1", name: "Aither" }] });
    }
    throw new Error(`unexpected tool ${name}`);
  };
}

test("voiceSnapshot aggregates status and voices", async () => {
  const calls = [];
  const snap = await voiceSnapshot(fakeCall(calls));
  assert.equal(snap.ok, true);
  assert.equal(snap.status.service, "aither-voice");
  assert.equal(snap.voices.voices.length, 1);
  assert.ok(snap.at > 0);
  assert.deepEqual(
    calls.map((c) => c.name),
    ["get_voice_status", "get_available_voices"],
  );
});

test("a failing source degrades to an ERROR note, not a failed snapshot", async () => {
  const snap = await voiceSnapshot(async (name) => {
    if (name === "get_voice_status") throw new Error("voice down");
    return JSON.stringify({ voices: [] });
  });
  assert.equal(snap.ok, true, "the snapshot survives one dead source");
  assert.match(snap.status.note, /voice down/);
});

test("a dead transport degrades every source to an ERROR note", async () => {
  const snap = await voiceSnapshot(async () => {
    throw new Error("no session bearer");
  });
  assert.equal(snap.ok, true);
  assert.match(snap.status.note, /no session bearer/);
  assert.match(snap.voices.note, /no session bearer/);
});

test("synthesize forwards text and optional voice", async () => {
  const calls = [];
  const result = await synthesize("hello", "v1", async (name, args) => {
    calls.push({ name, args });
    return JSON.stringify({ audio: "/data/audio/out.wav" });
  });
  assert.equal(result.audio, "/data/audio/out.wav");
  assert.deepEqual(calls[0], { name: "synthesize_speech", args: { text: "hello", voice: "v1" } });
});

test("listVoices parses prose-free json, falls back to a note", async () => {
  const ok = await listVoices(async () => JSON.stringify(["a", "b"]));
  assert.deepEqual(ok, ["a", "b"]);
  const prose = await listVoices(async () => "not json at all");
  assert.equal(typeof prose.note, "string");
});
