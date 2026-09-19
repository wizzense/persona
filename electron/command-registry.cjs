"use strict";

/**
 * The command registry — ONE inventory of what Desk can do, and where each
 * capability appears.
 *
 * WHY THIS EXISTS (owner, 2026-09-18): "the whole UI/UX is starting to just
 * become a stacked mess of things -- we need a real proper reimplementation
 * that makes this actually functional."
 *
 * The mess is not visual. Measured that day: 10 BrowserWindows across 7 modules,
 * 6 preload bridges, 43 ipcMain channels, and THREE menus (tray, avatar
 * right-click, console bar) that each listed capabilities by hand. Nothing in
 * the tree could answer "where does this capability appear?", so:
 *
 *   - avatar window size hung off exactly ONE gesture (a right-click that lands
 *     on a body and travels under 6px) plus two global shortcuts whose
 *     registration result was discarded. A gesture change removed it, silently.
 *   - "Aither Console…" was hand-written in three templates, and each menu drifted
 *     from the others between consolidations (09-13 was the last one).
 *
 * So menus stop being hand-written. Every capability is declared HERE once, with
 * the surfaces it belongs on, and each menu is RENDERED from this list. A
 * capability that reaches only one surface must say why, in the record, where a
 * reviewer sees it -- `conformance()` fails otherwise, and its test fails with it.
 *
 * This module is deliberately electron-free and side-effect-free: it is data plus
 * two pure functions, so the inventory can be asserted under `node --test`
 * without a window. Behaviour stays in main.cjs, injected as `run(id)`.
 *
 * Slice 1 of docs/UX-REIMPLEMENTATION.md. Slice 2 gives routes the same
 * treatment (one owner for "where is this surface right now").
 */

/** Every surface that can present a command. A palette lands in slice 1b. */
const SURFACES = Object.freeze(["tray", "avatar-menu", "palette"]);

/**
 * The inventory.
 *
 * - `id`        stable, dotted, never shown to anyone.
 * - `label`     a string, or (ctx) => string for the ones that count things.
 * - `surfaces`  where it appears. Order within a surface follows this array.
 * - `group`     menu separators are derived from a group change, never placed by hand.
 * - `dynamic`   the submenu is built by main at popup time (roster, sizes).
 * - `whySingle` REQUIRED when `surfaces` names exactly one. It is the review note
 *               that stops another gesture-only affordance being born by accident.
 */
const COMMANDS = Object.freeze([
  Object.freeze({
    id: "console.open", label: "Aither Console…", group: "go",
    surfaces: ["tray", "avatar-menu", "palette"],
  }),
  Object.freeze({
    id: "inbox.open", group: "go",
    surfaces: ["tray", "palette"],
    label: (ctx = {}) => {
      const waiting = Number(ctx.decisionsWaiting || 0);
      const total = Number(ctx.decisionsTotal || 0);
      if (waiting > 0) return `Inbox — ${waiting} decision${waiting === 1 ? "" : "s"} waiting`;
      if (total > 0) return `Inbox — ${total} card${total === 1 ? "" : "s"}`;
      return "Inbox";
    },
  }),
  Object.freeze({
    id: "avatar.toggle", group: "avatar",
    surfaces: ["tray", "palette"],
    label: (ctx = {}) => (ctx.avatarShown ? "Hide avatar" : "Show avatar"),
  }),
  // 🚩 The command this registry was born for. It is on the tray as well as the
  // avatar's own menu because the avatar menu needs a right-click that lands on
  // a BODY: with the avatar hidden, tiny, or off-screen there was no path at all.
  Object.freeze({
    id: "window.size", label: "Avatar window size", group: "avatar",
    surfaces: ["tray", "avatar-menu", "palette"], dynamic: true,
  }),
  Object.freeze({
    id: "characters.pick", label: "Characters", group: "avatar",
    surfaces: ["tray", "avatar-menu", "palette"], dynamic: true,
  }),
  Object.freeze({
    id: "about", label: "About Desk", group: "app",
    surfaces: ["tray", "palette"],
  }),
  Object.freeze({
    id: "quit", label: "Quit", group: "app", surfaces: ["tray"],
    whySingle: "Quitting from a palette or a body's context menu is a misclick with "
      + "no undo; the tray is the deliberate place for it.",
  }),
]);

/** The commands on one surface, in declaration order. */
function commandsFor(surface) {
  return COMMANDS.filter((command) => command.surfaces.includes(surface));
}

function byId(id) {
  return COMMANDS.find((command) => command.id === String(id || "")) || null;
}

function labelOf(command, ctx) {
  return typeof command.label === "function" ? command.label(ctx || {}) : command.label;
}

/**
 * Render one surface to a menu template.
 *
 * Returns PLAIN objects (`{ label, click }` / `{ type: "separator" }` /
 * `{ label, submenu }`), so Electron is not needed to assert the shape. Separators
 * come from `group` changes -- a menu cannot grow a stray divider by hand.
 *
 * `run(id)` performs a command. `submenus[id]` supplies a dynamic command's items;
 * a dynamic command with no submenu supplied is DROPPED rather than rendered as a
 * dead row, because a menu entry that does nothing is worse than an absent one.
 */
function buildMenu(surface, run, { ctx = {}, submenus = {} } = {}) {
  const wanted = commandsFor(surface);
  const template = [];
  let lastGroup = null;
  for (const command of wanted) {
    if (command.dynamic && !submenus[command.id]) continue;
    if (lastGroup !== null && command.group !== lastGroup) template.push({ type: "separator" });
    lastGroup = command.group;
    const label = labelOf(command, ctx);
    if (command.dynamic) template.push({ label, submenu: submenus[command.id] });
    else template.push({ label, click: () => run(command.id) });
  }
  return template;
}

/**
 * Everything wrong with the inventory itself, as sentences. Empty = healthy.
 *
 * Exported (not just tested) so a future palette or a startup assertion can read
 * the same verdict: a checker nobody can run from the app is documentation.
 */
function conformance() {
  const problems = [];
  const seen = new Set();
  for (const command of COMMANDS) {
    if (seen.has(command.id)) problems.push(`duplicate id: ${command.id}`);
    seen.add(command.id);
    if (!command.label) problems.push(`${command.id} has no label`);
    if (!command.group) problems.push(`${command.id} has no group`);
    if (!Array.isArray(command.surfaces) || command.surfaces.length === 0) {
      problems.push(`${command.id} names no surface -- it is unreachable`);
      continue;
    }
    for (const surface of command.surfaces) {
      if (!SURFACES.includes(surface)) problems.push(`${command.id} names unknown surface ${surface}`);
    }
    // The rule the size regression earned: one entry point is allowed only as a
    // decision somebody wrote down.
    if (command.surfaces.length === 1 && !command.whySingle) {
      problems.push(`${command.id} reaches only ${command.surfaces[0]} and gives no whySingle`);
    }
  }
  return problems;
}

module.exports = { SURFACES, COMMANDS, commandsFor, byId, labelOf, buildMenu, conformance };
