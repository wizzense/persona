"use strict";

/** "Detach to own window" — pop one avatar OUT of the shared multi-avatar canvas into
 *  a real, separate OS window. This is the actual fix for "janky, only one draggable" —
 *  not a patch on the in-canvas raycast-drag-vs-shared-OrbitControls fight, but removing
 *  that fight entirely: a detached avatar is moved with the OS's own window drag (the
 *  same top-edge drag-handle strip every Persona window already has) and resized with
 *  the OS's own edge-resize, both categorically more reliable than 3D raycasting a
 *  pointer against a ground plane inside a camera that also owns rotate-drag. This is
 *  literally what "let me break them out into completely separate boxes" means. */

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { BrowserWindow, Menu } = require("electron");
const { isAllowedRendererNavigation } = require("./navigation-policy.cjs");

const detachedWindows = new Map(); // slotId -> BrowserWindow

function rendererUrlFor(modelUrl) {
  const base =
    process.env.VITE_DEV_SERVER_URL ||
    pathToFileURL(path.join(__dirname, "..", "dist", "index.html")).href;
  const url = new URL(base);
  // The solo window's own React entry reads this to render JUST this one character,
  // static/idle, instead of the full multi-avatar scene — see App.tsx.
  url.searchParams.set("solo", modelUrl);
  return url.href;
}

function isOpen(slotId) {
  const win = detachedWindows.get(slotId);
  return Boolean(win && !win.isDestroyed());
}

/**
 * Open a standalone always-on-top window for one avatar.
 * `onMergeBack(slotId)`, if given, is called when the user picks "Return to main scene"
 * from the detached window's own right-click menu — the caller (main.cjs) owns
 * `spawnAvatarSlot`, so re-adding it to the shared scene happens there, not here
 * (keeps this module independent of main.cjs — no circular require).
 */
function openDetachedAvatar(slotId, modelUrl, title, { onMergeBack } = {}) {
  if (isOpen(slotId)) {
    detachedWindows.get(slotId).focus();
    return detachedWindows.get(slotId);
  }

  const win = new BrowserWindow({
    width: 420,
    height: 620,
    minWidth: 260,
    minHeight: 360,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    roundedCorners: false,
    autoHideMenuBar: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    title: title || "Persona",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  const rendererUrl = rendererUrlFor(modelUrl);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isAllowedRendererNavigation(targetUrl, rendererUrl)) event.preventDefault();
  });
  void win.loadURL(rendererUrl);

  // Frameless + transparent means no native close button, same as the main avatar
  // window — right-click gives the way out (and the way back into the shared scene).
  win.webContents.on("context-menu", () => {
    Menu.buildFromTemplate([
      {
        label: "Return to main scene",
        click: () => {
          closeDetachedAvatar(slotId);
          onMergeBack?.(slotId);
        },
      },
      { label: "Close", click: () => closeDetachedAvatar(slotId) },
    ]).popup({ window: win });
  });

  win.on("closed", () => {
    detachedWindows.delete(slotId);
  });
  detachedWindows.set(slotId, win);
  return win;
}

function closeDetachedAvatar(slotId) {
  const win = detachedWindows.get(slotId);
  if (win && !win.isDestroyed()) win.close();
  detachedWindows.delete(slotId);
}

function listDetached() {
  return [...detachedWindows.keys()];
}

module.exports = {
  openDetachedAvatar,
  closeDetachedAvatar,
  isOpen,
  listDetached,
};
