"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const { keepDeskResponsive, raisePriorities, wantedPriority } = require("./process-priority.cjs");

test("above normal by default; DESK_PRIORITY=normal leaves the processes alone", () => {
  assert.equal(wantedPriority({}), os.constants.priority.PRIORITY_ABOVE_NORMAL);
  assert.equal(wantedPriority({ DESK_PRIORITY: "junk" }), os.constants.priority.PRIORITY_ABOVE_NORMAL);
  assert.equal(wantedPriority({ DESK_PRIORITY: "Normal" }), null);
});

test("each pid is raised once, a vanished pid is a count not a crash, and gone pids are forgotten", () => {
  const calls = [];
  const set = (pid, p) => {
    if (pid === 3) throw new Error("ESRCH");
    calls.push([pid, p]);
  };
  const done = new Set();
  assert.deepEqual(raisePriorities([1, 2, 3], -7, set, done), { raised: 2, failed: 1 });
  assert.deepEqual(raisePriorities([1, 2, 4], -7, set, done), { raised: 1, failed: 0 });
  assert.deepEqual(calls.map((c) => c[0]), [1, 2, 4]);
  raisePriorities([4], -7, set, done);
  assert.deepEqual([...done], [4]);
});

test("the sweep covers every app process and re-runs on a timer", () => {
  let scheduled = null;
  const app = { getAppMetrics: () => [{ pid: process.pid }] };
  const before = os.getPriority(process.pid);
  const out = keepDeskResponsive(app, { env: {}, setIntervalFn: (fn) => { scheduled = fn; return { unref() {} }; } });
  assert.equal(out.enabled, true);
  assert.equal(typeof scheduled, "function");
  os.setPriority(process.pid, before);
  assert.equal(keepDeskResponsive(app, { env: { DESK_PRIORITY: "normal" } }).enabled, false);
});
