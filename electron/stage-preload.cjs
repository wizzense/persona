"use strict";

/**
 * Bridge for the Stage pane (stage.html), injected by console-preload.cjs
 * because the pane is an iframe under nodeIntegrationInSubFrames.
 *
 * Four verbs, and every one of them is something that was previously reachable
 * ONLY by hitting a 3D body with the mouse.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aitherStage", {
  /** Who is on the stage: [{ slotId, name, agent, resident }]. */
  bodies: () => ipcRenderer.invoke("desk:stage-bodies"),
  /** Apply a named arrangement (row / arc / pair / focus / reset). */
  arrange: (name, options) => ipcRenderer.invoke(
    "desk:stage-arrange", String(name || ""), options || {},
  ),
  /** Frame one body, or everyone when slotId is null. */
  focus: (slotId) => ipcRenderer.invoke("desk:stage-focus", slotId || null),
  /** Send one body away (the resident stays; main refuses that). */
  remove: (slotId) => ipcRenderer.invoke("desk:stage-remove", String(slotId || "")),
});
