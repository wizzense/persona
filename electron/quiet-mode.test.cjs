"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { decide, parseProbeLine, createQuietMode } = require("./quiet-mode.cjs");

test("parseProbeLine reads the probe's one line, and refuses anything else", () => {
  assert.deepEqual(parseProbeLine("QUNS=3 FS=1 PID=4242 NAME=Hellraiser-Win64-Shipping\r"),
    { quns: 3, fullscreen: true, pid: 4242, name: "Hellraiser-Win64-Shipping" });
  assert.equal(parseProbeLine("Add-Type : warning"), null);
});

test("an exclusive full-screen game, Windows' BUSY and Focus Assist are all quiet", () => {
  const on = { quietWhenFullscreen: true };
  for (const quns of [2, 3, 4, 6]) {
    assert.equal(decide(on, { quns, fullscreen: false, pid: 1, name: "" }).quiet, true, `QUNS=${quns}`);
  }
  assert.equal(decide(on, { quns: 5, fullscreen: false, pid: 1, name: "" }).quiet, false, "5 = accepts notifications");
});

test("a BORDERLESS game (Windows says 'accepts notifications') is caught by its rect", () => {
  const v = decide({ quietWhenFullscreen: true }, { quns: 5, fullscreen: true, pid: 77, name: "bg3" });
  assert.deepEqual(v, { quiet: true, reason: "bg3 is full-screen" });
});

test("the desk's OWN full-screen overlay is never mistaken for a game", () => {
  const v = decide({ quietWhenFullscreen: true }, { quns: 5, fullscreen: true, pid: 77, name: "electron" }, [77]);
  assert.equal(v.quiet, false);
});

test("Do not disturb wins; turning the automatic switch off only disables the automatic half", () => {
  assert.equal(decide({ doNotDisturb: true, quietWhenFullscreen: false }, null).quiet, true);
  assert.equal(decide({ quietWhenFullscreen: false }, { quns: 3, fullscreen: true, pid: 1, name: "g" }).quiet, false);
});

test("no probe yet (or a dead one) is NOT quiet -- a broken probe must not silence the desk forever", () => {
  assert.equal(decide({ quietWhenFullscreen: true }, null).quiet, false);
});

test("the live instance streams probe lines, fires onChange once per transition, and forgets a dead probe", () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.kill = () => {};
  const changes = [];
  const quiet = createQuietMode({
    platform: "win32",
    spawn: () => child,
    readPrefs: () => ({ quietWhenFullscreen: true }),
    ownPids: () => [],
    onChange: (now) => changes.push(now.quiet),
  });
  quiet.start();
  child.stdout.emit("data", "QUNS=3 FS=1 PID=9 NAME=game\r\nQUNS=3 FS=1 PID=9 NA");
  child.stdout.emit("data", "ME=game\r\n");
  assert.equal(quiet.isQuiet(), true);
  child.stdout.emit("data", "QUNS=5 FS=0 PID=1 NAME=\r\n");
  assert.equal(quiet.isQuiet(), false);
  child.stdout.emit("data", "QUNS=3 FS=1 PID=9 NAME=game\r\n");
  quiet.stop();
  child.emit("exit");
  assert.equal(quiet.isQuiet(), false, "a probe that exits leaves the desk audible");
  assert.deepEqual(changes, [true, false, true, false]);
});

test("off Windows the probe never starts and the desk is simply not quiet", () => {
  let spawned = false;
  const quiet = createQuietMode({ platform: "linux", spawn: () => { spawned = true; }, readPrefs: () => ({}) });
  quiet.start();
  assert.equal(spawned, false);
  assert.equal(quiet.isQuiet(), false);
});

test("every door that can put something on screen or in the ears asks quietMode first", () => {
  // The sweep of 2026-09-23 found these doors in main.cjs; a door that loses its
  // check is a popup over a game again. Source-level on purpose: main.cjs cannot be
  // loaded in a unit test (it takes the running desk's single-instance lock).
  const main = require("node:fs").readFileSync(require("node:path").join(__dirname, "main.cjs"), "utf8");
  const bodyOf = (marker, span = 1400) => {
    const at = main.indexOf(marker);
    assert.ok(at >= 0, `door not found: ${marker}`);
    return main.slice(at, at + span);
  };
  for (const marker of [
    "function handleBridgeEvent(",
    "async function handleMcpWindowAction(",
    "function handleProtocolUrl(",
    "consoleHandler: (pane) =>",
    "desktopHandler: (mode) =>",
    "const announceDecisions = (list, isBacklog) =>",
    "decisionCards.setWindowRouter(",
    "async function speakAloud(",
  ]) {
    assert.match(bodyOf(marker), /quietMode\.isQuiet\(\)/, `${marker} does not ask quietMode`);
  }
  assert.doesNotMatch(main, /AITHER_DECISIONS_POPUP:\s*"1"/, "the desk must not force popups past the owner's off switch");
});
