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

/**
 * Every surface that can present a command.
 *
 * `beads` is the round button rail beside the avatar and `jumplist` is the Windows
 * taskbar's right-click list. Both were hand-wired (a `desk:deck-action` verb per
 * bead, no jump list at all), which is how the chat bead came to say "Talk to
 * Aither" while the tray said "Talk to the agents" and meant the microphone.
 */
const SURFACES = Object.freeze(["tray", "avatar-menu", "palette", "beads", "jumplist"]);

/**
 * A group's ONE parent label, for every menu that nests it.
 *
 * Owner, 2026-09-20: "the whole task bar tray menu is completely different and
 * disconnected". Measured that day: the same six size rows sat under "Avatar
 * window size" on the tray and "Avatar window" on the avatar's menu, because
 * each caller passed its own `nest` map. The label is DATA here, so a group
 * cannot be called two things. A group with no entry renders flat.
 */
const GROUPS = Object.freeze({
  desktop: Object.freeze({ menu: "AitherOS Online" }),
  "window-size": Object.freeze({ menu: "Avatar window" }),
  stage: Object.freeze({ menu: "Stage" }),
  fleet: Object.freeze({ menu: "Fleet" }),
  arc: Object.freeze({ menu: "ARC" }),
  blog: Object.freeze({ menu: "Blog" }),
});

/**
 * Group ORDER per menu. Commands keep declaration order inside a group; a group
 * not named here follows the named ones in declaration order.
 *
 * The two menus answer different questions, so they lead with different groups:
 * the tray is "where do I go" (console, inbox, the desktop), a body's menu is
 * "what about THIS one" (talk to it, move it) and ends on the way out. The
 * ITEMS are one list; only the reading order differs.
 */
const LAYOUT = Object.freeze({
  tray: Object.freeze(["go", "desktop", "avatar", "window-size", "talk", "stage", "fleet", "arc", "blog", "app"]),
  "avatar-menu": Object.freeze(["talk", "body", "stage", "window-size", "avatar", "slot", "desktop", "go"]),
  // The rail reads top to bottom: what is waiting, where to go, who to talk to,
  // the desktop. The bell stays on top -- it is the one bead read without a click.
  beads: Object.freeze(["go", "talk", "desktop"]),
});

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
 * - `blog`      a blog verb (blog-commands.cjs BLOG_VERBS): main routes it to
 *               runBlogCommand, which speaks to the gateway's blog_* MCP tools.
 *               NO verb publishes: `publish` opens the Veil editor for a human.
 * - `prompt`    `{ placeholder }` -- the command needs ONE typed argument (a title,
 *               a slug). Only the palette has a text field, so a prompt command
 *               may name no other surface (`conformance()` refuses), and it still
 *               writes a `whySingle` like every other single-surface record.
 * - `whySingle` REQUIRED when `surfaces` names exactly one. It is the review note
 *               that stops another gesture-only affordance being born by accident.
 * - `menuLabel` the label INSIDE a nested group, where the parent already says
 *               the noun ("Stage ▸ Line them up"). The palette has no parent, so
 *               it keeps `label` ("Stage: line them up"). Same command, same id.
 * - `accel`     the global shortcut, in the form a human reads ("Ctrl+Shift+D").
 *               main REGISTERS shortcuts from this field and reports the ones it
 *               could not get in `ctx.deadAccels`; a label only advertises a key
 *               that is really bound. It used to be typed into the label text, so
 *               a key another app held was still promised on every menu.
 * - `scope`     "slot" -- the command is about ONE body. It renders only when
 *               `ctx.slotId` is set (a right-click that landed on a body) and its
 *               handler receives that slot. Off a body it does not exist, rather
 *               than existing as a row that acts on nothing.
 * - `when`      (ctx) => boolean. A row that does not apply is ABSENT.
 * - `enabled`   (ctx) => boolean. A row that applies but cannot act yet is greyed.
 * - `type` / `checked`  "checkbox" | "radio" with (ctx) => boolean, for the
 *               desktop's live switches. The state is main's; the row only reads it.
 */
const COMMANDS = Object.freeze([
  Object.freeze({
    id: "inbox.open", group: "go", icon: "bell",
    surfaces: ["tray", "palette", "beads", "jumplist"],
    label: (ctx = {}) => {
      const waiting = Number(ctx.decisionsWaiting || 0);
      const total = Number(ctx.decisionsTotal || 0);
      if (waiting > 0) return `Inbox — ${waiting} decision${waiting === 1 ? "" : "s"} waiting`;
      if (total > 0) return `Inbox — ${total} card${total === 1 ? "" : "s"}`;
      return "Inbox";
    },
  }),
  Object.freeze({
    id: "console.open", label: "Aither Console…", group: "go", icon: "grid",
    surfaces: ["tray", "avatar-menu", "palette", "beads", "jumplist"],
  }),
  // 🚩 AitherOS Online -- the Living Desktop held over the real one. It is what the
  // ecosystem registry says this app IS ("tray, avatars, decision cards, the Living
  // Desktop as an overlay"), and from 2026-09-13 to 2026-09-20 no human could open
  // it: the 09-13 menu consolidation deleted its two tray rows, this registry was
  // written five days later from the menus that were left, and the overlay was
  // never re-declared. It survived as a protocol URL, a CLI flag and an MCP tool
  // -- reachable by an agent, not by the owner. Its menu fragment
  // (buildLivingDesktopMenu) sat exported with zero callers the whole time.
  //
  // These records ARE that fragment, so the shell picker, ghost mode and sign-in
  // are on the tray, on every body's menu and in the palette, and a future
  // consolidation cannot drop them without failing `conformance()`'s reach test.
  Object.freeze({
    id: "desktop.overlay.toggle", group: "desktop", accel: "Ctrl+Shift+D", icon: "desktop",
    surfaces: ["tray", "avatar-menu", "palette", "beads", "jumplist"],
    label: (ctx = {}) => (ctx.overlayVisible ? "Hide AitherOS Online overlay" : "Open AitherOS Online overlay"),
    menuLabel: (ctx = {}) => (ctx.overlayVisible ? "Hide overlay" : "Open overlay"),
  }),
  Object.freeze({
    id: "desktop.app.open", label: "AitherOS Online: open as a window…", menuLabel: "Open as a window…",
    group: "desktop", surfaces: ["tray", "avatar-menu", "palette"],
  }),
  // The shells mirror Veil's SHELL_REGISTRY (components/os/shell-registry.tsx). An
  // id Veil does not know falls back to the Living OS server-side, so a stale row
  // here degrades to the default rather than to a blank overlay.
  Object.freeze({
    id: "desktop.shell.living-os", label: "AitherOS Online shell: Living Desktop", menuLabel: "Shell: Living Desktop",
    group: "desktop", surfaces: ["tray", "avatar-menu", "palette"],
    shell: null, type: "radio", checked: (ctx = {}) => !ctx.overlayShell,
  }),
  Object.freeze({
    id: "desktop.shell.aither-desktop", label: "AitherOS Online shell: Desktop Anywhere", menuLabel: "Shell: Desktop Anywhere",
    group: "desktop", surfaces: ["tray", "avatar-menu", "palette"],
    shell: "aither-desktop", type: "radio", checked: (ctx = {}) => ctx.overlayShell === "aither-desktop",
  }),
  Object.freeze({
    id: "desktop.shell.aither-shell", label: "AitherOS Online shell: awsh cockpit", menuLabel: "Shell: awsh cockpit",
    group: "desktop", surfaces: ["tray", "avatar-menu", "palette"],
    shell: "aither-shell", type: "radio", checked: (ctx = {}) => ctx.overlayShell === "aither-shell",
  }),
  Object.freeze({
    id: "desktop.shell.gobbonet", label: "AitherOS Online shell: GobboNet", menuLabel: "Shell: GobboNet",
    group: "desktop", surfaces: ["tray", "avatar-menu", "palette"],
    shell: "gobbonet", type: "radio", checked: (ctx = {}) => ctx.overlayShell === "gobbonet",
  }),
  Object.freeze({
    id: "desktop.overlay.ghost", label: "AitherOS Online: click-through desktop", menuLabel: "Click-through desktop",
    group: "desktop", surfaces: ["tray", "avatar-menu", "palette"],
    type: "checkbox", checked: (ctx = {}) => Boolean(ctx.overlayGhost),
  }),
  Object.freeze({
    id: "desktop.overlay.solid", label: "AitherOS Online: solid background", menuLabel: "Solid background",
    group: "desktop", surfaces: ["tray", "avatar-menu", "palette"],
    type: "checkbox", checked: (ctx = {}) => Boolean(ctx.overlaySolid),
  }),
  Object.freeze({
    id: "desktop.overlay.reload", label: "AitherOS Online: reload", menuLabel: "Reload",
    group: "desktop", surfaces: ["tray", "avatar-menu", "palette"],
    enabled: (ctx = {}) => Boolean(ctx.overlayOpen),
  }),
  Object.freeze({
    id: "desktop.signin", label: "AitherOS Online: sign in…", menuLabel: "Sign in…",
    group: "desktop", surfaces: ["tray", "avatar-menu", "palette"],
  }),
  Object.freeze({
    id: "avatar.toggle", group: "avatar", accel: "Ctrl+Shift+A",
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
    id: "window.size.bigger", label: "Avatar window: bigger", menuLabel: "Bigger",
    group: "window-size", accel: "Ctrl+Shift+=",
    surfaces: ["tray", "avatar-menu", "palette"],
  }),
  Object.freeze({
    id: "window.size.smaller", label: "Avatar window: smaller", menuLabel: "Smaller",
    group: "window-size", accel: "Ctrl+Shift+-",
    surfaces: ["tray", "avatar-menu", "palette"],
  }),
  // These two lived ONLY in the hand-written avatar menu, appended after the
  // registry's size rows -- so the tray's "Avatar window size" and the body's
  // "Avatar window" were different menus with different contents.
  Object.freeze({
    id: "window.outline", label: "Avatar window: show / hide its boundary", menuLabel: "Show / hide boundary",
    group: "window-size", surfaces: ["tray", "avatar-menu", "palette"],
  }),
  Object.freeze({
    id: "layout.reset-all", label: "Avatar window: reset every avatar's layout (reload)",
    menuLabel: "Reset every avatar's layout (reload)",
    group: "window-size", surfaces: ["tray", "avatar-menu", "palette"],
  }),
  // 🚩 "Talk" meant TWO things under THREE labels (measured 2026-09-20): the tray's
  // "Talk to the agents" toggled the MICROPHONE, the avatar menu's "Talk to <agent>"
  // and the chat bead's "Talk to Aither" opened the CHAT pane -- and the avatar
  // menu's row sat where the registry said voice.talk lived, so the mic was
  // unreachable from the one surface you are looking at a body on. One verb per
  // meaning now: you SPEAK with your voice, you CHAT in the pane.
  //
  // Plan 40 slice C: the label says which way the toggle goes, because a button
  // that might already be listening is a button nobody presses.
  Object.freeze({
    id: "voice.talk", group: "talk", accel: "Ctrl+Shift+Space", icon: "mic",
    surfaces: ["tray", "avatar-menu", "palette", "jumplist"],
    label: (ctx = {}) => (ctx.listening ? "Stop listening" : "Speak to the agents (microphone)"),
  }),
  // Plan: configurable voice + hotkeys (owner 2026-09-22: "let you click on the
  // avatar... enable voice mode or mute"). A dedicated mute toggle separate from
  // voice.talk: muting must not depend on remembering whether you were mid-listen.
  Object.freeze({
    id: "voice.mute", group: "talk", accel: "Ctrl+Shift+M", icon: "mic-off",
    surfaces: ["tray", "avatar-menu", "palette"],
    label: (ctx = {}) => (ctx.micMuted ? "Unmute microphone" : "Mute microphone"),
  }),
  // The settings page the owner asked for by name ("there still isnt just a
  // shared settings page"). Opens as a console pane (kind:"file", no vite
  // build) so it ships without touching the React bundle.
  Object.freeze({
    id: "settings.open", group: "avatar", accel: "Ctrl+Shift+,", icon: "settings",
    surfaces: ["tray", "avatar-menu", "palette"],
    label: "Settings…",
  }),
  Object.freeze({
    id: "chat.open", group: "talk", icon: "chat",
    surfaces: ["tray", "avatar-menu", "palette", "beads"],
    label: (ctx = {}) => `Chat with ${ctx.agent || "Aither"}…`,
  }),
  // U27, the second half of the same regression: talking to a session meant
  // finding its body first. Not on tray -- "this session" is meaningless
  // without a body or a palette row already scoped to one, unlike cast.open.
  // On a body with no live session behind it the row is greyed, not hidden: it
  // tells you an ordinary character has nobody to steer.
  Object.freeze({
    id: "room.steer", label: "Message this session…", group: "talk",
    surfaces: ["avatar-menu", "palette"],
    enabled: (ctx = {}) => !ctx.slotId || Boolean(ctx.sessionAddress),
  }),
  // The body verbs. They were literals in popupAvatarMenu; as records they are
  // also palette rows ("frame everyone" needs no body) and the handler is the
  // one runCommand switch instead of five closures.
  Object.freeze({
    id: "avatar.focus", label: "Focus camera here", group: "body", scope: "slot",
    surfaces: ["avatar-menu"],
    whySingle: "'Here' is the body that was right-clicked; no other surface has a body in hand. "
      + "stage.focus is the unscoped twin on the tray and the palette.",
  }),
  Object.freeze({
    id: "avatar.frame-all", label: "Frame everyone", group: "body",
    surfaces: ["avatar-menu", "palette"],
  }),
  Object.freeze({
    id: "avatar.reset", label: "Reset position & size", group: "body", scope: "slot",
    surfaces: ["avatar-menu"],
    whySingle: "Resets ONE body, so it needs the body that was right-clicked. "
      + "layout.reset-all is the everywhere twin.",
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
    id: "stage.row", label: "Stage: line them up", menuLabel: "Line them up", group: "stage",
    surfaces: ["tray", "avatar-menu", "palette"], arrangement: "row",
  }),
  Object.freeze({
    id: "stage.arc", label: "Stage: gather in an arc", menuLabel: "Gather in an arc", group: "stage",
    surfaces: ["tray", "avatar-menu", "palette"], arrangement: "arc",
  }),
  Object.freeze({
    id: "stage.pair", label: "Stage: face each other", menuLabel: "Face each other", group: "stage",
    surfaces: ["tray", "avatar-menu", "palette"], arrangement: "pair",
  }),
  Object.freeze({
    id: "stage.focus", label: "Stage: focus one, others step back", menuLabel: "Focus one, others step back", group: "stage",
    surfaces: ["tray", "avatar-menu", "palette"], arrangement: "focus",
  }),
  Object.freeze({
    id: "stage.reset", label: "Stage: reset everyone", menuLabel: "Reset everyone", group: "stage",
    surfaces: ["tray", "avatar-menu", "palette"], arrangement: "reset",
  }),
  Object.freeze({
    id: "avatar.remove", label: "Remove this avatar", group: "slot", scope: "slot",
    surfaces: ["avatar-menu"], when: (ctx = {}) => Boolean(ctx.removable),
    whySingle: "Removes ONE spawned body, so it needs the body that was right-clicked; the "
      + "Stage pane's 'Send away' is the same action with the body chosen from a list.",
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
    id: "arc.status", label: "ARC: is it solving?", menuLabel: "Is it solving?", group: "arc",
    surfaces: ["tray", "palette"], fleet: "arc-status",
  }),
  Object.freeze({
    id: "arc.now", label: "ARC: run now (4 h, overrides quiet hours)", menuLabel: "Run now (4 h, overrides quiet hours)", group: "arc",
    surfaces: ["tray", "palette"], fleet: "arc-now",
  }),
  Object.freeze({
    id: "arc.start", label: "ARC: start (respect quiet hours)", menuLabel: "Start (respect quiet hours)", group: "arc",
    surfaces: ["tray", "palette"], fleet: "arc-start",
  }),
  Object.freeze({
    id: "arc.stop", label: "ARC: stop the solver", menuLabel: "Stop the solver", group: "arc",
    surfaces: ["tray", "palette"], fleet: "arc-stop", destructive: true,
  }),
  // Blog (owner ruling 2026-09-19, .claude/rules/blog-voice.md): machine paths
  // create DRAFTS; a human publishes. These records speak to the gateway's
  // blog_* MCP tools through gateway-mcp.cjs -- the same client the market and
  // system panels use -- so the desk never grows a second Veil credential.
  // `blog.publish` therefore does NOT publish: it opens the Veil editor for the
  // slug, where the owner reads the draft and flips the status with a click.
  Object.freeze({
    id: "blog.list", label: "Blog: list posts (drafts included)", menuLabel: "List posts (drafts included)", group: "blog",
    surfaces: ["tray", "palette"], blog: "list",
  }),
  Object.freeze({
    id: "blog.draft", label: "Blog: new draft…", group: "blog",
    surfaces: ["palette"], blog: "draft",
    prompt: Object.freeze({ placeholder: "Title for the new draft" }),
    whySingle: "Needs a typed title; the palette is the only surface with a text "
      + "field. A tray row could only create an untitled draft.",
  }),
  Object.freeze({
    id: "blog.show", label: "Blog: show a post…", group: "blog",
    surfaces: ["palette"], blog: "show",
    prompt: Object.freeze({ placeholder: "Post slug (e.g. bonsai-2-ptq-verdict)" }),
    whySingle: "Needs a typed slug; the palette is the only surface with a text field.",
  }),
  Object.freeze({
    id: "blog.publish", label: "Blog: open in the Veil editor to publish…", group: "blog",
    surfaces: ["palette"], blog: "publish",
    prompt: Object.freeze({ placeholder: "Slug of the draft to review and publish" }),
    whySingle: "Needs a typed slug; the palette is the only surface with a text field. "
      + "Opens the editor -- publishing itself is the human's click there.",
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
    .filter((command) => !command.dynamic && appliesTo(command, ctx))
    .map((command) => ({
      id: command.id,
      label: labelOf(command, ctx),
      group: command.group,
      // The shell asks for the argument before it calls run(id, arg); a row
      // without `prompt` runs on Enter as before.
      ...(command.prompt ? { prompt: { placeholder: String(command.prompt.placeholder || "") } } : {}),
    }));
}

/** Does this command exist for this caller? `scope: "slot"` needs a body in hand. */
function appliesTo(command, ctx = {}) {
  if (command.scope === "slot" && !ctx.slotId) return false;
  if (typeof command.when === "function" && !command.when(ctx)) return false;
  return true;
}

/**
 * A command's label. `nested` picks `menuLabel` (the parent already said the noun).
 * The shortcut is appended only when main really holds it: `ctx.deadAccels` lists
 * the ones `globalShortcut.register` refused, and a key another app owns is not
 * promised on a menu.
 */
function labelOf(command, ctx, { nested = false } = {}) {
  const pick = nested && command.menuLabel ? command.menuLabel : command.label;
  const text = typeof pick === "function" ? pick(ctx || {}) : pick;
  const dead = (ctx && ctx.deadAccels) || [];
  return command.accel && !dead.includes(command.accel) ? `${text}  (${command.accel})` : text;
}

/** "Ctrl+Shift+D" -> Electron's "CommandOrControl+Shift+D". */
function electronAccel(accel) {
  return String(accel || "").replace(/^Ctrl\+/, "CommandOrControl+");
}

/** Every command that owns a global shortcut, for main to register from. */
function shortcuts(overrides = {}) {
  // overrides: id -> accel string from cast.json's hotkeys{} (Plan: configurable
  // hotkeys, owner 2026-09-22). Falls back to the DEFAULT accel so a machine
  // with no overrides behaves exactly as before this landed.
  return COMMANDS.filter((command) => command.accel)
    .map((command) => {
      const accel = (overrides && typeof overrides[command.id] === "string" && overrides[command.id].trim())
        || command.accel;
      return { id: command.id, accel, electron: electronAccel(accel), defaultAccel: command.accel };
    });
}

/** The groups of one surface, in that surface's reading order (see LAYOUT). */
function groupOrder(surface, commands) {
  const present = [];
  for (const command of commands) if (!present.includes(command.group)) present.push(command.group);
  const wanted = (LAYOUT[surface] || []).filter((group) => present.includes(group));
  return [...wanted, ...present.filter((group) => !wanted.includes(group))];
}

function rowFor(command, ctx, run, nested) {
  const row = { label: labelOf(command, ctx, { nested }), click: () => run(command.id) };
  if (command.type) {
    row.type = command.type;
    row.checked = typeof command.checked === "function" ? Boolean(command.checked(ctx)) : false;
  }
  if (typeof command.enabled === "function" && !command.enabled(ctx)) row.enabled = false;
  return row;
}

/**
 * Render one surface to a menu template.
 *
 * Returns PLAIN objects (`{ label, click }` / `{ type: "separator" }` /
 * `{ label, submenu }`), so Electron is not needed to assert the shape. Separators
 * come from `group` changes -- a menu cannot grow a stray divider by hand -- and a
 * group named in GROUPS nests under its one label on every menu.
 *
 * `run(id)` performs a command. `submenus[id]` supplies a dynamic command's items;
 * a dynamic command with no submenu supplied is DROPPED rather than rendered as a
 * dead row, because a menu entry that does nothing is worse than an absent one.
 */
function buildMenu(surface, run, { ctx = {}, submenus = {} } = {}) {
  const wanted = commandsFor(surface)
    .filter((command) => appliesTo(command, ctx))
    .filter((command) => !command.dynamic || submenus[command.id]);
  const template = [];
  for (const group of groupOrder(surface, wanted)) {
    const members = wanted.filter((command) => command.group === group);
    if (template.length) template.push({ type: "separator" });
    const nest = GROUPS[group] && GROUPS[group].menu;
    if (nest) {
      // A menu nests a group; the palette lists the same commands one per row.
      // Both read this list, so neither can carry an entry the other lacks.
      template.push({ label: nest, submenu: members.map((child) => rowFor(child, ctx, run, true)) });
      continue;
    }
    for (const command of members) {
      if (command.dynamic) template.push({ label: labelOf(command, ctx), submenu: submenus[command.id] });
      else template.push(rowFor(command, ctx, run, false));
    }
  }
  return template;
}

/**
 * The rows of a NON-menu surface (the bead rail, the Windows jump list): id,
 * resolved label and icon. A page or a jump list cannot run a closure, so it
 * gets data and sends the id back.
 */
function rowsFor(surface, ctx = {}) {
  const wanted = commandsFor(surface).filter((command) => appliesTo(command, ctx) && !command.dynamic);
  return groupOrder(surface, wanted)
    .flatMap((group) => wanted.filter((command) => command.group === group))
    .map((command) => ({ id: command.id, label: labelOf(command, ctx), icon: command.icon || null, group: command.group }));
}

/**
 * Everything wrong with the inventory itself, as sentences. Empty = healthy.
 *
 * Exported (not just tested) so a future palette or a startup assertion can read
 * the same verdict: a checker nobody can run from the app is documentation.
 */
function conformance(commands = COMMANDS) {
  const problems = [];
  const seen = new Set();
  for (const command of commands) {
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
    if (command.type && !["checkbox", "radio"].includes(command.type)) {
      problems.push(`${command.id} has unknown type ${command.type}`);
    }
    if (command.type && typeof command.checked !== "function") {
      problems.push(`${command.id} is a ${command.type} that cannot say whether it is checked`);
    }
    // A slot-scoped command has no body to act on anywhere but a body's own menu.
    if (command.scope === "slot") {
      for (const surface of command.surfaces) {
        if (surface !== "avatar-menu") problems.push(`${command.id} needs a body but sits on ${surface}, which never has one`);
      }
    }
    // A command that needs typing can only live where typing exists. On a tray
    // it would be a row that runs with no argument -- a dead row with a label.
    if (command.prompt) {
      if (!command.prompt.placeholder) problems.push(`${command.id} has a prompt with no placeholder`);
      for (const surface of command.surfaces) {
        if (surface !== "palette") problems.push(`${command.id} prompts for text but sits on ${surface}, which has no text field`);
      }
    }
  }
  // Two commands on one key: the second registration silently loses.
  const keys = new Map();
  for (const command of commands) {
    if (!command.accel) continue;
    if (keys.has(command.accel)) problems.push(`${command.id} and ${keys.get(command.accel)} both claim ${command.accel}`);
    keys.set(command.accel, command.id);
  }
  // Every group GROUPS or LAYOUT names must exist, or the entry is a typo that
  // silently nests or reorders nothing.
  if (commands === COMMANDS) {
    const groups = new Set(commands.map((command) => command.group));
    for (const name of [...Object.keys(GROUPS), ...Object.values(LAYOUT).flat()]) {
      if (!groups.has(name)) problems.push(`group ${name} is named in GROUPS/LAYOUT and no command belongs to it`);
    }
  }
  return problems;
}

module.exports = {
  SURFACES, GROUPS, LAYOUT, COMMANDS, commandsFor, groupFor, paletteRows, rowsFor, byId, labelOf,
  buildMenu, conformance, shortcuts, electronAccel, appliesTo,
};
