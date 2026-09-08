"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { parseProtocolUrl } = require("./protocol-actions.cjs");

test("maps Desk URLs to lifecycle and clamped level events", () => {
  const commands = parseProtocolUrl("desk://speaking?level=3");
  assert.equal(commands[0].event.state.activity, "speaking");
  assert.deepEqual(commands[1].event, { type: "audio-level", level: 1 });
  assert.equal(parseProtocolUrl("desk://inactive")[0].event.state.phase, "inactive");
  assert.deepEqual(parseProtocolUrl("desk://fleet"), [{ type: "fleet" }]);
  assert.deepEqual(parseProtocolUrl("desk:///fleet"), [{ type: "fleet" }]);
});

test("maps window and animation URLs without accepting another scheme", () => {
  assert.deepEqual(parseProtocolUrl("desk://toggle"), [{ type: "toggle" }]);
  assert.deepEqual(parseProtocolUrl("desk://dance"), [
    { type: "event", event: { type: "animation", animation: "DANCE" } },
  ]);
  assert.deepEqual(parseProtocolUrl("desk://finger-gun"), [
    { type: "event", event: { type: "animation", animation: "FINGER_GUN" } },
  ]);
  assert.deepEqual(parseProtocolUrl("desk://happy"), [
    { type: "event", event: { type: "animation", animation: "HAPPY" } },
  ]);
  assert.equal(parseProtocolUrl("desk://celebrate"), null);
  assert.equal(parseProtocolUrl("another-product://show"), null);
  assert.equal(parseProtocolUrl("not a URL"), null);
});

test("maps desk://command to command window protocol action", () => {
  assert.deepEqual(parseProtocolUrl("desk://command"), [{ type: "command" }]);
  assert.deepEqual(parseProtocolUrl("desk:///command"), [{ type: "command" }]);
});

test("desk://overlay and desk://desktop map to the two desktop surfaces", () => {
  assert.deepEqual(parseProtocolUrl("desk://overlay"), [{ type: "overlay" }]);
  assert.deepEqual(parseProtocolUrl("desk://living-desktop"), [{ type: "overlay" }]);
  assert.deepEqual(parseProtocolUrl("desk://desktop"), [{ type: "desktop" }]);
  assert.deepEqual(parseProtocolUrl("desk:///aither-desktop"), [{ type: "desktop" }]);
});
