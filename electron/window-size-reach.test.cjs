"use strict";

/**
 * Can the owner change the avatar window's size AT ALL?
 *
 * Owner, 2026-09-18: "i cant control the actual avatar stage / window / box size
 * anymore". Nothing had thrown and nothing was logged -- the window is frameless
 * and transparent with a three.js canvas over every pixel, so there is no edge to
 * drag (SIZE_PRESETS says so), and each remaining path had quietly narrowed:
 *
 *   - the size menu hung ONLY off the avatar's own right-click menu, which needs
 *     a right-click that lands on a BODY and travels under 6px (gestures v5,
 *     the same day);
 *   - the two global shortcuts were registered with the return value discarded,
 *     so an accelerator held by another app removed the keyboard path silently.
 *
 * These are source-shape assertions on main.cjs, deliberately: the behaviour they
 * protect is a MENU ENTRY and a LOG LINE, neither of which survives being tested
 * through a mock of Electron. A UI affordance that exists in exactly one place is
 * one gesture change away from being gone.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const MAIN = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");

const registry = require("./command-registry.cjs");

test("window size is reachable from the TRAY, not only from a gesture", () => {
  // The tray is the path that cannot be lost to a gesture change, a hidden
  // avatar or a stolen accelerator. Since slice 1 the tray is RENDERED from the
  // registry, so this is two facts: the registry puts size on the tray, and main
  // supplies the presets behind it (a dynamic command with no submenu is dropped).
  assert.ok(
    registry.commandsFor("tray").some((command) => command.id === "window.size"),
    "the registry no longer puts window size on the tray",
  );
  const at = MAIN.indexOf("buildMenu(\"tray\"");
  assert.ok(at > 0, "the tray is no longer rendered from the registry");
  assert.match(
    MAIN.slice(at, at + 600),
    /"window\.size":\s*buildSizeMenu\(\)/,
    "nothing supplies the tray's size presets, so the row is dropped",
  );
});

test("the avatar's own menu keeps its size submenu too", () => {
  const at = MAIN.indexOf("function popupAvatarMenu");
  assert.ok(at > 0, "popupAvatarMenu is gone");
  assert.match(MAIN.slice(at, at + 2500), /\.\.\.buildSizeMenu\(\)/);
});

test("a size shortcut that could not be registered SAYS so", () => {
  // register() returns false when another app holds the accelerator. Discarding
  // that is how the keyboard path dies with no error, no log and no symptom
  // other than "it stopped working".
  const at = MAIN.indexOf("CommandOrControl+Shift+=");
  assert.ok(at > 0, "the grow shortcut is gone");
  const block = MAIN.slice(Math.max(0, at - 900), at + 900);
  assert.match(block, /if \(!globalShortcut\.register\(/,
    "the registration result must be checked");
  assert.match(block, /console\.warn/, "a lost accelerator must be reported");
});

test("every size preset stays reachable and sane", () => {
  const at = MAIN.indexOf("const SIZE_PRESETS");
  assert.ok(at > 0, "SIZE_PRESETS is gone");
  const block = MAIN.slice(at, MAIN.indexOf("]", at));
  const presets = [...block.matchAll(/width:\s*(\d+),\s*height:\s*(\d+)/g)]
    .map(([, w, h]) => ({ w: Number(w), h: Number(h) }));
  assert.ok(presets.length >= 3, "a size menu with fewer than three choices is a toggle");
  for (const { w, h } of presets) {
    // setWindowSize clamps to these floors; a preset under them is a menu entry
    // that appears to do nothing.
    assert.ok(w >= 320 && h >= 480, `preset ${w}x${h} is below the clamp floor`);
  }
});
