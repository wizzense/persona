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

const path = require("node:path");
const { BrowserWindow, ipcMain } = require("electron");
const { CommandAgent } = require("./command-agent.cjs");
const { installHarnessBackend } = require("./command-harness.cjs");

let commandWindow = null;
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
      if (commandWindow && !commandWindow.isDestroyed()) {
        commandWindow.webContents.send("desk:command-progress", payload);
      }
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
    if (commandWindow && !commandWindow.isDestroyed()) { commandWindow.close(); return; }
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
  if (commandWindow && !commandWindow.isDestroyed()) {
    commandWindow.show();
    commandWindow.focus();
    return commandWindow;
  }
  commandWindow = new BrowserWindow({
    width: 640,
    height: 720,
    minWidth: 480,
    minHeight: 560,
    show: false,
    title: "Aither Command",
    backgroundColor: "#0f1218",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "command-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  commandWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  commandWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  commandWindow.once("ready-to-show", () => {
    commandWindow.show();
    commandWindow.focus();
  });
  commandWindow.on("closed", () => {
    commandWindow = null;
  });
  void commandWindow.loadFile(path.join(__dirname, "command.html"));
  return commandWindow;
}

/** Close the standalone window (the console's "reattach"). No-op when absent. */
function closeCommandWindow() {
  if (commandWindow && !commandWindow.isDestroyed()) commandWindow.close();
}

function isCommandWindowOpen() {
  return Boolean(commandWindow && !commandWindow.isDestroyed());
}

module.exports = {
  createCommandWindow,
  ensureCommandIpc,
  setCloseFallback,
  closeCommandWindow,
  isCommandWindowOpen,
  getAgent,
};
