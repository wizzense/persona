"use strict";

// Preload for the Fleet window (fleet-control.html). The renderer is sandboxed
// and sees exactly four verbs; every one goes through main's FleetControl, so
// the window, the tray, `game down|up` and the MCP tool can never disagree.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fleet", {
  status: (opts) => ipcRenderer.invoke("desk:fleet-status", opts ?? {}),
  run: (action) => ipcRenderer.invoke("desk:fleet-run", String(action)),
  onProgress: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("desk:fleet-progress", handler);
    return () => ipcRenderer.off("desk:fleet-progress", handler);
  },
  close: () => ipcRenderer.send("desk:fleet-close"),
  // Open one of the probed doors (tunnel, pulse, grafana, ...) in the browser.
  // Main only opens URLs from its own SURFACES list — the renderer cannot pick.
  open: (url) => ipcRenderer.send("desk:fleet-open", String(url)),
});
