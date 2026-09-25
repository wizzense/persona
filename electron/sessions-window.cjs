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

// The window itself is presentation.cjs's route "sessions" (slice 3, P2): its size,
// title, preload and single-instance show+focus live in ROUTE_WINDOWS.sessions.
// This module keeps the IPC; its create/close/isOpen are wrappers.
const { openRouteWindow, closeRouteWindow, routeWindow } = require("./presentation.cjs");

const ROUTE = "sessions";

// Same lazy-require rule as console-window.cjs: keep this module loadable
// under `node --test` without Electron.
function electron() {
  return require("electron");
}

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
  // Deny-open, no-navigate, show+focus on ready and the dropped handle on
  // 'closed' are presentation's openRouteWindow -- the same fence every file page carries.
  return openRouteWindow(ROUTE, { electron: electron() });
}

function closeSessionsWindow() {
  closeRouteWindow(ROUTE);
}

function isSessionsWindowOpen() {
  return Boolean(routeWindow(ROUTE));
}

module.exports = { ensureSessionsIpc, createSessionsWindow, closeSessionsWindow, isSessionsWindowOpen };
