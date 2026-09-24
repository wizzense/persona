"use strict";

/** Preload for the Home pane (home.html). Read-mostly: one summary, plus the few
 *  verbs Home offers -- a registry command, a pane to open, a card to answer. */

const { contextBridge, ipcRenderer } = require("electron");

/** Only the switch keys main understands, and only as booleans. */
function desiredState(patch) {
  const out = {};
  for (const key of ["voicesMuted", "micMuted", "avatarShown", "doNotDisturb"]) {
    if (patch && typeof patch[key] === "boolean") out[key] = patch[key];
  }
  return out;
}

contextBridge.exposeInMainWorld("aitherHome", {
  summary: () => ipcRenderer.invoke("desk:home-summary"),
  run: (id) => ipcRenderer.invoke("desk:home-run", String(id || "")),
  /** A switch sends the state it now SHOWS; main flips only what differs. */
  set: (patch) => ipcRenderer.invoke("desk:home-set", desiredState(patch)),
  open: (paneId, param) => ipcRenderer.invoke("desk:home-open", String(paneId || ""), param == null ? null : String(param)),
  answer: (cardId, key) => ipcRenderer.invoke("desk:home-answer", String(cardId || ""), String(key || "")),
});
