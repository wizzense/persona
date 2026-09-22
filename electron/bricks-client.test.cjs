"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { runBricks, listBricks, actOnBrick } = require("./bricks-client.cjs");

function fakeExec(result) {
  const calls = [];
  const impl = (bin, argv, opts, cb) => {
    calls.push({ bin, argv, opts });
    setImmediate(() => cb(result.error || null, result.stdout || "", result.stderr || ""));
  };
  return { impl, calls };
}

test("list runs `adk bricks list --json` as an argv, never a shell string", async () => {
  const fx = fakeExec({ stdout: "[]" });
  const res = await listBricks({ execFileImpl: fx.impl, bin: "adk" });
  assert.deepEqual(res, { ok: true, data: [] });
  assert.deepEqual(fx.calls[0].argv, ["bricks", "list", "--json"]);
  assert.equal(fx.calls[0].opts.shell, undefined);
});

test("a bad verb or brick name is refused WITHOUT spawning anything", async () => {
  const fx = fakeExec({ stdout: "{}" });
  for (const [verb, name] of [["uninstall", "awgit"], ["upgrade", "awgit; rm -rf /"], ["test", ""],
    ["rollback", "--index-url=http://evil"]]) {
    const res = await actOnBrick(verb, name, { execFileImpl: fx.impl, bin: "adk" });
    assert.equal(res.ok, false, `${verb} ${name} was not refused`);
  }
  assert.equal(fx.calls.length, 0);
});

test("a failed upgrade exits non-zero but its JSON verdict is still read", async () => {
  const verdict = { id: "awtunnel", ok: false, rolled_back: true, error: "test failed" };
  const fx = fakeExec({ error: Object.assign(new Error("exit 1"), { code: 1 }), stdout: JSON.stringify(verdict) });
  const res = await actOnBrick("upgrade", "awtunnel", { execFileImpl: fx.impl, bin: "adk" });
  assert.equal(res.ok, false);
  assert.equal(res.data.rolled_back, true, "the rollback fact must reach the pane");
  assert.deepEqual(fx.calls[0].argv, ["bricks", "upgrade", "awtunnel", "--json"]);
});

test("a missing adk says so; unreadable output is an error, never an empty list", async () => {
  const missing = fakeExec({ error: Object.assign(new Error("spawn adk ENOENT"), { code: "ENOENT" }) });
  const r1 = await runBricks(["list"], { execFileImpl: missing.impl, bin: "adk" });
  assert.equal(r1.ok, false);
  assert.match(r1.error, /not installed or not on PATH/);
  const garbage = fakeExec({ stdout: "usage: adk [-h] ..." });
  const r2 = await runBricks(["list"], { execFileImpl: garbage.impl, bin: "adk" });
  assert.equal(r2.ok, false);
  assert.equal(r2.data, undefined);
});
