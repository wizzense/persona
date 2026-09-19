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
 * - `fleet`     a fleet/ARC verb (fleet-control.cjs ACTIONS, or `open_panel`);
 *               main routes it to fleetAction. `destructive` marks the ones a
 *               menu should not fire on a slip -- main confirms those first.
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
  // 🚩 The commands this registry was born for. They are on the tray as well as
  // the avatar's own menu because that menu needs a right-click that lands on a
  // BODY: with the avatar hidden, tiny or off-screen there was no path at all.
  //
  // The presets are DATA here rather than a submenu main builds, so the palette
  // can list them one per row while the menus nest them. A dynamic submenu is
  // invisible to anything that is not a menu -- which is how "size" stayed
  // unreachable from everywhere except one gesture.
  Object.freeze({
    id: "window.size.small", label: "Small", group: "window-size",
    surfaces: ["tray", "avatar-menu", "palette"], size: Object.freeze({ width: 430, height: 680 }),
  }),
  Object.freeze({
    id: "window.size.medium", label: "Medium", group: "window-size",
    surfaces: ["tray", "avatar-menu", "palette"], size: Object.freeze({ width: 600, height: 950 }),
  }),
  Object.freeze({
    id: "window.size.large", label: "Large", group: "window-size",
    surfaces: ["tray", "avatar-menu", "palette"], size: Object.freeze({ width: 800, height: 1266 }),
  }),
  Object.freeze({
    id: "window.size.xlarge", label: "Extra large", group: "window-size",
    surfaces: ["tray", "avatar-menu", "palette"], size: Object.freeze({ width: 1000, height: 1583 }),
  }),
  Object.freeze({
    id: "window.size.bigger", label: "Bigger  (Ctrl+Shift+=)", group: "window-size",
    surfaces: ["tray", "avatar-menu", "palette"],
  }),
  Object.freeze({
    id: "window.size.smaller", label: "Smaller  (Ctrl+Shift+-)", group: "window-size",
    surfaces: ["tray", "avatar-menu", "palette"],
  }),
  // Plan 40 slice C. The mic used to live in ONE React section of the deck, so
  // talking to the agents meant finding that pane first. The label says which
  // way the toggle goes, because a button that might already be listening is a
  // button nobody presses.
  Object.freeze({
    id: "voice.talk", group: "avatar",
    surfaces: ["tray", "avatar-menu", "palette"],
    label: (ctx = {}) => (ctx.listening ? "Stop listening  (Ctrl+Shift+Space)"
      : "Talk to the agents  (Ctrl+Shift+Space)"),
  }),
  Object.freeze({
    id: "characters.pick", label: "Characters", group: "avatar",
    surfaces: ["tray", "avatar-menu", "palette"], dynamic: true,
  }),
  // U27 (owner, 2026-09-19): today the ONLY way to assign an agent's avatar a
  // voice/cast identity is the same nested tray submenu this file was built to
  // replace -- reachable only from whichever character is resident right now.
  // cast.open is the one door onto cast.json (U01) from all three surfaces.
  Object.freeze({
    id: "cast.open", label: "Cast & voices…", group: "avatar",
    surfaces: ["tray", "avatar-menu", "palette"],
  }),
  // Plan 40 slice G, "think macOS Stage Manager": the verbs for a stage with
  // several bodies on it. Arranging four avatars by dragging each one is the work
  // this removes, and on a frameless overlay it is also the least accurate work
  // there is. The renderer owns the geometry; a command only names the shape.
  Object.freeze({
    id: "stage.row", label: "Stage: line them up", group: "stage",
    surfaces: ["tray", "avatar-menu", "palette"], arrangement: "row",
  }),
  Object.freeze({
    id: "stage.arc", label: "Stage: gather in an arc", group: "stage",
    surfaces: ["tray", "avatar-menu", "palette"], arrangement: "arc",
  }),
  Object.freeze({
    id: "stage.pair", label: "Stage: face each other", group: "stage",
    surfaces: ["tray", "avatar-menu", "palette"], arrangement: "pair",
  }),
  Object.freeze({
    id: "stage.focus", label: "Stage: focus one, others step back", group: "stage",
    surfaces: ["tray", "avatar-menu", "palette"], arrangement: "focus",
  }),
  Object.freeze({
    id: "stage.reset", label: "Stage: reset everyone", group: "stage",
    surfaces: ["tray", "avatar-menu", "palette"], arrangement: "reset",
  }),
  // U27, the second half of the same regression: talking to a session meant
  // finding its body first. Not on tray -- "this session" is meaningless
  // without a body or a palette row already scoped to one, unlike cast.open.
  Object.freeze({
    id: "room.steer", label: "Message this session…", group: "room",
    surfaces: ["avatar-menu", "palette"],
  }),
  // Command and control (owner, 2026-09-19: "i need controls in awdesk and awsh").
  // Until today the fleet verbs lived on ONE page (the Fleet window) and the ARC
  // verbs lived nowhere a human could click -- a solver that had been stopped
  // twice overnight could only be restarted from a shell. A `fleet` record is
  // DATA: main hands the verb to the same runner the Fleet window and the MCP
  // `fleet_control` tool use, so a tray click, a palette row, an awsh command
  // and an agent call execute the same script with the same argv.
  Object.freeze({
    id: "fleet.open", label: "Fleet window…", group: "fleet",
    surfaces: ["tray", "palette"], fleet: "open_panel",
  }),
  Object.freeze({
    id: "fleet.gaming", label: "GPU quiet (game on)", group: "fleet",
    surfaces: ["tray", "palette"], fleet: "gaming", destructive: true,
  }),
  Object.freeze({
    id: "fleet.resume", label: "GPU resume (game off)", group: "fleet",
    surfaces: ["tray", "palette"], fleet: "resume",
  }),
  Object.freeze({
    id: "arc.status", label: "ARC: is it solving?", group: "arc",
    surfaces: ["tray", "palette"], fleet: "arc-status",
  }),
  Object.freeze({
    id: "arc.now", label: "ARC: run now (4 h, overrides quiet hours)", group: "arc",
    surfaces: ["tray", "palette"], fleet: "arc-now",
  }),
  Object.freeze({
    id: "arc.start", label: "ARC: start (respect quiet hours)", group: "arc",
    surfaces: ["tray", "palette"], fleet: "arc-start",
  }),
  Object.freeze({
    id: "arc.stop", label: "ARC: stop the solver", group: "arc",
    surfaces: ["tray", "palette"], fleet: "arc-stop", destructive: true,
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

/** One group's commands on a surface -- what a menu nests and a palette flattens. */
function groupFor(group, surface) {
  return commandsFor(surface).filter((command) => command.group === String(group));
}

/**
 * The palette's rows: id + resolved label + group, nothing a page cannot render.
 *
 * A palette entry says which MENU would also have offered it, because "I know it
 * is in a menu somewhere" is the state the palette exists to end.
 */
function paletteRows(ctx = {}) {
  return commandsFor("palette")
    .filter((command) => !command.dynamic)
    .map((command) => ({
      id: command.id,
      label: labelOf(command, ctx),
      group: command.group,
    }));
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
function buildMenu(surface, run, { ctx = {}, submenus = {}, nest = {} } = {}) {
  const wanted = commandsFor(surface);
  const template = [];
  const nested = new Set();
  let lastGroup = null;
  for (const command of wanted) {
    if (command.dynamic && !submenus[command.id]) continue;
    const nestLabel = nest[command.group];
    if (nestLabel && nested.has(command.group)) continue;
    if (lastGroup !== null && command.group !== lastGroup) template.push({ type: "separator" });
    lastGroup = command.group;
    if (nestLabel) {
      // A menu nests a group; the palette lists the same commands one per row.
      // Both read this list, so neither can carry an entry the other lacks.
      nested.add(command.group);
      template.push({
        label: nestLabel,
        submenu: groupFor(command.group, surface).map((child) => ({
          label: labelOf(child, ctx),
          click: () => run(child.id),
        })),
      });
      continue;
    }
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

module.exports = {
  SURFACES, COMMANDS, commandsFor, groupFor, paletteRows, byId, labelOf, buildMenu, conformance,
};
