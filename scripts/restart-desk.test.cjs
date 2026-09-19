"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { freshPids } = require("./restart-desk.cjs");

// 2026-09-18: a killed main lingers in the process list for a second or two.
// The verification re-read the DYING pid, printed "desk up (main 3068)" and
// exited 0 over a desk that was actually down.
test("a pid we just killed never counts as the relaunch", () => {
  assert.deepStrictEqual(freshPids([3068], [3068]), []);
  assert.deepStrictEqual(freshPids([3068], [3068, 34224]), [34224]);
});

test("a cold start (nothing killed) accepts the first main", () => {
  assert.deepStrictEqual(freshPids([], [34224]), [34224]);
  assert.deepStrictEqual(freshPids(undefined, undefined), []);
});

test("number and string pids compare as the same process", () => {
  assert.deepStrictEqual(freshPids(["3068"], [3068]), []);
});
