"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { connectSnapshot, terminalSessions } = require("./connect-client.cjs");

test("connectSnapshot aggregates the workspace profile and terminal sessions", async () => {
  const calls = [];
  const snap = await connectSnapshot(async (name) => {
    calls.push(name);
    if (name === "get_active_workspace_profile") {
      return JSON.stringify({ profile: "sovereign", active: true });
    }
    if (name === "get_running_processes") {
      return JSON.stringify([
        { name: "WindowsTerminal.exe", pid: 1 },
        { name: "Code.exe", pid: 2 },
        { name: "pwsh", pid: 3 },
      ]);
    }
    throw new Error(`unexpected tool ${name}`);
  });
  assert.equal(snap.ok, true);
  assert.equal(snap.workspace.profile, "sovereign");
  assert.equal(snap.terminals.total, 2, "Code.exe is not a terminal");
  assert.deepEqual(snap.terminals.names, ["windowsterminal.exe", "pwsh"]);
  assert.ok(snap.at > 0);
});

test("terminalSessions tolerates string rows and non-array tables", async () => {
  const strings = await terminalSessions(async () =>
    JSON.stringify(["WindowsTerminal.exe", "node.exe"]));
  assert.equal(strings.total, 1);

  const objects = await terminalSessions(async () =>
    JSON.stringify({ processes: [{ ProcessName: "bash" }, { ProcessName: "spotify" }] }));
  assert.equal(objects.total, 1);
  assert.deepEqual(objects.names, ["bash"]);

  const garbage = await terminalSessions(async () => "not a table");
  assert.equal(garbage.total, 0);
  assert.equal(typeof garbage.note, "string");
});

test("terminalSessions carries the availability envelope's reason forward", async () => {
  const blocked = await terminalSessions(async () =>
    JSON.stringify({
      available: false,
      message: "Desktop context tools require Windows platform",
    }));
  assert.equal(blocked.total, 0);
  assert.match(blocked.note, /require Windows platform/);
});

test("a failing profile source degrades to an ERROR note, not a failed snapshot", async () => {
  const snap = await connectSnapshot(async (name) => {
    if (name === "get_active_workspace_profile") throw new Error("profile down");
    return JSON.stringify([]);
  });
  assert.equal(snap.ok, true);
  assert.match(snap.workspace.note, /profile down/);
});

test("a dead transport degrades every source to an ERROR note", async () => {
  const snap = await connectSnapshot(async () => {
    throw new Error("no session bearer");
  });
  assert.equal(snap.ok, true);
  assert.match(snap.workspace.note, /no session bearer/);
  assert.match(snap.terminals.note, /no session bearer/);
});
