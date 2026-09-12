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
  Object.freeze({
    id: "command", label: "Command", hint: "Say it in a sentence",
    kind: "file", file: "command.html",
  }),
  Object.freeze({
    id: "fleet", label: "Fleet", hint: "Containers, VRAM, doors",
    kind: "file", file: "fleet-control.html",
  }),
  // Slice 1 of COCKPIT-DESIGN: the unified session directory (daemon-owned
  // sessions + DISCOVERED interactive Claude Code tabs), read-only with live
  // tails. No detach wiring on purpose yet — a pane that cannot come back out
  // yet also must not offer a Detach button that does nothing (callWindow
  // answers "no open target" and the rail stays honest).
  Object.freeze({
    id: "sessions", label: "Sessions", hint: "Every Claude session, live",
    kind: "file", file: "sessions.html",
  }),
  Object.freeze({
    id: "cards", label: "Cards", hint: "Decisions waiting on you",
    kind: "view", query: "deck=1",
  }),
  Object.freeze({
    id: "chat", label: "Chat", hint: "The company room",
    kind: "view", query: "chat=1",
  }),
  // 🚩 HOSTED, not framed, and the difference is the login. The AitherDesktop
  // shell keeps its session in the persist:living-desktop partition -- that is
  // where the vault-injected aither_auth_token lives and why the standalone
  // window comes up signed in. An iframe inherits the CONSOLE's session, so a
  // framed desktop would render signed-out beside a signed-in twin and read as
  // "the desktop is broken". A WebContentsView carries the partition, so the
  // pane and the window are one profile.
  Object.freeze({
    id: "desktop", label: "Desktop", hint: "The aitherium.com shell",
    kind: "hosted", partition: "persist:living-desktop",
  }),
]);

let consoleWindow = null;
let wired = false;
/** { <paneId>: { open(), close(), isOpen() } } — injected by main.cjs. */
let windowsImpl = {};
let rendererUrlImpl = null;

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

/** Which panes are currently living in their own window. */
function detachedIds() {
  return PANES.filter((pane) => {
    const impl = windowsImpl[pane.id];
    try {
      return Boolean(impl && typeof impl.isOpen === "function" && impl.isOpen());
    } catch {
      return false;
    }
  }).map((pane) => pane.id);
}

function callWindow(paneId, verb) {
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
  return { ok: true, pane: paneId, detached: detachedIds() };
}

/** { <paneId>: WebContentsView } — built on first show, kept across pane switches. */
const hostedViews = new Map();
let hostedUrls = {};

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
    void view.webContents.loadURL(url);
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
function showConsole({ windows = {}, rendererUrl = null, urls = {}, autoShow = true } = {}) {
  windowsImpl = windows || {};
  rendererUrlImpl = rendererUrl;
  hostedUrls = urls || {};
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
    backgroundColor: "#0f1218",
    autoHideMenuBar: true,
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
    if (!autoShow) return;
    consoleWindow.show();
    consoleWindow.focus();
  });
  consoleWindow.on("closed", () => {
    dropHostedViews();
    consoleWindow = null;
  });

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

/** Test seam: inject window impls without constructing a BrowserWindow. */
function __setWindowsForTest(windows) {
  windowsImpl = windows || {};
}

module.exports = {
  showConsole,
  focusPane,
  placeHosted,
  closeConsole,
  isConsoleOpen,
  paneSources,
  detachedIds,
  callWindow,
  PANES,
  __setWindowsForTest,
};
