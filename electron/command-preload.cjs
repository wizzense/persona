"use strict";

// Preload for the Command window (command.html). The renderer is sandboxed
// and sees four verbs; every one goes through main's CommandAgent, so multiple
// windows and the bridge/MCP can never disagree.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("command", {
  send: (text) => ipcRenderer.invoke("desk:command-send", String(text)),
  history: (limit) => ipcRenderer.invoke("desk:command-history", limit ?? 50),
  onProgress: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("desk:command-progress", handler);
    return () => ipcRenderer.off("desk:command-progress", handler);
  },
  close: () => ipcRenderer.send("desk:command-close"),
  openFleet: () => ipcRenderer.send("desk:command-open-fleet"),
});
