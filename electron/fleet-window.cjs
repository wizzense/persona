"use strict";

/**
 * fleet-window.cjs — the Fleet control window: a REAL window (framed, in the
 * taskbar, its own title) the owner can launch from the tray, `desk://fleet`,
 * `game panel`, `awdesk --fleet` or the MCP `fleet_control open_panel` action.
 *
 * It renders fleet-control.html over a four-verb preload; every verb lands on
 * ONE FleetControl instance owned here, which the tray tooltip, the bridge's
 * /fleet routes and the MCP tools share — so no two surfaces can hold a
 * different idea of whether the fleet is up.
 */

const path = require("node:path");
const { BrowserWindow, ipcMain, shell } = require("electron");
const { FleetControl, summarize, classify } = require("./fleet-control.cjs");
const { OPENABLE } = require("./surfaces.cjs");

let fleetWindow = null;
let control = null;
let ipcWired = false;

/** What "close" means when there is no standalone window -- set by main to close
 *  the console, the only other surface fleet-control.html can be living in. */
let closeFallback = null;

function setCloseFallback(fn) {
  closeFallback = typeof fn === "function" ? fn : null;
}

/**
 * Wire the IPC without opening a window.
 *
 * 🚩 The console's Fleet pane loads fleet-control.html directly and calls
 * `desk:fleet-status` on load, so a handler must exist BEFORE any standalone
 * window is created. Without it the pane renders its full layout and every field
 * stays an em-dash -- indistinguishable from a fleet that is genuinely down.
 */
function ensureFleetIpc() {
  wireIpc();
}

function getControl() {
  if (!control) {
    control = new FleetControl();
    control.on("progress", (payload) => {
      if (fleetWindow && !fleetWindow.isDestroyed()) {
        fleetWindow.webContents.send("desk:fleet-progress", payload);
      }
    });
  }
  return control;
}

function wireIpc() {
  if (ipcWired) return;
  ipcWired = true;
  ipcMain.handle("desk:fleet-status", (_event, opts) =>
    getControl().status(opts && typeof opts === "object" ? opts : {}));
  ipcMain.handle("desk:fleet-run", (_event, action) => getControl().run(String(action)));
  ipcMain.on("desk:fleet-close", () => {
    if (fleetWindow && !fleetWindow.isDestroyed()) { fleetWindow.close(); return; }
    // No standalone window means the sender is the console's Fleet PANE, whose
    // close button (and Escape) would otherwise be dead.
    if (typeof closeFallback === "function") closeFallback();
  });
  // A door chip was clicked. Only the probed SURFACES may be opened — a
  // renderer-supplied URL never reaches the shell.
  ipcMain.on("desk:fleet-open", (_event, url) => {
    if (typeof url === "string" && OPENABLE.has(url)) void shell.openExternal(url);
  });
}

function createFleetWindow() {
  wireIpc();
  if (fleetWindow && !fleetWindow.isDestroyed()) {
    fleetWindow.show();
    fleetWindow.focus();
    return fleetWindow;
  }
  fleetWindow = new BrowserWindow({
    width: 640,
    height: 720,
    minWidth: 480,
    minHeight: 560,
    show: false,
    title: "Aither Fleet",
    backgroundColor: "#0f1218",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "fleet-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  fleetWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  fleetWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  fleetWindow.once("ready-to-show", () => {
    fleetWindow.show();
    fleetWindow.focus();
  });
  fleetWindow.on("closed", () => {
    fleetWindow = null;
  });
  void fleetWindow.loadFile(path.join(__dirname, "fleet-control.html"));
  return fleetWindow;
}

/** For the tray tooltip / MCP get_status: cached, never a live probe from a hover. */
function fleetSummaryCached() {
  const c = getControl();
  if (c.busy) return `Fleet: running "${c.busy}"`;
  if (!c.lastStatus) return "Fleet: not probed yet";
  return `${classify(c.lastStatus)} — ${summarize(c.lastStatus)}`;
}

/** Close the standalone window (the console's "reattach"). No-op when absent. */
function closeFleetWindow() {
  if (fleetWindow && !fleetWindow.isDestroyed()) fleetWindow.close();
}

function isFleetWindowOpen() {
  return Boolean(fleetWindow && !fleetWindow.isDestroyed());
}

module.exports = {
  createFleetWindow,
  ensureFleetIpc,
  setCloseFallback,
  closeFleetWindow,
  isFleetWindowOpen,
  getControl,
  fleetSummaryCached,
};
