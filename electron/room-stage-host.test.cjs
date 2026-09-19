"use strict";

/**
 * room-stage-host tests — every dep stubbed (no Electron, no daemon, no real
 * RoomStage timers): this file proves the WIRING (which function gets which
 * arguments, in which order) since room-stage.cjs and cast-config.cjs already
 * prove their own logic in their own suites.
 *
 * cast-config calls here all take `{file}` explicitly (never DESK_CAST_FILE),
 * same reasoning as cast-config.test.cjs's own header: this file's tests run
 * sequentially in one `node --test` process, but a per-test tmpdir fixture is
 * simpler to reason about than env mutation regardless.
 *
 *   node --test electron/room-stage-host.test.cjs
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const host = require("./room-stage-host.cjs");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "desk-room-stage-host-"));
}

function castFileIn(dir) {
  return path.join(dir, "cast.json");
}

function writeCast(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A RoomStage stand-in that mirrors the REAL class's `status()` shape
 * (derived live from `slots`, exactly like room-stage.cjs's own status()) so
 * reconcileOnStage's `stage.slots.set(...)` bookkeeping write is visible to
 * the next `status()` call the way it would be against the real class.
 */
class FakeRoomStage {
  constructor(io, options) {
    this.io = io;
    this.options = options;
    this.slots = new Map();
    this.started = false;
    this.stopped = false;
    this.lastConfig = null;
  }
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
  setConfig(result) {
    this.lastConfig = result;
  }
  status() {
    return {
      onStage: [...this.slots.entries()].map(([slotId, s]) => ({
        slotId,
        agent: s.agent,
        character: s.character,
        actorId: s.actorId || "",
        actorKind: s.actorKind || "",
      })),
    };
  }
  evict(slotId) {
    const had = this.slots.has(slotId);
    this.slots.delete(slotId);
    return had;
  }
}

function baseDeps(overrides = {}) {
  return {
    roomPublisher: { recentChat: async () => [] },
    spawnAvatarSlot: () => true,
    removeAvatarSlot: () => true,
    speakAloud: async () => ({ ok: true }),
    listCharacters: () => ["Nova", "Luna"],
    filterCharacters: (names) => names,
    getActiveCharacter: () => "Aither",
    sendToRenderer: () => {},
    log: () => {},
    env: {},
    RoomStage: FakeRoomStage,
    ...overrides,
  };
}

// ─── the regression arm: resolve is a REAL function, and the knobs land ─────

test("startRoomStage: passes io.resolve as a function AND the numeric stage knobs to RoomStage", () => {
  const dir = tmpDir();
  const deps = baseDeps({ castFile: castFileIn(dir) }); // file does not exist: builtins
  try {
    const stage = host.startRoomStage(deps);
    assert.ok(stage, "startRoomStage must return the stage when roomPublisher is present");
    assert.equal(
      typeof stage.io.resolve,
      "function",
      "io.resolve must be a function -- the previous `voices` option was plumbed the same way and never supplied by anything; a dropped resolver means every row is silently unbodied and unvoiced",
    );
    assert.equal(typeof stage.io.spawn, "function");
    assert.equal(typeof stage.io.remove, "function");
    assert.equal(typeof stage.io.speak, "function");
    assert.equal(typeof stage.io.onEvict, "function");
    assert.equal(typeof stage.io.recentChat, "function");
    // Built-in defaults: no file, no env.
    assert.equal(stage.options.maxBodies, 3);
    assert.equal(stage.options.idleMs, 600 * 1000);
    assert.equal(stage.options.cooldownMs, 20 * 1000);
    assert.equal(stage.options.gapMs, 350);
    assert.equal(stage.options.pollMs, 2000);
    assert.equal(stage.started, true, "startRoomStage must call .start()");
  } finally {
    host.stopRoomStage();
  }
});

test("startRoomStage: is idempotent (a second call while one runs returns the SAME stage)", () => {
  const dir = tmpDir();
  const deps = baseDeps({ castFile: castFileIn(dir) });
  try {
    const first = host.startRoomStage(deps);
    const second = host.startRoomStage(baseDeps({ castFile: castFileIn(tmpDir()) }));
    assert.equal(first, second);
  } finally {
    host.stopRoomStage();
  }
});

test("startRoomStage: returns null with no roomPublisher, and with DESK_ROOM_STAGE=0", () => {
  const dir = tmpDir();
  try {
    assert.equal(host.startRoomStage(baseDeps({ roomPublisher: null, castFile: castFileIn(dir) })), null);
    assert.equal(
      host.startRoomStage(baseDeps({ castFile: castFileIn(dir), env: { DESK_ROOM_STAGE: "0" } })),
      null,
    );
  } finally {
    host.stopRoomStage();
  }
});

// ─── maxBodies: file honours 0; the legacy env tier keeps the old `||` bug ──

test("resolveStageKnobs: stage.maxBodies:0 in the FILE reaches RoomStage as 0", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  writeCast(file, { version: 1, stage: { maxBodies: 0 } });
  const deps = baseDeps({ castFile: file, env: {} });
  try {
    const stage = host.startRoomStage(deps);
    assert.equal(stage.options.maxBodies, 0, "an explicit 0 in the file must not read as 'unset'");
  } finally {
    host.stopRoomStage();
  }
});

test("resolveStageKnobs: an UNSET file plus DESK_ROOM_MAX_BODIES=0 still yields 3 (the legacy `||` trap, kept on purpose)", () => {
  const dir = tmpDir();
  const file = castFileIn(dir); // never written: ENOENT -> builtin source
  const deps = baseDeps({ castFile: file, env: { DESK_ROOM_MAX_BODIES: "0" } });
  try {
    const stage = host.startRoomStage(deps);
    assert.equal(
      stage.options.maxBodies,
      3,
      "Number('0') || 3 === 3 is the bug main.cjs shipped with before cast.json existed; an operator's existing env var must keep behaving exactly as it did, not silently start working as part of an unrelated file split",
    );
  } finally {
    host.stopRoomStage();
  }
});

test("resolveStageKnobs: an UNSET file plus a non-zero DESK_ROOM_MAX_BODIES is honoured", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  const deps = baseDeps({ castFile: file, env: { DESK_ROOM_MAX_BODIES: "5" } });
  try {
    const stage = host.startRoomStage(deps);
    assert.equal(stage.options.maxBodies, 5);
  } finally {
    host.stopRoomStage();
  }
});

// ─── hot reload: a changed character re-spawns ONLY that slot ──────────────

test("cast-config.watch: a changed character re-spawns only that slot, via spawnAvatarSlot, and never touches applyCharacter", async () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  writeCast(file, { version: 1, authors: { "agent-a": { character: "Nova" } } });

  const spawnCalls = [];
  const deps = baseDeps({
    castFile: file,
    watchDebounceMs: 30,
    spawnAvatarSlot: (slotId, character, agent, place) => {
      spawnCalls.push({ slotId, character, agent, place });
      return true;
    },
    env: {},
  });

  // 🚩 `applyCharacter` is simply never in `deps` at all -- this module
  // cannot call it even by accident, unlike the pre-refactor main.cjs, which
  // had it in scope as a closure. Asserting its absence from the dep surface
  // IS the guarantee the plan's "never applyCharacter" arm asks for.
  assert.equal("applyCharacter" in deps, false);

  try {
    const stage = host.startRoomStage(deps);
    // Simulate a slot room-stage.cjs's own ensureSlot already spawned, with
    // the character the OLD file authored.
    stage.slots.set("room-agent-a", { agent: "agent-a", character: "Nova", actorId: "", actorKind: "" });

    writeCast(file, { version: 1, authors: { "agent-a": { character: "Luna" } } });
    await sleep(400);

    assert.equal(spawnCalls.length, 1, "exactly one re-spawn, for the one slot whose character changed");
    assert.equal(spawnCalls[0].slotId, "room-agent-a");
    assert.equal(spawnCalls[0].character, "Luna");
    assert.equal(spawnCalls[0].agent, "agent-a");
    assert.equal(
      stage.slots.get("room-agent-a").character,
      "Luna",
      "room-stage's own bookkeeping must reflect the re-spawn, or the NEXT reconcile re-spawns it again every save",
    );
  } finally {
    host.stopRoomStage();
  }
});

test("cast-config.watch: an UNCHANGED character on stage triggers no re-spawn", async () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  writeCast(file, { version: 1, authors: { "agent-a": { character: "Nova" } } });

  const spawnCalls = [];
  const deps = baseDeps({
    castFile: file,
    watchDebounceMs: 30,
    spawnAvatarSlot: (slotId, character, agent, place) => {
      spawnCalls.push({ slotId, character, agent, place });
      return true;
    },
    env: {},
  });

  try {
    const stage = host.startRoomStage(deps);
    stage.slots.set("room-agent-a", { agent: "agent-a", character: "Nova", actorId: "", actorKind: "" });

    // A save that changes something IRRELEVANT to this actor.
    writeCast(file, { version: 1, authors: { "agent-a": { character: "Nova" } }, voice: { defaultSpeed: 1.1 } });
    await sleep(400);

    assert.equal(spawnCalls.length, 0);
  } finally {
    host.stopRoomStage();
  }
});

// ─── castPaneImpl ────────────────────────────────────────────────────────────

test("castPaneImpl.setActor: writes through cast-config.write and returns {ok:true}", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  const pane = host.castPaneImpl(baseDeps({ castFile: file }));

  const result = pane.setActor({ key: "claude_code:*", patch: { voice: "echo" } });
  assert.equal(result.ok, true);

  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(onDisk.actors["claude_code:*"].voice, "echo");
});

test("castPaneImpl.setActor: refuses with no key, and never writes the file", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  const pane = host.castPaneImpl(baseDeps({ castFile: file }));
  const result = pane.setActor({ patch: { voice: "echo" } });
  assert.equal(result.ok, false);
  assert.equal(fs.existsSync(file), false);
});

test("castPaneImpl.captureStage: writes a place for EACH on-stage actor", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  const deps = baseDeps({ castFile: file, env: {} });

  try {
    const stage = host.startRoomStage(deps);
    stage.slots.set("room-a", { agent: "agent-a", character: "Nova", actorId: "aaaa1111", actorKind: "claude_code" });
    stage.slots.set("room-b", { agent: "agent-b", character: "Luna", actorId: "bbbb2222", actorKind: "claude_code" });

    const pane = host.castPaneImpl(deps);
    const result = pane.captureStage();
    assert.equal(result.ok, true, result.error || "");
    assert.equal(result.captured, 2);

    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(onDisk.actors["claude_code:aaaa1111"].place, "actor a must get a place");
    assert.ok(onDisk.actors["claude_code:bbbb2222"].place, "actor b must get a place");
    assert.equal(onDisk.actors["claude_code:aaaa1111"].place.position.length, 3);
  } finally {
    host.stopRoomStage();
  }
});

test("castPaneImpl.captureStage: nothing on stage is ok:true with captured:0, and writes nothing", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  const deps = baseDeps({ castFile: file, env: {} });
  try {
    host.startRoomStage(deps);
    const pane = host.castPaneImpl(deps);
    const result = pane.captureStage();
    assert.equal(result.ok, true);
    assert.equal(result.captured, 0);
    assert.equal(fs.existsSync(file), false);
  } finally {
    host.stopRoomStage();
  }
});

test("castPaneImpl.muteOrigin / reveal: mute sets speak:false; reveal clears it and sets presence normal", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  const pane = host.castPaneImpl(baseDeps({ castFile: file }));

  const muted = pane.muteOrigin({ key: "relay:#ops:nick" });
  assert.equal(muted.ok, true);
  let onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(onDisk.actors["relay:#ops:nick"].speak, false);

  const revealed = pane.reveal({ key: "relay:#ops:nick" });
  assert.equal(revealed.ok, true);
  onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal("speak" in onDisk.actors["relay:#ops:nick"], false);
  assert.equal(onDisk.actors["relay:#ops:nick"].presence, "normal");
});

// ─── evictSlot / status ──────────────────────────────────────────────────────

test("evictSlot: false with no stage running; true and clears bookkeeping once one is", () => {
  assert.equal(host.evictSlot("room-agent-a"), false);
  const dir = tmpDir();
  const deps = baseDeps({ castFile: castFileIn(dir), env: {} });
  try {
    const stage = host.startRoomStage(deps);
    stage.slots.set("room-agent-a", { agent: "agent-a", character: "Nova" });
    assert.equal(host.evictSlot("room-agent-a"), true);
    assert.equal(stage.slots.has("room-agent-a"), false);
    assert.equal(host.evictSlot("room-agent-a"), false, "evicting an already-gone slot is a harmless false, not a throw");
  } finally {
    host.stopRoomStage();
  }
});

test("status(): null with no stage running; the live stage's status() once one is", () => {
  assert.equal(host.status(), null);
  const dir = tmpDir();
  const deps = baseDeps({ castFile: castFileIn(dir), env: {} });
  try {
    const stage = host.startRoomStage(deps);
    stage.slots.set("room-agent-a", { agent: "agent-a", character: "Nova" });
    const s = host.status();
    assert.equal(s.onStage.length, 1);
    assert.equal(s.onStage[0].slotId, "room-agent-a");
  } finally {
    host.stopRoomStage();
  }
});

// ─── buildResolver / resolveStageKnobs as pure units ────────────────────────

test("buildResolver: resolves an authored character via the authors tier with no live stage running", () => {
  const dir = tmpDir();
  const file = castFileIn(dir);
  writeCast(file, { version: 1, authors: { "agent-a": { character: "Nova" } } });
  const deps = baseDeps({ castFile: file });
  const resolve = host.buildResolver(deps, () => file, null);
  const resolution = resolve({ author: "agent-a", actorId: "x", actorKind: "claude_code" });
  assert.equal(resolution.character, "Nova");
  assert.equal(resolution.characterFrom, "authors.agent-a.character");
});

test("resolveStageKnobs: cooldown/gap/poll have no legacy env tier -- file or builtin only", () => {
  const knobsNoFile = host.resolveStageKnobs(null, { DESK_ROOM_MAX_BODIES: "1" });
  assert.equal(knobsNoFile.cooldownMs, 20 * 1000);
  assert.equal(knobsNoFile.gapMs, 350);
  assert.equal(knobsNoFile.pollMs, 2000);

  const knobsFile = host.resolveStageKnobs(
    { stage: { cooldownSeconds: 5, gapMs: 100, pollMs: 500 } },
    {},
  );
  assert.equal(knobsFile.cooldownMs, 5000);
  assert.equal(knobsFile.gapMs, 100);
  assert.equal(knobsFile.pollMs, 500);
});
