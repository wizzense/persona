"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createProtocolRouting } = require("./protocol-routing.cjs");

// Every door is a recorder, so a test reads which one a URL or an argv opened.
function harness({ quiet = false, known = ["open-console"] } = {}) {
  const calls = [];
  const rec = (name) => (...args) => calls.push([name, ...args]);
  const routing = createProtocolRouting({
    protocolScheme: "desk",
    quietMode: { isQuiet: () => quiet },
    holdWhileQuiet: rec("holdWhileQuiet"),
    showOverlay: rec("showOverlay"),
    hideOverlay: rec("hideOverlay"),
    toggleOverlay: rec("toggleOverlay"),
    createFleetWindow: rec("createFleetWindow"),
    createCommandWindow: rec("createCommandWindow"),
    getFleetControl: () => "fleet-control",
    createDeckWindow: rec("createDeckWindow"),
    openConsole: rec("openConsole"),
    showLivingDesktop: rec("showLivingDesktop"),
    showDesktopApp: rec("showDesktopApp"),
    handleBridgeEvent: rec("handleBridgeEvent"),
    commandRegistry: { byId: (id) => known.includes(id) },
    runCommand: rec("runCommand"),
  });
  return { routing, calls, names: () => calls.map((call) => call[0]) };
}

test("desk:// verbs open their doors; a foreign scheme is refused", () => {
  const { routing, names } = harness();
  assert.equal(routing.handleProtocolUrl("desk://show"), true);
  assert.equal(routing.handleProtocolUrl("desk://fleet"), true);
  assert.equal(routing.handleProtocolUrl("desk://command"), true);
  assert.equal(routing.handleProtocolUrl("other://show"), false);
  assert.deepEqual(names(), ["showOverlay", "createFleetWindow", "createCommandWindow"]);
});

test("while quiet, desk:// may hide but never open a window", () => {
  const { routing, names } = harness({ quiet: true });
  routing.handleProtocolUrl("desk://show");
  routing.handleProtocolUrl("desk://fleet");
  routing.handleProtocolUrl("desk://hide");
  assert.deepEqual(names(), ["hideOverlay"]);
});

test("a second launch routes its first flag; a jump-list --run needs a registry row", () => {
  const cases = [
    [["desk.exe", "--open-deck", "--fleet"], ["createDeckWindow"]],
    [["desk.exe", "--fleet"], ["createFleetWindow"]],
    [["desk.exe", "--console"], ["openConsole"]],
    [["desk.exe", "--run=open-console"], ["runCommand"]],
    [["desk.exe", "--run=no-such-row"], []],
    [["desk.exe", "--command"], ["createCommandWindow"]],
    [["desk.exe", "--overlay"], ["showLivingDesktop"]],
    [["desk.exe", "--desktop"], ["showDesktopApp"]],
    [["desk.exe", "--background"], []],
    [["desk.exe"], ["showOverlay"]],
    [["desk.exe", "desk://fleet"], ["createFleetWindow"]],
  ];
  for (const [argv, expected] of cases) {
    const { routing, names } = harness();
    routing.handleSecondInstance(argv);
    assert.deepEqual(names(), expected, argv.join(" "));
  }
  const { routing, calls } = harness();
  routing.handleSecondInstance(["desk.exe", "--run=open-console"]);
  assert.deepEqual(calls[0], ["runCommand", "open-console", undefined, { surface: "jumplist" }]);
});

test("a bare relaunch while quiet shows the overlay without focus", () => {
  const { routing, calls } = harness({ quiet: true });
  routing.handleSecondInstance(["desk.exe"]);
  assert.deepEqual(calls, [["showOverlay", { focus: false }]]);
});
