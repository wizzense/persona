"use strict";

/**
 * cast-window.test.cjs (U03) — drives `castHandlers` headless. It never
 * requires real Electron (see cast-window.cjs's own doc: `require("electron")`
 * outside a running Electron process returns a path STRING, not `{ipcMain,
 * BrowserWindow}` — that is why no other *-window.cjs in this tree has a test
 * file at all). `castHandlers(getImpl)` is the pure seam that makes this file
 * possible: every desk:cast-* verb, driven directly with a fake impl.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { castHandlers, ensureCastIpc, createCastWindow, closeCastWindow, isCastWindowOpen } =
  require("./cast-window.cjs");

const HERE = __dirname;

const DOCUMENTED_CHANNELS = [
  "desk:cast-describe",
  "desk:cast-set-actor",
  "desk:cast-clear-actor",
  "desk:cast-set-stage",
  "desk:cast-set-voice",
  "desk:cast-set-channel",
  "desk:cast-capture-stage",
  "desk:cast-mute-origin",
  "desk:cast-reveal",
];

function handlersFor(impl) {
  return castHandlers(() => impl);
}

test("the desk:cast-* channel set is EXACTLY the documented nine -- nothing dropped, nothing extra", () => {
  const handlers = handlersFor({});
  assert.deepEqual(Object.keys(handlers).sort(), [...DOCUMENTED_CHANNELS].sort());
  for (const channel of DOCUMENTED_CHANNELS) {
    assert.equal(typeof handlers[channel], "function", `${channel} is not a function`);
  }
});

test("describe() passes an impl's plain object through, wrapped in ok:true", () => {
  const shape = { snapshot: { version: 1 }, problems: [], error: null, roster: ["atlas"], onStage: [], seen: {} };
  const handlers = handlersFor({ describe: () => shape });
  const result = handlers["desk:cast-describe"]();
  assert.deepEqual(result, { ok: true, ...shape });
});

test("a throwing impl yields {ok:false,error:'<verb>: ...'} SYNCHRONOUSLY -- never a rejected promise", () => {
  const handlers = handlersFor({ describe: () => { throw new Error("cast.json is not readable"); } });
  const result = handlers["desk:cast-describe"]();
  // The failure mode this arm exists to catch: if `call()` ever awaited fn()
  // instead of invoking it synchronously inside try/catch, a throwing impl
  // would produce an unhandled rejection instead of this envelope.
  assert.equal(typeof result?.then, "undefined", "describe() must not return a thenable");
  assert.deepEqual(result, { ok: false, error: "describe: cast.json is not readable" });
});

test("a writer's own {ok:false,...} verdict is honoured verbatim, never re-wrapped to ok:true", () => {
  const refusal = { ok: false, snapshot: null, problems: [], error: "refusing to write cast.json: unusable" };
  const handlers = handlersFor({ setActor: () => refusal });
  const result = handlers["desk:cast-set-actor"](null, "claude_code:7f3a", { presence: "normal" });
  assert.deepEqual(result, refusal);
});

test("setActor writes through with {key, patch} exactly as given", () => {
  let seen = null;
  const handlers = handlersFor({ setActor: (args) => { seen = args; return { ok: true, snapshot: {}, problems: [], error: null }; } });
  const result = handlers["desk:cast-set-actor"](null, "claude_code:7f3a", { voice: "onyx" });
  assert.equal(result.ok, true);
  assert.deepEqual(seen, { key: "claude_code:7f3a", patch: { voice: "onyx" } });
});

test("setActor coerces a non-plain-object patch to {} rather than forwarding garbage", () => {
  let seen = null;
  const handlers = handlersFor({ setActor: (args) => { seen = args; return { ok: true }; } });
  handlers["desk:cast-set-actor"](null, "claude_code:7f3a", ["not", "an", "object"]);
  assert.deepEqual(seen.patch, {});
  handlers["desk:cast-set-actor"](null, "claude_code:7f3a", undefined);
  assert.deepEqual(seen.patch, {});
});

test("a malformed key shape is refused BEFORE the impl is ever called -- the security-relevant arm", () => {
  // This is the assertion the plan calls out by name ("setActor refuses an
  // unknown key shape"): an object/number/array/blank string must not reach
  // cast-config.write and be stringified into cast.json as a bogus origin key.
  const malformed = [undefined, null, "", "   ", 42, {}, [], true, ["claude_code:7f3a"]];
  for (const bad of malformed) {
    let called = false;
    const handlers = handlersFor({ setActor: () => { called = true; return { ok: true }; } });
    const result = handlers["desk:cast-set-actor"](null, bad, { voice: "onyx" });
    assert.equal(called, false, `setActor must not run for key=${JSON.stringify(bad)}`);
    assert.deepEqual(result, { ok: false, error: "setActor: key is required" });
  }
});

for (const [channel, verb] of [
  ["desk:cast-clear-actor", "clearActor"],
  ["desk:cast-mute-origin", "muteOrigin"],
  ["desk:cast-reveal", "reveal"],
]) {
  test(`${channel} requires a non-empty string key and forwards {key} on success`, () => {
    let seen = null;
    const handlers = handlersFor({ [verb]: (args) => { seen = args; return { ok: true }; } });
    const refused = handlers[channel](null, {});
    assert.deepEqual(refused, { ok: false, error: `${verb}: key is required` });
    assert.equal(seen, null, `${verb} must not run on a malformed key`);

    const ok = handlers[channel](null, "relay:#agents");
    assert.equal(ok.ok, true);
    assert.deepEqual(seen, { key: "relay:#agents" });
  });
}

test("setChannel requires a non-empty channel and forwards {channel, patch}", () => {
  let seen = null;
  const handlers = handlersFor({ setChannel: (args) => { seen = args; return { ok: true }; } });
  const refused = handlers["desk:cast-set-channel"](null, "", { voiced: true });
  assert.deepEqual(refused, { ok: false, error: "setChannel: channel is required" });
  assert.equal(seen, null);

  const ok = handlers["desk:cast-set-channel"](null, "#agents", { voiced: true });
  assert.equal(ok.ok, true);
  assert.deepEqual(seen, { channel: "#agents", patch: { voiced: true } });
});

test("setStage / setVoice / captureStage need no key and coerce a bad patch to {}", () => {
  const stagePatches = [];
  const voicePatches = [];
  let captured = 0;
  const handlers = handlersFor({
    setStage: (patch) => { stagePatches.push(patch); return { ok: true }; },
    setVoice: (patch) => { voicePatches.push(patch); return { ok: true }; },
    captureStage: () => { captured += 1; return { ok: true, captured: 2 }; },
  });

  handlers["desk:cast-set-stage"](null, { maxBodies: 4 });
  handlers["desk:cast-set-stage"](null, "not-an-object");
  assert.deepEqual(stagePatches, [{ maxBodies: 4 }, {}]);

  handlers["desk:cast-set-voice"](null, { defaultSpeed: 1.1 });
  handlers["desk:cast-set-voice"](null, null);
  assert.deepEqual(voicePatches, [{ defaultSpeed: 1.1 }, {}]);

  const result = handlers["desk:cast-capture-stage"]();
  assert.equal(captured, 1);
  assert.deepEqual(result, { ok: true, captured: 2 });
});

test("an impl missing a verb entirely does not throw -- optional chaining yields ok:true with no extra fields", () => {
  const handlers = handlersFor({}); // no describe at all
  const result = handlers["desk:cast-describe"]();
  assert.deepEqual(result, { ok: true });
});

// ─── shape / static assertions ─────────────────────────────────────────────

test("ensureCastIpc / createCastWindow / closeCastWindow / isCastWindowOpen are all exported functions", () => {
  // Not invoked here: each one calls electron() (BrowserWindow / ipcMain),
  // which is unavailable under plain `node --test` -- see the file header.
  // Their EXISTENCE and the impl-injection contract are what this test can
  // assert without a real Electron process; main.cjs's guarded require
  // (`if (ensureCastIpc) ...`) is what actually exercises them at runtime.
  assert.equal(typeof ensureCastIpc, "function");
  assert.equal(typeof createCastWindow, "function");
  assert.equal(typeof closeCastWindow, "function");
  assert.equal(typeof isCastWindowOpen, "function");
});

test("cast-window.cjs never requires main.cjs -- it must be requirable from a second process", () => {
  const source = fs.readFileSync(path.join(HERE, "cast-window.cjs"), "utf8");
  assert.doesNotMatch(source, /require\(["']\.\/main\.cjs["']\)/);
});

test("cast.html and cast-preload.cjs exist and are what cast-window.cjs loads", () => {
  const source = fs.readFileSync(path.join(HERE, "cast-window.cjs"), "utf8");
  assert.match(source, /cast-preload\.cjs/);
  assert.match(source, /cast\.html/);
  assert.ok(fs.existsSync(path.join(HERE, "cast.html")), "cast.html is missing");
  assert.ok(fs.existsSync(path.join(HERE, "cast-preload.cjs")), "cast-preload.cjs is missing");
});

test("cast-preload.cjs exposes window.aitherCast over exactly the documented channels", () => {
  const source = fs.readFileSync(path.join(HERE, "cast-preload.cjs"), "utf8");
  assert.match(source, /exposeInMainWorld\("aitherCast"/);
  for (const channel of DOCUMENTED_CHANNELS) {
    assert.match(source, new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `cast-preload.cjs never invokes ${channel}`);
  }
});
