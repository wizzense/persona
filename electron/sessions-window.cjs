"use strict";

/**
 * sessions-window.cjs — the Sessions pane's standalone twin, and the owner of
 * its IPC.
 *
 * WHY THE HANDLERS LIVE HERE, not in console-window.cjs: a detached sessions
 * window must work on its own (the desk may never have opened the console this
 * session), and console-window's wireIpc only runs when the console opens. The
 * console's own rule is that a pane is a MODE, not a one-way door — a detach
 * button with no way back is how floating windows come back — so the pane gets
 * the same window treatment as Fleet and Command, via the same
 * ensureXxxIpc()/create/close/isOpen shape.
 *
 * Read-only (COCKPIT-DESIGN slice 1): list + tail, no steering.
 */

const path = require("node:path");

// Same lazy-require rule as console-window.cjs: keep this module loadable
// under `node --test` without Electron.
function electron() {
  return require("electron");
}

let sessionsWindow = null;
let wired = false;

function ensureSessionsIpc() {
  if (wired) return;
  wired = true;
  const { ipcMain } = electron();
  const sessions = require("./sessions-client.cjs");
  ipcMain.handle("desk:sessions-list", () => sessions.listSessions());
  ipcMain.handle("desk:sessions-tail", (_event, _sessionId, transcriptPath) =>
    sessions.tailTranscript(transcriptPath));
}

function createSessionsWindow() {
  ensureSessionsIpc();
  const { BrowserWindow } = electron();
  if (sessionsWindow && !sessionsWindow.isDestroyed()) {
    sessionsWindow.show();
    sessionsWindow.focus();
    return sessionsWindow;
  }
  sessionsWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 640,
    minHeight: 460,
    show: false,
    title: "Aither Sessions",
    backgroundColor: "#0f1218",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "sessions-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // The same fence every other desk window carries.
  sessionsWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  sessionsWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  sessionsWindow.once("ready-to-show", () => {
    sessionsWindow.show();
    sessionsWindow.focus();
  });
  sessionsWindow.on("closed", () => {
    sessionsWindow = null;
  });
  void sessionsWindow.loadFile(path.join(__dirname, "sessions.html"));
  return sessionsWindow;
}

function closeSessionsWindow() {
  if (sessionsWindow && !sessionsWindow.isDestroyed()) sessionsWindow.close();
}

function isSessionsWindowOpen() {
  return Boolean(sessionsWindow && !sessionsWindow.isDestroyed());
}

module.exports = { ensureSessionsIpc, createSessionsWindow, closeSessionsWindow, isSessionsWindowOpen };
