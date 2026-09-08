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

let commandWindow = null;
let agent = null;
let ipcWired = false;

function getAgent(fleetControl) {
  if (!agent) {
    agent = new CommandAgent({ fleetControl });
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

function wireIpc() {
  if (ipcWired) return;
  ipcWired = true;
  ipcMain.handle("desk:command-send", (_event, text) => getAgent(fleetControlInstance).run(text, { source: "command-window" }));
  ipcMain.handle("desk:command-history", (_event, limit) => getAgent(fleetControlInstance).history(limit ?? 50));
  ipcMain.on("desk:command-close", () => {
    if (commandWindow && !commandWindow.isDestroyed()) commandWindow.close();
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

module.exports = { createCommandWindow, getAgent };
