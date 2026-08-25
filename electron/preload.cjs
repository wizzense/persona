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

// D-2170: LEFT-drag rotates the model (OrbitControls) and RIGHT-drag pans it,
// so neither button is free to move the WINDOW without breaking something
// that already works. A dedicated top-edge drag strip exists but is only
// 18px tall and easy to miss ("the avatar is trapped in a box" — reported
// live after the strip-only fix, because dragging the body of the model does
// nothing). MIDDLE-mouse-drag is unused by anything here, so it moves the
// window from ANYWHERE on the avatar, no modifier key needed.
let middleDragActive = false;
window.addEventListener(
  "mousedown",
  (event) => {
    if (event.button === 1) {
      middleDragActive = true;
      ipcRenderer.send("persona:drag-start", { x: event.screenX, y: event.screenY });
      event.preventDefault();
    }
  },
  true,
);
window.addEventListener(
  "mousemove",
  (event) => {
    if (middleDragActive) ipcRenderer.send("persona:drag-move", { x: event.screenX, y: event.screenY });
  },
  true,
);
window.addEventListener(
  "mouseup",
  (event) => {
    if (event.button === 1 && middleDragActive) {
      middleDragActive = false;
      ipcRenderer.send("persona:drag-end");
    }
  },
  true,
);
