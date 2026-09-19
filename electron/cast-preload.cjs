"use strict";

/**
 * Bridge for the Cast pane (cast.html), injected by console-preload.cjs
 * because the pane is an iframe under nodeIntegrationInSubFrames -- same
 * wiring stage-preload.cjs uses for stage.html.
 *
 * Nine verbs over cast-config.cjs's (U01) write surface and
 * room-stage-host.cjs's castPaneImpl (U07) read surface. See cast-window.cjs
 * for the desk:cast-* channel names this mirrors 1:1, and its `call()` for
 * why every one of these resolves to `{ok, ...}` rather than ever rejecting.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aitherCast", {
  /** The live snapshot, every on-stage actor's resolution + provenance
   *  (characterFrom/voiceFrom/... — "the pane must be able to say WHY"),
   *  the safe (content-rating-filtered) roster, the seen-but-silent book,
   *  and any parse problems. */
  describe: () => ipcRenderer.invoke("desk:cast-describe"),
  /** Merge `patch` into `actors[key]` (creating the record if absent). */
  setActor: (key, patch) => ipcRenderer.invoke("desk:cast-set-actor", String(key || ""), patch || {}),
  /** Drop `actors[key]` entirely -- reverts to whatever the tier below it grants. */
  clearActor: (key) => ipcRenderer.invoke("desk:cast-clear-actor", String(key || "")),
  /** Merge `patch` into `stage` (maxBodies, idleSeconds, cooldownSeconds, gapMs, pollMs, resident). */
  setStage: (patch) => ipcRenderer.invoke("desk:cast-set-stage", patch || {}),
  /** Merge `patch` into `voice` (defaultVoice, defaultSpeed, maxChars, endpoint, speechFilter, affectIntensity). */
  setVoice: (patch) => ipcRenderer.invoke("desk:cast-set-voice", patch || {}),
  /** Merge `patch` into `channels[channel]` (voiced, presence). */
  setChannel: (channel, patch) => ipcRenderer.invoke("desk:cast-set-channel", String(channel || ""), patch || {}),
  /** Pin every on-stage actor's CURRENT resolved place into `actors[key].place`. */
  captureStage: () => ipcRenderer.invoke("desk:cast-capture-stage"),
  /** Hard mute: speak:false beats presence and keeps the body ("be here, say nothing"). */
  muteOrigin: (key) => ipcRenderer.invoke("desk:cast-mute-origin", String(key || "")),
  /** Clear a mute and set presence back to "normal" -- the inverse of muteOrigin
   *  AND of a presence:"off"/"quiet" grant. */
  reveal: (key) => ipcRenderer.invoke("desk:cast-reveal", String(key || "")),
});
