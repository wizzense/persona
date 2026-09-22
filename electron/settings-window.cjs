"use strict";

/**
 * settings-window.cjs — the standalone Settings window, for the detach case.
 * Same shape as stage-window.cjs: no state of its own, loads settings.html
 * (which talks to main directly via settings-preload.cjs's settingsBridge),
 * and exists so "Detach" on the Settings pane opens something real instead
 * of failing silently the way an unwritten detach target does.
 */

const path = require("node:path");

function electron() {
  return require("electron");
}

let settingsWindow = null;

function createSettingsWindow() {
  const { BrowserWindow } = electron();
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return settingsWindow;
  }
  settingsWindow = new BrowserWindow({
    width: 640,
    height: 560,
    minWidth: 460,
    minHeight: 380,
    show: false,
    title: "Aither Settings",
    backgroundColor: "#0f1218",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "settings-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  settingsWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  settingsWindow.once("ready-to-show", () => {
    settingsWindow.show();
    settingsWindow.focus();
  });
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
  void settingsWindow.loadFile(path.join(__dirname, "settings.html"));
  return settingsWindow;
}

function closeSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
}

function isSettingsWindowOpen() {
  return Boolean(settingsWindow && !settingsWindow.isDestroyed());
}

module.exports = { createSettingsWindow, closeSettingsWindow, isSettingsWindowOpen };
