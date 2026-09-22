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

if (href.includes("settings.html")) {
  require("./settings-preload.cjs");
} else if (href.includes("command.html")) {
  require("./command-preload.cjs");
} else if (href.includes("fleet-control.html")) {
  require("./fleet-preload.cjs");
} else if (href.includes("sessions.html")) {
  require("./sessions-preload.cjs");
} else if (href.includes("stage.html")) {
  require("./stage-preload.cjs");
} else if (href.includes("cast.html")) {
  require("./cast-preload.cjs");
} else if (!href.includes("console.html")) {
  // The renderer bundle: ?deck=1 and ?chat=1 both live here. Loaded ONLY for
  // those frames, because preload.cjs also installs middle-drag window-move
  // handlers meant for the avatar — harmless in the pane that already has them,
  // wrong everywhere else.
  require("./preload.cjs");
}

// ── one skin, one chrome, in every frame ─────────────────────────────────────────
// Each pane is its own document, so both facts have to be applied per frame:
//   data-theme  the family theme the owner picked (aither-tokens.css keys off it)
//   .embedded   this document is a PANE inside the console. The shell's bar already
//               says "Fleet -- Containers, VRAM, doors"; a pane that repeats its
//               own title under it is the double header in the owner's screenshots.
//               The same page detached into its own window is NOT embedded and
//               keeps its title, because there it is the only one.
// A preload runs in the page's world; `globalThis` is how this file already reaches
// it (see `href` above), and it keeps the node-flavoured lint config honest.
const doc = globalThis.document;

function applyAppearance(appearance) {
  const root = doc.documentElement;
  if (!root || !appearance) return;
  if (appearance.theme && appearance.theme !== "dark-glass") root.dataset.theme = appearance.theme;
  else delete root.dataset.theme;
  if (Number.isFinite(appearance.uiScale)) root.style.setProperty("--ui-scale", String(appearance.uiScale));
}
function markFrame() {
  const root = doc.documentElement;
  if (!root) return;
  // A cross-origin parent throws on access -- which itself means "I am framed".
  const framed = () => { try { return globalThis.top !== globalThis.self; } catch { return true; } };
  root.classList.toggle("embedded", framed());
}
let lastAppearance = null;
const paint = () => { markFrame(); applyAppearance(lastAppearance); };
ipcRenderer.invoke("desk:appearance-get").then((a) => { lastAppearance = a; paint(); }).catch(() => {});
ipcRenderer.on("desk:appearance-changed", (_event, a) => { lastAppearance = a; paint(); });
if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", paint);
else paint();

contextBridge.exposeInMainWorld("aitherConsole", {
  /** { theme, uiScale, themes[] } -- the family's eleven, generated from Veil's. */
  appearance: () => ipcRenderer.invoke("desk:appearance-get"),
  setAppearance: (patch) => ipcRenderer.invoke("desk:appearance-set", patch || {}),
  /** The rail, with each pane's resolved src. Main decides, never the page. */
  panes: () => ipcRenderer.invoke("desk:console-panes"),
  /** Hand a pane to its standalone window. */
  detach: (paneId) => ipcRenderer.invoke("desk:console-detach", String(paneId)),
  /** Take it back: close the standalone window, re-embed the pane. */
  reattach: (paneId) => ipcRenderer.invoke("desk:console-reattach", String(paneId)),
  /** Which panes are currently detached. Still asked on focus as a backstop; the
   *  live answer arrives through onSurfaces below. */
  detached: () => ipcRenderer.invoke("desk:console-detached"),
  /** WHERE every pane is, pushed by main whenever the map moves (slice 2). The
   *  owner can close a detached window from its own title bar, and the rail used
   *  to keep saying "detached" until the console next regained focus. */
  onSurfaces: (listener) => {
    const handler = (_event, snapshot) => listener(snapshot || {});
    ipcRenderer.on("desk:console-surfaces", handler);
    return () => ipcRenderer.off("desk:console-surfaces", handler);
  },
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
  /** Everything Desk can do, for the palette (Ctrl+K). Resolved labels, no logic. */
  commands: () => ipcRenderer.invoke("desk:console-commands"),
  /** Run one of them by id; `arg` is the typed text for a row with `prompt`. */
  runCommand: (id, arg) => ipcRenderer.invoke(
    "desk:console-command-run", String(id), arg == null ? undefined : String(arg)),
  close: () => ipcRenderer.send("desk:console-close"),
});
