"use strict";

/**
 * command-window.cjs — the Command window: a REAL window (framed, in the
 * taskbar, its own title) the owner can launch from the tray, `desk://command`,
 * `awdesk --command` or the MCP `desk_command` tool.
 *
 * It renders command.html over a CommandAgent; every request lands on ONE
 * shared CommandAgent instance owned here, which the bridge and MCP tools share
 * — so no two surfaces can hold a different idea of what was run.
 */

const electron = require("electron");
const { ipcMain } = electron;
const { CommandAgent } = require("./command-agent.cjs");
const { installHarnessBackend } = require("./command-harness.cjs");
// The window itself is presentation.cjs's route "command" (slice 3, P2): its size,
// title, preload and single-instance show+focus live in ROUTE_WINDOWS.command.
// This module keeps the agent and the IPC; its create/close/isOpen are wrappers.
const { openRouteWindow, closeRouteWindow, routeWindow } = require("./presentation.cjs");

const ROUTE = "command";

let agent = null;
let ipcWired = false;

function getAgent(fleetControl) {
  if (!agent) {
    agent = new CommandAgent({ fleetControl });
    // AWDESK_COMMAND_BACKEND=harness: the agent lane runs as ONE session on the
    // awdk harness daemon (@agent /skill addressing) instead of `claude -p`.
    // Opt-in until the parity test is green (daily-driver plan, decision 5).
    if (process.env.AWDESK_COMMAND_BACKEND === "harness") installHarnessBackend(agent);
    agent.on("progress", (payload) => {
      const win = routeWindow(ROUTE);
      if (win) win.webContents.send("desk:command-progress", payload);
    });
  }
  return agent;
}

let fleetControlInstance = null;

let createFleetWindowImpl = null;

/** What "close" means when there is no standalone window -- set by main to close
 *  the console, which is the only other surface this page can be living in. */
let closeFallback = null;

function setCloseFallback(fn) {
  closeFallback = typeof fn === "function" ? fn : null;
}

/**
 * Wire the IPC without opening a window.
 *
 * 🚩 The console's Command pane loads command.html directly, so `desk:command-send`
 * must have a handler BEFORE any standalone window is created. Without this the
 * pane renders perfectly and the first message fails with "No handler registered
 * for 'desk:command-send'" -- the surface looks finished and answers nothing.
 */
function ensureCommandIpc(fleetControl, { createFleetWindow = null } = {}) {
  if (fleetControl) fleetControlInstance = fleetControl;
  if (createFleetWindow) createFleetWindowImpl = createFleetWindow;
  wireIpc();
}

function wireIpc() {
  if (ipcWired) return;
  ipcWired = true;
  ipcMain.handle("desk:command-send", (_event, text) => getAgent(fleetControlInstance).run(text, { source: "command-window" }));
  ipcMain.handle("desk:command-history", (_event, limit) => getAgent(fleetControlInstance).history(limit ?? 50));
  ipcMain.on("desk:command-close", () => {
    const win = routeWindow(ROUTE);
    if (win) { win.close(); return; }
    // No standalone window means the sender is the console's Command PANE, whose
    // close button would otherwise be dead: the handler existed, found nothing to
    // close, and returned -- a button that does nothing and says nothing.
    if (typeof closeFallback === "function") closeFallback();
  });
  ipcMain.on("desk:command-open-fleet", () => {
    if (createFleetWindowImpl) createFleetWindowImpl();
  });
}

function createCommandWindow(fleetControl, { createFleetWindow = null } = {}) {
  fleetControlInstance = fleetControl;
  createFleetWindowImpl = createFleetWindow;
  wireIpc();
  return openRouteWindow(ROUTE, { electron });
}

/** Close the standalone window (the console's "reattach"). No-op when absent. */
function closeCommandWindow() {
  closeRouteWindow(ROUTE);
}

function isCommandWindowOpen() {
  return Boolean(routeWindow(ROUTE));
}

module.exports = {
  createCommandWindow,
  ensureCommandIpc,
  setCloseFallback,
  closeCommandWindow,
  isCommandWindowOpen,
  getAgent,
};
