"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("deskBridge", {
  getSnapshot: () => ipcRenderer.invoke("desk:get-snapshot"),
  hide: () => ipcRenderer.send("desk:hide"),
  minimize: () => ipcRenderer.send("desk:window-minimize"),
  close: () => ipcRenderer.send("desk:window-close"),
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
    // "None of these — do this instead": the card plane's steer verb, so a card
    // whose right answer is not one of its options no longer needs a terminal.
    steer: (id, text) => ipcRenderer.invoke("desk:deck-steer", { id, text }),
    action: (name, arg) => ipcRenderer.invoke("desk:deck-action", name, arg),
    // The Aitherium marketplace, one-stop-shop data layer
    // (market-client.cjs speaks MCP to the local gateway with the session
    // bearer; same credential story as the relay feed).
    marketBrowse: (query) => ipcRenderer.invoke("desk:market-browse", query ?? ""),
    // Per-avatar direct chat: the thread under an agent's message.
    relayThread: (messageId) => ipcRenderer.invoke("desk:relay-thread", messageId ?? ""),
    // Avatar previews: read a character's cached thumbnail (data URL or null),
    // and store one the deck just rendered offscreen. Names are validated as
    // slugs on the main side.
    characterThumb: (name) => ipcRenderer.invoke("desk:character-thumb", name ?? ""),
    saveCharacterThumb: (name, dataUrl) =>
      ipcRenderer.invoke("desk:save-character-thumb", name ?? "", dataUrl ?? ""),
  },
  // Full system awareness (#9): the five snapshot sources the System section
  // renders. Read-only; every one fails soft to ok:true + ERROR notes.
  system: {
    snapshot: () => ipcRenderer.invoke("desk:system-snapshot"),
    voice: () => ipcRenderer.invoke("desk:voice-snapshot"),
    vision: () => ipcRenderer.invoke("desk:vision-snapshot"),
    desktop: () => ipcRenderer.invoke("desk:desktop-snapshot"),
    connect: () => ipcRenderer.invoke("desk:connect-snapshot"),
  },
  // Push-to-talk (2026-08-29): renderer captures the mic, main writes the wav
  // to a temp file and runs it through the gateway's transcribe_audio tool.
  // Returns the transcript text, or an error string starting with "ERROR:".
  voiceTranscribe: (audioB64, format) =>
    ipcRenderer.invoke("desk:voice-transcribe", audioB64, format ?? "wav"),
  // Slice C: a finished transcript. Main posts it to the company room as the
  // OWNER and runs it as a command, so the answer comes back through the same
  // mouth the agents speak with.
  voiceHeard: (text) => ipcRenderer.invoke("desk:voice-heard", String(text || "")),
  /** listening / transcribing / idle / error: … — for the tray's mic line. */
  voiceListenState: (state) => ipcRenderer.send("desk:voice-listen-state", String(state || "")),
  // Drop-to-avatar (2026-08-29): the renderer hands the File object over;
  // the sandboxed renderer cannot see paths, so webUtils resolves it here.
  // Main MIME-routes it (image/audio/video/doc) and resolves with the
  // verdict: {ok, kind, name, summary} or {ok:false, reason}.
  fileDropped: (file) => {
    try {
      const filePath = webUtils.getPathForFile(file);
      if (!filePath) {
        return Promise.resolve({ ok: false, reason: "could not resolve the dropped file's path" });
      }
      return ipcRenderer.invoke("desk:file-dropped", filePath, file.type || "");
    } catch {
      return Promise.resolve({ ok: false, reason: "could not resolve the dropped file's path" });
    }
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

// Measured: LEFT-drag rotates the model (OrbitControls) and RIGHT-drag pans it,
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
