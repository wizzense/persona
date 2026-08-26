"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { desktopSnapshot, browserHistory } = require("./browser-client.cjs");

function fakeCall(calls) {
  return async (name, args) => {
    calls.push({ name, args });
    if (name === "get_active_window") {
      return JSON.stringify({ process: "Code.exe", title: "Desk.tsx" });
    }
    if (name === "browser_context") {
      return JSON.stringify({ url: "https://portal.aitherium.com", title: "Portal" });
    }
    throw new Error(`unexpected tool ${name}`);
  };
}

test("desktopSnapshot aggregates the focused window and the active tab", async () => {
  const calls = [];
  const snap = await desktopSnapshot(fakeCall(calls));
  assert.equal(snap.ok, true);
  assert.equal(snap.window.process, "Code.exe");
  assert.equal(snap.context.url, "https://portal.aitherium.com");
  assert.ok(snap.at > 0);
  assert.deepEqual(
    calls.map((c) => c.name),
    ["get_active_window", "browser_context"],
  );
});

test("a failing source degrades to an ERROR note, not a failed snapshot", async () => {
  const snap = await desktopSnapshot(async (name) => {
    if (name === "browser_context") throw new Error("no active tab");
    return JSON.stringify({ process: "Code.exe" });
  });
  assert.equal(snap.ok, true);
  assert.match(snap.context.note, /no active tab/);
});

test("a dead transport degrades every source to an ERROR note", async () => {
  const snap = await desktopSnapshot(async () => {
    throw new Error("no session bearer");
  });
  assert.equal(snap.ok, true);
  assert.match(snap.window.note, /no session bearer/);
  assert.match(snap.context.note, /no session bearer/);
});

test("browserHistory forwards the limit", async () => {
  const calls = [];
  await browserHistory(3, async (name, args) => {
    calls.push({ name, args });
    return JSON.stringify([{ url: "https://x.example" }]);
  });
  assert.deepEqual(calls[0], { name: "browser_context_history", args: { limit: 3 } });
});
