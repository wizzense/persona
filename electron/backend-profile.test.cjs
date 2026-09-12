"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");

const { BackendResolver } = require("./backend-profile.cjs");

/** A fake pwsh: writes the payload the launcher would write, then exits. */
function fakeHelper({ code = 0, payload = null, stderrLines = [] } = {}) {
  const spawned = [];
  const spawnImpl = (cmd, args, opts) => {
    spawned.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setTimeout(() => {
      for (const line of stderrLines) child.stderr.emit("data", Buffer.from(line + "\n"));
      if (code === 0 && payload) {
        const i = args.indexOf("--to-file");
        fs.writeFileSync(args[i + 1], JSON.stringify(payload), "utf8");
      }
      child.emit("close", code);
    }, 5);
    return child;
  };
  return { spawnImpl, spawned };
}

test("resolve: happy path separates profile, keeps env, deletes the temp file", async () => {
  const { spawnImpl, spawned } = fakeHelper({
    payload: {
      profile: "deepseek",
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_MODEL: "deepseek-v4-flash[1m]",
      ANTHROPIC_AUTH_TOKEN: "tok",
    },
  });
  const resolver = new BackendResolver({ spawnImpl });
  const result = await resolver.resolve();
  assert.equal(result.ok, true);
  assert.equal(result.profile, "deepseek");
  assert.equal(result.env.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
  assert.equal(result.env.ANTHROPIC_AUTH_TOKEN, "tok");
  assert.equal(result.env.profile, undefined, "profile is metadata, not env");
  const dest = spawned[0].args[spawned[0].args.indexOf("--to-file") + 1];
  assert.equal(fs.existsSync(dest), false, "temp file must not survive the read");
});

test("resolve: success is cached; the TTL expiry re-runs the helper", async () => {
  const { spawnImpl, spawned } = fakeHelper({ payload: { profile: "deepseek", A: "1" } });
  let clock = 1_000_000;
  const resolver = new BackendResolver({ spawnImpl, now: () => clock, ttlMs: 1000 });
  await resolver.resolve();
  await resolver.resolve();
  assert.equal(spawned.length, 1, "second call rides the cache");
  clock += 1001;
  await resolver.resolve();
  assert.equal(spawned.length, 2, "a stale cache re-resolves");
});

test("resolve: a failed helper yields {} with a note, and retries after FAILURE_TTL", async () => {
  const { spawnImpl, spawned } = fakeHelper({ code: 1, stderrLines: ["resolve: vault unreachable"] });
  let clock = 5_000_000;
  const resolver = new BackendResolver({ spawnImpl, now: () => clock, ttlMs: 999_999 });
  const first = await resolver.resolve();
  assert.equal(first.ok, false);
  assert.deepEqual(first.env, {});
  assert.match(first.note, /vault unreachable/);
  const second = await resolver.resolve();
  assert.equal(second.ok, false);
  assert.equal(spawned.length, 1, "a failure is cached for FAILURE_TTL (60 s), not re-hammered");
});

test("resolve: AWDESK_BACKEND_RESOLVE=0 is a kill switch with no spawn", async () => {
  const { spawnImpl, spawned } = fakeHelper({ payload: { profile: "deepseek" } });
  process.env.AWDESK_BACKEND_RESOLVE = "0";
  try {
    const resolver = new BackendResolver({ spawnImpl });
    const result = await resolver.resolve();
    assert.equal(result.ok, false);
    assert.match(result.note, /disabled/);
    assert.equal(spawned.length, 0);
  } finally {
    delete process.env.AWDESK_BACKEND_RESOLVE;
  }
});
