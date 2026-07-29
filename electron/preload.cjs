"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("personaBridge", {
  getSnapshot: () => ipcRenderer.invoke("persona:get-snapshot"),
  hide: () => ipcRenderer.send("persona:hide"),
  subscribe: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("persona:event", handler);
    return () => ipcRenderer.off("persona:event", handler);
  },
});

// The camera controls preventDefault() on contextmenu (right-drag pans), which suppresses
// Electron's webContents "context-menu" event — so surface the menu via IPC instead.
// Capture phase + a small drag threshold: a right-DRAG pans, a right-CLICK opens the menu.
let rightDownAt = null;
window.addEventListener(
  "mousedown",
  (event) => {
    if (event.button === 2) rightDownAt = { x: event.screenX, y: event.screenY };
  },
  true,
);
window.addEventListener(
  "mouseup",
  (event) => {
    if (event.button !== 2 || !rightDownAt) return;
    const moved =
      Math.abs(event.screenX - rightDownAt.x) + Math.abs(event.screenY - rightDownAt.y);
    rightDownAt = null;
    if (moved < 5) ipcRenderer.send("persona:context-menu");
  },
  true,
);
