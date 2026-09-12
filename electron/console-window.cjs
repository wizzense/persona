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
  Object.freeze({
    id: "cards", label: "Cards", hint: "Decisions waiting on you",
    kind: "view", query: "deck=1",
  }),
  Object.freeze({
    id: "chat", label: "Chat", hint: "The company room",
    kind: "view", query: "chat=1",
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
    // 🚩 An EMPTY base is refused rather than concatenated. "" + "?deck=1" is a
    // relative URL, so the pane would load console.html INTO ITSELF -- a console
    // inside a console inside a console, with no error anywhere. A pane that says
    // why it is empty beats one that recurses.
    if (!base) return { ...pane, src: null, unavailable: "renderer bundle not resolved" };
    const src = base + (base.includes("?") ? "&" : "?") + pane.query;
    return { ...pane, src };
  });
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

function wireIpc() {
  if (wired) return;
  wired = true;

  const { ipcMain } = electron();
  ipcMain.handle("desk:console-panes", () =>
    paneSources(typeof rendererUrlImpl === "function" ? rendererUrlImpl() : ""));
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
function showConsole({ windows = {}, rendererUrl = null } = {}) {
  windowsImpl = windows || {};
  rendererUrlImpl = rendererUrl;
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
  consoleWindow.webContents.on("will-navigate", (event, url) => {
    // Panes navigate inside their own frames; the SHELL never navigates.
    if (event.frame === consoleWindow.webContents.mainFrame && !url.includes("console.html")) {
      event.preventDefault();
    }
  });

  consoleWindow.once("ready-to-show", () => {
    consoleWindow.show();
    consoleWindow.focus();
  });
  consoleWindow.on("closed", () => {
    consoleWindow = null;
  });

  void consoleWindow.loadFile(path.join(__dirname, "console.html"));
  return consoleWindow;
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
  closeConsole,
  isConsoleOpen,
  paneSources,
  detachedIds,
  callWindow,
  PANES,
  __setWindowsForTest,
};
