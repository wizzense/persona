"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  COMMANDS,
  SURFACES,
  buildMenu,
  byId,
  commandsFor,
  conformance,
} = require("./command-registry.cjs");
const { ACTIONS: fleetActions } = require("./fleet-control.cjs");

test("the inventory itself is healthy", () => {
  assert.deepEqual(conformance(), []);
});

test("a capability with ONE entry point must say why", () => {
  // The regression this registry exists to prevent: avatar window size reachable
  // only through a right-click that lands on a body. Single-surface is allowed --
  // silently single-surface is not.
  for (const command of COMMANDS) {
    if (command.surfaces.length === 1) {
      assert.ok(
        typeof command.whySingle === "string" && command.whySingle.length > 20,
        `${command.id} is single-surface with no written reason`,
      );
    }
  }
});

test("window size reaches the tray, the avatar menu AND the palette", () => {
  const sizes = COMMANDS.filter((command) => command.group === "window-size");
  assert.ok(sizes.length >= 4, "the size group lost its presets");
  for (const command of sizes) {
    for (const surface of ["tray", "avatar-menu", "palette"]) {
      assert.ok(command.surfaces.includes(surface), `${command.id} is missing from ${surface}`);
    }
  }
  // Flat rows for the palette, nested under one label for a menu -- one list.
  const rows = require("./command-registry.cjs").paletteRows({});
  assert.equal(rows.filter((row) => row.group === "window-size").length, sizes.length);
});

test("U27: configuration is reachable from three surfaces, not one gesture", () => {
  // The regression this unit exists for: assigning a character's cast/voice
  // identity had exactly one door, a tray submenu that only bound whichever
  // avatar was resident. cast.open puts it on all three; room.steer needs a
  // scoped body/row first, so it skips tray on purpose (not a whySingle case --
  // it still names two surfaces).
  const cast = byId("cast.open");
  assert.ok(cast, "cast.open is missing from the registry");
  assert.equal(cast.group, "avatar");
  assert.deepEqual(cast.surfaces, ["tray", "avatar-menu", "palette"]);
  assert.equal(cast.whySingle, undefined, "cast.open is multi-surface, whySingle is not its job");

  const steer = byId("room.steer");
  assert.ok(steer, "room.steer is missing from the registry");
  assert.equal(steer.group, "room");
  assert.deepEqual(steer.surfaces, ["avatar-menu", "palette"]);
  assert.equal(steer.whySingle, undefined, "room.steer names two surfaces, not one");
});

test("every surface renders, and separators come from groups", () => {
  for (const surface of SURFACES) {
    const ran = [];
    const template = buildMenu(surface, (id) => ran.push(id), {
      ctx: { avatarShown: true, decisionsWaiting: 2, decisionsTotal: 5 },
      submenus: Object.fromEntries(
        commandsFor(surface).filter((c) => c.dynamic).map((c) => [c.id, [{ label: "x" }]]),
      ),
    });
    assert.ok(template.length > 0, `${surface} rendered nothing`);
    assert.ok(!template[0].type, `${surface} starts with a separator`);
    assert.ok(!template[template.length - 1].type, `${surface} ends with a separator`);
    for (let i = 1; i < template.length; i += 1) {
      assert.ok(
        !(template[i].type === "separator" && template[i - 1].type === "separator"),
        `${surface} has two separators in a row`,
      );
    }
    // Every non-dynamic row must actually do something.
    const clickable = template.filter((row) => typeof row.click === "function");
    clickable[0].click();
    assert.equal(ran.length, 1, "a rendered row did not reach run()");
  }
});

test("a dynamic command with no submenu is DROPPED, never rendered dead", () => {
  const template = buildMenu("tray", () => {}, { submenus: {} });
  const labels = template.map((row) => row.label).filter(Boolean);
  assert.ok(!labels.includes("Avatar window size"),
    "a size menu with no presets behind it is a row that does nothing");
  assert.ok(labels.includes("Aither Console…"), "static rows must still render");
});

test("counting labels say what is actually waiting", () => {
  const label = (ctx) => byId("inbox.open").label(ctx);
  assert.equal(label({ decisionsWaiting: 1, decisionsTotal: 3 }), "Inbox — 1 decision waiting");
  assert.equal(label({ decisionsWaiting: 0, decisionsTotal: 3 }), "Inbox — 3 cards");
  assert.equal(label({}), "Inbox");
});

test("every command either has a handler or a dynamic submenu", () => {
  // A row that renders and does nothing is the failure mode a registry invites:
  // the inventory is easy to extend, the switch is easy to forget.
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const at = main.indexOf("function runCommand(");
  assert.ok(at > 0, "runCommand is gone -- the registry has no HOW");
  const body = main.slice(at, main.indexOf("\nfunction ", at + 10));
  const trayAt = main.indexOf("buildMenu(\"tray\"");
  const traySubmenus = main.slice(trayAt, trayAt + 600);
  for (const command of COMMANDS) {
    if (command.dynamic) {
      assert.match(
        traySubmenus,
        new RegExp(`"${command.id.replace(".", "\\.")}":`),
        `${command.id} is dynamic but nothing supplies its submenu`,
      );
      continue;
    }
    // A command is answerable three ways: a case in the switch, a dynamic submenu,
    // or DATA on its own record -- the size presets and the stage arrangements --
    // which the default branch applies without a case per entry.
    if (command.size) {
      assert.match(body, /command\.size/, "the size branch is gone");
      continue;
    }
    if (command.arrangement) {
      assert.match(body, /command\.arrangement/, "the arrangement branch is gone");
      assert.match(body, /stage-arrange/, "nothing sends the arrangement to the renderer");
      continue;
    }
    if (command.fleet) {
      // Fleet/ARC verbs are data too: the verb must be one the runner knows (or
      // the panel opener), and the default branch must hand it over.
      assert.match(body, /command\.fleet/, "the fleet branch is gone");
      assert.match(body, /runFleetCommand/, "nothing routes a fleet verb to fleetAction");
      const known = command.fleet === "open_panel" || Object.prototype.hasOwnProperty.call(fleetActions, command.fleet);
      assert.ok(known, `${command.id} names fleet verb "${command.fleet}" that fleet-control.cjs does not know`);
      continue;
    }
    assert.ok(body.includes(`"${command.id}"`), `${command.id} has no case in runCommand`);
  }
});

test("main.cjs RENDERS the tray from the registry, it does not hand-write it", () => {
  // The whole point: three menus drifted because each was a literal template.
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const built = main.indexOf("commandRegistry.buildMenu(\"tray\"");
  const set = main.indexOf("tray?.setContextMenu(");
  assert.ok(built > 0, "the tray is no longer rendered from the registry");
  assert.ok(set > built, "the tray menu is set before it is rendered");
  // and what it sets is that template, not a second hand-written one.
  assert.match(main.slice(set, set + 200), /Menu\.buildFromTemplate\(trayTemplate\)/);
});
