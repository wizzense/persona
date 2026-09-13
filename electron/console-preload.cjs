"use strict";

/**
 * Preload for the Aither Console — and for every pane inside it.
 *
 * The console runs with `nodeIntegrationInSubFrames`, so THIS file is injected
 * into each pane's iframe as well as the shell. Which API a frame gets is decided
 * by the frame's own URL, and the three pane preloads are REQUIRED rather than
 * re-implemented: a hand-copied `deskBridge` (138 lines, 20 verbs) would drift
 * from the real one, and the pane would then behave differently inside the
 * console than in its detached window — the one thing this whole arrangement
 * exists to prevent.
 *
 * Requiring them is why the console is not sandboxed: a sandboxed preload's
 * `require` is a polyfill that resolves `electron` and nothing else. The boundary
 * that matters is unchanged — contextIsolation stays on and nodeIntegration stays
 * off, so page script still reaches Node through nothing but these bridges.
 */

const { contextBridge, ipcRenderer } = require("electron");

const href = String(globalThis.location?.href || "");

if (href.includes("command.html")) {
  require("./command-preload.cjs");
} else if (href.includes("fleet-control.html")) {
  require("./fleet-preload.cjs");
} else if (href.includes("sessions.html")) {
  require("./sessions-preload.cjs");
} else if (!href.includes("console.html")) {
  // The renderer bundle: ?deck=1 and ?chat=1 both live here. Loaded ONLY for
  // those frames, because preload.cjs also installs middle-drag window-move
  // handlers meant for the avatar — harmless in the pane that already has them,
  // wrong everywhere else.
  require("./preload.cjs");
}

contextBridge.exposeInMainWorld("aitherConsole", {
  /** The rail, with each pane's resolved src. Main decides, never the page. */
  panes: () => ipcRenderer.invoke("desk:console-panes"),
  /** Hand a pane to its standalone window. */
  detach: (paneId) => ipcRenderer.invoke("desk:console-detach", String(paneId)),
  /** Take it back: close the standalone window, re-embed the pane. */
  reattach: (paneId) => ipcRenderer.invoke("desk:console-reattach", String(paneId)),
  /** Which panes are currently detached — the console asks on focus, because the
   *  owner can close a detached window directly and the rail must not lie. */
  detached: () => ipcRenderer.invoke("desk:console-detached"),
  /** Report where a HOSTED pane should be painted, or null when it is hidden.
   *  Main owns the view; the shell owns the layout, and only it can measure it. */
  stage: (pane, rect) => ipcRenderer.invoke("desk:console-stage",
    { pane: String(pane), rect: rect || null }),
  /** Main asks for a pane (a decision card arriving, a tray click). */
  onFocus: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("desk:console-focus", handler);
    return () => ipcRenderer.off("desk:console-focus", handler);
  },
  /** The inbox count for the Inbox tab (the same number the tray and taskbar show). */
  onInboxCount: (listener) => {
    const handler = (_event, payload) => listener(Number(payload?.count) || 0);
    ipcRenderer.on("desk:console-inbox-count", handler);
    return () => ipcRenderer.off("desk:console-inbox-count", handler);
  },
  close: () => ipcRenderer.send("desk:console-close"),
});
