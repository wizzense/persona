"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  screen,
  shell,
  Tray,
} = require("electron");
const decisionCards = require("./decision-cards.cjs");
const { createBridgeServer, DEFAULT_PORT } = require("./bridge-server.cjs");
const {
  createDeskMcpHandler,
  getAnimationEventName,
  ANIMATION_EVENT_NAMES,
} = require("./mcp-server.cjs");
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
const fs = require("node:fs");
const {
  getAgentAvatar,
  listAgents,
  loadMap: loadAgentAvatars,
  setAgentAvatar,
} = require("./agent-avatars.cjs");
const { exportToAitherShell } = require("./aithershell-export.cjs");
const { buildLivingDesktopMenu, showLivingDesktop } = require("./living-desktop-window.cjs");
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

function buildDetachAvatarMenu() {
  if (avatarSlots.size === 0) return [{ label: "(no extra avatars)", enabled: false }];
  return [...avatarSlots.entries()].map(([slotId, info]) => ({
    label: info.agent ? `${info.agent} — ${info.name}` : info.name,
    click: () => detachAvatarToOwnWindow(slotId),
  }));
}

// D-2170: 430x680 on a 3840x2112 4K display reads as "trapped in a tiny box" —
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
// the D-2170 default every time.
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
const protocolScheme = "desk";
const debugEnabled = process.env.DESK_DEBUG === "1";

let avatarWindow = null;
let bridge = null;
let isQuitting = false;
let latestEvent = null;
let latestListenerStatus = null;
let latestVoiceState = null;
let audioListener = null;
let tray = null;
// Decision-card plane (see decision-cards.cjs): the open queue drives the tray
// label/tooltip, and new arrivals raise a native notification.
let openDecisions = [];
let knownDecisionIds = new Set();
let decisionsSeenOnce = false;
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

// ── awdesk rename: migrate the legacy userData dir once ────────────────────────────────────────────────────────
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

  const rendererUrl =
    process.env.VITE_DEV_SERVER_URL ||
    pathToFileURL(path.join(__dirname, "..", "dist", "index.html")).href;
  avatarWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  avatarWindow.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isAllowedRendererNavigation(targetUrl, rendererUrl)) event.preventDefault();
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
  // Right-click the avatar for the same menu the tray offers (characters, previews, quit).
  // Right-DRAG still pans the camera; the menu only pops on release. The renderer's camera
  // controls preventDefault() the contextmenu event, so the preload relays it over IPC —
  // keep the native handler too as a fallback.
  const popupAvatarMenu = () => {
    debugLog("avatar context menu requested");
    Menu.buildFromTemplate([
      { label: "Characters", submenu: buildCharacterMenu() },
      { label: "Window Size", submenu: buildSizeMenu() },
      { label: "Add Avatar", submenu: buildSpawnAvatarMenu() },
      { label: "Remove Avatar", submenu: buildRemoveAvatarMenu() },
      { label: "Detach to own window", submenu: buildDetachAvatarMenu() },
      { label: "Living Desktop", submenu: buildLivingDesktopMenu() },
      {
        label:
          openDecisions.length > 0
            ? `Decision cards (${openDecisions.length} waiting)`
            : "Decision cards",
        submenu: [
          {
            // The notification area the owner watches lives IN the Living
            // Desktop (its bell reads this same queue over the bridge), so the
            // tray links there first; the popup window stays one item away as
            // the answering surface.
            label: "Show in Living Desktop",
            click: () => showLivingDesktop(),
          },
          { label: "Open answer window…", click: () => decisionCards.openQueueWindow() },
        ],
      },
      { label: "Talk to Aither…", click: openTalkWindow },
      { label: "Browse models…", click: openModelBrowser },
      { type: "separator" },
      { label: "Preview speaking", click: () => handleBridgeEvent(voiceState("speaking")) },
      {
        label: "Preview dance",
        click: () => handleBridgeEvent({ type: "animation", animation: "DANCE" }),
      },
      { type: "separator" },
      { label: "Hide Desk", click: () => void hideOverlay() },
      {
        label: "Quit",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]).popup({ window: avatarWindow });
  };
  avatarWindow.webContents.on("context-menu", popupAvatarMenu);
  ipcMain.removeAllListeners("desk:context-menu");
  ipcMain.on("desk:context-menu", popupAvatarMenu);

  // D-2170: middle-mouse-drag window move (preload.cjs sends these). Tracks
  // the mouse's screen position at drag start against the window's own
  // position at drag start, then repositions by the same delta on every
  // move — works from anywhere on the avatar, doesn't touch left/right
  // click at all so OrbitControls and the context menu stay untouched.
  let dragOrigin = null;
  ipcMain.removeAllListeners("desk:drag-start");
  ipcMain.removeAllListeners("desk:drag-move");
  ipcMain.removeAllListeners("desk:drag-end");
  ipcMain.on("desk:drag-start", (_event, { x, y }) => {
    if (!avatarWindow) return;
    const [winX, winY] = avatarWindow.getPosition();
    dragOrigin = { mouseX: x, mouseY: y, winX, winY };
  });
  ipcMain.on("desk:drag-move", (_event, { x, y }) => {
    if (!dragOrigin || !avatarWindow) return;
    avatarWindow.setPosition(
      Math.round(dragOrigin.winX + (x - dragOrigin.mouseX)),
      Math.round(dragOrigin.winY + (y - dragOrigin.mouseY)),
      false,
    );
  });
  ipcMain.on("desk:drag-end", () => {
    dragOrigin = null;
  });
  void avatarWindow.loadURL(rendererUrl);
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
  avatarWindow.webContents.once("did-finish-load", flushPendingRendererEvents);
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
    else if (command.type === "event") handleBridgeEvent(command.event);
  }
  return true;
}

function handleProtocolArgv(argv) {
  const protocolUrl = argv.find((value) => value.startsWith(`${protocolScheme}://`));
  if (protocolUrl) handleProtocolUrl(protocolUrl);
}

/** Open a local helper page, spawning its python server the first time. */
function openLocalTool(url, script) {
  const probe = require("node:http").get(url, () => {
    probe.destroy();
    void shell.openExternal(url);
  });
  probe.on("error", () => {
    const { spawn } = require("node:child_process");
    spawn("python", [path.join(__dirname, "..", script)], {
      detached: true,
      stdio: "ignore",
      cwd: path.join(__dirname, ".."),
    }).unref();
    // The server opens the page itself once it is listening.
  });
  probe.setTimeout(1500, () => probe.destroy());
}

/** Open the local VRoid model browser (spawns model-browser.py if not already up). */
function openModelBrowser() {
  openLocalTool("http://127.0.0.1:47836/", "model-browser.py");
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



/** Open AitherShell — the platform's real chat client. It already drives this avatar
 *  (speaking state + emotion animations via its desk-bridge), so talking to Aither
 *  there IS talking to the character on screen. Deliberately NOT a second chat UI. */
function openTalkWindow() {
  const { spawn } = require("node:child_process");
  // Windows Terminal if present, else a plain console — both detached from this process.
  spawn("cmd", ["/c", "start", "", "wt", "-w", "0", "nt", "--title", "Aither", "cmd", "/k", "aither"], {
    detached: true,
    stdio: "ignore",
  })
    .on("error", () => {
      spawn("cmd", ["/c", "start", "Aither", "cmd", "/k", "aither"], {
        detached: true,
        stdio: "ignore",
      }).unref();
    })
    .unref();
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
function buildSpawnAvatarMenu() {
  const roster = listCharacters();
  const agents = listAgents();
  const item = (agent) => {
    const assigned = getAgentAvatar(agent);
    const character = assigned || fallbackCharacterForAgent(agent, roster);
    return {
      label: assigned ? agent : `${agent}  (unassigned → ${character || "none"})`,
      enabled: Boolean(character),
      click: () => character && spawnAvatarSlot(nextFreeSlotId(), character, agent),
    };
  };
  const CHUNK = 14;
  const groups = [];
  for (let start = 0; start < agents.length; start += CHUNK) {
    const slice = agents.slice(start, start + CHUNK);
    const first = slice[0];
    const last = slice[slice.length - 1];
    groups.push({
      label: slice.length > 1 ? `${first} … ${last}` : first,
      submenu: slice.map(item),
    });
  }
  return groups.length ? groups : [{ label: "(no agents found)", enabled: false }];
}

/** "Remove Avatar" — one entry per currently-spawned extra slot (never slot0/default,
 *  which this whole mechanism structurally cannot name — see spawnAvatarSlot/removeAvatarSlot).
 *  Shows the agent name when the slot was spawned from Add Avatar's agent list, since that
 *  is what the owner picked and remembers, not the underlying VRM filename. */
function buildRemoveAvatarMenu() {
  if (avatarSlots.size === 0) return [{ label: "(no extra avatars)", enabled: false }];
  return [...avatarSlots.entries()].map(([slotId, info]) => ({
    label: info.agent ? `${info.agent} — ${info.name}  (${slotId})` : `${info.name}  (${slotId})`,
    click: () => removeAvatarSlot(slotId),
  }));
}

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
    const first = slice[0];
    const last = slice[slice.length - 1];
    groups.push({
      label: slice.length > 1 ? `${first} … ${last}` : first,
      submenu: slice.map(item),
    });
  }

  const recents = getRecentCharacters().map(item);
  return [
    { label: "Recent", enabled: false },
    ...(recents.length ? recents : [{ label: "(none yet)", enabled: false }]),
    { type: "separator" },
    {
      label: `All characters (${all.length})`,
      submenu: groups.length ? groups : [{ label: "(roster empty)", enabled: false }],
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
 * surface (awsh turns, the decision-card fanout, Living OS, Awconnect) calls
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
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show Desk", click: () => showOverlay({ focus: true }) },
      { label: "Hide Desk", click: () => void hideOverlay() },
      { type: "separator" },
      { label: "Characters", submenu: buildCharacterMenu() },
      { label: "Window Size", submenu: buildSizeMenu() },
      { label: "Add Avatar", submenu: buildSpawnAvatarMenu() },
      { label: "Remove Avatar", submenu: buildRemoveAvatarMenu() },
      { label: "Detach to own window", submenu: buildDetachAvatarMenu() },
      { label: "Living Desktop", submenu: buildLivingDesktopMenu() },
      {
        label:
          openDecisions.length > 0
            ? `Decision cards (${openDecisions.length} waiting)`
            : "Decision cards",
        submenu: [
          {
            // The notification area the owner watches lives IN the Living
            // Desktop (its bell reads this same queue over the bridge), so the
            // tray links there first; the popup window stays one item away as
            // the answering surface.
            label: "Show in Living Desktop",
            click: () => showLivingDesktop(),
          },
          { label: "Open answer window…", click: () => decisionCards.openQueueWindow() },
        ],
      },
      { label: "Talk to Aither…", click: openTalkWindow },
      { label: "Browse models…", click: openModelBrowser },
      { label: "Media Forge", click: openMediaForge },
      { type: "separator" },
      { label: "Preview listening", click: () => handleBridgeEvent(voiceState("listening")) },
      { label: "Preview speaking", click: () => handleBridgeEvent(voiceState("speaking")) },
      {
        label: "Preview dance",
        click: () => handleBridgeEvent({ type: "animation", animation: "DANCE" }),
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

function createTray() {
  const iconPath = path.join(__dirname, "..", "build", "icon.png");
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 20, height: 20 });
  tray = new Tray(icon);
  tray.setToolTip("Desk");
  refreshTrayMenu();
  tray.on("click", toggleOverlay);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const handled = argv.some((value) => value.startsWith(`${protocolScheme}://`));
    handleProtocolArgv(argv);
    if (!handled && !argv.includes("--background")) showOverlay({ focus: true });
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleProtocolUrl(url);
  });

  app.whenReady().then(async () => {
    // Unpackaged runs (npx electron .) have no Start Menu shortcut registering
    // the AUMID, so Windows shows the RAW id as every toast's header — the
    // owner's decision-card notification read "com.xikhar.awdesk" instead of
    // the app's name (screenshot, 2026-08-25). Dev uses the display name;
    // packaged installs keep the registered id so their toast grouping and
    // notification settings survive.
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
    });
    bridge = createBridgeServer({
      port: Number(process.env.DESK_BRIDGE_PORT || DEFAULT_PORT),
      onEvent: handleBridgeEvent,
      mcpHandler,
      // The Living Desktop overlay renders the STATIC site, whose
      // /api/decisions is a build stub — this loopback read is how its bell
      // sees the queue at all. Read-only; answering stays in the queue window.
      decisionsProvider: () => decisionCards.listOpen(),
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

    // Watch the decision-card store: tray label + tooltip track the open queue,
    // and a genuinely new card raises a native notification whose click opens
    // the shared queue window. The first observation is summarised as ONE
    // notification, never a burst — a backlog is a fact, not an alarm per row.
    decisionWatchStop = decisionCards.watch({
      onChange: (cards) => {
        const previouslyKnown = knownDecisionIds;
        openDecisions = cards;
        knownDecisionIds = new Set(cards.map((c) => c.id));
        refreshTrayMenu();
        tray?.setToolTip(
          cards.length > 0
            ? `Desk — ${cards.length} decision${cards.length === 1 ? "" : "s"} waiting`
            : "Desk",
        );
        if (!Notification.isSupported()) return;
        if (!decisionsSeenOnce) {
          decisionsSeenOnce = true;
          if (cards.length > 0) {
            const summary = new Notification({
              title:
                cards.length === 1
                  ? "1 decision card is waiting on you"
                  : `${cards.length} decision cards are waiting on you`,
              body: cards[0].title,
              silent: true,
            });
            summary.on("click", () => decisionCards.openQueueWindow());
            summary.show();
          }
          return;
        }
        // Cap the burst: three individual notifications, then one rollup.
        const fresh = cards.filter((c) => !previouslyKnown.has(c.id));
        for (const card of fresh.slice(0, 3)) {
          const where = card.tab || card.cwd || card.agent;
          const n = new Notification({
            title: card.title,
            body:
              (card.summary || "A decision card needs your answer.") +
              (where && !card.title.includes(where) ? `
${where}` : ""),
            silent: card.urgency !== "critical" && card.urgency !== "high",
          });
          n.on("click", () => decisionCards.openQueueWindow());
          n.show();
        }
        if (fresh.length > 3) {
          const rollup = new Notification({
            title: `${fresh.length - 3} more decision cards arrived`,
            silent: true,
          });
          rollup.on("click", () => decisionCards.openQueueWindow());
          rollup.show();
        }
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
  });
}

app.on("activate", () => showOverlay({ focus: true }));

app.on("before-quit", () => {
  isQuitting = true;
  clearTimeout(hyprlandConfigurationTimer);
  decisionWatchStop?.();
  audioListener?.stop();
  globalShortcut.unregisterAll();
  void bridge?.close().catch((error) => debugLog("integration server close failed", error));
});

app.on("window-all-closed", () => {
  // The tray, protocol handler, and adapter server keep Desk available.
});
