"use strict";

/** Preload for the Living Desktop overlay window.
 *
 *  The Living OS shell in `?mode=overlay` publishes its interactive hit-rects every
 *  ~60ms as `postMessage({ __aither: 'os-regions', regions, dock }, '*')` to its parent
 *  (Veil `src/components/os/os-client.tsx` — the same protocol AitherConnect's browser
 *  overlay consumes to clip its iframe). Loaded TOP-LEVEL here, `window.parent` IS the
 *  window, so the page posts to itself and this listener receives it. We forward the
 *  rects to the main process, which flips `setIgnoreMouseEvents` per cursor position —
 *  that is what makes the real Windows desktop clickable THROUGH the overlay everywhere
 *  the Living OS isn't drawing a window/dock. */

const { ipcRenderer } = require("electron");

window.addEventListener("message", (event) => {
  const data = event && event.data;
  if (!data || data.__aither !== "os-regions") return;
  ipcRenderer.send("living-desktop:regions", {
    regions: Array.isArray(data.regions) ? data.regions : [],
    dock: data.dock && typeof data.dock === "object" ? data.dock : null,
  });
});

// Desk -> Living OS state channel (2026-08-25): main pushes the Desk snapshot
// (decision cards, avatar slots, agents, relay feed) and this forwards it into the
// page as a postMessage the Veil shell can listen for — the same family as the
// os-regions protocol above, so the shell treats the overlay as a connected host
// rather than a dumb window.
ipcRenderer.on("living-desktop:desk-state", (_event, payload) => {
  window.postMessage(Object.assign({ __aither: "desk-state" }, payload), "*");
});
