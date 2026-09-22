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
    registry.groupFor("window-size", "tray").length >= 4,
    "the registry no longer puts the size commands on the tray",
  );
  const at = MAIN.indexOf("buildMenu(\"tray\"");
  assert.ok(at > 0, "the tray is no longer rendered from the registry");
  // The parent label is registry DATA (GROUPS) since 2026-09-20: each call site
  // used to pass its own `nest` map, and the tray and the body's menu named the
  // same group differently.
  assert.ok(registry.GROUPS["window-size"] && registry.GROUPS["window-size"].menu,
    "the size group must nest under one label, or it renders eight flat rows");
  const tray = registry.buildMenu("tray", () => {}, {});
  const nested = tray.find((row) => row.label === registry.GROUPS["window-size"].menu);
  assert.ok(nested && nested.submenu.length >= 6, "the tray lost its size submenu");
});

test("the avatar's own menu keeps its size submenu too", () => {
  const at = MAIN.indexOf("function popupAvatarMenu");
  assert.ok(at > 0, "popupAvatarMenu is gone");
  assert.match(MAIN.slice(at, at + 2500), /buildMenu\(\s*"avatar-menu"/);
  const body = registry.buildMenu("avatar-menu", () => {}, { ctx: { slotId: "slot1" } });
  const nested = body.find((row) => row.label === registry.GROUPS["window-size"].menu);
  assert.ok(nested && nested.submenu.length >= 6, "a body's menu lost its size submenu");
});

test("a size shortcut that could not be registered SAYS so", () => {
  // register() returns false when another app holds the accelerator. Discarding
  // that is how the keyboard path dies with no error, no log and no symptom
  // other than "it stopped working".
  assert.ok(registry.shortcuts().some((k) => k.electron === "CommandOrControl+Shift+=" && k.id === "window.size.bigger"),
    "the grow shortcut is gone");
  // Plan: configurable hotkeys -- main now calls shortcuts(overrides) from
  // inside applyHotkeys(), not a bare shortcuts() at the top level.
  const at = MAIN.indexOf("commandRegistry.shortcuts(");
  assert.ok(at > 0, "main no longer registers the registry's shortcuts");
  const block = MAIN.slice(Math.max(0, at - 900), at + 900);
  assert.match(block, /if \(!globalShortcut\.register\(/,
    "the registration result must be checked");
  assert.match(block, /console\.warn/, "a lost accelerator must be reported");
});

test("every size preset stays reachable and sane", () => {
  // The presets are registry DATA now (one list, rendered as a nested menu and as
  // flat palette rows), so this reads them there rather than from a second copy
  // in main.cjs -- the duplication that let one surface offer a size another did not.
  const presets = registry.groupFor("window-size", "palette").filter((c) => c.size);
  assert.ok(presets.length >= 3, "a size menu with fewer than three choices is a toggle");
  for (const { id, size } of presets) {
    // setWindowSize clamps to these floors; a preset under them is a row that
    // appears to do nothing.
    assert.ok(size.width >= 320 && size.height >= 480,
      `${id} is ${size.width}x${size.height}, below the clamp floor`);
  }
  assert.match(MAIN, /command\.size\)\s*\{[\s\S]{0,200}setWindowSize\(command\.size\.width/,
    "main must apply a preset's size from the registry record");
});
