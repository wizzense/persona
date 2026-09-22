"use strict";

/**
 * cast-config tests — the pure schema/resolver/hash/migration plane.
 *
 * Every exported function takes {file} directly, so tests point straight at a
 * per-test tmpdir fixture instead of juggling DESK_CAST_FILE / env-at-require
 * (the trap content-rating.test.cjs and pack-roster.test.cjs hit, because
 * `node --test` runs each file as a PARALLEL child process and two of them
 * racing on one real path is flaky by construction — see content-rating's
 * header comment). No Electron, no daemon, no voice service: this module is
 * pure on purpose (see cast-config.cjs's header, "risk").
 *
 *   node --test electron/cast-config.test.cjs
 *
 * Exit 0 = every arm holds, non-zero = a contract broke.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const cast = require("./cast-config.cjs");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "desk-cast-config-"));
}

function castFileIn(dir) {
  return path.join(dir, "cast.json");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Same computation as cast-config's internal quoteKey — a trivial, stable
 *  standard-library call, not a fragile re-implementation. Used only to build
 *  the EXPECTED provenance string an assertion checks against. */
function q(key) {
  return JSON.stringify(String(key));
}

// ─── field-level precedence ──────────────────────────────────────────────────

test("resolveActor: actors[exact] > actors[<kind>:*] > authors.seats[n] > authors > defaults > voice.defaultVoice > hash, per field", () => {
  const snapshot = {
    version: 1,
    voice: { defaultVoice: "alloy" },
    defaults: { voice: "onyx" },
    authors: {
      "aitheros-fresh": { voice: "fable", seats: [{ voice: "shimmer" }] },
    },
    actors: {
      "claude_code:seat0": { voice: "nova" },
      "claude_code:*": { voice: "echo" },
    },
  };
  const ctx = { kind: "claude_code", id: "seat0", author: "aitheros-fresh", seat: 0, roster: [] };

  // Tier 1: the exact origin key.
  let r = cast.resolveActor(snapshot, ctx);
  assert.equal(r.voice, "nova");
  assert.ok(r.voiceFrom.startsWith(`actors[${q("claude_code:seat0")}]`), r.voiceFrom);

  // Tier 2: the exact row removed -> the class grant.
  delete snapshot.actors["claude_code:seat0"];
  r = cast.resolveActor(snapshot, ctx);
  assert.equal(r.voice, "echo");
  assert.ok(r.voiceFrom.startsWith(`actors[${q("claude_code:*")}]`), r.voiceFrom);

  // Tier 3: the class grant removed -> this parallel session's own seat.
  delete snapshot.actors["claude_code:*"];
  r = cast.resolveActor(snapshot, ctx);
  assert.equal(r.voice, "shimmer");
  assert.ok(r.voiceFrom.startsWith("authors.aitheros-fresh.seats[0]"), r.voiceFrom);

  // Tier 4: the seat removed -> the author record.
  delete snapshot.authors["aitheros-fresh"].seats;
  r = cast.resolveActor(snapshot, ctx);
  assert.equal(r.voice, "fable");
  assert.ok(r.voiceFrom.startsWith("authors.aitheros-fresh"), r.voiceFrom);

  // Tier 5: the author record removed entirely -> file-wide defaults.
  delete snapshot.authors["aitheros-fresh"];
  r = cast.resolveActor(snapshot, ctx);
  assert.equal(r.voice, "onyx");
  assert.equal(r.voiceFrom, "defaults.voice");

  // Tier 6: defaults.voice removed -> voice.defaultVoice.
  delete snapshot.defaults.voice;
  r = cast.resolveActor(snapshot, ctx);
  assert.equal(r.voice, "alloy");
  assert.equal(r.voiceFrom, "voice.defaultVoice");

  // Tier 7: nothing configured anywhere -> the stable hash, never a built-in
  // constant (an authored default must beat a hash, but there is no built-in
  // "nova" above the hash — see resolveActor's docstring).
  delete snapshot.voice.defaultVoice;
  r = cast.resolveActor(snapshot, ctx);
  assert.equal(r.voiceFrom, "hash");
  assert.ok(cast.VOICES.includes(r.voice), r.voice);
});

test("resolveActor: relay chain is actors[exact nick] > actors[relay:<channel>] > channels[<channel>] (presence only) > actors[relay:*]", () => {
  const snapshot = {
    version: 1,
    actors: {
      "relay:#agents:bob": { presence: "chatty" },
      "relay:#agents": { presence: "normal" },
      "relay:*": { presence: "off" },
    },
    channels: { "#agents": { presence: "quiet", voiced: true } },
  };
  const ctx = { kind: "relay", channel: "#agents", nick: "bob", roster: [] };

  let r = cast.resolveActor(snapshot, ctx);
  assert.equal(r.presence, "chatty");
  assert.ok(r.presenceFrom.startsWith(`actors[${q("relay:#agents:bob")}]`), r.presenceFrom);

  delete snapshot.actors["relay:#agents:bob"];
  r = cast.resolveActor(snapshot, ctx);
  assert.equal(r.presence, "normal");
  assert.ok(r.presenceFrom.startsWith(`actors[${q("relay:#agents")}]`), r.presenceFrom);

  delete snapshot.actors["relay:#agents"];
  r = cast.resolveActor(snapshot, ctx);
  assert.equal(r.presence, "quiet");
  assert.ok(r.presenceFrom.startsWith(`channels[${q("#agents")}]`), r.presenceFrom);

  delete snapshot.channels["#agents"];
  r = cast.resolveActor(snapshot, ctx);
  assert.equal(r.presence, "off");
  assert.ok(r.presenceFrom.startsWith(`actors[${q("relay:*")}]`), r.presenceFrom);

  // A relay row with no explicit voiced grant anywhere must never be
  // implicitly audible — the owner ruling this whole plan was written
  // around ("a relay nick can never be implicitly audible").
  const unvoiced = cast.resolveActor(
    { version: 1 },
    { kind: "relay", channel: "#random", nick: "stranger", roster: [] },
  );
  assert.equal(unvoiced.voiced, false);
  assert.match(unvoiced.voicedReason, /not voiced/);
});

test("resolveActor: speed falls through actors -> voice.defaultSpeed -> legacy env DESK_VOICE_SPEED -> builtin", () => {
  const ctx = { kind: "claude_code", id: "x", roster: [] };
  const withEnv = cast.resolveActor({ version: 1 }, { ...ctx, env: { DESK_VOICE_SPEED: "1.75" } });
  assert.equal(withEnv.speed, 1.75);
  assert.equal(withEnv.speedFrom, "env.DESK_VOICE_SPEED");

  const bare = cast.resolveActor({ version: 1 }, { ...ctx, env: {} });
  assert.equal(bare.speed, cast.BUILTIN_VOICE.defaultSpeed);
  assert.equal(bare.speedFrom, "builtin");
});

// ─── hash stability (the plan's stated "risk"; see failureProof) ────────────

test("stableCharacter: a seed's pick survives a name being ADDED to the roster", () => {
  const roster = ["alpha", "bravo", "charlie", "delta"];
  const seed = "aitheros-fresh:0";
  const before = cast.stableCharacter(seed, roster, { taken: [], resident: null });
  assert.ok(before, "expected a pick from a non-empty roster");
  const grown = cast.stableCharacter(seed, [...roster, "echo-new-arrival"], { taken: [], resident: null });
  assert.equal(grown, before, "adding a name to the roster must not move an existing agent's body");
});

test("stableCharacter: a seed's pick survives an UNRELATED body being taken", () => {
  const roster = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
  // Find two seeds whose unconstrained picks differ, so "Y's body is taken"
  // is a real, non-degenerate precondition rather than an accidental no-op.
  let seedX;
  let nameX;
  let nameY;
  for (let i = 0; i < 50; i += 1) {
    const a = `agent-${i}:0`;
    const b = `agent-${i + 1}:0`;
    const na = cast.stableCharacter(a, roster, { taken: [], resident: null });
    const nb = cast.stableCharacter(b, roster, { taken: [], resident: null });
    if (na && nb && na !== nb) {
      seedX = a;
      nameX = na;
      nameY = nb;
      break;
    }
  }
  assert.ok(seedX, "could not find two distinct picks in 50 tries — roster too small");

  const nameXAfterYArrives = cast.stableCharacter(seedX, roster, { taken: [nameY], resident: null });
  assert.equal(nameXAfterYArrives, nameX, "an unrelated arrival taking a body must not reindex X");
});

test("stableCharacter: a taken or resident name is skipped, in the seed's own rank order", () => {
  const roster = ["alpha", "bravo", "charlie"];
  const seed = "agent-z:0";
  const free = cast.stableCharacter(seed, roster, { taken: [], resident: null });
  assert.ok(roster.includes(free));
  const blocked = cast.stableCharacter(seed, roster, { taken: [free], resident: null });
  assert.notEqual(blocked, free);
  assert.ok(blocked === null || roster.includes(blocked));
  const allBlocked = cast.stableCharacter(seed, roster, { taken: roster, resident: null });
  assert.equal(allBlocked, null, "nothing free to wear must resolve to null, never throw");
});

// ─── malformed file handling ─────────────────────────────────────────────────

test("load: malformed JSON keeps the LAST GOOD snapshot, sets error, and copies the bad bytes to cast.invalid.json", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);

  const written = cast.write((draft) => {
    draft.defaults = { voice: "nova" };
    return draft;
  }, { file });
  assert.ok(written.ok, written.error);
  assert.equal(written.snapshot.defaults.voice, "nova");

  const badBytes = "{ this is not json, it just looks like it might be";
  fs.writeFileSync(file, badBytes, "utf8");

  const result = cast.load({ file });
  assert.ok(result.error, "a malformed file must surface an error string");
  assert.equal(result.snapshot.meta.source, "last-good");
  assert.equal(result.snapshot.defaults.voice, "nova", "the last good snapshot must be kept, not discarded");
  assert.ok(fs.existsSync(cast.INVALID_FILE(file)));
  assert.equal(fs.readFileSync(cast.INVALID_FILE(file), "utf8"), badBytes);
});

test("load: a FIRST-EVER malformed file (no last-good yet) silently defaults NOTHING", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  const badBytes = "not json at all {{{";
  fs.writeFileSync(file, badBytes, "utf8");

  const result = cast.load({ file });
  assert.ok(result.error);
  assert.equal(result.snapshot.meta.source, "builtin");
  // "silently defaults nothing" — the snapshot must be genuinely EMPTY, never
  // a synthetic record built from BUILTIN_* as if the file had said so.
  assert.deepEqual(result.snapshot.stage, {});
  assert.deepEqual(result.snapshot.defaults, {});
  assert.deepEqual(result.snapshot.authors, {});
  assert.deepEqual(result.snapshot.actors, {});
  assert.deepEqual(result.snapshot.channels, {});
  assert.ok(fs.existsSync(cast.INVALID_FILE(file)));
});

test("validateCast: version !== 1 is a whole-file, parse-class refusal", () => {
  const { config, fatal, problems } = cast.validateCast({ version: 2, defaults: { voice: "nova" } });
  assert.equal(fatal, true);
  assert.equal(config, null);
  assert.ok(problems.some((p) => p.path === "version"));
});

// ─── per-field validation: drop, never clamp ─────────────────────────────────

test("validateCast: an out-of-range field is reported with path+value+reason and DROPPED, while its siblings survive", () => {
  const raw = {
    version: 1,
    defaults: {
      character: "ok-name",
      speed: 9,
      presence: "loud",
      place: { position: [8, 0, 0], scale: 1 },
    },
  };
  const { config, problems } = cast.validateCast(raw);

  const speedProblem = problems.find((p) => p.path === "defaults.speed");
  assert.ok(speedProblem, "expected a problem at defaults.speed");
  assert.equal(speedProblem.value, 9);
  assert.match(speedProblem.reason, /0\.25/);

  const presenceProblem = problems.find((p) => p.path === "defaults.presence");
  assert.ok(presenceProblem, "expected a problem at defaults.presence");
  assert.equal(presenceProblem.value, "loud");
  assert.match(presenceProblem.reason, /off \| quiet \| normal \| chatty/);

  const placeProblem = problems.find((p) => p.path === "defaults.place.position[0]");
  assert.ok(placeProblem, "expected a problem at defaults.place.position[0]");
  assert.equal(placeProblem.value, 8);
  assert.match(placeProblem.reason, /visible stage/);

  // Dropped, not clamped: the bad fields are simply ABSENT, not coerced.
  assert.equal(config.defaults.speed, undefined);
  assert.equal(config.defaults.presence, undefined);
  assert.equal(config.defaults.place, undefined);
  // The one valid field in the same record is untouched by its siblings' sins.
  assert.equal(config.defaults.character, "ok-name");
});

test("validateCast: an unknown key is REPORTED, never dropped in silence", () => {
  const { problems } = cast.validateCast({ version: 1, defaults: { typo_field: "x" } });
  const hit = problems.find((p) => p.path === "defaults.typo_field");
  assert.ok(hit, "a typo'd key must produce a problem, not vanish");
  assert.match(hit.reason, /unknown key/);
});

test("resolveActor: a character not in the safe roster is reported and falls through to the hash", () => {
  const snapshot = { version: 1, defaults: { character: "atlas-bot" } };
  const roster = ["nova-vrm", "echo-vrm"];
  const r = cast.resolveActor(snapshot, { kind: "claude_code", id: "y", roster, taken: [], resident: null });

  assert.notEqual(r.character, "atlas-bot");
  assert.equal(r.characterFrom, "hash");
  assert.ok(roster.includes(r.character));
  const hit = r.problems.find((p) => p.path === "defaults.character");
  assert.ok(hit, "expected a problem naming defaults.character");
  assert.match(hit.reason, /safe roster/);
});

// ─── stage.maxBodies: unset must not read as zero, nor zero as unset ────────

test("resolveStage: maxBodies 0 resolves to 0 while unset resolves to the built-in 3 (Number(x)||3 cannot tell these apart)", () => {
  const zero = cast.resolveStage({ version: 1, stage: { maxBodies: 0 } }, { env: {} });
  assert.equal(zero.maxBodies, 0);
  assert.equal(zero.maxBodiesFrom, "stage.maxBodies");

  const unset = cast.resolveStage({ version: 1, stage: {} }, { env: {} });
  assert.equal(unset.maxBodies, 3);
  assert.equal(unset.maxBodiesFrom, "builtin");
});

// ─── migration ────────────────────────────────────────────────────────────────

test("migrateLegacy: folds .agent-avatars.json and the legacy AGENT_VOICES in once, keeps the legacy file, and never overwrites an owner-authored value", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  const avatarsFile = path.join(dir, "legacy-avatars.json");
  fs.writeFileSync(
    avatarsFile,
    JSON.stringify({ atlas: "atlas-vrm", " Weird Name ": "weird-vrm", badtype: 123 }, null, 2),
    "utf8",
  );

  // The owner already chose atlas's character by hand, before migration runs.
  const pre = cast.write((draft) => {
    draft.authors = { atlas: { character: "owner-chosen-vrm" } };
    return draft;
  }, { file });
  assert.ok(pre.ok, pre.error);

  const first = cast.migrateLegacy({ file, avatarsFile });
  assert.ok(first.ok, first.reason);
  assert.equal(first.migrated, true);
  assert.equal(first.characters, 1, "atlas is pre-authored and skipped; badtype is not a string; only the weird-name row is new");
  assert.equal(first.voices, Object.keys(cast.LEGACY_AGENT_VOICES).length);
  assert.equal(first.legacyKept, true);
  assert.ok(fs.existsSync(avatarsFile), "the legacy dotfile must be COPIED, never deleted");

  const { snapshot } = cast.load({ file });
  assert.equal(snapshot.authors.atlas.character, "owner-chosen-vrm", "an owner-authored value must survive migration untouched");
  assert.equal(snapshot.authors.atlas.voice, cast.LEGACY_AGENT_VOICES.atlas, "voice was not pre-authored, so migration fills it");
  assert.equal(snapshot.authors["weird name"].character, "weird-vrm");
  assert.ok(typeof snapshot.migratedLegacyAt === "string" && snapshot.migratedLegacyAt);

  // One-shot: running it again is a no-op, guarded by the marker.
  const second = cast.migrateLegacy({ file, avatarsFile });
  assert.equal(second.migrated, false);
  assert.match(second.reason, /already migrated/);
});

// ─── the seen-book ────────────────────────────────────────────────────────────

test("originOf + noteSeen: an unknown origin lands in cast-seen.json with count, firstSeen and a sample, and accumulates on repeat sightings", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  const seenFile = cast.SEEN_FILE(file);

  const origin = cast.originOf({ kind: "claude_code", id: "newbie-123" });
  assert.equal(origin.key, "claude_code:newbie-123");

  const first = cast.noteSeen(origin, "  hello   world, first sighting  ", { file: seenFile });
  assert.equal(first.count, 1);
  assert.ok(typeof first.firstSeen === "string" && first.firstSeen);
  assert.equal(first.sample, "hello world, first sighting");
  assert.equal(first.kind, "claude_code");

  const book = cast.readSeen({ file: seenFile });
  assert.equal(book["claude_code:newbie-123"].count, 1);

  const second = cast.noteSeen(origin, "second sighting text", { file: seenFile });
  assert.equal(second.count, 2, "a repeat sighting must accumulate, not overwrite");
  assert.equal(second.firstSeen, first.firstSeen, "firstSeen must not move on a later sighting");
  assert.equal(second.sample, "second sighting text", "the sample reflects the most recent sighting");
});

test("noteSeen: never throws, even when it cannot write (best-effort by construction)", () => {
  const dir = tmpDir();
  // A path whose parent does not exist AND cannot be created (a file standing
  // where a directory is needed) — this must return null, not throw.
  const blocker = path.join(dir, "not-a-dir");
  fs.writeFileSync(blocker, "x");
  const target = path.join(blocker, "seen.json");
  assert.doesNotThrow(() => {
    const result = cast.noteSeen(cast.originOf({ kind: "x", id: "y" }), "sample", { file: target });
    assert.equal(result, null);
  });
});

// ─── watch: our own write must not re-enter the loader ─────────────────────

test("watch: an external edit in the SAME mtime tick still fires (size is in the stamp)", async () => {
  // Measured 2026-09-22 on the Windows CI runner: a write landing in the same
  // timestamp tick as the one the watcher started on was dropped as "a touch
  // that changed nothing". Pin both writes to one whole second to force it.
  const dir = tmpDir();
  const file = castFileIn(dir);
  const tick = 1700000000;
  fs.writeFileSync(file, `${JSON.stringify({ version: 1 })}
`, "utf8");
  fs.utimesSync(file, tick, tick);
  const events = [];
  const unwatch = cast.watch((result) => events.push(result), { file, debounceMs: 50 });
  try {
    // macOS FSEvents arms the stream asynchronously: an edit in the first
    // milliseconds after fs.watch() is not delivered at all (CI, 2026-09-22).
    await sleep(250);
    fs.writeFileSync(file, `${JSON.stringify({ version: 1, defaults: { voice: "nova" } })}
`, "utf8");
    fs.utimesSync(file, tick, tick);
    await sleep(500);
    assert.ok(events.length >= 1, "a same-tick external edit was dropped by the change guard");
    assert.equal(events[events.length - 1].snapshot.defaults.voice, "nova");
  } finally {
    unwatch();
  }
});

test("watch: a write through write() does not fire onChange; an external edit does", async () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  cast.write((draft) => {
    draft.defaults = { voice: "onyx" };
    return draft;
  }, { file });

  const events = [];
  const unwatch = cast.watch((result) => events.push(result), { file, debounceMs: 50 });
  try {
    const result = cast.write((draft) => {
      draft.defaults = { voice: "echo" };
      return draft;
    }, { file });
    assert.ok(result.ok, result.error);

    await sleep(350);
    assert.equal(events.length, 0, "our own write must not re-enter the loader (selfWrite guard)");

    // A change made OUTSIDE write() — e.g. the owner hand-editing the file —
    // must still be observed, proving the guard suppresses only OUR writes.
    fs.writeFileSync(
      file,
      `${JSON.stringify({ version: 1, defaults: { voice: "nova" } }, null, 2)}\n`,
      "utf8",
    );
    await sleep(350);
    assert.equal(events.length, 1, "an external edit must fire onChange exactly once");
    assert.equal(events[0].snapshot.defaults.voice, "nova");
  } finally {
    unwatch();
  }
});

// ─── the file path itself ────────────────────────────────────────────────────

test("CAST_FILE: DESK_CAST_FILE overrides the resolved path, and is read lazily (not cached at require time)", () => {
  const dir = tmpDir();
  const override = path.join(dir, "override-cast.json");
  const had = process.env.DESK_CAST_FILE;
  try {
    process.env.DESK_CAST_FILE = override;
    assert.equal(cast.CAST_FILE(), path.resolve(override));
  } finally {
    if (had === undefined) delete process.env.DESK_CAST_FILE;
    else process.env.DESK_CAST_FILE = had;
  }
});

// ─── loudness: a mixer (master x actor), a global mute, and provenance ───────

test("resolveActor: unset volume is FULL volume, from the built-in, and the actor is still voiced", () => {
  const r = cast.resolveActor({ version: 1 }, { kind: "claude_code", id: "v0", roster: null });
  assert.equal(r.volume, 1);
  assert.equal(r.masterVolume, 1);
  assert.equal(r.muted, false);
  assert.equal(r.effectiveVolume, 1);
  assert.equal(r.volumeFrom, "builtin");
  assert.equal(r.masterVolumeFrom, "builtin");
  assert.equal(r.voiced, true);
});

test("resolveActor: effective volume is master x actor, and each factor says where it came from", () => {
  const snapshot = {
    version: 1,
    voice: { volume: 0.5 },
    defaults: { volume: 0.8 },
    actors: { "claude_code:loud": { volume: 1.6 } },
  };
  const loud = cast.resolveActor(snapshot, { kind: "claude_code", id: "loud", roster: null });
  assert.equal(loud.volume, 1.6);
  assert.equal(loud.volumeFrom, 'actors["claude_code:loud"].volume');
  assert.equal(loud.masterVolumeFrom, "voice.volume");
  assert.equal(loud.effectiveVolume, 0.8);

  // An actor with no record of its own inherits the defaults tier, like every
  // other actor field -- pulling the master down moves BOTH of them.
  const other = cast.resolveActor(snapshot, { kind: "claude_code", id: "other", roster: null });
  assert.equal(other.volumeFrom, "defaults.volume");
  assert.equal(other.effectiveVolume, 0.4);
});

test("resolveActor: voice.muted silences everyone and is named BEFORE a per-actor reason", () => {
  const snapshot = { version: 1, voice: { muted: true }, defaults: { speak: false } };
  const r = cast.resolveActor(snapshot, { kind: "claude_code", id: "m", roster: null });
  assert.equal(r.effectiveVolume, 0);
  assert.equal(r.voiced, false);
  assert.match(r.voicedReason, /^voice\.muted \(voice\.muted\)/);
  // Muting is not un-bodying: the avatar stays on stage.
  assert.equal(r.bodied, true);
});

test("resolveActor: a fader at zero refuses BEFORE synthesis and says which fader", () => {
  const master = cast.resolveActor({ version: 1, voice: { volume: 0 } }, { kind: "claude_code", id: "z", roster: null });
  assert.equal(master.voiced, false);
  assert.match(master.voicedReason, /^voice\.volume=0 \(voice\.volume\)/);

  const actor = cast.resolveActor({ version: 1, defaults: { volume: 0 } }, { kind: "claude_code", id: "z", roster: null });
  assert.equal(actor.voiced, false);
  assert.match(actor.voicedReason, /^volume=0 \(defaults\.volume\)/);
});

test("resolveActor: an out-of-range volume is DROPPED with a problem, never clamped", () => {
  const snapshot = { version: 1, voice: { volume: 3 }, defaults: { volume: -1 } };
  const r = cast.resolveActor(snapshot, { kind: "claude_code", id: "bad", roster: null });
  // Both fall through to the built-in: a clamp would pin the owner to a
  // loudness they never chose (the module's own DROP, DO NOT CLAMP rule).
  assert.equal(r.masterVolume, 1);
  assert.equal(r.volume, 1);
  assert.ok(r.problems.find((p) => p.path === "voice.volume"), "expected a problem naming voice.volume");
  assert.ok(r.problems.find((p) => p.path === "defaults.volume"), "expected a problem naming defaults.volume");
});

test("validateCast + resolveVoice: volume and muted are known voice keys, not unknown-key problems", () => {
  const { problems } = cast.validateCast({ version: 1, voice: { volume: 0.3, muted: true } });
  assert.deepEqual(problems, []);
  const v = cast.resolveVoice({ version: 1, voice: { volume: 0.3, muted: true } }, { env: {} });
  assert.equal(v.volume, 0.3);
  assert.equal(v.volumeFrom, "voice.volume");
  assert.equal(v.muted, true);
});

// ─── captions: shown when PRESENT, not when AUDIBLE ─────────────────────────

test("resolveActor: every kind of mute keeps its caption -- that is what the caption is for", () => {
  const ctx = { kind: "claude_code", id: "c", roster: null };
  const cases = [
    { version: 1, voice: { muted: true } },
    { version: 1, voice: { volume: 0 } },
    { version: 1, defaults: { speak: false } },
    { version: 1, defaults: { presence: "quiet" } },
    { version: 1, defaults: { volume: 0 } },
  ];
  for (const snapshot of cases) {
    const r = cast.resolveActor(snapshot, ctx);
    assert.equal(r.voiced, false, `expected silence for ${JSON.stringify(snapshot)}`);
    assert.equal(r.captioned, true, `a muted speaker lost its caption: ${JSON.stringify(snapshot)}`);
  }
});

test("resolveActor: presence=off and an unnamed relay channel get NO caption (or slot0's bubble floods)", () => {
  const off = cast.resolveActor({ version: 1, defaults: { presence: "off" } }, { kind: "claude_code", id: "c", roster: null });
  assert.equal(off.captioned, false);
  assert.match(off.captionedReason, /^presence=off/);

  const relay = cast.resolveActor({ version: 1 }, { kind: "relay", channel: "#random", nick: "someone", roster: null });
  assert.equal(relay.captioned, false);
  assert.match(relay.captionedReason, /is not voiced/);

  // Naming the channel is what turns BOTH on.
  const named = cast.resolveActor(
    { version: 1, channels: { "#random": { voiced: true } } },
    { kind: "relay", channel: "#random", nick: "someone", roster: null },
  );
  assert.equal(named.captioned, true);
});

test("resolveActor: captions switch off for the whole stage, or for one speaker, with provenance", () => {
  const stage = cast.resolveActor({ version: 1, stage: { bubbles: false } }, { kind: "claude_code", id: "c", roster: null });
  assert.equal(stage.captioned, false);
  assert.match(stage.captionedReason, /^stage\.bubbles=false \(stage\.bubbles\)/);

  const snapshot = { version: 1, actors: { "claude_code:noisy": { bubble: false } } };
  const one = cast.resolveActor(snapshot, { kind: "claude_code", id: "noisy", roster: null });
  assert.equal(one.captioned, false);
  assert.match(one.captionedReason, /^bubble=false \(actors\["claude_code:noisy"\]\.bubble\)/);
  const other = cast.resolveActor(snapshot, { kind: "claude_code", id: "fine", roster: null });
  assert.equal(other.captioned, true);

  const { problems } = cast.validateCast({ version: 1, stage: { bubbles: false }, defaults: { bubble: true } });
  assert.deepEqual(problems, []);
});

// ─── physics: per-sub-key tiers, whole-block validation ─────────────────────

test("resolveActor: physics resolves PER SUB-KEY across tiers, each knob with its own provenance", () => {
  const snapshot = {
    version: 1,
    defaults: { physics: { weight: 0.5, damping: 1.5, jiggle: 0.8 } },
    authors: { "agent-a": { physics: { stiffness: 2 } } },
    actors: { "claude_code:one": { physics: { jiggle: 0.2 } } },
  };
  const one = cast.resolveActor(snapshot, { kind: "claude_code", id: "one", author: "agent-a", roster: null });
  assert.deepEqual(one.physics, { enabled: true, weight: 0.5, stiffness: 2, damping: 1.5, jiggle: 0.2 });
  assert.equal(one.physicsFrom.jiggle, 'actors["claude_code:one"].physics.jiggle');
  assert.equal(one.physicsFrom.stiffness, "authors.agent-a.physics.stiffness");
  assert.equal(one.physicsFrom.weight, "defaults.physics.weight");
  assert.equal(one.physicsFrom.enabled, "builtin");

  // Nothing authored anywhere: the built-in is a full set of 1s -- "as the
  // model's author meant it" -- never a 0 that would read as "physics off".
  const bare = cast.resolveActor({ version: 1 }, { kind: "claude_code", id: "two", roster: null });
  assert.deepEqual(bare.physics, cast.BUILTIN_PHYSICS);
  for (const from of Object.values(bare.physicsFrom)) assert.equal(from, "builtin");
});

test("resolveActor: the resident's physics resolve under service:awdesk, the same key its voice uses", () => {
  const snapshot = { version: 1, actors: { "service:awdesk": { physics: { weight: 0.3 } } } };
  const origin = cast.originOf({ key: cast.ORIGIN_LITERALS.SERVICE_AWDESK });
  const resident = cast.resolveActor(snapshot, { actorKind: origin.kind, actorId: origin.id, origin, roster: null });
  assert.equal(resident.physics.weight, 0.3);
  assert.equal(resident.physicsFrom.weight, 'actors["service:awdesk"].physics.weight');
});

test("validateCast + resolveActor: a physics block with one bad knob is DROPPED for that tier (reported with the sub-path) and the tier below answers", () => {
  const raw = {
    version: 1,
    defaults: { physics: { weight: 0.7 } },
    actors: { "claude_code:x": { physics: { weight: 9, jiggle: 0.5 } } }, // 9 > PHYSICS_MULTIPLIER_MAX
  };
  const { problems } = cast.validateCast(raw);
  const hit = problems.find((p) => p.path.includes("physics"));
  assert.ok(hit, "the bad block is reported");
  assert.match(hit.path, /physics\.weight$/);

  const x = cast.resolveActor(raw, { kind: "claude_code", id: "x", roster: null });
  assert.equal(x.physics.weight, 0.7, "the tier below answers the dropped block");
  assert.equal(x.physics.jiggle, 1, "a sibling in the SAME dropped block is not honoured (whole-block, like place)");

  const unknown = cast.validateCast({ version: 1, defaults: { physics: { bounce: 2 } } });
  assert.ok(unknown.problems.some((p) => /unknown key/.test(p.reason)), "an unknown knob is reported, never silently kept");
});
