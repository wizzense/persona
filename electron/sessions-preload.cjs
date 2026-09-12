"use strict";

/**
 * Bridge for the Sessions pane (sessions.html), injected by console-preload.cjs
 * because the pane is an iframe under nodeIntegrationInSubFrames.
 *
 * Two verbs, both read-only for slice 1 of COCKPIT-DESIGN: the session list
 * (the daemon's unified directory) and a transcript tail. Steering is NOT here
 * yet on purpose — a capability the pane cannot honestly exercise must not be
 * offered, and the rows already render each session's steer_capability so the
 * owner sees what a later slice will unlock.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aitherSessions", {
  list: () => ipcRenderer.invoke("desk:sessions-list"),
  tail: (sessionId, transcriptPath) => ipcRenderer.invoke(
    "desk:sessions-tail", String(sessionId || ""), String(transcriptPath || ""),
  ),
});
