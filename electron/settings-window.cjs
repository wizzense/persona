"use strict";

/**
 * settings-window.cjs — the standalone Settings window, for the detach case.
 * Same shape as stage-window.cjs: no state of its own, loads settings.html
 * (which talks to main directly via settings-preload.cjs's settingsBridge),
 * and exists so "Detach" on the Settings pane opens something real instead
 * of failing silently the way an unwritten detach target does.
 */

// The window itself is presentation.cjs's route "settings" (slice 3, P2): its size,
// title, preload and single-instance show+focus live in ROUTE_WINDOWS.settings.
// This module has no IPC to keep; create/close/isOpen are wrappers.
const { openRouteWindow, closeRouteWindow, routeWindow } = require("./presentation.cjs");

const ROUTE = "settings";

// Same lazy-require rule as the other window modules: loadable under
// `node --test` without Electron.
function electron() {
  return require("electron");
}

function createSettingsWindow() {
  // Deny-open, no-navigate, show+focus on ready and the dropped handle on
  // 'closed' are presentation's openRouteWindow -- the same fence every desk window carries.
  return openRouteWindow(ROUTE, { electron: electron() });
}

function closeSettingsWindow() {
  closeRouteWindow(ROUTE);
}

function isSettingsWindowOpen() {
  return Boolean(routeWindow(ROUTE));
}

module.exports = { createSettingsWindow, closeSettingsWindow, isSettingsWindowOpen };
