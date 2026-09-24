"use strict";

/**
 * avatar-window.cjs -- the avatar overlay window: its construction, the saved size
 * and the resize verbs, the Hyprland placement retries, show/hide/toggle, the
 * renderer event queue (emitToRenderer / sendToAvatar and the load hook that
 * flushes it), the window outline and layout reset, and the `--smoke` boot test.
 *
 * Moved out of main.cjs in slice 3 of docs/UX-REIMPLEMENTATION.md (step 13). Pure
 * move: every channel name, size, flag and comment is what main.cjs had. The window
 * is REPLACED over the desk's life (closed -> null -> rebuilt by the next show), so
 * nobody outside this module holds it: every reader goes through getAvatarWindow()
 * at call time. Electron arrives as deps, so the module loads in a plain `node`.
 */

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// Measured: 430x680 on a 3840x2112 4K display reads as "trapped in a tiny box" —
// it's genuinely small on a real screen, independent of camera framing. Kept
// the same ~0.63 aspect ratio, just bigger. Still user-resizable (min 320x480).
const WINDOW_WIDTH = 600;
const WINDOW_HEIGHT = 950;

/** One bundle, three modes: the default avatar scene, `?solo=<model>` detached windows,
 *  and `?deck=1` the Desk panel (see createDeckWindow). */
function rendererUrl() {
  return (
    process.env.VITE_DEV_SERVER_URL ||
    pathToFileURL(path.join(__dirname, "..", "dist", "index.html")).href
  );
}

function createAvatarWindow({
  electron: { BrowserWindow, screen, ipcMain },
  app,
  configureHyprlandWindow,
  getHyprlandWindowPlacement,
  isAllowedRendererNavigation,
  // main owns the quit flag (tray Quit, before-quit); read at close time.
  isQuitting = () => false,
  // The tray is built after this module; refreshTrayMenu is only called while it exists.
  getTray = () => null,
  refreshTrayMenu = () => {},
  // Right-click on the avatar opens the Desk panel (presentation.cjs's 'cards').
  onContextMenu = () => {},
  debugLog = () => {},
} = {}) {
  let avatarWindow = null;
  let latestEvent = null;
  let hyprlandConfigured = false;
  let hyprlandConfiguring = false;
  let hyprlandConfigurationTimer = null;
  let hyprlandLastPosition = null;
  let rendererLoadHookAttached = false;
  const pendingRendererEvents = new Map();

  // D-2xxx: `resizable` defaults true, but the window is frameless + transparent
  // and the three.js canvas covers the whole surface capturing every pointer
  // event for camera controls (see the drag-window IPC below, which exists for
  // the identical reason: there is no OS-visible edge left to grab). Native
  // edge-resize is therefore unreachable in practice — "resizable: true" was
  // true and useless. Fixed the same way window MOVE already is: menu items +
  // shortcuts driving setBounds() directly, not relying on an edge nobody can
  // click. Size is persisted so it survives a restart instead of resetting to
  // the measured default every time.
  // The presets themselves live in command-registry.cjs, as commands: the palette
  // lists them one per row while the menus nest them, and a second copy of the
  // numbers here is how one surface ends up offering a size another does not.
  const SIZE_STATE_PATH = () => path.join(app.getPath("userData"), "window-size.json");

  function loadSavedSize() {
    try {
      const raw = fs.readFileSync(SIZE_STATE_PATH(), "utf-8");
      const parsed = JSON.parse(raw);
      if (Number.isFinite(parsed?.width) && Number.isFinite(parsed?.height)) {
        return { width: parsed.width, height: parsed.height };
      }
    } catch {
      /* no saved size yet, or file is corrupt — fall back to the default */
    }
    return { width: WINDOW_WIDTH, height: WINDOW_HEIGHT };
  }

  function saveSize(width, height) {
    try {
      fs.mkdirSync(path.dirname(SIZE_STATE_PATH()), { recursive: true });
      fs.writeFileSync(SIZE_STATE_PATH(), JSON.stringify({ width, height }), "utf-8");
    } catch {
      /* best-effort — a failed save just means the next launch uses the old size */
    }
  }

  /** Resize the overlay in place (top-left corner stays put), clamped to the
   *  display's work area so a saved size from a bigger monitor can't put the
   *  window partly off-screen on a smaller one. */
  function setWindowSize(width, height) {
    if (!avatarWindow || avatarWindow.isDestroyed()) return;
    const bounds = avatarWindow.getBounds();
    const area = screen.getDisplayMatching(bounds).workAreaSize;
    const w = Math.max(320, Math.min(Math.round(width), area.width));
    const h = Math.max(480, Math.min(Math.round(height), area.height));
    avatarWindow.setBounds({ x: bounds.x, y: bounds.y, width: w, height: h });
    saveSize(w, h);
  }

  function growWindow(factor = 1.15) {
    if (!avatarWindow || avatarWindow.isDestroyed()) return;
    const { width, height } = avatarWindow.getBounds();
    setWindowSize(width * factor, height * factor);
  }

  function shrinkWindow(factor = 1.15) {
    if (!avatarWindow || avatarWindow.isDestroyed()) return;
    const { width, height } = avatarWindow.getBounds();
    setWindowSize(width / factor, height / factor);
  }

  function positionWindow(window) {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const bounds = window.getBounds();
    const margin = 24;
    window.setPosition(
      Math.round(display.workArea.x + display.workArea.width - bounds.width - margin),
      Math.round(display.workArea.y + display.workArea.height - bounds.height - margin),
      false,
    );
  }

  function scheduleHyprlandWindowConfiguration({
    attempt = 0,
    force = false,
    position = null,
    reposition = !hyprlandConfigured,
  } = {}) {
    if (
      (hyprlandConfigured && !force) ||
      hyprlandConfiguring ||
      !avatarWindow ||
      avatarWindow.isDestroyed()
    ) {
      return;
    }
    clearTimeout(hyprlandConfigurationTimer);
    const delays = [0, 80, 200, 500, 1000];
    hyprlandConfigurationTimer = setTimeout(async () => {
      hyprlandConfigurationTimer = null;
      if (!avatarWindow || avatarWindow.isDestroyed()) return;
      hyprlandConfiguring = true;
      hyprlandConfigured = await configureHyprlandWindow({
        pid: process.pid,
        width: WINDOW_WIDTH,
        height: WINDOW_HEIGHT,
        onDebug: debugLog,
        position,
        reposition,
      });
      hyprlandConfiguring = false;
      if (!hyprlandConfigured && attempt + 1 < delays.length) {
        scheduleHyprlandWindowConfiguration({
          attempt: attempt + 1,
          force: true,
          position,
          reposition,
        });
      }
    }, delays[attempt] ?? delays.at(-1));
    hyprlandConfigurationTimer.unref?.();
  }

  function showOverlay({ focus = false } = {}) {
    const window = createWindow();
    if (window.isMinimized()) window.restore();
    if (focus) {
      if (!window.isVisible()) window.show();
      window.focus();
    } else if (!window.isVisible()) {
      window.showInactive();
    }
    scheduleHyprlandWindowConfiguration();
    // The tray's "Hide avatar / Show avatar" line reads the window state when the
    // menu is BUILT, so a toggle left it saying the wrong thing until something
    // else rebuilt the menu (owner, 2026-09-18: "the hide avatar button doesn't
    // change to unhide"). Rebuild on every show/hide.
    if (getTray()) refreshTrayMenu();
  }

  async function hideOverlay() {
    debugLog("hide overlay");
    const placement = await getHyprlandWindowPlacement(process.pid);
    if (placement) {
      hyprlandLastPosition = { x: placement.x, y: placement.y };
    }
    avatarWindow?.hide();
    if (getTray()) refreshTrayMenu();
  }

  function toggleOverlay() {
    if (avatarWindow?.isVisible()) void hideOverlay();
    else showOverlay({ focus: true });
  }

  function createWindow() {
    if (avatarWindow && !avatarWindow.isDestroyed()) return avatarWindow;

    const savedSize = loadSavedSize();
    avatarWindow = new BrowserWindow({
      width: savedSize.width,
      height: savedSize.height,
      minWidth: 320,
      minHeight: 480,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      roundedCorners: false,
      autoHideMenuBar: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      title: "Desk",
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Never throttle the overlay's animation loop (see the switches at the top
        // of main.cjs).
        backgroundThrottling: false,
      },
    });

    avatarWindow.setAlwaysOnTop(true, "floating");
    avatarWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    avatarWindow.setOpacity(1);
    avatarWindow.once("ready-to-show", () => {
      positionWindow(avatarWindow);
      scheduleHyprlandWindowConfiguration();
    });
    avatarWindow.on("show", () => {
      avatarWindow.setAlwaysOnTop(true, "floating");
      avatarWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      avatarWindow.setOpacity(1);
      scheduleHyprlandWindowConfiguration({
        force: true,
        position: hyprlandLastPosition,
        reposition: !hyprlandConfigured || hyprlandLastPosition != null,
      });
    });
    avatarWindow.on("close", (event) => {
      if (isQuitting()) return;
      event.preventDefault();
      void hideOverlay();
    });
    avatarWindow.on("closed", () => {
      clearTimeout(hyprlandConfigurationTimer);
      hyprlandConfigurationTimer = null;
      hyprlandConfigured = false;
      hyprlandConfiguring = false;
      rendererLoadHookAttached = false;
      avatarWindow = null;
    });

    const homeUrl = rendererUrl();
    avatarWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    avatarWindow.webContents.on("will-navigate", (event, targetUrl) => {
      if (!isAllowedRendererNavigation(targetUrl, homeUrl)) event.preventDefault();
    });
    // Nothing previously listened for either of these. A renderer crash left the window
    // showing whatever was on screen at the moment it died (often just black/blank) with
    // `windowVisible: true` still reported correctly by get_status (that flag reflects the
    // WINDOW, not the page inside it) and no signal anywhere that anything had gone wrong.
    // A JS exception in React reads identically from every existing check: healthy process,
    // healthy MCP server, "visible" window, nothing on screen.
    avatarWindow.webContents.on("render-process-gone", (_event, details) => {
      debugLog("RENDERER PROCESS GONE", details.reason, details.exitCode);
    });
    // Electron 39's console-message event passes ONE object, not five positional args —
    // the five-arg form still fires (nothing breaks) but logs a deprecation warning on
    // every single message, which would have buried the real signal this listener exists
    // to surface under noise about itself.
    avatarWindow.webContents.on("console-message", (event) => {
      // level 2 = error, 3 = warning in Electron's ConsoleMessageLevel; only surface those,
      // not every console.log — this is a crash/error signal, not a firehose.
      if (event.level >= 2) {
        debugLog(`[renderer console] ${event.sourceId}:${event.lineNumber} — ${event.message}`);
      }
    });
    // Right-click the avatar opens the DESK PANEL (the bead deck), not a native
    // menu — owner redesign 2026-08-25: "move away from nested menus... on right
    // click a full ui/ux opens up". Right-DRAG still pans the camera; the menu
    // only pops on release. The renderer's camera controls preventDefault() the
    // contextmenu event, so the preload relays it over IPC — keep the native
    // handler too as a fallback. All the old submenus (decisions, talk, models,
    // Aitheros Online, avatar slots, size) are now deck sections, one click deep
    // instead of three.
    avatarWindow.webContents.on("context-menu", () => onContextMenu());
    ipcMain.removeAllListeners("desk:context-menu");
    ipcMain.on("desk:context-menu", () => onContextMenu());

    // Measured: middle-mouse-drag window move (preload.cjs sends these). Tracks
    // the mouse's screen position at drag start against the window's own
    // position at drag start, then repositions by the same delta on every
    // move — works from anywhere on the avatar, doesn't touch left/right
    // click at all so OrbitControls and the context menu stay untouched.
    let dragOrigin = null;
    ipcMain.removeAllListeners("desk:drag-start");
    ipcMain.removeAllListeners("desk:drag-move");
    ipcMain.removeAllListeners("desk:drag-end");
    ipcMain.on("desk:drag-start", (event, { x, y }) => {
      // The window that SENT the drag — the preload runs in the avatar,
      // deck AND chat windows, and moving the avatar from the chat window
      // was the measured "you can't even move it" bug (2026-08-25).
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return;
      const [winX, winY] = win.getPosition();
      dragOrigin = { mouseX: x, mouseY: y, winX, winY, win };
    });
    ipcMain.on("desk:drag-move", (_event, { x, y }) => {
      if (!dragOrigin || dragOrigin.win.isDestroyed()) return;
      dragOrigin.win.setPosition(
        Math.round(dragOrigin.winX + (x - dragOrigin.mouseX)),
        Math.round(dragOrigin.winY + (y - dragOrigin.mouseY)),
        false,
      );
    });
    ipcMain.on("desk:drag-end", () => {
      dragOrigin = null;
    });

    // Sender-scoped window controls: any window (deck, chat) can minimize or
    // close ITSELF — the chat window shipped frameless with no way out,
    // which read as half-done (2026-08-25).
    ipcMain.on("desk:window-minimize", (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win) win.minimize();
    });
    ipcMain.on("desk:window-close", (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win) win.close();
    });
    // NOTE: rendererUrl is a FUNCTION — call it. Passing the function itself to
    // loadURL throws "Error processing argument at index 0, conversion failure"
    // (a rename collision, caught 2026-08-25), which aborts the whenReady chain:
    // blank avatar, never shown, deck never created.
    void avatarWindow.loadURL(rendererUrl());
    return avatarWindow;
  }

  function flushPendingRendererEvents() {
    rendererLoadHookAttached = false;
    if (!avatarWindow || avatarWindow.isDestroyed() || avatarWindow.webContents.isLoading()) return;
    for (const event of pendingRendererEvents.values()) {
      avatarWindow.webContents.send("desk:event", event);
    }
    pendingRendererEvents.clear();
  }

  function ensureRendererLoadHook() {
    if (
      rendererLoadHookAttached ||
      !avatarWindow ||
      avatarWindow.isDestroyed() ||
      !avatarWindow.webContents.isLoading()
    ) {
      return;
    }
    rendererLoadHookAttached = true;
    avatarWindow.webContents.once("did-finish-load", () => {
      flushPendingRendererEvents();
      // Re-apply the toggleable window boundary if it was left on (the overlay
      // div dies with every page load; the flag in localStorage survives it).
      void avatarWindow.webContents.executeJavaScript(
        "(() => {"
        + "if (localStorage.getItem('desk.window-outline') === '1'"
        + " && !document.getElementById('desk-window-outline')) {"
        + "const d = document.createElement('div');"
        + "d.id = 'desk-window-outline';"
        + "d.style.cssText = 'position:fixed;inset:0;border:2px dashed"
        + " rgba(120,160,255,.5);pointer-events:none;z-index:9999;"
        + "background:rgba(120,160,255,.06);box-sizing:border-box;"
        + "border-radius:10px;';"
        + "document.body.appendChild(d);"
        + "}"
        + "true;"
        + "})();").catch(() => {});
    });
  }

  function emitToRenderer(event) {
    latestEvent = event;
    pendingRendererEvents.set(event.type, event);
    if (!avatarWindow || avatarWindow.isDestroyed()) return;
    if (avatarWindow.webContents.isLoading()) {
      ensureRendererLoadHook();
      return;
    }
    avatarWindow.webContents.send("desk:event", event);
    pendingRendererEvents.delete(event.type);
  }

  /** Fire-and-forget event at the avatar window (menus, stage arrangements).
   *  Module level, because a stage command can come from the tray or the palette
   *  as well as from a body's own menu -- as a local it was a ReferenceError the
   *  moment the arrangement was picked anywhere but the menu (caught by eslint,
   *  no-undef, before it ever ran). */
  function sendToAvatar(type, payload = {}) {
    if (avatarWindow && !avatarWindow.isDestroyed()) {
      avatarWindow.webContents.send("desk:event", { type, ...payload });
    }
  }

  /** Toggleable "invisible glass" boundary: a dashed edge + faint tint so the
   *  avatar window's borders are visible while arranging it (owner 2026-08-25).
   *  Persisted per-window; restored on every renderer load by ensureRendererLoadHook. */
  function toggleWindowOutline() {
    if (!avatarWindow || avatarWindow.isDestroyed()) return;
    void avatarWindow.webContents.executeJavaScript(
      "(() => {"
      + "const KEY = 'desk.window-outline';"
      + "const on = localStorage.getItem(KEY) !== '1';"
      + "localStorage.setItem(KEY, on ? '1' : '0');"
      + "document.getElementById('desk-window-outline')?.remove();"
      + "if (on) {"
      + "const d = document.createElement('div');"
      + "d.id = 'desk-window-outline';"
      + "d.style.cssText = 'position:fixed;inset:0;border:2px dashed"
      + " rgba(120,160,255,.5);pointer-events:none;z-index:9999;"
      + "background:rgba(120,160,255,.06);box-sizing:border-box;"
      + "border-radius:10px;';"
      + "document.body.appendChild(d);"
      + "}"
      + "return on;"
      + "})();")
      .catch(() => {});
  }

  /** Drop the persisted per-slot transforms (every invisible-avatar artifact of
   *  2026-08-25 lived in that key — and the 2026-09-13 floating hair was its
   *  SCALE, since fixed in applySpringScale) and reload the avatar window, which
   *  re-frames with the default placement. Owner: "need like a reset button". */
  function resetAvatarLayout() {
    if (!avatarWindow || avatarWindow.isDestroyed()) return;
    void avatarWindow.webContents
      .executeJavaScript("localStorage.removeItem('desk.avatar-layout.v1'); true;")
      .finally(() => avatarWindow.reloadIgnoringCache());
  }

  /** `--smoke`: boot the REAL overlay window against the built renderer, then exit.
   *  Prints one SMOKE-OK / SMOKE-FAIL line; exits 1 on createWindow throw, load
   *  failure, renderer crash, or a 30 s timeout. The single-instance lock is
   *  skipped in smoke so an already-running Desk cannot turn this into a FALSE
   *  PASS — a second instance normally quits 0 without ever booting a window. */
  function runSmokeTest() {
    const fail = (reason) => {
      console.error(`SMOKE-FAIL desk: ${reason}`);
      app.exit(1);
    };
    const timer = setTimeout(() => fail("timed out after 30s"), 30000);
    let window;
    try {
      window = createWindow();
    } catch (error) {
      clearTimeout(timer);
      fail(`createWindow threw: ${error?.message || error}`);
      return;
    }
    const contents = window.webContents;
    contents.once("did-fail-load", (_event, code, description, url) =>
      fail(`did-fail-load ${code} ${description} ${url}`));
    contents.once("render-process-gone", (_event, details) =>
      fail(`render-process-gone ${details?.reason || "unknown"}`));
    contents.once("did-finish-load", () => {
      clearTimeout(timer);
      console.log(`SMOKE-OK desk ${app.getVersion()}`);
      app.exit(0);
    });
  }

  return {
    // The live window (null between a close and the next show). A getter, never a
    // value: the window is replaced, and a captured one goes stale.
    getAvatarWindow: () => avatarWindow,
    // The LAST event handed to the renderer: desk:get-snapshot returns it.
    getLatestEvent: () => latestEvent,
    rendererUrl,
    createWindow,
    showOverlay,
    hideOverlay,
    toggleOverlay,
    setWindowSize,
    growWindow,
    shrinkWindow,
    emitToRenderer,
    sendToAvatar,
    toggleWindowOutline,
    resetAvatarLayout,
    runSmokeTest,
    // before-quit: a pending Hyprland retry must not fire into a closing app.
    stop: () => clearTimeout(hyprlandConfigurationTimer),
  };
}

module.exports = { createAvatarWindow, rendererUrl, WINDOW_WIDTH, WINDOW_HEIGHT };
