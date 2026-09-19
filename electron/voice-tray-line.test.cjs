"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { voiceTrayItems } = require("./voice-tray-line.cjs");

test("a healthy listener adds nothing to the tray", () => {
  assert.deepEqual(voiceTrayItems({ available: true }, false), []);
  assert.deepEqual(voiceTrayItems({ available: true }, true), []);
});

test("no status yet (listener still starting) adds nothing", () => {
  assert.deepEqual(voiceTrayItems(null, false), []);
  assert.deepEqual(voiceTrayItems(undefined, true), []);
  assert.deepEqual(voiceTrayItems({}, false), []);
});

test("a dead listener in a dev tree names the fix", () => {
  const [item] = voiceTrayItems({ available: false }, false);
  assert.ok(item, "one disabled line");
  assert.equal(item.enabled, false);
  assert.match(item.label, /^Voice: listener missing/);
  assert.match(item.label, /npm run native:fetch/);
});

test("a dead listener in a packaged install says reinstall", () => {
  const [item] = voiceTrayItems({ available: false }, true);
  assert.equal(item.enabled, false);
  assert.match(item.label, /^Voice: listener unavailable/);
  assert.match(item.label, /reinstall/i);
});
