"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { linkStatus, linkStart, linkPoll } = require("./link-client.cjs");

function fakeExec(result) {
  const calls = [];
  const impl = (bin, argv, opts, cb) => {
    calls.push({ bin, argv, opts });
    setImmediate(() => cb(result.error || null, result.stdout || "", result.stderr || ""));
  };
  return { impl, calls };
}

test("status runs `adk link status --json` as an argv and returns the role", async () => {
  const fx = fakeExec({ stdout: JSON.stringify({ linked: true, signed_in: true, role: "owner", username: "owner" }) });
  const res = await linkStatus({ execFileImpl: fx.impl, bin: "adk" });
  assert.deepEqual(fx.calls[0].argv, ["link", "status", "--json"]);
  assert.equal(fx.calls[0].opts.shell, undefined);
  assert.equal(res.ok, true);
  assert.equal(res.data.role, "owner");
});

test("start hands back the code and approve link", async () => {
  const fx = fakeExec({ stdout: JSON.stringify({ ok: true, user_code: "AB-12", approve_url: "https://p/link?c=AB-12", device_code: "dc-0123456789" }) });
  const res = await linkStart({ execFileImpl: fx.impl, bin: "adk" });
  assert.equal(res.data.user_code, "AB-12");
  assert.deepEqual(fx.calls[0].argv, ["link", "start", "--json"]);
});

test("a device code that is not code-shaped is refused WITHOUT spawning", async () => {
  const fx = fakeExec({ stdout: "{}" });
  for (const bad of ["", "short", "dc; rm -rf /", "--portal=http://evil", "a b c d e f g h"]) {
    assert.equal((await linkPoll(bad, { execFileImpl: fx.impl, bin: "adk" })).ok, false, bad);
  }
  assert.equal(fx.calls.length, 0);
});

test("a poll that failed exits non-zero but its JSON verdict is still read", async () => {
  const fx = fakeExec({ error: Object.assign(new Error("exit 1"), { code: 1 }), stdout: JSON.stringify({ ok: false, status: "denied", error: "access_denied" }) });
  const res = await linkPoll("dc-0123456789", { execFileImpl: fx.impl, bin: "adk" });
  assert.equal(res.ok, false);
  assert.equal(res.data.status, "denied");
  assert.deepEqual(fx.calls[0].argv, ["link", "poll", "dc-0123456789", "--json"]);
});

test("a missing adk says so; garbage output is an error, never 'not linked'", async () => {
  const missing = fakeExec({ error: Object.assign(new Error("spawn adk ENOENT"), { code: "ENOENT" }) });
  assert.match((await linkStatus({ execFileImpl: missing.impl, bin: "adk" })).error, /not installed or not on PATH/);
  const garbage = fakeExec({ stdout: "usage: adk [-h]" });
  const r = await linkStatus({ execFileImpl: garbage.impl, bin: "adk" });
  assert.equal(r.ok, false);
  assert.equal(r.data, undefined);
});
