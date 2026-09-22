"use strict";

/**
 * The Aither Console — ONE window, four panes, each detachable.
 *
 * WHY THIS EXISTS (owner, 2026-09-08, looking at two floating windows):
 *
 *     "why are these seperate windows and detached from awask / awdesk popups
 *      and the awdesk app -- i would like a unified window with option to detach
 *      these including the decision cards -- cant seem to get a wrangle on all
 *      of these pop ups"
 *
 * The honest answer is that nothing was ever unified. Each surface grew as its
 * own BrowserWindow with its own creator and there was no shell for any of them
 * to live in: command-window.cjs, fleet-window.cjs, main.cjs's deckWindow and
 * chatWindow, plus the avatar, the overlay, the AitherDesktop app, the detached
 * avatar and the hyprland shell — NINE windows, no host. Detached was not a
 * mode; it was the only mode.
 *
 * So this inverts the default. The console is the host, every pane lives in it,
 * and DETACHING is the option — it hands the pane to the very same standalone
 * window that used to be the only way to see it, and reattaching closes that
 * window and re-embeds the page. Nothing is reimplemented: a pane is an iframe
 * over the page its window already loads, so a pane cannot drift from its
 * detached twin, because it IS its detached twin.
 *
 * 🚩 Reattach is the half that makes this a MODE rather than a one-way door, and
 * it is the half that is easy to skip. A detach button with no way back is how
 * the owner ends up with floating windows again by lunchtime.
 *
 * Lazy on purpose: a pane's iframe is created the first time it is shown. The
 * Fleet pane probes seven doors and the GPU counters on load, and paying for
 * that in order to open a window the owner wanted for the Command pane is how a
 * unified window earns a reputation for being slow and stops being opened.
 */

const path = require("node:path");
// WHERE each surface is, with one owner (slice 2 of docs/UX-REIMPLEMENTATION.md).
const { createSurfaceState } = require("./surface-state.cjs");

// Required lazily, not at module load: `paneSources`, `detachedIds` and
// `callWindow` are the parts worth asserting, and they are pure. A top-level
// electron require makes this whole module unloadable under `node --test`, which
// is how a window module ends up with no test at all.
function electron() {
  return require("electron");
}

/**
 * The panes, in rail order.
 *
 * `kind: "file"` is a page under electron/; `kind: "view"` is the renderer bundle
 * with a query flag, which is a dev-server URL in development and a file:// bundle
 * in production — so its src is resolved by MAIN at call time rather than written
 * into the page. A second copy of that rule is how a pane loads in one build and
 * comes up blank in the other.
 */
const PANES = Object.freeze([
  // FIRST on purpose (owner, 2026-09-13: "no proper notification area"): the
  // inbox — decision cards and the agents' messages — is what the tray badge,
  // the taskbar overlay and the bell all open. Same renderer as the old "Desk
  // panel" (?deck=1), so a detached inbox is that window.
  Object.freeze({
    id: "cards", label: "Inbox", hint: "Decisions and messages", section: "Now", icon: "bell",
    kind: "view", query: "deck=1",
  }),
  Object.freeze({
    id: "command", label: "Command", hint: "Say it in a sentence", section: "Control", icon: "terminal",
    kind: "file", file: "command.html",
  }),
  Object.freeze({
    id: "fleet", label: "Fleet", hint: "Containers, VRAM, doors", section: "Control", icon: "server",
    kind: "file", file: "fleet-control.html",
  }),
  // Slice 1 of COCKPIT-DESIGN: the unified session directory (daemon-owned
  // sessions + DISCOVERED interactive Claude Code tabs), read-only with live
  // tails. No detach wiring on purpose yet — a pane that cannot come back out
  // yet also must not offer a Detach button that does nothing (callWindow
  // answers "no open target" and the rail stays honest).
  Object.freeze({
    id: "sessions", label: "Sessions", hint: "Every Claude session, live", section: "Agents", icon: "layers",
    kind: "file", file: "sessions.html",
  }),
  Object.freeze({
    id: "chat", label: "Chat", hint: "The company room", section: "Agents", icon: "chat",
    kind: "view", query: "chat=1",
  }),
  // Plan 40 slice G, the surface half: who is standing on the stage and the
  // arrangements, in a list. Every other way to manage a body is a GESTURE on
  // that body (drag, right-drag, wheel, right-click) -- useless when the body is
  // hidden, tiny or behind a window, which is how the owner lost control of the
  // stage in the first place.
  Object.freeze({
    id: "stage", label: "Stage", hint: "Who is standing, and where", section: "Presence", icon: "users",
    kind: "file", file: "stage.html",
  }),
  // Plan 40 cast pane: who appears and how they sound, authored in cast.json
  // (U01) instead of a nested tray submenu click. `kind: "file"` on purpose --
  // it needs no vite build, and src/** is the peer's territory this unit does
  // not touch.
  Object.freeze({
    id: "cast", label: "Cast", hint: "Who appears, and how they sound", section: "Presence", icon: "mic",
    kind: "file", file: "cast.html",
  }),
  // Plan: the ONE shared settings page (owner 2026-09-22: "there still isnt
  // just a shared settings page"). kind:"file" -- no vite build.
  Object.freeze({
    id: "settings", label: "Settings", hint: "Voice, hotkeys, devices", section: "Control", icon: "settings",
    kind: "file", file: "settings.html",
  }),
  // Owner, 2026-09-20: the Inbox pane was rendering decision cards, wakes, relay messages,
  // the stage slots, the spawn chips AND the whole Models & Market grid in one scroll
  // ("mixes notifications and decisions and avatars"). Bodies belong under PRESENCE, beside
  // Stage and Cast. Same bundle and the SAME deck-state subscription as the inbox — it is one
  // component with a view prop, so the two panes cannot drift.
  Object.freeze({
    id: "characters", label: "Characters", hint: "Bodies, spawns and the market", section: "Presence", icon: "users",
    kind: "view", query: "characters=1",
  }),
  // 🚩 HOSTED, not framed, and the difference is the login. The AitherDesktop
  // shell keeps its session in the persist:living-desktop partition -- that is
  // where the vault-injected aither_auth_token lives and why the standalone
  // window comes up signed in. An iframe inherits the CONSOLE's session, so a
  // framed desktop would render signed-out beside a signed-in twin and read as
  // "the desktop is broken". A WebContentsView carries the partition, so the
  // pane and the window are one profile.
  Object.freeze({
    id: "desktop", label: "AitherOS Online", hint: "The living desktop, signed in", section: "Online", icon: "desktop",
    kind: "hosted", partition: "persist:living-desktop",
  }),
]);

let consoleWindow = null;
let wired = false;
/** { <paneId>: { open(), close(), isOpen() } } — injected by main.cjs. */
let windowsImpl = {};
let rendererUrlImpl = null;
/** { list(ctx) -> rows, run(id) } — injected by main.cjs; stubbed by the smoke.
 *  The palette lives HERE rather than in main so the console can be verified
 *  without loading main.cjs (which would take the running Desk's instance lock). */
let commandsImpl = null;

/** The desk's appearance + the themes it may choose from (generated from Veil's). */
function appearanceNow() {
  const castConfig = require("./cast-config.cjs");
  let themes = [];
  try {
    themes = JSON.parse(require("node:fs").readFileSync(path.join(__dirname, "aither-themes.json"), "utf8")).themes || [];
  } catch {
    /* a missing generated file leaves the picker empty, never the window unstyled */
  }
  const loaded = castConfig.load();
  const appearance = (loaded && loaded.appearance) || castConfig.BUILTIN_APPEARANCE;
  return { theme: appearance.theme, uiScale: appearance.uiScale, themes };
}

/** Every frame of the console, not just the shell: a pane is its own document. */
function broadcastAppearance(appearance) {
  if (!consoleWindow || consoleWindow.isDestroyed()) return;
  for (const frame of consoleWindow.webContents.mainFrame.framesInSubtree) {
    try { frame.send("desk:appearance-changed", appearance); } catch { /* a frame mid-navigation */ }
  }
}

/**
 * Resolve each pane's content URL.
 *
 * Exported and pure so the pane table can be asserted without launching Electron.
 */
function paneSources(rendererUrl) {
  const base = String(rendererUrl || "");
  return PANES.map((pane) => {
    if (pane.kind === "file") return { ...pane, src: `./${pane.file}` };
    // A hosted pane has no src at all: main paints its own view over the stage
    // rectangle the shell reports. The shell must NOT build an iframe for it.
    if (pane.kind === "hosted") return { ...pane, src: null, hosted: true };
    // 🚩 An EMPTY base is refused rather than concatenated. "" + "?deck=1" is a
    // relative URL, so the pane would load console.html INTO ITSELF -- a console
    // inside a console inside a console, with no error anywhere. A pane that says
    // why it is empty beats one that recurses.
    if (!base) return { ...pane, src: null, unavailable: "renderer bundle not resolved" };
    const src = base + (base.includes("?") ? "&" : "?") + pane.query;
    return { ...pane, src };
  });
}

/**
 * The renderer base, from a FUNCTION or a plain string.
 *
 * 🚩 It took a function only, and passing a string degraded to "" -- which
 * paneSources correctly refuses, so Cards and Chat came up as "has nowhere to
 * load from" while Command and Fleet were fine. The contract was invisible and
 * its violation looked like two broken panes, not a wrong argument. Measured by
 * console-smoke.cjs, which passed a string on its first run.
 */
function resolveRendererUrl() {
  if (typeof rendererUrlImpl === "function") return String(rendererUrlImpl() || "");
  if (typeof rendererUrlImpl === "string") return rendererUrlImpl;
  return "";
}

/**
 * WHERE each pane is, with one owner (surface-state.cjs, slice 2 of
 * docs/UX-REIMPLEMENTATION.md). The windows stay the oracle: `observeWindows()`
 * asks them, `reconcile` folds the answer in, and subscribers hear about it once.
 */
const surfaces = createSurfaceState(PANES.map((pane) => pane.id));

/** What the window creators say right now -- reality, not intention. */
function observeWindows() {
  const observed = {};
  for (const pane of PANES) {
    const impl = windowsImpl[pane.id];
    try {
      observed[pane.id] = Boolean(impl && typeof impl.isOpen === "function" && impl.isOpen());
    } catch {
      observed[pane.id] = false;
    }
  }
  return observed;
}

/** Which panes are currently living in their own window, re-measured. */
function detachedIds() {
  surfaces.reconcile(observeWindows());
  return surfaces.detached();
}

// 🚩 The owner can close a detached window from ITS OWN title bar, and nothing
// tells the console. Until now the rail only re-derived itself when the console
// regained focus, so a pane could sit there labelled "detached" with no window
// behind it -- reachable again only by clicking a Reattach that closes nothing.
// While the console is open, poll the creators and push the map when it moves.
const SURFACE_POLL_MS = 1000;
let surfacePollTimer = null;

function startSurfaceWatch() {
  if (surfacePollTimer) return;
  surfacePollTimer = setInterval(() => {
    if (!consoleWindow || consoleWindow.isDestroyed()) return stopSurfaceWatch();
    surfaces.reconcile(observeWindows());
  }, SURFACE_POLL_MS);
  surfacePollTimer.unref?.();
}

function stopSurfaceWatch() {
  if (!surfacePollTimer) return;
  clearInterval(surfacePollTimer);
  surfacePollTimer = null;
}

// One subscriber, one message: the shell never keeps a second copy of this map,
// it renders the one it is handed.
surfaces.subscribe((snapshot) => {
  if (!consoleWindow || consoleWindow.isDestroyed()) return;
  consoleWindow.webContents.send("desk:console-surfaces", snapshot);
});

/**
 * Wait until a pane's window actually reaches the state we asked for.
 *
 * 🚩 `BrowserWindow.close()` is ASYNCHRONOUS. It emits `close`, then `closed` a
 * turn later, and only then does main null the handle -- so `isOpen()` read on
 * the next line still answers TRUE for the window we just closed. The reattach
 * reply therefore carried the pane in `detached`, the shell re-rendered it as
 * detached, and the owner saw a reattach that "did nothing". Settling here keeps
 * one truth: the reply describes the fleet of windows AFTER the verb landed.
 * Bounded, because a window that refuses to close must not hang the rail.
 */
async function settle(impl, want, deadlineMs = 1500) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    let state;
    try {
      state = Boolean(typeof impl.isOpen === "function" && impl.isOpen());
    } catch {
      return; // A creator that cannot answer is not worth waiting on.
    }
    if (state === want || Date.now() >= until) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function callWindow(paneId, verb) {
  const impl = windowsImpl[String(paneId || "")];
  const fn = impl && impl[verb];
  if (typeof fn !== "function") {
    return { ok: false, error: `no ${verb} target for pane ${paneId}`, detached: detachedIds() };
  }
  try {
    fn();
  } catch (error) {
    // Never throw across the bridge: a rail that goes dead because one creator
    // raised is worse than a pane that reports why it did not move.
    return { ok: false, error: String((error && error.message) || error), detached: detachedIds() };
  }
  await settle(impl, verb === "open");
  return { ok: true, pane: paneId, detached: detachedIds() };
}

/** { <paneId>: WebContentsView } — built on first show, kept across pane switches. */
const hostedViews = new Map();
let hostedUrls = {};
/** { <paneId>: async () => boolean } -- main's "make this partition signed in" hook.
 *  Injected (like hostedUrls) so the console stays verifiable without main.cjs. */
let hostedPrepare = {};
/** { <paneId>: () => string } -- where to send a pane that could not be signed in. */
let hostedSignIn = {};

/**
 * Load a hosted pane: prepare its session FIRST, then decide what to show.
 *
 * Signed in -> the desktop. Not signed in -> the sign-in page in the SAME
 * partition, so one login here signs in the pane, the overlay and the standalone
 * window together. Never the apex signed-out: that is a marketing page, and a
 * marketing page inside the owner's own console reads as "the desktop is gone".
 */
async function loadHosted(paneId, view, url) {
  let signedIn = true;
  const prepare = hostedPrepare[paneId];
  if (typeof prepare === "function") {
    try { signedIn = Boolean(await prepare()); } catch { signedIn = false; }
  }
  if (view.webContents.isDestroyed()) return;
  const signIn = typeof hostedSignIn[paneId] === "function" ? hostedSignIn[paneId]() : "";
  const target = signedIn || !signIn ? url : signIn;
  if (!signedIn && signIn) {
    // Once the login lands (the cookie appears), go to the desktop on our own:
    // portal's open-redirect guard strips foreign returnUrls, so nothing bounces back.
    const poll = setInterval(async () => {
      if (view.webContents.isDestroyed()) return clearInterval(poll);
      const ok = await Promise.resolve().then(prepare).then(Boolean, () => false);
      if (ok) { clearInterval(poll); void view.webContents.loadURL(url); }
    }, 3000);
    view.webContents.once("destroyed", () => clearInterval(poll));
  }
  void view.webContents.loadURL(target);
}

/**
 * Attach or detach a hosted pane's view, and size it to the stage.
 *
 * Detaching REMOVES the child view rather than destroying it: the desktop shell
 * is a full web app with a login and a socket, and rebuilding it on every rail
 * click would make the console the slowest way to reach it -- which is how a
 * unified window stops being used.
 */
function placeHosted(paneId, rect) {
  const pane = PANES.find((p) => p.id === paneId && p.kind === "hosted");
  if (!pane || !consoleWindow || consoleWindow.isDestroyed()) return false;
  const { WebContentsView } = electron();
  let view = hostedViews.get(paneId);
  if (!rect) {
    if (view) consoleWindow.contentView.removeChildView(view);
    return true;
  }
  if (!view) {
    const url = typeof hostedUrls[paneId] === "function" ? hostedUrls[paneId]() : "";
    if (!url) return false;
    view = new WebContentsView({
      webPreferences: {
        partition: pane.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    // The same fence the shell carries: a hosted surface may not spawn windows.
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    hostedViews.set(paneId, view);
    void loadHosted(paneId, view, url);
  }
  consoleWindow.contentView.addChildView(view);
  view.setBounds({
    x: Math.round(rect.x || 0),
    y: Math.round(rect.y || 0),
    width: Math.max(0, Math.round(rect.width || 0)),
    height: Math.max(0, Math.round(rect.height || 0)),
  });
  return true;
}

function dropHostedViews() {
  for (const view of hostedViews.values()) {
    try {
      view.webContents.close();
    } catch {
      // A view whose contents are already gone is the normal case on window close.
    }
  }
  hostedViews.clear();
}

function wireIpc() {
  if (wired) return;
  wired = true;

  const { ipcMain } = electron();
  // The shell measures its own stage and reports it; main never guesses a layout
  // it cannot see. `rect: null` means "this pane is not showing" -- the same
  // message carries both, so a hidden view can never be left painted over a
  // different pane.
  ipcMain.handle("desk:console-stage", (_event, payload) =>
    placeHosted(payload && payload.pane, (payload && payload.rect) || null));
  ipcMain.handle("desk:console-panes", () => paneSources(resolveRendererUrl()));
  ipcMain.handle("desk:console-detach", (_event, paneId) => callWindow(paneId, "open"));
  ipcMain.handle("desk:console-reattach", (_event, paneId) => callWindow(paneId, "close"));
  ipcMain.handle("desk:console-detached", () => detachedIds());
  // Appearance: which of the family's eleven themes the desk wears. Read from and
  // written to cast.json (the desk's one synced settings file), and BROADCAST to
  // every frame -- each pane is its own document, so a theme set on the shell
  // alone re-skins the rail and leaves eight panes in the old one.
  ipcMain.handle("desk:appearance-get", () => appearanceNow());
  ipcMain.handle("desk:appearance-set", (_event, patch) => {
    const castConfig = require("./cast-config.cjs");
    const wanted = {};
    if (patch && typeof patch.theme === "string") wanted.theme = patch.theme;
    if (patch && Number.isFinite(Number(patch.uiScale))) wanted.uiScale = Number(patch.uiScale);
    const result = castConfig.write((draft) => {
      draft.appearance = { ...(draft.appearance || {}), ...wanted };
    });
    const bad = (result.problems || []).filter((p) => String(p.path).startsWith("appearance"));
    if (!result.ok || bad.length) {
      return { ok: false, error: result.error || bad.map((p) => `${p.path}: ${p.reason}`).join("; ") };
    }
    const next = appearanceNow();
    broadcastAppearance(next);
    return { ok: true, ...next };
  });
  // The palette: one list of everything Desk can do, and one way to run it.
  // Rows come from the command registry via main; the shell renders what it is
  // handed and knows no capability of its own.
  ipcMain.handle("desk:console-commands", () => {
    try {
      return (commandsImpl && commandsImpl.list && commandsImpl.list()) || [];
    } catch (error) {
      console.warn(`[console] command list failed: ${(error && error.message) || error}`);
      return [];
    }
  });
  // `arg` is the typed argument of a row that declared `prompt` (a title, a
  // slug); undefined otherwise. A runner that answers a promise is AWAITED so
  // its verdict ({ok, message}) reaches the palette instead of a bare "ran".
  ipcMain.handle("desk:console-command-run", async (_event, id, arg) => {
    const command = String(id || "");
    if (!commandsImpl || typeof commandsImpl.run !== "function") {
      return { ok: false, error: "no command runner wired" };
    }
    try {
      const out = await commandsImpl.run(command, arg == null ? undefined : String(arg));
      if (out && typeof out === "object") {
        return { ok: out.ok !== false, id: command, ...out, error: out.ok === false ? (out.message || out.error) : undefined };
      }
      return { ok: true, id: command };
    } catch (error) {
      // A palette that dies on one bad command is worse than one that says so.
      return { ok: false, id: command, error: String((error && error.message) || error) };
    }
  });
  ipcMain.on("desk:console-close", () => {
    if (consoleWindow && !consoleWindow.isDestroyed()) consoleWindow.close();
  });
}

/**
 * Raise the console.
 *
 * @param windows      { command|fleet|cards|chat: {open, close, isOpen} } — the
 *                     EXISTING standalone-window creators, injected rather than
 *                     required so this module has no cycle with main.cjs and the
 *                     pane table stays testable without Electron.
 * @param rendererUrl  main.cjs's own resolver, for the same reason.
 */
function showConsole({
  windows = {}, rendererUrl = null, urls = {}, autoShow = true, commands = null,
  prepare = {}, signIn = {},
} = {}) {
  windowsImpl = windows || {};
  rendererUrlImpl = rendererUrl;
  hostedUrls = urls || {};
  hostedPrepare = prepare || {};
  hostedSignIn = signIn || {};
  commandsImpl = commands;
  wireIpc();

  if (consoleWindow && !consoleWindow.isDestroyed()) {
    if (consoleWindow.isMinimized()) consoleWindow.restore();
    consoleWindow.show();
    consoleWindow.focus();
    return consoleWindow;
  }

  const { BrowserWindow } = electron();
  consoleWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 880,
    minHeight: 600,
    show: false,
    title: "Aither Console",
    // Veil's --background for dark-glass. The title bar is drawn by WINDOWS in the
    // same colour (titleBarOverlay), so the window has one skin from the OS's
    // caption buttons down -- it used to be a grey system bar over a dark page.
    backgroundColor: "#07080d",
    autoHideMenuBar: true,
    ...(process.platform === "win32"
      ? { titleBarStyle: "hidden", titleBarOverlay: { color: "#05060a", symbolColor: "#e4e4ef", height: 34 } }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "console-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // Every pane is an iframe, and a pane with no bridge is a blank rectangle
      // with no error — so the preload must reach sub-frames.
      nodeIntegrationInSubFrames: true,
      // The one deviation from the other desk windows, and it is what buys the
      // panes their REAL preloads instead of copies: a sandboxed preload's
      // require() resolves `electron` and nothing else. contextIsolation and
      // nodeIntegration are unchanged, so page script still reaches Node through
      // nothing but the exposed bridges.
      sandbox: false,
      webviewTag: false,
    },
  });

  // The same fence every other desk window carries.
  consoleWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // The SHELL never navigates. `will-navigate` is main-frame-only in Electron
  // (a pane's own navigation is `will-frame-navigate`), so this cannot strand a
  // pane -- and it is written to fail CLOSED rather than keyed on event.frame,
  // which would let every navigation through if that property ever went missing.
  consoleWindow.webContents.on("will-navigate", (event, url) => {
    if (!String(url).includes("console.html")) event.preventDefault();
  });

  // autoShow:false is for the smoke test ONLY. A verification run that pops a
  // window steals the owner's focus mid-game, which is how a useful check becomes
  // one nobody is willing to run.
  consoleWindow.once("ready-to-show", () => {
    applyInboxBadge();
    if (!autoShow) return;
    consoleWindow.show();
    consoleWindow.focus();
  });
  consoleWindow.on("closed", () => {
    dropHostedViews();
    stopSurfaceWatch();
    consoleWindow = null;
  });
  // The rail must follow the windows even when nobody touches the console.
  startSurfaceWatch();

  void consoleWindow.loadFile(path.join(__dirname, "console.html"));
  return consoleWindow;
}

/**
 * Raise the console ON a given pane -- the door the decision-card router uses.
 *
 * `param` reaches the pane as an extra query flag (a card id), so "show me THIS
 * card" lands somewhere specific instead of merely opening the deck. Returns
 * false when there is no console to land in, which is what makes the caller's
 * fallback to the standalone popup a real ladder rather than a silent drop.
 */
function focusPane(paneId, param = null) {
  const id = String(paneId || "");
  if (!PANES.some((pane) => pane.id === id)) return false;
  if (!consoleWindow || consoleWindow.isDestroyed()) return false;
  const send = () => {
    if (consoleWindow && !consoleWindow.isDestroyed()) {
      consoleWindow.webContents.send("desk:console-focus", { pane: id, param: param || null });
    }
  };
  // A console raised in the same breath is still loading; a send() into a page
  // that has not run its script yet is dropped with no error at all.
  if (consoleWindow.webContents.isLoading()) {
    consoleWindow.webContents.once("did-finish-load", send);
  } else {
    send();
  }
  if (consoleWindow.isMinimized()) consoleWindow.restore();
  consoleWindow.show();
  consoleWindow.focus();
  return true;
}

function isConsoleOpen() {
  return Boolean(consoleWindow && !consoleWindow.isDestroyed());
}

function closeConsole() {
  if (consoleWindow && !consoleWindow.isDestroyed()) consoleWindow.close();
}

/** The inbox count, on the surfaces this window owns: its Inbox tab and its
 *  taskbar button (setOverlayIcon — the Windows-native badge). Remembered, so a
 *  console opened later starts with the right number. */
let lastInbox = { count: 0, image: null, tooltip: "" };
function setInboxBadge({ count = 0, image = null, tooltip = "" } = {}) {
  lastInbox = { count: Number(count) || 0, image, tooltip };
  applyInboxBadge();
}
function applyInboxBadge() {
  if (!consoleWindow || consoleWindow.isDestroyed()) return;
  try {
    consoleWindow.setOverlayIcon(lastInbox.count > 0 ? lastInbox.image : null, lastInbox.count > 0 ? lastInbox.tooltip : "");
  } catch {
    /* not every platform draws overlays; the tab still carries the number */
  }
  const send = () => {
    if (consoleWindow && !consoleWindow.isDestroyed()) {
      consoleWindow.webContents.send("desk:console-inbox-count", { count: lastInbox.count });
    }
  };
  if (consoleWindow.webContents.isLoading()) consoleWindow.webContents.once("did-finish-load", send);
  else send();
}

/** Test seam: inject window impls without constructing a BrowserWindow. */
function __setWindowsForTest(windows) {
  windowsImpl = windows || {};
}

module.exports = {
  showConsole,
  focusPane,
  setInboxBadge,
  placeHosted,
  closeConsole,
  isConsoleOpen,
  paneSources,
  detachedIds,
  callWindow,
  PANES,
  __setWindowsForTest,
};
