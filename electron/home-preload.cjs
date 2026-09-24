"use strict";

/** Preload for the Home pane (home.html). Read-mostly: one summary, plus the few
 *  verbs Home offers -- a registry command, a pane to open, a card to answer. */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aitherHome", {
  summary: () => ipcRenderer.invoke("desk:home-summary"),
  run: (id) => ipcRenderer.invoke("desk:home-run", String(id || "")),
  open: (paneId, param) => ipcRenderer.invoke("desk:home-open", String(paneId || ""), param == null ? null : String(param)),
  answer: (cardId, key) => ipcRenderer.invoke("desk:home-answer", String(cardId || ""), String(key || "")),
});
