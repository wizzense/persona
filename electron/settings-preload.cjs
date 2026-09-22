"use strict";

// Preload for the Settings pane (settings.html) -- the ONE shared settings
// page (owner, 2026-09-22: "there still isnt just a shared settings page").
// device enumeration itself uses navigator.mediaDevices directly (a Web API,
// not Node), so nothing is exposed for it here; this bridge covers only the
// main-process state (cast.json's input/hotkeys) that a sandboxed page cannot
// reach on its own.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("settingsBridge", {
  get: () => ipcRenderer.invoke("desk:settings-get"),
  setInput: (patch) => ipcRenderer.invoke("desk:settings-set-input", patch),
  probeAccel: (accel, excludeId) => ipcRenderer.invoke("desk:settings-probe-accel", accel, excludeId),
  setHotkey: (id, accel) => ipcRenderer.invoke("desk:settings-set-hotkey", id, accel),
  clearHotkey: (id) => ipcRenderer.invoke("desk:settings-set-hotkey", id, ""),
  bricksList: () => ipcRenderer.invoke("desk:bricks-list"),
  bricksAct: (verb, name) => ipcRenderer.invoke("desk:bricks-act", verb, name),
});
