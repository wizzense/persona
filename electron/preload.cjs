"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("deskBridge", {
  getSnapshot: () => ipcRenderer.invoke("desk:get-snapshot"),
  hide: () => ipcRenderer.send("desk:hide"),
  // Per-avatar context menu (2026-08-25): the renderer raycasts the click itself and
  // names the slot it hit; main builds the native Menu. The window-level deck trigger
  // below is suppressed for avatar hits via a dataset flag the renderer sets on the
  // canvas at pointerdown — the deck opening behind the avatar menu reads as a bug.
  avatarContextMenu: (slotId) => ipcRenderer.send("desk:avatar-context-menu", slotId),
  subscribe: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("desk:event", handler);
    return () => ipcRenderer.off("desk:event", handler);
  },
  // The Desk panel (bead deck): state pull + push subscription + actions. The
  // deck is a VIEW over main's state — every write goes back through main's own
  // functions, so the panel can never drift from the tray.
  deck: {
    getState: () => ipcRenderer.invoke("desk:deck-get-state"),
    open: () => ipcRenderer.send("desk:deck-open"),
    close: () => ipcRenderer.send("desk:deck-close"),
    answer: (id, choice) => ipcRenderer.invoke("desk:deck-answer", { id, choice }),
    action: (name, arg) => ipcRenderer.invoke("desk:deck-action", name, arg),
    // The Aitherium marketplace, one-stop-shop data layer
    // (market-client.cjs speaks MCP to the local gateway with the session
    // bearer; same credential story as the relay feed).
    marketBrowse: (query) => ipcRenderer.invoke("desk:market-browse", query ?? ""),
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
    // The renderer marks a right-click that hit an AVATAR by setting
    // dataset.rightOnAvatar on the canvas at pointerdown; main shows the per-avatar
    // menu for that click instead of the deck (both would otherwise open).
    const target = event.target;
    const onAvatar =
      target instanceof Element &&
      Boolean(target.dataset && target.dataset.rightOnAvatar);
    rightDownAt = null;
    // Always clear the flag — a right-DRAG pan starting on an avatar must not make
    // the NEXT empty-space right-click open nothing.
    if (target instanceof Element && target.dataset) delete target.dataset.rightOnAvatar;
    if (moved < 5 && !onAvatar) ipcRenderer.send("desk:context-menu");
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
      ipcRenderer.send("desk:drag-start", { x: event.screenX, y: event.screenY });
      event.preventDefault();
    }
  },
  true,
);
window.addEventListener(
  "mousemove",
  (event) => {
    if (middleDragActive) ipcRenderer.send("desk:drag-move", { x: event.screenX, y: event.screenY });
  },
  true,
);
window.addEventListener(
  "mouseup",
  (event) => {
    if (event.button === 1 && middleDragActive) {
      middleDragActive = false;
      ipcRenderer.send("desk:drag-end");
    }
  },
  true,
);
