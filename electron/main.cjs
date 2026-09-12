"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  shell,
  Tray,
} = require("electron");
const decisionCards = require("./decision-cards.cjs");
const {
  fetchHistory: fetchRelayHistory,
  fetchThread: fetchRelayThread,
  post: postToRelay,
  postThreadReply: postRelayThreadReply,
  RELAY_CHANNEL,
  RELAY_NICK,
} = require("./relay-feed.cjs");
const marketClient = require("./market-client.cjs");
// Full system awareness (#9): the five snapshot clients the deck's System
// section renders. Each fails soft (ok:true + per-source ERROR notes) — a
// down gateway is a rendered state, never a broken panel.
const { systemSnapshot } = require("./system-client.cjs");
const { voiceSnapshot } = require("./voice-client.cjs");
const { visionSnapshot } = require("./vision-client.cjs");
const { routeDrop, synthesizeVerdict, stagePath, cleanupStage } = require("./drop-router.cjs");
const { desktopSnapshot } = require("./browser-client.cjs");
const { connectSnapshot } = require("./connect-client.cjs");
const { createBridgeServer, DEFAULT_PORT } = require("./bridge-server.cjs");
const {
  createDeskMcpHandler,
  getAnimationEventName,
  ANIMATION_EVENT_NAMES,
} = require("./mcp-server.cjs");
const {
  createFleetWindow,
  ensureFleetIpc,
  setCloseFallback: setFleetCloseFallback,
  closeFleetWindow,
  isFleetWindowOpen,
  getControl: getFleetControl,
  fleetSummaryCached,
} = require("./fleet-window.cjs");
const {
  createCommandWindow,
  ensureCommandIpc,
  setCloseFallback: setCommandCloseFallback,
  closeCommandWindow,
  isCommandWindowOpen,
  getAgent: getCommandAgent,
} = require("./command-window.cjs");
const { showConsole, focusPane, closeConsole } = require("./console-window.cjs");
const {
  ensureSessionsIpc,
  createSessionsWindow,
  closeSessionsWindow,
  isSessionsWindowOpen,
} = require("./sessions-window.cjs");
// The company room, both halves: the awdk daemon room (local, fleet-independent)
// and the relay channels (#command / #agents) that the poller executes from.
const { RoomPublisher } = require("./room-publisher.cjs");
const { RelayPoller } = require("./relay-poller.cjs");
const {
  configureHyprlandWindow,
  getHyprlandWindowPlacement,
} = require("./hyprland-window.cjs");
const { createAudioListener } = require("./audio-listener.cjs");
const { isAllowedRendererNavigation } = require("./navigation-policy.cjs");
const { parseProtocolUrl, voiceState } = require("./protocol-actions.cjs");
const {
  ROSTER_DIR,
  getRecentCharacters,
  enrollNewestDownload,
  getActiveCharacter,
  installCharacter,
  installCharacterToSlot,
  listCharacters,
} = require("./character-roster.cjs");
const { invalidateGate, isHidden } = require("./content-rating.cjs");
const { packContentDir } = require("./content-rating-loader.cjs");
const fs = require("node:fs");
const {
  getAgentAvatar,
  listAgents,
  loadMap: loadAgentAvatars,
  setAgentAvatar,
} = require("./agent-avatars.cjs");
const { exportToAitherShell } = require("./aithershell-export.cjs");
const {
  buildLivingDesktopMenu,
  desktopStatus,
  pushDeskState,
  setDeskStateProvider,
  showDesktopApp,
  showLivingDesktop,
  closeDesktopApp,
  desktopAppUrl,
  isAppOpen,
} = require("./living-desktop-window.cjs");
const { openDetachedAvatar } = require("./detached-avatar-window.cjs");

/** "Detach to own window" — pull one extra avatar out of the shared canvas into its own
 *  real, separately-draggable/resizable OS window. See detached-avatar-window.cjs. */
function detachAvatarToOwnWindow(slotId) {
  const info = avatarSlots.get(slotId);
  if (!info) return false;
  removeAvatarSlot(slotId);
  openDetachedAvatar(slotId, info.modelUrl, info.agent || info.name, {
    onMergeBack: () => spawnAvatarSlot(nextFreeSlotId(), info.name, info.agent),
  });
  return true;
}

// 430x680 on a 3840x2112 4K display reads as "trapped in a tiny box" —
// it's genuinely small on a real screen, independent of camera framing. Kept
// the same ~0.63 aspect ratio, just bigger. Still user-resizable (min 320x480).
const WINDOW_WIDTH = 600;
const WINDOW_HEIGHT = 950;

// D-2xxx: `resizable` defaults true, but the window is frameless + transparent
// and the three.js canvas covers the whole surface capturing every pointer
// event for camera controls (see the drag-window IPC below, which exists for
// the identical reason: there is no OS-visible edge left to grab). Native
// edge-resize is therefore unreachable in practice — "resizable: true" was
// true and useless. Fixed the same way window MOVE already is: menu items +
// shortcuts driving setBounds() directly, not relying on an edge nobody can
// click. Size is persisted so it survives a restart instead of resetting to
// the old default every time.
const SIZE_PRESETS = [
  { label: "Small", width: 430, height: 680 },
  { label: "Medium", width: WINDOW_WIDTH, height: WINDOW_HEIGHT },
  { label: "Large", width: 800, height: 1266 },
  { label: "Extra Large", width: 1000, height: 1583 },
];
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

function buildSizeMenu() {
  return [
    ...SIZE_PRESETS.map((preset) => ({
      label: preset.label,
      click: () => setWindowSize(preset.width, preset.height),
    })),
    { type: "separator" },
    { label: "Bigger  (Ctrl+Shift+=)", click: () => growWindow() },
    { label: "Smaller  (Ctrl+Shift+-)", click: () => shrinkWindow() },
  ];
}
const startInBackground = process.argv.includes("--background");
/** "Open the Desk panel at startup" — the owner's quick path into the panel, and a
 *  deterministic way to verify the deck live (restart with this flag, screenshot). */
const deckIsRequested = process.argv.includes("--open-deck");
const consoleIsRequested = process.argv.includes("--console");
/** "Boot the real window, prove the renderer loads, exit" — the Release workflow
 *  runs this against the INSTALLED app on every platform (job: package, step:
 *  "Smoke test the installed app"), so a package that cannot start fails the
 *  release, not the user's first launch. */
const smokeIsRequested = process.argv.includes("--smoke");
const protocolScheme = "desk";
const debugEnabled = process.env.DESK_DEBUG === "1";

let avatarWindow = null;
let deckWindow = null;
let chatWindow = null;
let bridge = null;
let isQuitting = false;
let latestEvent = null;
let latestListenerStatus = null;
let latestVoiceState = null;
let audioListener = null;
let tray = null;
// Decision-card plane (see decision-cards.cjs): the open queue drives the tray
// label/tooltip and the deck badge. Native notifications were REMOVED
// 2026-08-31 (owner decision) — the tray badge, deck and Discord fanout carry
// the push; DTOAST001 gates the notify.py twins against Windows toasts.
let openDecisions = [];
let relayFeed = [];
let relayFeedTimer = null;
// The local room (awdk daemon :8362, works with the fleet down) and the relay
// poller that turns messages typed anywhere in the relay into work orders.
let roomFeed = [];
let roomFeedTimer = null;
let roomPublisher = null;
let relayPoller = null;
let decisionWatchStop = null;
let hyprlandConfigured = false;
let hyprlandConfiguring = false;
let hyprlandConfigurationTimer = null;
let hyprlandLastPosition = null;
let rendererLoadHookAttached = false;
let mcpAnimationRequestId = 0;
const pendingRendererEvents = new Map();
const avatarSlots = new Map(); // Map<slotId, { name, modelUrl }> — tracks spawned slots (not slot 0)

app.setName("Desk");

// ── awdesk rename: migrate the legacy userData dir once ──────────────────────
// app.setName() decides the userData path, so renaming Persona -> Desk points
// Electron at %APPDATA%\Desk. The old %APPDATA%\Persona holds the character
// roster, ratings, settings and decision state. On first launch under the new
// name, copy it across; the legacy dir is LEFT IN PLACE so a rollback to the
// previous build keeps its data. Copy rather than move: userData can be large
// (VRM models), and a half-failed move orphans state under BOTH names.
try {
  const legacyDir = path.join(app.getPath("appData"), "Persona");
  const newDir = app.getPath("userData");
  if (fs.existsSync(legacyDir) && !fs.existsSync(newDir)) {
    fs.cpSync(legacyDir, newDir, { recursive: true });
    console.error("[desk] migrated userData Persona -> Desk");
  }
} catch (err) {
  // A failed migration must never block launch: start clean, and the legacy
  // dir is still there for the next attempt.
  console.error("[desk] userData migration failed (starting clean):", err?.message || err);
}

function debugLog(...values) {
  if (debugEnabled) console.error("[desk]", ...values);
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
}

async function hideOverlay() {
  debugLog("hide overlay");
  const placement = await getHyprlandWindowPlacement(process.pid);
  if (placement) {
    hyprlandLastPosition = { x: placement.x, y: placement.y };
  }
  avatarWindow?.hide();
}

function toggleOverlay() {
  if (avatarWindow?.isVisible()) void hideOverlay();
  else showOverlay({ focus: true });
}

/** One bundle, three modes: the default avatar scene, `?solo=<model>` detached windows,
 *  and `?deck=1` the Desk panel (see createDeckWindow). */
function rendererUrl() {
  return (
    process.env.VITE_DEV_SERVER_URL ||
    pathToFileURL(path.join(__dirname, "..", "dist", "index.html")).href
  );
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
    if (isQuitting) return;
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
  avatarWindow.webContents.on("context-menu", () => createDeckWindow());
  ipcMain.removeAllListeners("desk:context-menu");
  ipcMain.on("desk:context-menu", () => createDeckWindow());

  // Middle-mouse-drag window move (preload.cjs sends these). Tracks
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

function handleBridgeEvent(event) {
  if (event.type !== "audio-level" || event.level > 0.025) debugLog("event", event);
  if (event.type === "state") {
    latestVoiceState = event.state;
    if (event.state.phase === "starting" || event.state.phase === "active") {
      showOverlay();
    }
  } else if (event.type === "audio-level" && event.level > 0.025) {
    showOverlay();
  } else if (event.type === "animation") {
    showOverlay();
  }
  emitToRenderer(event);
}

function handleListenerStatus(status) {
  latestListenerStatus = status;
  emitToRenderer({ type: "listener-status", status });
}

async function handleMcpWindowAction(action) {
  if (action === "show") showOverlay({ focus: true });
  else if (action === "hide") await hideOverlay();
  else if (avatarWindow?.isVisible()) await hideOverlay();
  else showOverlay({ focus: true });
  return avatarWindow?.isVisible() ?? false;
}

function getMcpStatus() {
  return {
    windowVisible: avatarWindow?.isVisible() ?? false,
    voiceState: latestVoiceState,
    listener: latestListenerStatus,
  };
}

function listAvailableAnimations() {
  const animationsDir = path.join(__dirname, "..", "dist", "assets", "animations");
  try {
    const files = fs.readdirSync(animationsDir);
    return files.filter((file) => file.endsWith(".vrma"));
  } catch {
    return [];
  }
}

function handleProtocolUrl(rawUrl) {
  const commands = parseProtocolUrl(rawUrl, protocolScheme);
  if (!commands) return false;
  for (const command of commands) {
    if (command.type === "show") showOverlay({ focus: true });
    else if (command.type === "hide") void hideOverlay();
    else if (command.type === "toggle") toggleOverlay();
    else if (command.type === "fleet") createFleetWindow();
    else if (command.type === "command") createCommandWindow(getFleetControl(), { createFleetWindow });
    else if (command.type === "console") openConsole();
    else if (command.type === "overlay") showLivingDesktop();
    else if (command.type === "desktop") showDesktopApp();
    else if (command.type === "event") handleBridgeEvent(command.event);
  }
  return true;
}

function handleProtocolArgv(argv) {
  const protocolUrl = argv.find((value) => value.startsWith(`${protocolScheme}://`));
  if (protocolUrl) handleProtocolUrl(protocolUrl);
}

/** Open the model browser — the deck panel's Models & Market section. */
function openModelBrowser() {
  // Owner-overruled 2026-08-25: the standalone python page (model-browser.py
  // on :47836) was "still fucking lame" and its marketplace tab never
  // existed — the deck panel's Models & Market section IS the browser now
  // (search + roster characters + the live Aitherium marketplace feed).
  const win = createDeckWindow();
  // The deck opens at the TOP (quick actions first — the 2026-08-25 ordering
  // fix), but Models & market sits below notifications and system awareness,
  // so "Browse models" that only opens the deck read as a dead button
  // (owner, 2026-08-27: "still unable to open model/avatar browser").
  // Scroll the section into view; the renderer handles scroll-to-section.
  const scrollToModels = () => {
    if (win && !win.isDestroyed()) {
      win.webContents.send("desk:event", {
        type: "scroll-to-section",
        section: "models",
      });
    }
  };
  if (win.webContents.isLoading()) {
    win.webContents.once("did-finish-load", scrollToModels);
  } else {
    scrollToModels();
  }
  return win;
}

/** Open Forge Studio — media-forge's web UI, served by a HOST process
 *  (D:\media-forge, `python run.py` at 127.0.0.1:8200), not by a script inside
 *  this app. Unlike the model browser it does not open the page itself on boot,
 *  so this polls /health after spawning and opens the tab once it answers. */
function openMediaForge() {
  const url = "http://127.0.0.1:8200/";
  const probe = require("node:http").get(url, () => {
    probe.destroy();
    void shell.openExternal(url);
  });
  probe.on("error", () => {
    const { spawn } = require("node:child_process");
    spawn("python", [path.join("D:\\media-forge", "run.py")], {
      detached: true,
      stdio: "ignore",
      cwd: "D:\\media-forge",
      windowsHide: true,
    }).unref();
    const deadline = Date.now() + 15000;
    const poll = setInterval(() => {
      const check = require("node:http").get(url, (resp) => {
        if (resp.statusCode === 200) {
          clearInterval(poll);
          check.destroy();
          void shell.openExternal(url);
        }
      });
      check.on("error", () => {});
      check.setTimeout(750, () => check.destroy());
      if (Date.now() > deadline) clearInterval(poll);
    }, 500);
  });
  probe.setTimeout(1500, () => probe.destroy());
}

/** Open the talk surface. The deck panel IS the chat window: its relay section
 *  posts to #agents (the channel Aither and every connected session read and
 *  answer in) and shows the feed right there. The old behaviour — spawning a
 *  Windows Terminal tab running the `aither` CLI — was owner-overruled
 *  2026-08-25: "STILL just opens a terminal tab instead of a chat window right
 *  there". One chat surface, in the app, no terminal. */
function openTalkWindow() {
  createDeckWindow();
}

/** If the gate closed while an adult character was ON SCREEN, swap it off.
 *
 *  Filtering the menus is not enough: the avatar is a persistent always-on-top
 *  window, so a character installed while the gate was open keeps rendering
 *  after it closes. Runs at startup and whenever the tray menu is rebuilt. */
function enforceActiveCharacterRating() {
  const active = getActiveCharacter();
  if (!active || !isHidden(active)) return false;
  const replacement = listCharacters()[0];
  if (!replacement) {
    debugLog("adult gate closed and no visible character remains; hiding overlay");
    void hideOverlay();
    return true;
  }
  debugLog("adult gate closed; switching off hidden character", active);
  installCharacter(replacement);
  if (avatarWindow && !avatarWindow.isDestroyed()) {
    avatarWindow.webContents.reloadIgnoringCache();
  }
  return true;
}

/** Switch to a roster character and hot-reload the renderer (no app restart). */
function applyCharacter(name) {
  if (!installCharacter(name)) return false;
  debugLog("character switched", name);
  if (avatarWindow && !avatarWindow.isDestroyed()) {
    avatarWindow.webContents.reloadIgnoringCache();
  }
  refreshTrayMenu();
  showOverlay();
  return true;
}

/** Add a spawned avatar slot to the scene WITHOUT reloading. Slot "slot0" and
 *  variants of the default slot ID are reserved and refused. `agent`, when given,
 *  records which roster agent this slot represents (for the Remove Avatar label and
 *  future dialogue/arbitration routing) — it does not change which character renders. */
function spawnAvatarSlot(slotId, name, agent) {
  // Refuse slot IDs reserved for the default avatar
  if (slotId === "slot0" || slotId === "default" || slotId === "") return false;

  const modelUrl = installCharacterToSlot(name, slotId);
  if (!modelUrl) return false;

  avatarSlots.set(slotId, { name, modelUrl, agent: agent || null });
  debugLog("avatar slot spawned", slotId, name, agent ? `(agent: ${agent})` : "");
  showOverlay();
  if (avatarWindow && !avatarWindow.isDestroyed()) {
    avatarWindow.webContents.send("desk:event", {
      type: "spawn-avatar",
      slotId,
      modelUrl,
    });
  }
  sendDeckState();
  return true;
}

/** Remove a spawned avatar slot from the scene. Cannot remove slot0 (the default). */
function removeAvatarSlot(slotId) {
  // Refuse removal of slot0/default
  if (slotId === "slot0" || slotId === "default" || slotId === "") return false;

  if (!avatarSlots.has(slotId)) return false;

  avatarSlots.delete(slotId);
  debugLog("avatar slot removed", slotId);
  if (avatarWindow && !avatarWindow.isDestroyed()) {
    avatarWindow.webContents.send("desk:event", {
      type: "remove-avatar",
      slotId,
    });
  }
  sendDeckState();
  return true;
}

/** Per-avatar context menu (2026-08-25). The renderer raycasts the right-click itself
 *  (the deck trigger cannot — it is window-level, and OrbitControls owns right-drag pan)
 *  and names the slot; this builds the native menu for THAT avatar. Actions are scoped
 *  to what the slot actually is: talk goes to AitherShell (the platform chat, which
 *  already drives this avatar's speaking state and emotion animations over the same
 *  bridge — that IS the A2A integration), agent tools open the Desk panel whose agents
 *  section lists the same roster, and only a spawned slot offers removal. */
function popupAvatarMenu(slotId) {
  const isDefault = slotId === "slot0" || slotId === "default";
  const info = isDefault ? null : avatarSlots.get(slotId);
  if (!isDefault && !info) return;
  const displayName = isDefault ? getActiveCharacter() || "Aither" : info.name;
  const agent = isDefault ? "aither" : info.agent || null;

  const sendToAvatar = (type, payload) => {
    if (avatarWindow && !avatarWindow.isDestroyed()) {
      avatarWindow.webContents.send("desk:event", { type, ...payload });
    }
  };

  const template = [
    { label: `${displayName}${agent ? " — " + agent : ""}`, enabled: false },
    { type: "separator" },
    { label: "Focus camera here", click: () => sendToAvatar("focus-avatar", { slotId }) },
    { label: "Frame everyone", click: () => sendToAvatar("focus-avatar", { slotId: null }) },
    { label: "Reset position & size", click: () => sendToAvatar("reset-avatar-layout", { slotId }) },
    { type: "separator" },
    { label: agent ? `Talk to ${agent}` : "Talk to Aither", click: () => openTalkWindow() },
    { label: "Open agent tools", click: () => createDeckWindow() },
    { type: "separator" },
    { label: "Aither Console…", click: () => openConsole() },
    { label: "Aither Command…", click: () => createCommandWindow(getFleetControl(), { createFleetWindow }) },
    { label: "Fleet control…", click: () => createFleetWindow() },
  ];
  if (!isDefault) {
    template.push(
      { type: "separator" },
      { label: "Remove Avatar", click: () => removeAvatarSlot(slotId) },
    );
  }
  if (avatarWindow && !avatarWindow.isDestroyed()) {
    Menu.buildFromTemplate(template).popup({ window: avatarWindow });
  }
}

ipcMain.on("desk:avatar-context-menu", (_event, slotId) => {
  popupAvatarMenu(String(slotId || ""));
});

/** First "slotN" not already in avatarSlots — spawn_avatar/remove_avatar were MCP-only
 *  (an agent had to name a slot id itself); the menu needs to pick one for the owner. */
function nextFreeSlotId() {
  for (let n = 1; n < 1000; n += 1) {
    const candidate = `slot${n}`;
    if (!avatarSlots.has(candidate)) return candidate;
  }
  return `slot${Date.now()}`; // pathological case, still a valid unique id
}

/** Deterministic (not random) fallback character for an agent with no assignment yet —
 *  so every agent in the roster is spawnable IMMEDIATELY from "Add Avatar" without first
 *  visiting Characters ▸ Agents ▸ Assign, and so a group of unassigned agents lands on
 *  DIFFERENT characters instead of all cloning roster[0]. A simple string hash into the
 *  roster is enough; this is cosmetic seeding, not an identity guarantee. Returns null
 *  when the roster is empty — nothing to fall back to. */
function fallbackCharacterForAgent(agent, roster) {
  if (roster.length === 0) return null;
  let hash = 0;
  for (let i = 0; i < agent.length; i += 1) hash = (hash * 31 + agent.charCodeAt(i)) >>> 0;
  return roster[hash % roster.length];
}

/** "Add Avatar" — spawn an AGENT's avatar into the next free slot, not a bare VRM
 *  filename. D-2xxx: this used to list raw roster characters (`aiko-droid-base-model`,
 *  `celisia-arcroid`, ...) with no agent identity attached at all — meaningless to pick
 *  from if the point is "spawn Aither" or "spawn Hydra", and the whole reason multi-avatar
 *  exists is agent personas on screen, not a second copy of a random model. Reuses
 *  listAgents() (the SAME live union agent-avatars.cjs's other menu uses — sovereign
 *  roster + Library pack scan, no separate hardcoded list), chunked the same way
 *  buildCharacterMenu()/the old version of this menu did. Each entry uses the agent's
 *  ASSIGNED character (Characters ▸ Agents ▸ Assign current) when one exists, or a
 *  deterministic fallback so an unassigned agent is still spawnable rather than a dead
 *  menu entry — assign one later and future spawns of that agent pick it up. */
/** Recents on top for one-click switching, then every VISIBLE character in
 *  alphabetical groups — a flat list of 70+ filled the whole screen, so the roster
 *  lives in chunked sub-submenus instead.
 *
 *  Age-restricted characters are absent ENTIRELY while the adult-content gate
 *  is closed: listCharacters() drops them, so they are missing from Recent,
 *  from the "All characters" groups, and from the count in that label.
 *  The rating names themselves live in content-rating.cjs (ADULT_RATINGS) and
 *  are deliberately not repeated here — this file ships, and a comment that
 *  names the category announces it to anyone reading the bundle. */
function buildCharacterMenu() {
  const active = getActiveCharacter();
  const all = listCharacters();
  const item = (name) => ({
    label: name,
    type: "radio",
    checked: name === active,
    click: () => applyCharacter(name),
  });

  const CHUNK = 14;
  const groups = [];
  for (let start = 0; start < all.length; start += CHUNK) {
    const slice = all.slice(start, start + CHUNK);
    groups.push({
      // Paged, not "first … last": two 30-character slugs as a submenu LABEL
      // wrapped the menu and read as noise. A page number is scannable.
      label: `${start + 1}–${start + slice.length} of ${all.length}`,
      submenu: slice.map(item),
    });
  }

  const recents = getRecentCharacters().map(item);
  const rosterEntries = groups.length
    ? groups
    : [
        { label: "(no characters yet)", enabled: false },
        { type: "separator" },
        { label: "Get a model from VRoid Hub…", click: openVroidHub },
      ];
  return [
    { label: "Recent", enabled: false },
    ...(recents.length ? recents : [{ label: "(none yet — pick one below)", enabled: false }]),
    { type: "separator" },
    {
      label: `All characters (${all.length})`,
      submenu: rosterEntries,
    },
    { label: "Browse with pictures…", click: openModelBrowser },
    {
      label: "Send this character to AitherShell",
      click: () => {
        const name = getActiveCharacter() || "desk";
        showOverlay();
        exportToAitherShell(avatarWindow, name, handleBridgeEvent)
          .then((result) => debugLog("aithershell portrait written", result))
          .catch((error) => debugLog("aithershell export failed", error));
      },
    },
    { type: "separator" },
    { label: "Agents", submenu: buildAgentMenu() },
    { label: "Get a model from VRoid Hub…", click: openVroidHub },
    {
      label: "Enroll newest Downloads .vrm",
      click: () => {
        const name = enrollNewestDownload();
        if (name) applyCharacter(name);
        else debugLog("no .vrm found in Downloads to enroll");
      },
    },
    {
      label: "Open characters folder",
      click: () => {
        fsMkdirSafe(ROSTER_DIR);
        void shell.openPath(ROSTER_DIR);
      },
    },
  ];
}

/** Where characters come from (owner decision, 2026-09-10: Desk ships none).
 *  One function so the tray, the About box, the first-run prompt and the
 *  deck's "+ Add" all point at the SAME front door. */
function openVroidHub() {
  void shell.openExternal("https://hub.vroid.com/en/");
}

/** Renderer-supplied character names address files under the roster, so they
 *  are validated as SLUGS here: no separators, no traversal, no NUL. Every
 *  caller treats a rejected name as "no such character". */
function isValidCharacterName(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 128 &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0") &&
    name !== "." &&
    name !== ".."
  );
}

/** Where a visible character's model file lives (roster dir first, then the
 *  content pack), as a file:// URL — the deck's preview renderer loads it.
 *  Only main knows the real roster root, so the deck never builds these. */
function characterModelUrl(name) {
  if (!isValidCharacterName(name)) return null;
  const candidates = [path.join(ROSTER_DIR, name, "model.vrm")];
  try {
    const packDir = packContentDir("persona:characters-mature", "persona");
    if (packDir) candidates.push(path.join(packDir, "characters", name, "model.vrm"));
  } catch {
    /* no pack configured — roster only */
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return pathToFileURL(candidate).href;
    } catch {
      /* an unreadable candidate is simply not this one */
    }
  }
  return null;
}

/** Cached preview for a character (written by the deck after it renders one). */
function characterThumbPath(name) {
  return path.join(ROSTER_DIR, name, "thumbnail.jpg");
}

/** First run with an empty roster: Desk has nothing to render and — until now —
 *  said so nowhere. Asked ONCE per install (a marker file), never on every
 *  boot, and never blocking: the dialog is fire-and-forget. "Later" is a real
 *  answer; the tray keeps the same entries forever. */
function maybePromptForFirstCharacter() {
  try {
    if (listCharacters().length > 0) return;
    const marker = path.join(app.getPath("userData"), ".first-character-prompted");
    if (fs.existsSync(marker)) return;
    fs.writeFileSync(marker, new Date().toISOString());
    void dialog
      .showMessageBox({
        type: "info",
        title: "Desk has no character yet",
        message: "Desk ships no character models — add your own",
        detail: [
          "Get a VRM from VRoid Hub (free, and the models state their own",
          "license), then drop it in or use the tray:",
          "",
          "    tray ▸ Characters ▸ Enroll newest Downloads .vrm",
          "",
          "Any VRM 1.0 file you have the rights to works. Your models stay",
          "on this machine and are never redistributed.",
        ].join("\n"),
        buttons: ["Browse VRoid Hub…", "Open characters folder", "Later"],
        defaultId: 0,
        cancelId: 2,
      })
      .then(({ response }) => {
        if (response === 0) openVroidHub();
        else if (response === 1) {
          fsMkdirSafe(ROSTER_DIR);
          void shell.openPath(ROSTER_DIR);
        }
      });
  } catch (error) {
    debugLog("first-character prompt failed", error);
  }
}

/** Agents ▸ <agent> ▸ [Switch to its avatar | Assign current character]. Lets you keep
 *  one character per agent (Aither, Atlas, Demiurge, Lyra…) and flip between them. */
function buildAgentMenu() {
  const active = getActiveCharacter();
  return listAgents().map((agent) => {
    const assigned = getAgentAvatar(agent);
    return {
      label: assigned ? `${agent} — ${assigned}` : `${agent} — (unassigned)`,
      submenu: [
        {
          label: assigned ? `Switch to ${assigned}` : "Switch (assign one first)",
          enabled: Boolean(assigned),
          click: () => assigned && applyCharacter(assigned),
        },
        {
          label: active ? `Assign current: ${active}` : "Assign current character",
          enabled: Boolean(active),
          click: () => {
            if (!active) return;
            setAgentAvatar(agent, active);
            refreshTrayMenu();
            debugLog("agent avatar assigned", agent, active);
          },
        },
      ],
    };
  });
}

/** Switch the window to whichever character an agent owns. Returns the character or null.
 *
 * OPT-IN as of 2026-08-25 (DESK_AGENT_AVATAR_SWITCH=1 enables). Every agent
 * surface (awsh turns, the decision-card fanout, Aitheros Online, Awconnect) calls
 * set_agent as ambient telemetry, and each call re-installed that agent's
 * mapped character and RELOADED the window — so with several shells running,
 * the owner's manually chosen avatar was overwritten within seconds, over and
 * over ("keeps defaulting and changing to an avatar I don't want", measured
 * live: the unwanted character was exactly gobbonet's vrm-1-0 mapping while a
 * gobbonet companion shell was open). A window reload per agent turn is also a
 * visible seconds-long blank under GPU load, so the flips read as "the avatar
 * keeps breaking". The owner's explicit pick must never lose to telemetry;
 * per the AC001 rule the gate ships WITH its control (the env var), and the
 * refusal is logged so a silent no-op cannot be misread as a broken mapping.
 */
function applyAgentAvatar(agent) {
  if (process.env.DESK_AGENT_AVATAR_SWITCH !== "1") {
    debugLog("agent avatar switch suppressed (opt-in; DESK_AGENT_AVATAR_SWITCH!=1)", agent);
    return null;
  }
  const character = getAgentAvatar(agent);
  if (!character) return null;
  return applyCharacter(character) ? character : null;
}

function fsMkdirSafe(dir) {
  try {
    require("node:fs").mkdirSync(dir, { recursive: true });
  } catch {
    /* the open below will surface any real problem */
  }
}

function refreshTrayMenu() {
  invalidateGate();
  enforceActiveCharacterRating();
  // SLIMMED 2026-08-25 (owner redesign: "move away from nested menus"). The
  // deck panel (right-click the avatar, or "Open the Desk panel") carries the
  // decision cards, models, talk, Aitheros Online, avatar slots and size
  // controls — each is now ONE click from the deck instead of a three-deep
  // submenu. Characters stays as the single deliberate exception: a 70+
  // character roster needs a picker with more than a row of chips, and that
  // picker moves into the deck next.
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show Desk", click: () => showOverlay({ focus: true }) },
      { label: "Hide Desk", click: () => void hideOverlay() },
      { type: "separator" },
      {
        label: openDecisions.length > 0
          ? `Desk panel — ${openDecisions.length} decision${openDecisions.length === 1 ? "" : "s"} waiting`
          : "Open the Desk panel",
        click: () => createDeckWindow(),
      },
      {
        // First on purpose (2026-09-08): the console is the front door, and the
        // single-pane entries below it are now the DETACHED way in, not the only one.
        label: "Aither Console (everything in one window)…",
        click: () => openConsole(),
      },
      { label: "Talk to Aither…", click: openTalkWindow },
      { label: "Browse models…", click: openModelBrowser },
      { label: "Media Forge", click: openMediaForge },
      {
        // The fleet's on/off switch as a real window (2026-09-07, owner:
        // "a real program I can launch and interact with to control this").
        label: `Fleet control… (${fleetSummaryCached().split(" — ")[0]})`,
        click: () => createFleetWindow(),
      },
      {
        label: "Command…",
        click: () => createCommandWindow(getFleetControl(), { createFleetWindow }),
      },
      { label: "AitherOS overlay (Aitheros Online)", submenu: buildLivingDesktopMenu() },
      { label: "AitherDesktop app (full desktop)…", click: () => showDesktopApp() },
      { type: "separator" },
      { label: "Characters", submenu: buildCharacterMenu() },
      { label: "Window Size", submenu: buildSizeMenu() },
      { type: "separator" },
      {
        label: "About Desk",
        click: () => {
          // No bundled character since 2026-09-10 (owner decision): the About
          // surface says where a model comes from instead of crediting one,
          // and points at a real window rather than restating a license.
          void dialog
            .showMessageBox({
              type: "info",
              title: "About Desk",
              message: `Desk ${app.getVersion()}`,
              detail: [
                "The AitherOS desktop hub — avatar presence, decision cards, model & agent browsing, relay.",
                "",
                "Desk ships no character models. Add your own — VRoid Hub is the guided path;",
                "any VRM 1.0 file you have the rights to works. Your models stay on this machine.",
                "Full asset policy: ASSET_LICENSES.md.",
              ].join("\n"),
              buttons: ["Browse VRoid Hub…", "Close"],
              defaultId: 1,
              cancelId: 1,
            })
            .then(({ response }) => {
              if (response === 0) {
                void shell.openExternal("https://hub.vroid.com/en/");
              }
            });
        },
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
}

/** Everything the deck panel renders, in one object — the panel is a VIEW over
 *  main's state, so the tray and the deck can never disagree about what is
 *  waiting or which avatars exist (the one-source-of-truth class). */
function deckState() {
  return {
    decisions: openDecisions,
    openCount: openDecisions.length,
    deskVisible: Boolean(
      avatarWindow && !avatarWindow.isDestroyed() && avatarWindow.isVisible(),
    ),
    slots: [...avatarSlots.entries()].map(([slotId, info]) => ({
      slotId,
      name: info.name,
      agent: info.agent || "",
    })),
    agents: listAgents(),
    // The fleet-at-a-glance data the owner asked for (2026-08-25): roster
    // agents WITH their assigned avatars, and the installed character roster
    // count — one stop for fleet/roster/avatars/settings, not a launch button.
    characters: listCharacters(),
    // Where each character's model file actually LIVES, as a file:// URL the
    // renderer can load. Only main knows the real roster root (it moves with
    // DESK_ROSTER_DIR and differs in a packaged app), so the deck never
    // constructs these paths itself — the thumbnail renderer consumes them.
    characterModels: Object.fromEntries(
      listCharacters()
        .map((name) => [name, characterModelUrl(name)])
        .filter(([, url]) => Boolean(url)),
    ),
    activeCharacter: getActiveCharacter() || "",
    agentCharacters: Object.fromEntries(
      listAgents().map((agent) => [agent, getAgentAvatar(agent) || ""]),
    ),
    // The relay channel the sessions coordinate on — the desk is the cockpit,
    // and a cockpit that cannot see #agents is a window onto half the fleet
    // (owner: "why would awask + awdesk not be integrated into awrelay").
    relay: relayFeed,
    relayChannel: RELAY_CHANNEL,
    // The local room (awdk daemon): command requests/replies beside every
    // session's tool calls — the half of the company room that outlives the fleet.
    room: roomFeed,
    roomStatus: roomPublisher ? (roomPublisher.lastError || "ok") : "not started",
    relayPoller: relayPoller ? relayPoller.status() : null,
  };
}

/** Push fresh state to every window rendering the deck feed. */
function sendDeckState() {
  const event = { type: "deck-state", ...deckState() };
  if (deckWindow && !deckWindow.isDestroyed()) {
    deckWindow.webContents.send("desk:event", event);
  }
  // The chat window renders the SAME feed; without this push a sent
  // message never appears in the list the sender is looking at.
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.webContents.send("desk:event", event);
  }
}

// Feed the Aitheros Online overlay the same snapshot the deck panel consumes, so the
// shell can render decision cards / slots / agents — the Veil side listens for
// { __aither: 'desk-state' } postMessages (relayed by living-desktop-preload.cjs).
// Polled lightly: deckState() is cheap and the overlay is a separate renderer, so
// nothing here can lag the avatar window.
setDeskStateProvider(() => deckState());
setInterval(() => {
  pushDeskState();
}, 5000);

/** Poll #agents for the deck's relay section. [] on refusal — the section
 *  renders "relay unavailable" rather than pretending the channel is empty. */
async function refreshRelayFeed() {
  const rows = await fetchRelayHistory();
  relayFeed = rows;
  sendDeckState();
}

/** The local room's chat-like rows (command requests/replies, agent messages)
 *  from the awdk daemon — the half of the company room that does not need the
 *  fleet. [] when the daemon is down; the chat window says so. */
async function refreshRoomFeed() {
  if (!roomPublisher) return;
  const rows = await roomPublisher.recentChat({ limit: 60 });
  const changed = rows.length !== roomFeed.length || (rows.length && rows[rows.length - 1].id !== roomFeed[roomFeed.length - 1]?.id);
  roomFeed = rows;
  if (changed) sendDeckState();
}

/** Push the open-count badge to the avatar window's floating beads. */
function sendDecisionBadge() {
  if (!avatarWindow || avatarWindow.isDestroyed()) return;
  avatarWindow.webContents.send("desk:event", {
    type: "decisions-changed",
    openCount: openDecisions.length,
  });
}

/** The Desk panel — a frameless always-on-top window that opens beside the avatar
 *  on right-click. Same bundle as the avatar scene (`?deck=1`), same preload, so
 *  it shares the bridge and every future awdesk rename moves it along for free. */
function createDeckWindow() {
  if (deckWindow && !deckWindow.isDestroyed()) {
    deckWindow.show();
    deckWindow.focus();
    return deckWindow;
  }
  const workArea = screen.getPrimaryDisplay().workArea;
  const base =
    avatarWindow && !avatarWindow.isDestroyed() ? avatarWindow.getBounds() : null;
  const width = 460;
  const height = 700;
  let x = base ? base.x + base.width + 10 : workArea.x + workArea.width - width - 40;
  let y = base ? base.y : workArea.y + 80;
  // If the avatar sits against the right edge, open to its LEFT instead of off-screen.
  if (x + width > workArea.x + workArea.width) {
    x = Math.max(workArea.x + 8, base ? base.x - width - 10 : x);
  }
  y = Math.max(workArea.y + 8, Math.min(y, workArea.y + workArea.height - height - 8));

  deckWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    minWidth: 360,
    minHeight: 480,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: true,
    autoHideMenuBar: true,
    alwaysOnTop: true,
    // In the taskbar on purpose: an always-on-top frameless panel the owner
    // cannot find again once it loses focus is a trap, not a feature.
    skipTaskbar: false,
    title: "Desk",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  deckWindow.setAlwaysOnTop(true, "floating");
  deckWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const deckUrl = rendererUrl() + (rendererUrl().includes("?") ? "&" : "?") + "deck=1";
  deckWindow.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isAllowedRendererNavigation(targetUrl, deckUrl)) event.preventDefault();
  });
  deckWindow.webContents.on("console-message", (event) => {
    if (event.level >= 2) {
      debugLog(`[deck console] ${event.sourceId}:${event.lineNumber} — ${event.message}`);
    }
  });
  deckWindow.webContents.on("render-process-gone", (_event, details) => {
    debugLog("DECK RENDERER PROCESS GONE", details.reason, details.exitCode);
  });
  deckWindow.once("ready-to-show", () => {
    deckWindow.show();
    deckWindow.focus();
  });
  deckWindow.on("closed", () => {
    deckWindow = null;
  });
  void deckWindow.loadURL(deckUrl);
  return deckWindow;
}

function createChatWindow() {
  // The chat bead window (2026-08-25): the company-room relay + direct
  // threads in a DEDICATED chat surface — not the deck, not a terminal.
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.show();
    chatWindow.focus();
    return chatWindow;
  }
  const workArea = screen.getPrimaryDisplay().workArea;
  const base =
    avatarWindow && !avatarWindow.isDestroyed() ? avatarWindow.getBounds() : null;
  const width = 420;
  const height = 640;
  let x = base ? base.x - width - 10 : workArea.x + 60;
  let y = base ? base.y : workArea.y + 80;
  if (x < workArea.x) {
    x = Math.min(workArea.x + workArea.width - width - 8,
      base ? base.x + base.width + 10 : x);
  }
  y = Math.max(workArea.y + 8, Math.min(y, workArea.y + workArea.height - height - 8));
  chatWindow = new BrowserWindow({
    x, y, width, height, minWidth: 340, minHeight: 420,
    show: false, frame: false, transparent: true, alwaysOnTop: true,
    skipTaskbar: false, title: "Desk chat",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  chatWindow.setAlwaysOnTop(true, "floating");
  chatWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const chatUrl =
    rendererUrl() + (rendererUrl().includes("?") ? "&" : "?") + "chat=1";
  chatWindow.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isAllowedRendererNavigation(targetUrl, chatUrl)) event.preventDefault();
  });
  chatWindow.once("ready-to-show", () => {
    chatWindow.show();
    chatWindow.focus();
  });
  chatWindow.on("closed", () => {
    chatWindow = null;
  });
  void chatWindow.loadURL(chatUrl);
  return chatWindow;
}

/** ONE entry point for every fleet surface (window buttons, tray, bridge
 *  /fleet/*, MCP fleet_control, `game`): the verb lands on the single
 *  FleetControl so nothing can race a second mask/unmask pass. */
async function fleetAction(action, { fresh = false } = {}) {
  const control = getFleetControl();
  if (action === "open_panel" || action === "open") {
    createFleetWindow();
    return { ok: true, opened: true, summary: fleetSummaryCached() };
  }
  if (action === "status") {
    const verdict = await control.status(fresh ? { maxAgeMs: 0 } : {});
    return { ...verdict, summary: fleetSummaryCached() };
  }
  if (!Object.prototype.hasOwnProperty.call(require("./fleet-control.cjs").ACTIONS, action)) {
    return { ok: false, unknown: true, error: `unknown fleet action "${action}"` };
  }
  // Raise the window so the owner SEES a fleet-changing action an agent started.
  if (action !== "status") createFleetWindow();
  return control.run(action);
}

/** ONE entry point for every command surface (window, bridge, MCP): the request
 *  lands on the single CommandAgent so history and queue are consistent. */
async function commandAction(text, { source = "unknown" } = {}) {
  createCommandWindow(getFleetControl(), { createFleetWindow });
  const agentInstance = getCommandAgent(getFleetControl());
  return agentInstance.run(text, { source });
}

/**
 * The unified console: Command | Fleet | Cards | Chat in ONE window.
 *
 * Owner, 2026-09-08: "i would like a unified window with option to detach these
 * including the decision cards -- cant seem to get a wrangle on all of these pop
 * ups". Every creator below already existed; what did not exist was a host for
 * them. The console does not replace them -- it hands each pane BACK to its own
 * window on demand, and takes it back on reattach, which is why every entry
 * carries all three of open/close/isOpen. A detach with no way back would leave
 * the owner exactly where this started.
 */
function openConsole() {
  // 🚩 Wire the pane handlers FIRST. Both pages talk to main the moment they load
  // -- fleet-control.html probes on load, command.html sends on the first Enter --
  // and their handlers used to be installed only as a side effect of creating the
  // standalone window. Opening the console without ever having opened those
  // windows produced a Fleet pane of em-dashes (identical to a fleet that is down)
  // and a Command pane that failed with "No handler registered for
  // 'desk:command-send'". Both surfaces LOOK finished while answering nothing.
  ensureFleetIpc();
  ensureCommandIpc(getFleetControl(), { createFleetWindow });
  ensureSessionsIpc();
  // And "close" inside a pane now closes the console, rather than looking for a
  // standalone window that does not exist and silently doing nothing.
  setFleetCloseFallback(closeConsole);
  setCommandCloseFallback(closeConsole);
  return showConsole({
    rendererUrl,
    windows: {
      command: {
        open: () => createCommandWindow(getFleetControl(), { createFleetWindow }),
        close: closeCommandWindow,
        isOpen: isCommandWindowOpen,
      },
      fleet: {
        open: () => createFleetWindow(),
        close: closeFleetWindow,
        isOpen: isFleetWindowOpen,
      },
      sessions: {
        open: () => createSessionsWindow(),
        close: closeSessionsWindow,
        isOpen: isSessionsWindowOpen,
      },
      cards: {
        open: () => createDeckWindow(),
        close: () => {
          if (deckWindow && !deckWindow.isDestroyed()) deckWindow.close();
        },
        isOpen: () => Boolean(deckWindow && !deckWindow.isDestroyed()),
      },
      chat: {
        open: () => createChatWindow(),
        close: () => {
          if (chatWindow && !chatWindow.isDestroyed()) chatWindow.close();
        },
        isOpen: () => Boolean(chatWindow && !chatWindow.isDestroyed()),
      },
      // The AitherDesktop shell -- the SAME aitherium.com desktop the standalone
      // app window shows, hosted here on its own session partition so the two are
      // one login rather than two. The OVERLAY is deliberately not a pane: it is a
      // transparent, click-through surface over the whole Windows desktop, and a
      // rectangle inside a window is not that. It stays a tray/protocol launcher.
      desktop: {
        open: () => showDesktopApp(),
        close: () => closeDesktopApp(),
        isOpen: () => isAppOpen(),
      },
    },
    urls: { desktop: desktopAppUrl },
  });
}

// The LAST independent popup source folds in (owner, 2026-09-08: "I WANT TO
// CONSOLIDATE AND DEDUPE"). A decision card had three unrelated homes -- awask's
// own Tk window, the deck panel, and now the console's Cards pane -- and none of
// them knew the others existed, so answering a card in one left it sitting open
// in another. The ladder is now explicit and every rung is a surface that already
// exists: the deck window if the Cards pane is DETACHED into it, otherwise the
// console, and awask's popup only when neither is there to take it.
decisionCards.setWindowRouter((_kind, id) => {
  if (deckWindow && !deckWindow.isDestroyed()) {
    deckWindow.show();
    deckWindow.focus();
    return true;
  }
  openConsole();
  return focusPane("cards", id);
});

function createTray() {
  const iconPath = path.join(__dirname, "..", "build", "icon.png");
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 20, height: 20 });
  tray = new Tray(icon);
  tray.setToolTip("Desk — click to show/hide the avatar; right-click for decisions, avatars and surfaces");
  refreshTrayMenu();
  tray.on("click", toggleOverlay);
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

if (!smokeIsRequested && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const handled = argv.some((value) => value.startsWith(`${protocolScheme}://`));
    handleProtocolArgv(argv);
    if (argv.includes("--open-deck")) {
      createDeckWindow();
      return;
    }
    if (argv.includes("--fleet")) {
      createFleetWindow();
      return;
    }
    if (argv.includes("--console")) {
      openConsole();
      return;
    }
    if (argv.includes("--command")) {
      createCommandWindow(getFleetControl(), { createFleetWindow });
      return;
    }
    if (argv.includes("--overlay")) {
      showLivingDesktop();
      return;
    }
    if (argv.includes("--desktop")) {
      showDesktopApp();
      return;
    }
    if (!handled && !argv.includes("--background")) showOverlay({ focus: true });
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleProtocolUrl(url);
  });

  app.whenReady().then(async () => {
    if (smokeIsRequested) {
      runSmokeTest();
      return;
    }
    // Unpackaged runs (npx electron .) have no Start Menu shortcut registering
    // the AUMID, so Windows shows the RAW id as every toast's header — the
    // owner's decision-card notification read "com.xikhar.persona" instead of
    // the app's name (screenshot, 2026-08-25). Dev uses the display name;
    // packaged installs carry the awdesk id. Changing the AUMID resets toast
    // grouping and per-app notification settings once — the deliberate cost
    // of the rename, not a regression to chase.
    app.setAppUserModelId(app.isPackaged ? "com.xikhar.awdesk" : "Desk");
    app.dock?.hide();
    if (app.isPackaged) app.setAsDefaultProtocolClient(protocolScheme);

    ipcMain.handle("desk:get-snapshot", () => {
      // The renderer pulls this once per mount — including after the window
      // reload applyCharacter() does. Spawned avatar slots live only in main's
      // memory, and until 2026-08-24 nothing re-sent them after a reload, so
      // switching characters silently cleared every extra avatar while the
      // tray still listed them. Replay them here: the renderer registers its
      // event listener synchronously right after calling getSnapshot(), so by
      // the time this handler runs the listener exists — a push from here
      // cannot race the subscription (a push from did-finish-load can).
      // The renderer de-dupes by slotId, so a second pull cannot double-spawn.
      if (avatarWindow && !avatarWindow.isDestroyed()) {
        for (const [slotId, info] of avatarSlots) {
          avatarWindow.webContents.send("desk:event", {
            type: "spawn-avatar",
            slotId,
            modelUrl: info.modelUrl,
          });
        }
        if (avatarSlots.size > 0) debugLog("replayed avatar slots", avatarSlots.size);
      }
      return latestEvent;
    });
    ipcMain.on("desk:hide", () => void hideOverlay());

    // ---- Desk panel IPC (the bead deck) -------------------------------------
    // The deck is a VIEW over main's state: it pulls deckState() once on mount,
    // subscribes to desk:event pushes for updates, and routes every action
    // back through the same functions the old menus used — no second path to
    // drift from.
    ipcMain.handle("desk:deck-get-state", () => deckState());
    ipcMain.on("desk:deck-open", () => createDeckWindow());
    ipcMain.on("desk:deck-close", () => {
      if (deckWindow && !deckWindow.isDestroyed()) deckWindow.close();
    });
    ipcMain.handle("desk:deck-answer", (_event, payload) => {
      const { id, choice } = payload || {};
      const ok = decisionCards.answerCard(id, choice);
      if (ok) {
        // The loop closes only if the SESSIONS see the answer: post it to the
        // coordination channel the fleet already reads. Best-effort — a quiet
        // relay must never make the answer look undone.
        void postToRelay(RELAY_CHANNEL, `answered ${id}: ${choice} (via desk)`).then(() => {
          void refreshRelayFeed();
        });
      }
      return ok;
    });
    // STEER a card: "none of these options — do this instead". The card plane's
    // write verb the deck never had (integration-map gap 3): without it, a card
    // whose right answer was not one of its options had to be retyped in a
    // terminal. Mirrored to the coordination channel like an answer, so the
    // sessions see the order and not just its effect.
    ipcMain.handle("desk:deck-steer", (_event, payload) => {
      const { id, text } = payload || {};
      const ok = decisionCards.steerCard(id, text);
      if (ok) {
        void postToRelay(RELAY_CHANNEL, `steered ${id}: ${String(text).slice(0, 300)} (via desk)`)
          .then(() => void refreshRelayFeed());
      }
      return ok;
    });
    // One-stop-shop data: the Aitherium marketplace via market-client.cjs
    // (MCP to the local gateway, session bearer — same story as relay).
    ipcMain.handle("desk:market-browse", (_event, query) =>
      marketClient.browse(typeof query === "string" ? query : "", "", 24));
    // Avatar previews (owner, 2026-09-10: "let it give real previews"): the
    // deck asks for a character's cached preview and hands back one it just
    // rendered offscreen. Names are slug-validated — the renderer never names
    // a path. A thumb read/write failure is never fatal: the card falls back
    // to its monogram tile.
    ipcMain.handle("desk:character-thumb", (_event, name) => {
      if (!isValidCharacterName(name)) return null;
      try {
        const file = characterThumbPath(name);
        if (!fs.existsSync(file)) return null;
        return `data:image/jpeg;base64,${fs.readFileSync(file).toString("base64")}`;
      } catch {
        return null;
      }
    });
    ipcMain.handle("desk:save-character-thumb", (_event, name, dataUrl) => {
      if (!isValidCharacterName(name)) return false;
      const prefix = "data:image/jpeg;base64,";
      if (typeof dataUrl !== "string" || !dataUrl.startsWith(prefix)) return false;
      const base64 = dataUrl.slice(prefix.length);
      // A 256x256 JPEG of a face is ~10-30 KB; 2 MB is a generous ceiling that
      // still refuses a renderer bug trying to write a model file here.
      if (base64.length === 0 || base64.length > 2 * 1024 * 1024) return false;
      try {
        fs.writeFileSync(characterThumbPath(name), Buffer.from(base64, "base64"));
        return true;
      } catch (error) {
        debugLog("thumbnail write failed", name, error);
        return false;
      }
    });
    // The per-avatar direct chat READ side: every reply under one message
    // (the thread = the conversation with that agent). [] on any failure.
    ipcMain.handle("desk:relay-thread", (_event, messageId) =>
      fetchRelayThread(RELAY_CHANNEL, typeof messageId === "string" ? messageId : ""));
    // System awareness snapshots (#9) — read-only, fail-soft by contract.
    ipcMain.handle("desk:system-snapshot", () => systemSnapshot());
    ipcMain.handle("desk:voice-snapshot", () => voiceSnapshot());
    // Push-to-talk (2026-08-29): base64 wav from the renderer's MediaRecorder
    // -> temp file -> gateway transcribe_audio -> transcript. Errors return
    // "ERROR: ..." strings so the renderer can show them without a throw.
    ipcMain.handle("desk:voice-transcribe", async (_event, audioB64, format) => {
      try {
        if (typeof audioB64 !== "string" || audioB64.length === 0) {
          return "ERROR: no audio received";
        }
        const { transcribe } = require("./voice-client.cjs");
        const os = require("os");
        const path = require("path");
        const fs = require("fs");
        const isWebm = format === "webm";
        const tmp = path.join(os.tmpdir(), `desk-ptt-${Date.now()}.${isWebm ? "webm" : "wav"}`);
        fs.writeFileSync(tmp, Buffer.from(audioB64, "base64"));
        // Chromium's MediaRecorder emits webm/opus; whisper (PyAV) decodes
        // it, but 16k mono wav is the proven lane — convert when webm.
        let wav = tmp;
        if (isWebm) {
          wav = path.join(os.tmpdir(), `desk-ptt-${Date.now()}.wav`);
          const { execFileSync } = require("child_process");
          execFileSync("ffmpeg", ["-y", "-i", tmp, "-ar", "16000", "-ac", "1", wav],
            { stdio: "ignore", timeout: 30000 });
          fs.unlink(tmp, () => {});
        }
        // THE BRIDGE (drop-router doctrine, measured 2026-08-29): a HOST
        // temp path does not exist in the gateway — transcribe_audio reads
        // the file in ITS filesystem. Stage into the shared Library bind and
        // hand over the container path, exactly like the drop lane does.
        const staged = stagePath(wav);
        let out;
        try {
          out = await transcribe(staged.container);
        } finally {
          cleanupStage(staged.host);
          fs.unlink(wav, () => {});
        }
        const text = typeof out === "string" ? out : JSON.stringify(out);
        return text;
      } catch (error) {
        return `ERROR: ${error && error.message ? error.message : String(error)}`;
      }
    });
    // Drop-to-avatar (2026-08-29): the renderer hands a File over, main
    // MIME-routes it through drop-router.cjs (image -> gemma4 vision,
    // audio -> whisper, video -> first frame, doc -> rag_ingest) and returns
    // the verdict the deck renders. Success ALSO speaks it through the
    // avatar (TTS -> speak event) and posts a one-line notice to #agents so
    // aitherone/writer and every agent see the new knowledge.
    ipcMain.handle("desk:file-dropped", async (_event, filePath, mime) => {
      const verdict = await routeDrop({ filePath, mime: typeof mime === "string" ? mime : "" });
      if (!verdict.ok) return verdict;
      const line = verdict.kind === "doc"
        ? `📥 ${verdict.kind}: ${verdict.name} — ${verdict.summary}`
        : `📥 ${verdict.kind}: ${verdict.name} — ${String(verdict.summary).slice(0, 160)}`;
      const speakText = verdict.kind === "doc" ? verdict.summary : String(verdict.summary).slice(0, 220);
      // The avatar SPEAKS the verdict (fail-soft: a dead voice service must
      // never fail the drop itself).
      void synthesizeVerdict(speakText).then((tts) => {
        if (!tts.ok) return;
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send("desk:event", { type: "speak", audioBase64: tts.audioBase64 });
          }
        }
      });
      // GAP-4 agent pass: post the notice to the cockpit channel; the deck's
      // own relay feed picks it up via refreshRelayFeed. Fire-and-forget —
      // a refused post must not fail the drop.
      void postToRelay(RELAY_CHANNEL, line).then((sent) => {
        if (sent && sent.ok) void refreshRelayFeed();
      });
      return verdict;
    });
    ipcMain.handle("desk:vision-snapshot", () => visionSnapshot());
    ipcMain.handle("desk:desktop-snapshot", () => desktopSnapshot());
    ipcMain.handle("desk:connect-snapshot", () => connectSnapshot());
    ipcMain.handle("desk:deck-action", async (_event, name, arg) => {
      switch (name) {
        case "models":
          openModelBrowser();
          return true;
        case "marketplace":
          // The aitherium agent-pack + avatar marketplace. Portal is the
          // platform surface; the deep marketplace route gets pinned when the
          // Living-Desktop app phase lands.
          void shell.openExternal("https://aitherium.com");
          return true;
        case "switch-character": {
          // One-stop-shop switching: same path set_character over MCP uses,
          // so the panel, the tray, the MCP and the model browser can never
          // disagree about who is active. Pushes fresh state so the panel's
          // active badge moves in the same breath.
          if (typeof arg !== "string" || arg.length === 0) return false;
          const ok = applyCharacter(arg);
          if (ok) sendDeckState();
          return ok;
        }
        case "market-open": {
          // Open one marketplace listing (aither:// or https://) externally.
          if (typeof arg !== "string" || arg.length === 0) return false;
          if (!/^(aither|https?):\/\//.test(arg)) return false;
          void shell.openExternal(arg);
          return true;
        }
        case "add-character": {
          // One place that answers "how do I get another avatar?" (owner,
          // 2026-09-10). Desk ships no models, so this IS the first-run path
          // too: the empty-roster card and the tray menu both land here.
          const win = BrowserWindow.fromWebContents(_event.sender);
          const addMenu = Menu.buildFromTemplate([
            {
              label: "Enroll newest Downloads .vrm",
              click: () => {
                const name = enrollNewestDownload();
                if (name) applyCharacter(name);
                else debugLog("no .vrm found in Downloads to enroll");
              },
            },
            { label: "Get a model from VRoid Hub…", click: openVroidHub },
            {
              label: "Open characters folder",
              click: () => {
                fsMkdirSafe(ROSTER_DIR);
                void shell.openPath(ROSTER_DIR);
              },
            },
          ]);
          if (win && !win.isDestroyed()) addMenu.popup({ window: win });
          return true;
        }
        case "chat":
          createChatWindow();
          return true;
        // The unified console -- Command | Fleet | Cards | Chat in one window,
        // each pane detachable (owner, 2026-09-08).
        case "console":
          openConsole();
          return true;
        // The two control-plane windows, one click from the deck (owner,
        // 2026-09-08: "no way for me to easily launch aither command").
        case "command":
          createCommandWindow(getFleetControl(), { createFleetWindow });
          return true;
        case "fleet":
          createFleetWindow();
          return true;
        case "talk":
          openTalkWindow();
          return true;
        case "popup":
          decisionCards.openQueueWindow();
          return true;
        case "popout-card": {
          if (typeof arg !== "string" || arg.length === 0) return false;
          return decisionCards.openCardWindow(arg);
        }
        // The two desktop surfaces (owner, 2026-09-08): the OVERLAY — the
        // aitherium.com Living Desktop taskbar over the Windows desktop, the same
        // one AitherConnect puts over any web page — and the APP — the full
        // aitherium.com desktop (Desktop Anywhere shell) in its own window.
        case "living-desktop":
        case "overlay":
          showLivingDesktop();
          return true;
        case "aither-desktop":
        case "desktop":
          showDesktopApp();
          return true;
        case "toggle-desk":
          toggleOverlay();
          return true;
        case "hide-desk":
          void hideOverlay();
          return true;
        case "grow":
          growWindow();
          return true;
        case "shrink":
          shrinkWindow();
          return true;
        case "toggle-window-outline": {
          // Toggleable "invisible glass" boundary: a dashed edge + faint tint
          // so the avatar window's borders are visible while arranging it
          // (owner 2026-08-25: had to expand the window and move the avatar
          // left with no way to see the boundaries). Persisted per-window;
          // restored on every renderer load by ensureRendererLoadHook.
          if (avatarWindow && !avatarWindow.isDestroyed()) {
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
          return true;
        }
        case "reset-layout":
          // "Reset" the desk: drop the persisted per-slot transforms (every
          // invisible-avatar artifact of 2026-08-25 lived in that key) and
          // reload the avatar window, which re-frames with the default
          // placement. The deck window stays open. Requested live by the
          // owner after the D:\desk move window knocked the avatars off
          // screen: "need like a reset button".
          if (avatarWindow && !avatarWindow.isDestroyed()) {
            void avatarWindow.webContents
              .executeJavaScript(
                "localStorage.removeItem('desk.avatar-layout.v1'); true;")
              .finally(() => avatarWindow.reloadIgnoringCache());
          }
          return true;
        case "quit":
          isQuitting = true;
          app.quit();
          return true;
        case "relay-post": {
          if (typeof arg !== "string" || arg.length === 0) return false;
          // AWAIT and report the real result: the fire-and-forget version
          // returned true while the relay 403'd the post (agent-only channel,
          // unjoined identity) -- the chat window then believed the message
          // sent. False must reach the renderer. A failure returns the
          // relay's OWN refusal reason (a string) so the chat window shows
          // WHY, not just "refused".
          const sent = await postToRelay(RELAY_CHANNEL, arg);
          if (sent && sent.ok) void refreshRelayFeed();
          return sent && sent.ok ? true : (sent && sent.detail) || "the relay refused";
        }
        // The per-avatar DIRECT chat send path: the conversation with a
        // spawned agent is the THREAD under its message (the relay's
        // thread-reply primitive — no per-agent channels exist, and the
        // group chat is #agents itself). The thread READ side is the
        // desk:relay-thread handle (data must reach the renderer).
        case "relay-thread-reply": {
          if (typeof arg !== "string" || arg.length === 0) return false;
          let parsed;
          try {
            parsed = JSON.parse(arg); // {channel, messageId, text}
          } catch {
            return false;
          }
          if (!parsed || typeof parsed.messageId !== "string") return false;
          if (typeof parsed.text !== "string" || !parsed.text.trim()) return false;
          const replied = await postRelayThreadReply(
            parsed.channel || RELAY_CHANNEL,
            parsed.messageId,
            parsed.text,
          );
          if (replied && replied.ok) void refreshRelayFeed();
          return replied && replied.ok ? true : (replied && replied.detail) || "the relay refused";
        }
        // The chat window's LOCAL executor: the sentence runs through the one
        // CommandAgent (fleet verbs -> FleetControl, else a headless agent);
        // the request and reply land in the room (RoomPublisher) and the
        // Command window's history. Returns the reply text, or "ERROR: …".
        case "command-send": {
          if (typeof arg !== "string" || !arg.trim()) return false;
          try {
            const result = await getCommandAgent(getFleetControl()).run(arg.trim(), { source: "chat-window" });
            void refreshRoomFeed();
            return result && result.ok !== false ? String(result.reply || "done") : `ERROR: ${result?.reply || "failed"}`;
          } catch (error) {
            return `ERROR: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
        case "spawn-agent": {
          if (typeof arg !== "string" || arg.length === 0) return false;
          const roster = listCharacters();
          const assigned = getAgentAvatar(arg);
          const character = assigned || fallbackCharacterForAgent(arg, roster);
          if (!character) return false;
          return spawnAvatarSlot(nextFreeSlotId(), character, arg);
        }
        case "remove-slot": {
          if (typeof arg !== "string" || arg.length === 0) return false;
          return removeAvatarSlot(arg);
        }
        case "detach-slot": {
          if (typeof arg !== "string" || arg.length === 0) return false;
          return detachAvatarToOwnWindow(arg);
        }
        default:
          return false;
      }
    });

    const mcpHandler = createDeskMcpHandler({
      onAnimation: (animation) => {
        let animationEvent;
        if (animation.startsWith("FILE:")) {
          animationEvent = animation;
        } else {
          const eventName = getAnimationEventName(animation);
          // Report the miss instead of dropping it. Returning undefined here made
          // play_animation answer "Desk is playing the X animation" for a clip that
          // was never played, so a caller could not tell a typo from a working request —
          // the worst outcome, because it teaches them the feature works.
          if (eventName == null) return false;
          animationEvent = eventName;
        }
        mcpAnimationRequestId += 1;
        handleBridgeEvent({
          type: "animation",
          animation: animationEvent,
          source: "mcp",
          requestId: mcpAnimationRequestId,
        });
        return true;
      },
      onWindowAction: handleMcpWindowAction,
      getStatus: getMcpStatus,
      listCharacters: () => ({
        active: getActiveCharacter(),
        characters: listCharacters(),
      }),
      onCharacter: (name) => applyCharacter(name),
      onAgent: (agent) => applyAgentAvatar(agent),
      listAgentAvatars: () => loadAgentAvatars(),
      onExportPortrait: async () => {
        const name = getActiveCharacter() || "desk";
        showOverlay();
        return exportToAitherShell(avatarWindow, name, handleBridgeEvent);
      },
      listAnimations: () => {
        const builtIn = Object.keys(ANIMATION_EVENT_NAMES);
        const custom = listAvailableAnimations().map((file) => `FILE:${file}`);
        return [...builtIn, ...custom];
      },
      onSpawnAvatar: (slotId, name) => spawnAvatarSlot(slotId, name),
      onRemoveAvatar: (slotId) => removeAvatarSlot(slotId),
      onFleet: (action, opts) => fleetAction(action, opts),
      onCommand: (text, opts) => commandAction(text, opts),
      onDesktop: (surface) => {
        if (surface === "overlay") showLivingDesktop();
        else if (surface === "app") showDesktopApp();
        return { ok: true, opened: surface === "status" ? null : surface, ...desktopStatus() };
      },
    });
    bridge = createBridgeServer({
      port: Number(process.env.DESK_BRIDGE_PORT || DEFAULT_PORT),
      onEvent: handleBridgeEvent,
      mcpHandler,
      // The Aitheros Online overlay renders the STATIC site, whose
      // /api/decisions is a build stub — this loopback read is how its bell
      // sees the queue at all. Read-only; answering stays in the queue window.
      decisionsProvider: () => decisionCards.listOpen(),
      fleetHandler: (verb) => fleetAction(verb === "open" ? "open_panel" : verb, { fresh: false }),
      // awsh /desktop, adk desk desktop, awconnect's popup and `desk://` all land here.
      desktopHandler: (mode) => {
        if (mode === "overlay") showLivingDesktop();
        else if (mode === "app") showDesktopApp();
        return { ok: true, opened: mode === "status" ? null : mode, ...desktopStatus() };
      },
      commandHandler: (req) => {
        if (req.action === "history") {
          return getCommandAgent(getFleetControl()).history(req.limit);
        } else if (req.action === "send") {
          return commandAction(req.text, { source: "bridge" });
        } else if (req.action === "open") {
          // `game command` / `adk desk command --open` raise the window for the owner.
          createCommandWindow(getFleetControl(), { createFleetWindow });
          return { ok: true, opened: true };
        }
      },
    });
    try {
      await bridge.listen();
    } catch (error) {
      console.error(
        "[desk] local integration server unavailable:",
        error instanceof Error ? error.message : String(error),
      );
      bridge = null;
    }

    createTray();
    maybePromptForFirstCharacter();
    if (process.argv.includes("--fleet")) createFleetWindow();
    if (process.argv.includes("--command")) createCommandWindow(getFleetControl(), { createFleetWindow });
    if (process.argv.includes("--overlay")) showLivingDesktop();
    if (process.argv.includes("--desktop")) showDesktopApp();
    // Keep the tray's Fleet line honest: re-render the menu after every verdict.
    getFleetControl().on("progress", (p) => {
      if (p?.phase === "end") refreshTrayMenu();
    });

    // Watch the decision-card store: tray label + tooltip and the deck badge
    // track the open queue. Native notifications are REMOVED (2026-08-31,
    // owner decision) — a toast presented under the PowerShell app id with a
    // click that led nowhere is worse than no toast; the tray, deck and
    // Discord fanout are the bells. Relay feed for the deck: first pull
    // immediately, then every 60s. A cockpit feed lags the channel by design
    // — it is a summary, not a client.
    void refreshRelayFeed();
    relayFeedTimer = setInterval(() => void refreshRelayFeed(), 60_000);
    relayFeedTimer.unref?.();

    // The company room, wired both ways (owner, 2026-09-08: "full integration
    // into aitherrelay + aitherroom ... so I can just chat in there and have
    // things get done"). One CommandAgent executes; this makes every surface
    // reach it and every outcome land where it was asked:
    //  - RoomPublisher: each request/reply becomes an event in the awdk daemon
    //    room "main" (host process — works while the fleet is DOWN), beside the
    //    tool calls of every Claude Code tab; awsh /room and adk read it.
    //  - RelayPoller: a message in #command, or "@desk …" in #agents, runs
    //    through the same agent and is acked in-thread on the relay.
    const commandAgent = getCommandAgent(getFleetControl());
    roomPublisher = new RoomPublisher();
    roomPublisher.attach(commandAgent, {
      actorFor: (p) => (/^relay:/.test(String(p.source || ""))
        ? { kind: "human", id: RELAY_NICK, name: RELAY_NICK }
        : { kind: "human", id: "owner", name: "owner" }),
    });
    relayPoller = new RelayPoller({
      agent: commandAgent,
      fetchHistory: (channel, limit) => fetchRelayHistory(channel, limit),
      postThreadReply: (channel, id, text) => postRelayThreadReply(channel, id, text),
    });
    relayPoller.on("executed", (r) => {
      console.log(`[desk] relay order ${r.channel} ${r.id} -> ${r.result?.ok === false ? "FAILED" : "ok"}${r.posted ? "" : ` (ack not posted: ${r.postDetail || "refused"})`}`);
      void refreshRelayFeed();
    });
    relayPoller.start();
    void refreshRoomFeed();
    roomFeedTimer = setInterval(() => void refreshRoomFeed(), 15_000);
    roomFeedTimer.unref?.();
    commandAgent.on("complete", () => void refreshRoomFeed());

    decisionWatchStop = decisionCards.watch({
      onChange: (cards) => {
        openDecisions = cards;
        refreshTrayMenu();
        // The bell counts cards actually WAITING on the owner (options or
        // credential asks), never info digests — "3 decisions waiting" must
        // not turn out to be one ask and two facts (owner report 2026-08-31,
        // the same noise class as the removed toasts). The total rides the
        // tooltip so the deck's full view stays discoverable.
        const waiting = decisionCards.actionableCount(cards);
        tray?.setToolTip(
          waiting > 0
            ? `Desk — ${waiting} decision${waiting === 1 ? "" : "s"} waiting`
                + (cards.length > waiting ? ` · ${cards.length} cards in deck` : "")
            : cards.length > 0
              ? `Desk — ${cards.length} info card${cards.length === 1 ? "" : "s"} (nothing to answer)`
              : "Desk",
        );
        sendDeckState();
        sendDecisionBadge();
      },
    });

    globalShortcut.register("CommandOrControl+Shift+A", toggleOverlay);
    globalShortcut.register("CommandOrControl+Shift+=", () => growWindow());
    globalShortcut.register("CommandOrControl+Shift+-", () => shrinkWindow());
    handleProtocolArgv(process.argv);

    audioListener = createAudioListener({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      onActivity: (activity) => {
        debugLog("listener activity", activity);
        handleBridgeEvent(voiceState(activity));
      },
      onDebug: debugEnabled ? (nodes) => debugLog("listener output nodes", nodes) : null,
      onLevel: (level) => handleBridgeEvent({ type: "audio-level", level }),
      onSession: (active) => {
        debugLog("listener session", active);
        handleBridgeEvent(voiceState(active ? "listening" : "idle", active ? "active" : "inactive"));
      },
      onStatus: (status) => {
        debugLog("listener status", status);
        handleListenerStatus(status);
      },
    });
    if (audioListener) void audioListener.start();
    if (!audioListener) {
      handleListenerStatus({
        available: false,
        capturing: false,
        monitoring: false,
        source: null,
      });
    }

    if (!startInBackground) {
      createWindow();
      showOverlay({ focus: true });
    }
    if (deckIsRequested) createDeckWindow();
    if (consoleIsRequested) openConsole();
  });
}

app.on("activate", () => showOverlay({ focus: true }));

app.on("before-quit", () => {
  isQuitting = true;
  clearTimeout(hyprlandConfigurationTimer);
  if (relayFeedTimer) clearInterval(relayFeedTimer);
  decisionWatchStop?.();
  audioListener?.stop();
  globalShortcut.unregisterAll();
  void bridge?.close().catch((error) => debugLog("integration server close failed", error));
});

app.on("window-all-closed", () => {
  // The tray, protocol handler, and adapter server keep Desk available.
});
