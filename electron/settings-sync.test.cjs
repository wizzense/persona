"use strict";

/**
 * settings-sync tests — the rule that decides whether the owner's settings leave
 * this machine (pure), the scheduler around it (fake child), and ONE real round
 * trip through the actual `awsettings` CLI, because the contract that matters is
 * between two programs and a mock of the other one can only agree with itself.
 *
 *   node --test electron/settings-sync.test.cjs
 */

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createSettingsSync, plan } = require("./settings-sync.cjs");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "desk-sync-"));

function fakeSpawn({ code = 0, missing = [] } = {}) {
  const spawned = [];
  const spawnImpl = (cmd, args, opts) => {
    spawned.push({ cmd, args, env: opts.env });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setTimeout(() => {
      if (missing.includes(cmd)) child.emit("error", Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: "ENOENT" }));
      else child.emit("close", code);
    }, 2);
    return child;
  };
  return { spawnImpl, spawned };
}

// ─── the rule: what leaves, and when nothing does ───────────────────────────

test("plan: OFF unless the owner turned it on, and ON needs somewhere to sync to", () => {
  assert.deepEqual(plan({ sync: {} }, "c.json"), { enabled: false, reason: "sync.enabled is off" });
  assert.deepEqual(plan(undefined, "c.json"), { enabled: false, reason: "sync.enabled is off" });
  assert.equal(plan({ sync: { enabled: true } }, "c.json").enabled, false);
  assert.match(plan({ sync: { enabled: true } }, "c.json").reason, /neither sync\.profile nor sync\.url/);
});

test("plan: the token is handed over as a PATH and never read here", () => {
  const p = plan({ sync: { enabled: true, url: "https://hub.invalid/prefs", tokenFile: "C:/secret/bearer" } }, "c.json");
  assert.deepEqual(p.env, {
    AWSETTINGS_DESK_FILE: "c.json",
    AWSETTINGS_URL: "https://hub.invalid/prefs",
    AWSETTINGS_TOKEN_FILE: "C:/secret/bearer",
  });
  assert.ok(!("AWSETTINGS_TOKEN" in p.env), "a credential VALUE must never enter this process's env plan");
});

test("plan: a url beats a profile (as in the CLI), and a profile alone is the no-account path", () => {
  const both = plan({ sync: { enabled: true, url: "https://h.invalid/p", profile: "D:/p.json" } }, "c.json");
  assert.ok(both.env.AWSETTINGS_URL && !both.env.AWSETTINGS_PROFILE);
  const file = plan({ sync: { enabled: true, profile: "D:/p.json" } }, "c.json");
  assert.deepEqual(file.env, { AWSETTINGS_DESK_FILE: "c.json", AWSETTINGS_PROFILE: "D:/p.json" });
});

// ─── the scheduler ──────────────────────────────────────────────────────────

test("start: sync OFF spawns NOTHING -- no child, no network, and says why", async () => {
  const { spawnImpl, spawned } = fakeSpawn();
  const sync = createSettingsSync({ castFile: "c.json", settings: { sync: {} }, spawnImpl, watchFile: () => {}, unwatchFile: () => {} });
  const result = await sync.start();
  assert.equal(result.skipped, true);
  assert.equal(spawned.length, 0);
  assert.equal(sync.status().reason, "sync.enabled is off");
});

test("start: ON pulls once, for the desk domain, against THIS desk's cast file", async () => {
  const { spawnImpl, spawned } = fakeSpawn();
  const sync = createSettingsSync({
    castFile: "C:/x/cast.json", settings: { sync: { enabled: true, profile: "D:/p.json" } },
    spawnImpl, watchFile: () => {}, unwatchFile: () => {},
  });
  const result = await sync.start();
  assert.equal(result.ok, true);
  assert.deepEqual(spawned.map((s) => [s.cmd, ...s.args]), [["awsettings", "--domain", "desk", "--quiet", "pull"]]);
  assert.equal(spawned[0].env.AWSETTINGS_DESK_FILE, "C:/x/cast.json");
});

test("run: a console script missing from PATH falls back to `python -m`, and both missing is SAID", async () => {
  const one = fakeSpawn({ missing: ["awsettings"] });
  const sync = createSettingsSync({ castFile: "c.json", settings: { sync: { enabled: true, profile: "p" } }, spawnImpl: one.spawnImpl });
  assert.equal((await sync.pullNow()).ok, true);
  assert.deepEqual(one.spawned.map((s) => s.cmd), ["awsettings", "python"]);
  assert.deepEqual(one.spawned[1].args.slice(0, 2), ["-m", "awsettings.cli"]);

  const none = fakeSpawn({ missing: ["awsettings", "python"] });
  const dead = createSettingsSync({ castFile: "c.json", settings: { sync: { enabled: true, profile: "p" } }, spawnImpl: none.spawnImpl });
  const result = await dead.pullNow();
  assert.equal(result.ok, false);
  assert.match(result.verdict, /not installed/);
});

test("run: exit 1 and exit 2 are different sentences -- 'server dropped keys' is not 'offline'", async () => {
  for (const [code, pattern] of [[1, /kept less than it was sent/], [2, /could not reach/]]) {
    const { spawnImpl } = fakeSpawn({ code });
    const sync = createSettingsSync({ castFile: "c.json", settings: { sync: { enabled: true, profile: "p" } }, spawnImpl });
    const result = await sync.pushNow();
    assert.equal(result.ok, false);
    assert.match(result.verdict, pattern);
  }
});

test("watch: a burst of changes is ONE push, and pushOnChange:false is none", async () => {
  const { spawnImpl, spawned } = fakeSpawn();
  let onChange = null;
  const settings = { sync: { enabled: true, profile: "p", pullOnStart: false } };
  const sync = createSettingsSync({
    castFile: "c.json", settings: () => settings, spawnImpl, debounceMs: 25,
    watchFile: (_f, _o, cb) => { onChange = cb; }, unwatchFile: () => {},
  });
  await sync.start();
  for (let i = 1; i <= 5; i += 1) onChange({ mtimeMs: i + 1 }, { mtimeMs: i });
  await new Promise((r) => setTimeout(r, 90));
  assert.deepEqual(spawned.map((s) => s.args.at(-1)), ["push"], "five saves in a burst must be one push");

  settings.sync.pushOnChange = false;
  onChange({ mtimeMs: 99 }, { mtimeMs: 98 });
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(spawned.length, 1, "pushOnChange:false still pushed");
  sync.stop();
});

// ─── the real thing: two desks, one synced folder, the actual CLI ────────────

const cliPresent = spawnSync("awsettings", ["--version"], { encoding: "utf8" }).status === 0;

test("REAL round trip: desk A's fader reaches desk B through the actual awsettings CLI", { skip: !cliPresent && "awsettings CLI is not installed" }, async () => {
  const dir = tmp();
  const profile = path.join(dir, "shared", "awsettings.json");
  const a = path.join(dir, "A", "cast.json");
  const b = path.join(dir, "B", "cast.json");
  fs.mkdirSync(path.dirname(a), { recursive: true });
  fs.mkdirSync(path.dirname(b), { recursive: true });
  fs.writeFileSync(a, JSON.stringify({
    version: 1,
    voice: { volume: 0.35, endpoint: { host: "127.0.0.1", port: 8084 } },
    models: { commandProfile: "opus" },
    sync: { enabled: true, profile },
  }), "utf8");
  // B has a field A never set, a voice endpoint of its OWN, and no sync section.
  fs.writeFileSync(b, JSON.stringify({
    version: 1,
    voice: { defaultVoice: "onyx", endpoint: { host: "10.0.0.9", port: 9999 } },
  }), "utf8");
  const settings = { sync: { enabled: true, profile } };

  const deskA = createSettingsSync({ castFile: a, settings });
  assert.equal((await deskA.pushNow()).ok, true, JSON.stringify(deskA.status()));
  const deskB = createSettingsSync({ castFile: b, settings });
  assert.equal((await deskB.pullNow()).ok, true, JSON.stringify(deskB.status()));

  const merged = JSON.parse(fs.readFileSync(b, "utf8"));
  assert.equal(merged.voice.volume, 0.35, "A's fader did not arrive");
  assert.equal(merged.voice.defaultVoice, "onyx", "B lost the field A never had");
  assert.equal(merged.models.commandProfile, "opus", "the models section did not sync");
  assert.deepEqual(merged.voice.endpoint, { host: "10.0.0.9", port: 9999 }, "A's voice endpoint overwrote B's");
  assert.equal(merged.sync, undefined, "A's device-local sync section was delivered to B");
  const shared = JSON.parse(fs.readFileSync(profile, "utf8"));
  assert.equal(shared.awdesk.sync, undefined, "the sync section (local paths) left machine A");
  assert.equal(shared.awdesk.voice.endpoint, undefined, "the voice endpoint left machine A");
});
