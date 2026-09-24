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

const electron = require("electron");
const { ipcMain, shell } = electron;
const { FleetControl, summarize, classify } = require("./fleet-control.cjs");
const { OPENABLE } = require("./surfaces.cjs");
// The window itself is presentation.cjs's route "fleet" (slice 3, P2): its size,
// title, preload and single-instance show+focus live in ROUTE_WINDOWS.fleet.
// This module keeps FleetControl and the IPC; its create/close/isOpen are wrappers.
const { openRouteWindow, closeRouteWindow, routeWindow } = require("./presentation.cjs");

const ROUTE = "fleet";

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
      const win = routeWindow(ROUTE);
      if (win) win.webContents.send("desk:fleet-progress", payload);
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
  ipcMain.handle("desk:fleet-doors", () => require("./surfaces.cjs").probeSurfaces().catch(() => []));
  ipcMain.on("desk:fleet-close", () => {
    const win = routeWindow(ROUTE);
    if (win) { win.close(); return; }
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
  return openRouteWindow(ROUTE, { electron });
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
  closeRouteWindow(ROUTE);
}

function isFleetWindowOpen() {
  return Boolean(routeWindow(ROUTE));
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
