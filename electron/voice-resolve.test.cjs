"use strict";

/**
 * voice-resolve tests — the ONE audibility gate, against real cast.json
 * fixtures (cast-config.cjs and its own resolveActor precedence are already
 * proven in cast-config.test.cjs; this file proves the GATE built on top of
 * it: which origins get in, which get refused with which reason, and which
 * get noted as seen-but-silent).
 *
 * Every call here takes `file` directly (a per-test tmpdir fixture), same
 * reasoning as cast-config.test.cjs's own header: `node --test` runs test
 * FILES as parallel child processes, and DESK_CAST_FILE would otherwise be
 * one shared env var raced by every test() in this file.
 *
 *   node electron/voice-resolve.test.cjs
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { resolveSpeech } = require("./voice-resolve.cjs");
const cast = require("./cast-config.cjs");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "desk-voice-resolve-"));
}

function castFileIn(dir) {
  return path.join(dir, "cast.json");
}

function writeCast(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function readSeen(file) {
  return cast.readSeen({ file: cast.SEEN_FILE(file) });
}

// ─── unknown origins ─────────────────────────────────────────────────────────

test("resolveSpeech: an unconfigured relay channel is refused (channels default voiced:false) and recorded to cast-seen.json", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  // No cast.json at all -- the file has never been authored, which is the
  // real first-run state this arm exercises.
  const gate = resolveSpeech({ origin: "relay:#random", slotId: "slot1", text: "hello from #random", file });

  assert.equal(gate.allowed, false);
  assert.match(gate.reason, /not voiced/);

  const seen = readSeen(file);
  assert.ok(seen["relay:#random"], "an unknown relay origin must land in cast-seen.json");
  assert.equal(seen["relay:#random"].count, 1);
  assert.equal(seen["relay:#random"].sample, "hello from #random");
});

test("resolveSpeech: noteSeen accumulates on repeat sightings of the same unknown origin", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  resolveSpeech({ origin: "relay:#random", text: "first", file });
  resolveSpeech({ origin: "relay:#random", text: "second", file });
  const seen = readSeen(file);
  assert.equal(seen["relay:#random"].count, 2);
  assert.equal(seen["relay:#random"].sample, "second", "the LATEST sample wins");
});

test("resolveSpeech: a room actor with no cast.json entry is allowed by default (defaults.presence=normal) and does NOT get muted like an unconfigured relay", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  const gate = resolveSpeech({ origin: "claude_code:7f3a", text: "hi", file });
  assert.equal(gate.allowed, true, JSON.stringify(gate));
});

test("resolveSpeech: a KNOWN origin (an authored actors[] row) is never re-noted as seen", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  writeCast(file, { version: 1, actors: { "bridge:/speak": { voice: "echo" } } });
  resolveSpeech({ origin: "bridge:/speak", text: "hi", file });
  const seen = readSeen(file);
  assert.equal(seen["bridge:/speak"], undefined, "a configured origin is not \"seen but silent\"");
});

// ─── granted origins ─────────────────────────────────────────────────────────

test("resolveSpeech: a granted origin returns its authored voice/speed with provenance naming the actors[] row", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  writeCast(file, { version: 1, actors: { "mcp:speak": { voice: "echo", speed: 1.8 } } });
  const gate = resolveSpeech({ origin: "mcp:speak", slotId: "slot0", text: "hi", file });

  assert.equal(gate.allowed, true);
  assert.equal(gate.voice, "echo");
  assert.equal(gate.speed, 1.8);
  assert.match(gate.provenance.voiceFrom, /^actors\[/);
  assert.match(gate.provenance.speedFrom, /^actors\[/);
  assert.equal(gate.provenance.slotId, "slot0");
});

test("resolveSpeech: a relay nick's own colon-bearing key round-trips through the actors[] row minted for it", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  // Same key shape room-stage mints via originOf({kind:"relay", channel, nick}).
  // A per-nick voice preference alone does not make a mirrored channel
  // audible (channels default voiced:false on purpose -- "mirroring grants
  // nothing"), so the channel is granted too; this arm's job is proving the
  // KEY round-trips to the actors["relay:#agents:bob"] row at all, which
  // originOf({key: origin}) alone would get wrong (see originFromKey's doc).
  writeCast(file, {
    version: 1,
    channels: { "#agents": { voiced: true } },
    actors: { "relay:#agents:bob": { voice: "shimmer" } },
  });
  const gate = resolveSpeech({ origin: "relay:#agents:bob", text: "hi", file });
  assert.equal(gate.allowed, true, JSON.stringify(gate));
  assert.equal(gate.voice, "shimmer");
  assert.match(gate.provenance.voiceFrom, /^actors\[/, "must match the exact nick row, not a mangled key");
});

test("resolveSpeech: an unvoiced channel refuses a relay nick even when the nick has its own voice preference", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  writeCast(file, { version: 1, actors: { "relay:#agents:bob": { voice: "shimmer" } } });
  const gate = resolveSpeech({ origin: "relay:#agents:bob", text: "hi", file });
  assert.equal(gate.allowed, false, "mirroring grants nothing until the channel itself is voiced");
  assert.match(gate.reason, /not voiced/);
});

// ─── distinct refusals ───────────────────────────────────────────────────────

test("resolveSpeech: presence:\"quiet\" and speak:false both refuse, with DISTINCT reasons", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  writeCast(file, {
    version: 1,
    actors: {
      "mcp:speak": { presence: "quiet" },
      "desk:drop": { speak: false },
    },
  });
  const quiet = resolveSpeech({ origin: "mcp:speak", text: "hi", file });
  const muted = resolveSpeech({ origin: "desk:drop", text: "hi", file });

  assert.equal(quiet.allowed, false);
  assert.match(quiet.reason, /presence=quiet/);
  assert.equal(muted.allowed, false);
  assert.match(muted.reason, /speak=false/);
  assert.notEqual(quiet.reason, muted.reason);
});

test("resolveSpeech: presence:\"off\" refuses with its own reason too", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  writeCast(file, { version: 1, actors: { "bridge:/speak": { presence: "off" } } });
  const gate = resolveSpeech({ origin: "bridge:/speak", text: "hi", file });
  assert.equal(gate.allowed, false);
  assert.match(gate.reason, /presence=off/);
});

// ─── malformed file ──────────────────────────────────────────────────────────

test("resolveSpeech: a malformed cast file falls to the LAST-GOOD snapshot, not a wider default", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  writeCast(file, { version: 1, actors: { "mcp:speak": { speak: false } } });

  // Prime the cache AND cast-config's own last-good memo with the good file.
  const before = resolveSpeech({ origin: "mcp:speak", text: "hi", file });
  assert.equal(before.allowed, false);

  // Corrupt it -- bump mtime so this module's own cache re-reads instead of
  // serving a stale-but-still-good entry.
  fs.writeFileSync(file, "{ not json", "utf8");
  const after = resolveSpeech({ origin: "mcp:speak", text: "hi", file });

  // A malformed file must NOT read as "nothing configured" (which would
  // silently un-mute mcp:speak) -- it must keep yesterday's verdict.
  assert.equal(after.allowed, false, "a bad byte must not widen to the permissive default");
  assert.match(after.reason, /speak=false/);
});

// ─── fail-open on an internal error ─────────────────────────────────────────

test("resolveSpeech: never throws -- a garbage ctx still returns an allowed verdict", () => {
  assert.doesNotThrow(() => {
    const gate = resolveSpeech(undefined);
    assert.equal(gate.allowed, true);
  });
  assert.doesNotThrow(() => {
    const gate = resolveSpeech({ origin: 12345, slotId: {}, text: null });
    assert.equal(typeof gate.allowed, "boolean");
  });
});

// ─── loudness travels through the gate as ONE number ────────────────────────

test("resolveSpeech: an allowed verdict carries master x actor as `volume`, with provenance", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  writeCast(file, {
    version: 1,
    voice: { volume: 0.5 },
    actors: { "mcp:speak": { volume: 0.6 } },
  });
  const gate = resolveSpeech({ origin: "mcp:speak", text: "hi", file });
  assert.equal(gate.allowed, true);
  assert.equal(gate.volume, 0.3);
  assert.equal(gate.provenance.masterVolumeFrom, "voice.volume");
  assert.equal(gate.provenance.volumeFrom, 'actors["mcp:speak"].volume');
});

test("resolveSpeech: voice.muted refuses every door, so silence never reaches the TTS call", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  writeCast(file, { version: 1, voice: { muted: true } });
  for (const origin of ["mcp:speak", "bridge:/speak", "desk:drop", "service:awdesk"]) {
    const gate = resolveSpeech({ origin, text: "hi", file });
    assert.equal(gate.allowed, false, `${origin} must be refused while muted`);
    assert.match(gate.reason, /voice\.muted/);
  }
});

test("resolveSpeech: an origin configured with ONLY a volume is configured, not 'seen but silent'", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  writeCast(file, { version: 1, actors: { "mcp:speak": { volume: 0.4 } } });
  resolveSpeech({ origin: "mcp:speak", text: "hi", file });
  const seen = readSeen(file);
  const keys = Array.isArray(seen) ? seen.map((row) => row.key) : Object.keys(seen.origins || seen || {});
  assert.ok(!keys.includes("mcp:speak"), `a volume-only record must not be noted as unseen: ${JSON.stringify(seen)}`);
});

test("resolveSpeech: the fail-open verdict is FULL volume, never silence", () => {
  const gate = resolveSpeech(undefined);
  assert.equal(gate.allowed, true);
  assert.equal(gate.volume, 1);
});

// ─── the caption verdict rides the same gate ────────────────────────────────

test("resolveSpeech: a REFUSED speaker still carries caption:true, so muting never hides the words", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  writeCast(file, { version: 1, voice: { muted: true } });
  const gate = resolveSpeech({ origin: "mcp:speak", text: "the build is green", file });
  assert.equal(gate.allowed, false);
  assert.equal(gate.caption, true);
});

test("resolveSpeech: presence=off refuses the sound AND the caption", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  writeCast(file, { version: 1, actors: { "mcp:speak": { presence: "off" } } });
  const gate = resolveSpeech({ origin: "mcp:speak", text: "hi", file });
  assert.equal(gate.allowed, false);
  assert.equal(gate.caption, false);
});

test("resolveSpeech: the fail-open verdict shows the words", () => {
  assert.equal(resolveSpeech(undefined).caption, true);
});
