"use strict";

const path = require("node:path");
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

// A transparent always-on-top overlay must never be treated as "in the
// background". Measured 2026-09-18 over CDP with an IDLE renderer (0.7 s of work
// per 6 s): frame gaps of almost exactly 1000 ms, several per 10 s -- Chromium's
// 1 fps requestAnimationFrame throttle, applied whenever Windows' native
// occlusion tracker judged the overlay covered (it sits under/over other
// windows all day) or the renderer "backgrounded". On screen that is the avatar
// freezing for a second at a time. The window-level half is
// `backgroundThrottling: false` on the avatar BrowserWindow (avatar-window.cjs).
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
// How frames reach the screen (software present + the integrated adapter on
// Windows): the measurement and the knobs live in present-policy.cjs.
const presentState = require("./present-policy.cjs").applyPresentPolicy(app, {
  execFile: require("node:child_process").execFile,
});
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

// Main-process event-loop lag, measured not guessed: a 50 ms ticker records how
// late each tick fires. A block here (sync fs, execFileSync, a big JSON.parse)
// stalls IPC and frame delivery for every window. Reported on /health as
// `mainLag` {maxMs, over100, windowS}; the window resets every 10 s.
const mainLag = { maxMs: 0, over100: 0, windowS: 10, worst: [] };
{
  let expected = Date.now() + 50;
  let windowStart = Date.now();
  let cur = { maxMs: 0, over100: 0 };
  setInterval(() => {
    const now = Date.now();
    const late = now - expected;
    expected = now + 50;
    if (late > cur.maxMs) cur.maxMs = late;
    if (late > 100) {
      cur.over100 += 1;
      mainLag.worst.push({ at: new Date(now).toISOString().slice(11, 19), ms: late });
      if (mainLag.worst.length > 8) mainLag.worst.shift();
    }
    if (now - windowStart >= mainLag.windowS * 1000) {
      mainLag.maxMs = cur.maxMs;
      mainLag.over100 = cur.over100;
      cur = { maxMs: 0, over100: 0 };
      windowStart = now;
    }
  }, 50).unref();
}

// Opt-in diagnostics door: DESK_CDP_PORT=9223 exposes the renderer over CDP so
// scripts/perf-gate.cjs (and cdp-probe / cdp-profile) can measure the running
// app from outside. Must be set before the app is ready; off by default.
if (/^\d{2,5}$/.test(String(process.env.DESK_CDP_PORT || ""))) {
  app.commandLine.appendSwitch("remote-debugging-port", String(process.env.DESK_CDP_PORT));
}
const decisionCards = require("./decision-cards.cjs");
const {
  fetchChannels: fetchRelayChannels,
  fetchHistory: fetchRelayHistory,
  fetchThread: fetchRelayThread,
  post: postToRelay,
  postThreadReply: postRelayThreadReply,
  RELAY_CHANNEL,
  RELAY_NICK,
} = require("./relay-feed.cjs");
// The five system snapshot clients and routeDrop moved with the deck's doors
// (deck-actions.cjs); the speech + voice paths still use these three.
const { synthesizeVerdict, stagePath, cleanupStage } = require("./drop-router.cjs");
// ONE inventory of what Desk can do and which menus carry it. Menus are rendered
// from it; nothing lists a capability by hand (docs/UX-REIMPLEMENTATION.md).
const commandRegistry = require("./command-registry.cjs");
// awrise wakes (scheduled jobs) — read and mutated ONLY through the awdk
// harness daemon's /wakes window, so the desk, Discord, AitherDesktop and the
// MCP tool share one reader and one semantics (see wakes-feed.cjs header).
const wakesFeedClient = require("./wakes-feed.cjs");
// The pane window modules are handed WHOLE to presentation.cjs (below), which owns
// their detach verbs; main keeps only the names it calls itself.
const fleetWindow = require("./fleet-window.cjs");
const {
  createFleetWindow,
  getControl: getFleetControl,
  fleetSummaryCached,
} = fleetWindow;
const commandWindow = require("./command-window.cjs");
const {
  createCommandWindow,
  getAgent: getCommandAgent,
} = commandWindow;
const { showConsole, focusPane, closeConsole, setInboxBadge } = require("./console-window.cjs");
const { badgeBitmap, badgeTooltip, drawBadge } = require("./badge.cjs");
const { voiceTrayItems } = require("./voice-tray-line.cjs");
const sessionsWindow = require("./sessions-window.cjs");
// The company room, both halves: the awdk daemon room (local, fleet-independent)
// and the relay channels (#command / #agents) that the poller executes from.
// `steerEvent` is the pure envelope builder for an ADDRESSED steer (U18); the
// "room-steer" deck-action (deck-actions.cjs) is the ONLY thing that uses it.
const { RoomPublisher, steerEvent } = require("./room-publisher.cjs");
const { RelayPoller } = require("./relay-poller.cjs");
// U28: main delegates the company room's BUILD to room-stage-host.cjs (U07)
// instead of constructing `new RoomStage(...)` inline -- see startRoomStage()
// below and CAST004 (check_desk_cast_config.py), the static assert that this
// delegation, and the resolver it carries, both stay wired.
const roomStageHost = require("./room-stage-host.cjs");
const {
  configureHyprlandWindow,
  getHyprlandWindowPlacement,
} = require("./hyprland-window.cjs");
const { isAllowedRendererNavigation } = require("./navigation-policy.cjs");
const { parseProtocolUrl } = require("./protocol-actions.cjs");
const {
  ROSTER_DIR,
  enrollNewestDownloadChecked,
  getActiveCharacter,
  planSlotInstall,
  queueInstall,
  listCharacters,
} = require("./character-roster.cjs");
const { invalidateGate } = require("./content-rating.cjs");
const fs = require("node:fs");
const {
  getAgentAvatar,
  listAgents,
} = require("./agent-avatars.cjs");
const {
  desktopStatus,
  pushDeskState,
  setDeskStateProvider,
  showDesktopApp,
  showLivingDesktop,
  closeDesktopApp,
  desktopAppUrl,
  isAppOpen,
  toggleLivingDesktop,
  setShell: setDesktopShell,
  setGhostMode,
  setSolidBackground,
  reloadLivingDesktop,
  beginSignIn: beginDesktopSignIn,
  ensureDesktopSession,
  portalLoginUrl,
} = require("./living-desktop-window.cjs");
const { openDetachedAvatar } = require("./detached-avatar-window.cjs");
const stageWindow = require("./stage-window.cjs");
const settingsWindow = require("./settings-window.cjs");
// The guarded cast-window.cjs require moved to presentation.cjs with openConsole,
// its only consumer.
// speakAloud (ONE path for every speech door) + its caption, behind the voice-resolve
// gate and the safety funnel: speech.cjs. quietMode is a getter because it is built
// further down and its own onChange speaks through speakAloud.
const { speakAloud } = require("./speech.cjs").createSpeech({
  BrowserWindow,
  synthesizeVerdict,
  getQuietMode: () => quietMode,
  debugLog,
});

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

let isQuitting = false;
let latestVoiceState = null;
let tray = null;
// The avatar overlay window (avatar-window.cjs): construction, saved size + the
// resize verbs, Hyprland placement, show/hide/toggle, the renderer event queue,
// outline/reset and the --smoke boot. The window is REPLACED over the desk's life,
// so main never holds it: every reader calls getAvatarWindow() at call time.
const {
  getAvatarWindow,
  getLatestEvent,
  // One bundle for every renderer: presentation.cjs loads it for its panels too.
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
  stop: stopAvatarWindow,
} = require("./avatar-window.cjs").createAvatarWindow({
  electron: { BrowserWindow, screen, ipcMain },
  app,
  configureHyprlandWindow,
  getHyprlandWindowPlacement,
  isAllowedRendererNavigation,
  isQuitting: () => isQuitting,
  getTray: () => tray,
  refreshTrayMenu: () => refreshTrayMenu(),
  onContextMenu: () => createDeckWindow(),
  debugLog: (...args) => debugLog(...args),
});
// The deck's live feeds (relay, wakes, local room) and the company-room wiring that
// fills them -- RoomPublisher, RelayPoller, settings sync: feeds.cjs. Built here so
// every later reader sees the getters; start() runs in app.whenReady, and
// startRoomStage stays defined below (CAST004 reads it in this file).
const {
  refreshRelayFeed,
  refreshWakesFeed,
  refreshRoomFeed,
  wakesPending,
  start: startFeeds,
  stop: stopFeeds,
  getRelayFeed,
  getWakesFeed,
  getRoomFeed,
  getRoomPublisher,
  getRelayPoller,
  getSettingsSync,
} = require("./feeds.cjs").createFeeds({
  fetchRelayHistory,
  postRelayThreadReply,
  RELAY_NICK,
  wakesFeedClient,
  RoomPublisher,
  RelayPoller,
  getCommandAgent,
  getFleetControl,
  sendDeckState: () => sendDeckState(),
  startRoomStage: () => startRoomStage(),
  debugLog: (...args) => debugLog(...args),
});
// The extra bodies on the stage -- the slot map, spawn/remove/detach, the Stage
// pane's view, addressForSlot, the deck's spawn-agent verb and the reload replay:
// avatar-slots.cjs. avatarSlots is the module's own Map, read live below.
const {
  avatarSlots,
  spawnAvatarSlot,
  removeAvatarSlot,
  detachAvatarToOwnWindow,
  stagePaneImpl,
  addressForSlot,
  spawnAgent,
  replaySlots,
} = require("./avatar-slots.cjs").createAvatarSlots({
  getAvatarWindow,
  showOverlay: (...args) => showOverlay(...args),
  sendToAvatar: (...args) => sendToAvatar(...args),
  sendDeckState: () => sendDeckState(),
  roomStageHost,
  roomStageDeps: () => roomStageDeps(),
  planSlotInstall,
  queueInstall,
  openDetachedAvatar,
  getActiveCharacter,
  listCharacters,
  getAgentAvatar,
  debugLog: (...args) => debugLog(...args),
});

// The window plane (presentation.cjs): the console's route registry, the deck and
// chat panels, openConsole, and the inbox/talk/model-browser doors. Built before
// every factory below that takes these by value; home-ipc is created further down,
// and the avatar window is replaced, so both arrive through getters.
const {
  openConsole,
  openInbox,
  openTalkWindow,
  openModelBrowser,
  createDeckWindow,
  createChatWindow,
  getDeckWindow,
  getChatWindow,
} = require("./presentation.cjs").createPresentation({
  electron: { BrowserWindow, screen },
  rendererUrl,
  isAllowedRendererNavigation,
  getAvatarWindow,
  showConsole,
  focusPane,
  closeConsole,
  fleetWindow,
  commandWindow,
  sessionsWindow,
  stageWindow,
  settingsWindow,
  desktop: { showDesktopApp, closeDesktopApp, isAppOpen, desktopAppUrl, ensureDesktopSession, portalLoginUrl },
  ensureHomeIpc: () => ensureHomeIpc(),
  stagePaneImpl,
  castPaneImpl: () => roomStageHost.castPaneImpl(roomStageDeps()),
  commandRegistry,
  commandContext: () => commandContext(),
  runCommand: (...args) => runCommand(...args),
  debugLog: (...args) => debugLog(...args),
});

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

function handleBridgeEvent(event) {
  if (event.type !== "audio-level" || event.level > 0.025) debugLog("event", event);
  // Bridge /events come from scripts (the escalator's GREETING, a listener's audio
  // level). While a game is full-screen they animate a body that is already up,
  // but never bring a hidden avatar back over the game.
  if (quietMode.isQuiet()) {
    if (event.type === "state") latestVoiceState = event.state;
    emitToRenderer(event);
    return;
  }
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

/** Deps shared by room-stage-host's startRoomStage() and castPaneImpl() --
 *  see room-stage-host.cjs's own doc for the exact shape each reads (only
 *  startRoomStage needs roomPublisher/spawnAvatarSlot/removeAvatarSlot/
 *  speakAloud; castPaneImpl reads none of those, and an extra field is
 *  harmless). Built fresh per call, never cached: `roomPublisher` is null
 *  until app.whenReady's own sequence assigns it, and reading it here at
 *  CALL time (not at require time) is what makes that ordering safe. */
function roomStageDeps() {
  return {
    roomPublisher: getRoomPublisher(),
    spawnAvatarSlot,
    removeAvatarSlot,
    speakAloud,
    listCharacters,
    // SAFE roster only: the content-rating gate decides what may have a body.
    filterCharacters: require("./content-rating.cjs").filterCharacters,
    // UNFILTERED, for the Cast pane's "what is hidden and why" list ONLY.
    listAllCharacters: require("./character-roster.cjs").listAllCharacters,
    getActiveCharacter,
    sendToRenderer: emitToRenderer,
    log: (...args) => debugLog(...args),
    env: process.env,
    // Read at CALL time for the same reason roomPublisher is: null until ready.
    syncStatus: () => (getSettingsSync() ? getSettingsSync().status() : null),
  };
}

/** The company room on stage: one avatar per agent, spoken in turn. Started
 *  beside the room publisher; DESK_ROOM_STAGE=0 leaves the room text-only.
 *
 *  U28: this used to build `new RoomStage(...)` inline, closing over half a
 *  dozen main-side functions with no resolver at all -- the room-stage's
 *  `voices` option was plumbed end to end and nothing ever supplied it, which
 *  is exactly the failure mode CAST004 (check_desk_cast_config.py) now
 *  asserts statically can never happen again. room-stage-host.cjs (U07) owns
 *  the build; this is a delegation only. */
function startRoomStage() {
  if (!getRoomPublisher()) return;
  roomStageHost.startRoomStage(roomStageDeps());
}


function handleProtocolUrl(rawUrl) {
  const commands = parseProtocolUrl(rawUrl, protocolScheme);
  if (!commands) return false;
  // desk:// is how scripts and other apps reach the desk. While a game is
  // full-screen nothing they send may open or focus a window; hide and bare
  // events still pass (neither can cover the game).
  if (quietMode.isQuiet()) {
    for (const command of commands) {
      if (command.type === "hide") void hideOverlay();
      else if (command.type === "event") handleBridgeEvent(command.event);
      else if (command.type === "console") holdWhileQuiet();
    }
    return true;
  }
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

// The roster as the desk shows it: Characters/Agents menus, switching, the adult
// gate's on-screen enforcement, the rater's capture and the thumbnail IPC.
const {
  enforceActiveCharacterRating,
  applyCharacter,
  buildCharacterMenu,
  openVroidHub,
  captureRoster,
  captureRosterStatus,
  characterModelUrl,
  maybePromptForFirstCharacter,
  applyAgentAvatar,
  fsMkdirSafe,
  refreshSafetyPosture,
  registerIpc: registerRosterIpc,
} = require("./roster-surface.cjs").createRosterSurface({
  app,
  dialog,
  ipcMain,
  shell,
  getAvatarWindow,
  sendToAvatar: (...args) => sendToAvatar(...args),
  showOverlay: (...args) => showOverlay(...args),
  hideOverlay: (...args) => hideOverlay(...args),
  refreshTrayMenu: () => refreshTrayMenu(),
  openModelBrowser: (...args) => openModelBrowser(...args),
  handleBridgeEvent: (...args) => handleBridgeEvent(...args),
  debugLog: (...args) => debugLog(...args),
});

// The owner's voice INTO the desk -- push-to-talk, open mic, the mic mute, voiceAsk,
// the voice IPC and the process-audio listener (voice-input.cjs). The avatar window
// is replaced and commandAction is built below, so both are read at call time.
const {
  voiceAsk,
  listeningNow,
  micMuted,
  talkMode,
  applyTalkMode,
  restoreOpenMicAtBoot,
  toggleListening,
  toggleMicMute,
  isOpenMic,
  getListenerStatus,
  registerVoiceIpc,
  startAudioListener,
  stopAudioListener,
} = require("./voice-input.cjs").createVoiceInput({
  ipcMain,
  app,
  getAvatarWindow,
  getTray: () => tray,
  showOverlay: (...args) => showOverlay(...args),
  sendToAvatar: (...args) => sendToAvatar(...args),
  emitToRenderer: (...args) => emitToRenderer(...args),
  refreshTrayMenu: () => refreshTrayMenu(),
  handleBridgeEvent: (...args) => handleBridgeEvent(...args),
  speakAloud: (...args) => speakAloud(...args),
  commandAction: (...args) => commandAction(...args),
  stagePath,
  cleanupStage,
  debugEnabled,
  debugLog,
});

// The decision-card plane (decisions-plane.cjs): the open queue and its ONE count,
// the badges, quiet mode + Do Not Disturb, the spoken prompt for a new card, the
// window router and the deck's answer/steer/bulk IPC. Built here, after speech and
// voiceAsk exist; the tray and the avatar window are replaced, so both are getters.
const {
  quietMode,
  inputPrefs,
  toggleDoNotDisturb,
  holdWhileQuiet,
  visibleDecisions,
  pendingRemovals,
  inboxCounts,
  refreshNotificationBadges,
  setTrayBaseIcon,
  wireWindowRouter,
  registerDeckIpc,
  startDecisionWatch,
  stopDecisionWatch,
} = require("./decisions-plane.cjs").createDecisionsPlane({
  decisionCards,
  app,
  nativeImage,
  ipcMain,
  getTray: () => tray,
  getAvatarWindow,
  setInboxBadge,
  badgeBitmap,
  badgeTooltip,
  drawBadge,
  speakAloud: (...args) => speakAloud(...args),
  voiceAsk,
  micMuted: () => micMuted(),
  openInbox: (...args) => openInbox(...args),
  postToRelay: (...args) => postToRelay(...args),
  RELAY_CHANNEL,
  refreshRelayFeed: () => refreshRelayFeed(),
  refreshTrayMenu: () => refreshTrayMenu(),
  sendDeckState: () => sendDeckState(),
  debugLog: (...args) => debugLog(...args),
});

// "Mute all voices" + the right-click Voice picker live in voice-controls.cjs.
const { voicesMuted, toggleVoiceSilence, buildVoiceMenu } = require("./voice-controls.cjs").createVoiceControls({
  BrowserWindow,
  speakAloud: (...args) => speakAloud(...args),
  refreshTrayMenu: () => refreshTrayMenu(),
  castPane: () => roomStageHost.castPaneImpl(roomStageDeps()),
  debugLog: (...args) => debugLog(...args),
});

// The runners behind fleet/ARC, blog and About registry rows, and the one
// command-agent entry (command-actions.cjs). runCommand stays here.
const {
  runFleetCommand,
  runBlogMenuCommand,
  fleetAction,
  commandAction,
  showAboutDesk,
} = require("./command-actions.cjs").createCommandActions({
  app,
  dialog,
  shell,
  commandRegistry,
  getTray: () => tray,
  createFleetWindow,
  getFleetControl,
  fleetSummaryCached,
  createCommandWindow,
  getCommandAgent,
});

// The MCP handler and the loopback bridge server (the doors other programs use).
// Built here, after quietMode and voiceAsk exist; started in app.whenReady.
const integrationDoors = require("./integration-doors.cjs").createIntegrationDoors({
  quietMode,
  voiceAsk,
  decisionCards,
  commandRegistry,
  roomStageHost,
  mainLag,
  presentState,
  getAvatarWindow,
  getVoiceState: () => latestVoiceState,
  getListenerStatus: () => getListenerStatus(),
  getWakesFeed: () => getWakesFeed(),
  holdWhileQuiet: () => holdWhileQuiet(),
  showOverlay: (...args) => showOverlay(...args),
  hideOverlay: (...args) => hideOverlay(...args),
  handleBridgeEvent: (...args) => handleBridgeEvent(...args),
  applyCharacter: (...args) => applyCharacter(...args),
  applyAgentAvatar: (...args) => applyAgentAvatar(...args),
  captureRoster: (...args) => captureRoster(...args),
  captureRosterStatus: (...args) => captureRosterStatus(...args),
  spawnAvatarSlot: (...args) => spawnAvatarSlot(...args),
  removeAvatarSlot: (...args) => removeAvatarSlot(...args),
  fleetAction: (...args) => fleetAction(...args),
  commandAction: (...args) => commandAction(...args),
  speakAloud: (...args) => speakAloud(...args),
  openInbox: (...args) => openInbox(...args),
  openConsole: (...args) => openConsole(...args),
  focusPane: (...args) => focusPane(...args),
  runCommand: (...args) => runCommand(...args),
  commandContext: (...args) => commandContext(...args),
  showLivingDesktop: (...args) => showLivingDesktop(...args),
  showDesktopApp: (...args) => showDesktopApp(...args),
  desktopStatus: (...args) => desktopStatus(...args),
  getCommandAgent: (...args) => getCommandAgent(...args),
  getFleetControl: (...args) => getFleetControl(...args),
  createCommandWindow: (...args) => createCommandWindow(...args),
  createFleetWindow: (...args) => createFleetWindow(...args),
  debugLog: (...args) => debugLog(...args),
});

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
  const sessionAddress = addressForSlot(slotId); // U28: this body already knows its slot

  // 🚩 RENDERED from command-registry.cjs, like the tray. This was the last
  // hand-written menu, and it had drifted exactly the way the registry's header
  // predicts (measured 2026-09-20): cast.open declared for this surface and absent
  // from it, the microphone row replaced by a chat row under a near-identical
  // label, the size group under a different parent name than the tray's, and the
  // AitherOS Online overlay on neither. What a right-click adds is the BODY: the
  // slot rides in ctx, so slot-scoped rows appear here and nowhere else.
  const template = [
    // WHO first, body second (the VRM's own title led this header until 2026-09-21).
    { label: agent ? `${agent} — body ${displayName}` : displayName, enabled: false },
    { type: "separator" },
    ...commandRegistry.buildMenu(
      "avatar-menu",
      (id) => runCommand(id, undefined, { surface: "avatar-menu", slotId }),
      {
        ctx: { ...commandContext(), slotId, agent, removable: !isDefault, sessionAddress },
        submenus: { "characters.pick": buildCharacterMenu(), "voice.pick": buildVoiceMenu(slotId) },
      },
    ),
  ];
  const avatarWindow = getAvatarWindow();
  if (avatarWindow && !avatarWindow.isDestroyed()) {
    Menu.buildFromTemplate(template).popup({ window: avatarWindow });
  }
}

ipcMain.on("desk:avatar-context-menu", (_event, slotId) => {
  popupAvatarMenu(String(slotId || ""));
});

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
/**
 * The live facts a command's label, checkmark or greyed state reads. ONE producer:
 * the tray, a body's menu, the palette, the beads and the jump list all resolve
 * their rows against this, so "20 waiting" on one and "22" on another is not
 * possible by construction.
 */
// Global shortcuts + the Settings surface (hotkeys-settings.cjs). deadAccels is
// the module's own Set, refilled in place, so commandContext and the jump list
// below read the live list. Listen state changes, so it arrives as a getter.
const {
  deadAccels,
  applyHotkeys,
  registerSettingsIpc,
} = require("./hotkeys-settings.cjs").createHotkeysSettings({
  ipcMain,
  globalShortcut,
  shell,
  commandRegistry,
  runCommand: (...args) => runCommand(...args),
  refreshTrayMenu: () => refreshTrayMenu(),
  isListening: () => listeningNow(),
  applyTalkMode: (...args) => applyTalkMode(...args),
  speakAloud: (...args) => speakAloud(...args),
});

// The bead deck's IPC doors -- the desk:deck-action verb switch and the deck's
// read-side handles (deck-actions.cjs). Registered in app.whenReady; the deck and
// avatar windows are replaced over the desk's life, so both arrive as getters.
const { register: registerDeckActions } = require("./deck-actions.cjs").createDeckActions({
  ipcMain,
  Menu,
  BrowserWindow,
  shell,
  commandRegistry,
  runCommand,
  commandContext,
  deckState,
  sendDeckState,
  createDeckWindow,
  getDeckWindow,
  getAvatarWindow,
  buildCharacterMenu,
  applyCharacter,
  enrollNewestDownloadChecked,
  openVroidHub,
  fsMkdirSafe,
  ROSTER_DIR,
  fetchRelayChannels,
  fetchRelayHistory,
  fetchRelayThread,
  postToRelay,
  postRelayThreadReply,
  RELAY_CHANNEL,
  refreshRelayFeed,
  refreshWakesFeed,
  refreshRoomFeed,
  wakesPending,
  wakesFeedClient,
  getRoomPublisher,
  roomStageHost,
  steerEvent,
  addressForSlot,
  spawnAgent,
  removeAvatarSlot,
  detachAvatarToOwnWindow,
  openModelBrowser,
  createChatWindow,
  openConsole,
  createCommandWindow,
  createFleetWindow,
  getFleetControl,
  getCommandAgent,
  openTalkWindow,
  openInbox,
  decisionCards,
  showLivingDesktop,
  showDesktopApp,
  toggleOverlay,
  hideOverlay,
  growWindow,
  shrinkWindow,
  toggleWindowOutline,
  resetAvatarLayout,
  quitDesk: () => {
    isQuitting = true;
    app.quit();
  },
  speakAloud,
  debugLog,
});

/** Is the avatar on screen? The tray/palette context, the deck and Home read this
 *  one fact, through the getter -- the window is replaced over the desk's life. */
function isAvatarShown() {
  const avatarWindow = getAvatarWindow();
  return Boolean(avatarWindow && !avatarWindow.isDestroyed() && avatarWindow.isVisible());
}

function commandContext() {
  const desktop = desktopStatus().overlay;
  return {
    avatarShown: isAvatarShown(),
    decisionsWaiting: inboxCounts().waiting,
    decisionsTotal: inboxCounts().total,
    listening: listeningNow(),
    micMuted: micMuted(),
    voicesMuted: voicesMuted(),
    doNotDisturb: Boolean(inputPrefs().doNotDisturb),
    quietReason: quietMode.state().reason,
    talkMode: talkMode(),
    openMic: isOpenMic(),
    overlayOpen: desktop.open,
    overlayVisible: desktop.visible,
    overlayShell: desktop.shell,
    overlayGhost: desktop.ghost,
    overlaySolid: !desktop.transparent,
    deadAccels: [...deadAccels],
  };
}

/**
 * The Windows JUMP LIST -- right-click the desk on the taskbar. Rendered from the
 * registry's `jumplist` surface, so the OS's own menu offers the same verbs under
 * the same names as the tray, a body's menu and Ctrl+K. Each task relaunches the
 * desk with `--run=<id>`; the single-instance lock hands that to the running app.
 */
function refreshJumpList() {
  if (process.platform !== "win32" || typeof app.setUserTasks !== "function") return;
  // In a dev run the executable is electron.exe and the app is its first argument.
  const prefix = app.isPackaged ? "" : `"${app.getAppPath()}" `;
  try {
    app.setUserTasks(commandRegistry.rowsFor("jumplist", { deadAccels: [...deadAccels] }).map((row) => ({
      program: process.execPath,
      arguments: `${prefix}--run=${row.id}`,
      iconPath: process.execPath,
      iconIndex: 0,
      title: row.label.replace(/\s+\(Ctrl[^)]*\)$/, ""),
      description: row.label,
    })));
  } catch (error) {
    console.warn("[desk] jump list not set:", error?.message || error);
  }
}

function refreshTrayMenu() {
  invalidateGate();
  refreshSafetyPosture();
  // Slice F: append a line the first time the gate MOVES. The desk cannot
  // authenticate the flip (the platform writes the mirror), so what it attests
  // is what it observed and when -- which is the part a desk can honestly claim.
  require("./content-rating.cjs").noteGateState();
  enforceActiveCharacterRating();
  // SLIMMED 2026-08-25 (owner redesign: "move away from nested menus"). The
  // deck panel (right-click the avatar, or "Open the Desk panel") carries the
  // decision cards, models, talk, Aitheros Online, avatar slots and size
  // controls — each is now ONE click from the deck instead of a three-deep
  // submenu. Characters stays as the single deliberate exception: a 70+
  // character roster needs a picker with more than a row of chips, and that
  // picker moves into the deck next.
  // CONSOLIDATED 2026-09-13 (owner: "where is the unified command center …
  // all 3 of these menus so full of duplication"). The tray is the DOORBELL:
  // it opens the console (every surface lives there as a pane), shows the
  // inbox count, toggles the avatar and picks a character. Nothing that is a
  // console pane is listed here a second time.
  // 🚩 RENDERED from command-registry.cjs, never hand-written. Three menus used
  // to list capabilities by hand and drifted apart between consolidations; the
  // avatar window's size ended up reachable through exactly one gesture. The
  // registry owns the inventory, which surfaces carry each entry, and the ONE
  // label each nested group goes by. Slice 1 of docs/UX-REIMPLEMENTATION.md.
  const trayTemplate = commandRegistry.buildMenu("tray", runCommand, {
    ctx: commandContext(),
    submenus: { "characters.pick": buildCharacterMenu() },
  });
  // A dead voice listener is otherwise INVISIBLE (see voice-tray-line.cjs). It is
  // a STATUS line rather than a command, so it is spliced in after the avatar
  // group rather than declared in the registry.
  const voiceRows = voiceTrayItems(getListenerStatus(), app.isPackaged);
  const appGroupAt = trayTemplate.findIndex((row) => row.label === "About Desk");
  if (voiceRows.length && appGroupAt > 0) trayTemplate.splice(appGroupAt - 1, 0, ...voiceRows);
  else trayTemplate.push(...voiceRows);
  tray?.setContextMenu(Menu.buildFromTemplate(trayTemplate));
}

/**
 * Perform a registry command.
 *
 * The registry holds WHAT and WHERE; this holds HOW, in one switch, so every
 * surface that renders a command runs the identical action. An id with no case
 * here is a menu row that does nothing -- the conformance test in
 * command-registry.test.cjs and the arm below refuse to let that ship.
 *
 * `arg` is the palette's typed argument for a record with `prompt` (a title, a
 * slug); menus pass none. `surface` names who is asking so an async verdict can
 * be RETURNED to a palette (which shows it) rather than dialogued at a tray
 * click, which has nowhere else to put it.
 */
function runCommand(id, arg, { surface = "menu", slotId = null } = {}) {
  // A command can flip a fact a label reads (overlay open, ghost mode, mic on).
  // Re-render AFTER it ran rather than let the tray show the state from before
  // the click; setImmediate fires once this synchronous switch has returned.
  if (tray) setImmediate(() => refreshTrayMenu());
  switch (id) {
    case "console.open": return void openConsole();
    case "inbox.open": return void openInbox();
    case "avatar.toggle": return void toggleOverlay();
    case "voice.talk": return void toggleListening();
    case "window.size.bigger": return void growWindow();
    case "window.size.smaller": return void shrinkWindow();
    // U27's cast.open record -- the one door onto cast.json from tray/avatar-
    // menu/palette (see console-window.cjs's `cast` pane).
    case "cast.open": {
      openConsole();
      focusPane("cast");
      return;
    }
    // Plan: the settings page the owner asked for by name. kind:"file" pane,
    // no vite build (see console-window.cjs PANES).
    case "settings.open": {
      openConsole();
      focusPane("settings");
      return;
    }
    case "voice.mute": return void toggleMicMute();
    case "voice.silence": return void toggleVoiceSilence();
    case "attention.dnd": return void toggleDoNotDisturb();
    // voice.pick is a dynamic submenu: its rows carry their own clicks.
    case "voice.pick": return;
    // U27's room.steer record (palette surface only -- no slot in hand here;
    // the avatar menu's OWN "Message this session…" item, added in
    // popupAvatarMenu below, already knows its slot and does not reach this
    // case). The chat pane's "Bodies on stage" picker (U20/U21) is where the
    // session actually gets chosen.
    case "room.steer": return void createChatWindow();
    case "chat.open": return void openTalkWindow();
    // AitherOS Online. `desktop.shell.*` is data on the record (default branch).
    case "desktop.overlay.toggle": return void toggleLivingDesktop();
    case "desktop.app.open": return void showDesktopApp();
    case "desktop.overlay.ghost": return void setGhostMode(!desktopStatus().overlay.ghost);
    case "desktop.overlay.solid": return void setSolidBackground(desktopStatus().overlay.transparent);
    case "desktop.overlay.reload": return void reloadLivingDesktop();
    case "desktop.signin": return void beginDesktopSignIn();
    case "window.outline": return void toggleWindowOutline();
    case "layout.reset-all": return void resetAvatarLayout();
    // The body verbs: `slotId` is the body that was right-clicked.
    case "avatar.focus": return void sendToAvatar("focus-avatar", { slotId });
    case "avatar.frame-all": return void sendToAvatar("focus-avatar", { slotId: null });
    case "avatar.reset": return void sendToAvatar("reset-avatar-layout", { slotId });
    case "avatar.remove": return void (slotId && removeAvatarSlot(slotId));
    case "about": return void showAboutDesk();
    case "quit":
      isQuitting = true;
      return void app.quit();
    default: {
      // The size presets and the stage arrangements are DATA on their registry
      // records, so a new one is a line there and needs no case here.
      const command = commandRegistry.byId(id);
      if (command && command.size) {
        return void setWindowSize(command.size.width, command.size.height);
      }
      if (command && command.arrangement) {
        // The renderer holds the geometry (src/stage/arrangements.ts) because the
        // stage bounds live there; main names the shape and nothing else.
        // `focus` is the one shape with a subject: on a body's menu it is THAT
        // body, anywhere else the renderer picks the selected one.
        return void sendToAvatar("stage-arrange", {
          arrangement: command.arrangement,
          slotId: command.arrangement === "focus" ? slotId : null,
        });
      }
      if (command && "shell" in command) return void setDesktopShell(command.shell);
      if (command && command.fleet) {
        // Fleet and ARC verbs: the same runner the Fleet window, the bridge and
        // MCP fleet_control use, so a tray click is not a second implementation.
        return void runFleetCommand(command);
      }
      if (command && command.blog) {
        // Blog verbs: gateway blog_* tools through the desk's ONE MCP transport.
        // Returned (not void) so the palette can await and show the verdict.
        return runBlogMenuCommand(command, arg, { surface });
      }
      console.warn(`[desk] command ${id} has no handler`);
    }
  }
}

/** Everything the deck panel renders, in one object — the panel is a VIEW over
 *  main's state, so the tray and the deck can never disagree about what is
 *  waiting or which avatars exist (the one-source-of-truth class). The counts
 *  come from inboxCounts() (decisions-plane.cjs), the ONE answer every surface reads. */
function deckState() {
  const counts = inboxCounts();
  return {
    decisions: visibleDecisions(),
    openCount: counts.waiting,
    totalCount: counts.total,
    deskVisible: isAvatarShown(),
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
    relay: getRelayFeed(),
    relayChannel: RELAY_CHANNEL,
    // awrise's scheduled jobs + whether its clock is still ticking. A green job
    // list with no ticks is the failure that hides itself, so the liveness
    // fields ride on the same object the rows do.
    wakes: getWakesFeed(),
    // The local room (awdk daemon): command requests/replies beside every
    // session's tool calls — the half of the company room that outlives the fleet.
    room: getRoomFeed(),
    roomStatus: getRoomPublisher() ? (getRoomPublisher().lastError || "ok") : "not started",
    roomStage: roomStageHost.status(),
    relayPoller: getRelayPoller() ? getRelayPoller().status() : null,
  };
}

/** Push fresh state to every window rendering the deck feed. */
function sendDeckState() {
  const event = { type: "deck-state", ...deckState() };
  const deckWindow = getDeckWindow();
  if (deckWindow && !deckWindow.isDestroyed()) {
    deckWindow.webContents.send("desk:event", event);
  }
  // The chat window renders the SAME feed; without this push a sent
  // message never appears in the list the sender is looking at.
  const chatWindow = getChatWindow();
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

// Home (console-window PANES "home"): one summary read, three verbs (home-ipc.cjs).
// Registered once, from openConsole. The avatar window is replaced, so it is read
// through a getter.
const { ensureHomeIpc } = require("./home-ipc.cjs").createHomeIpc({
  ipcMain,
  decisionCards,
  commandRegistry,
  visibleDecisions: () => visibleDecisions(),
  pendingRemovals,
  voicesMuted: () => voicesMuted(),
  micMuted: () => micMuted(),
  talkMode: () => talkMode(),
  inputPrefs: () => inputPrefs(),
  isAvatarShown: () => isAvatarShown(),
  avatarBodies: () => avatarSlots.size,
  getActiveCharacter,
  runCommand: (...args) => runCommand(...args),
  focusPane,
  sendDeckState: () => sendDeckState(),
  postToRelay,
  RELAY_CHANNEL,
  refreshRelayFeed: () => refreshRelayFeed(),
});

// A card asking to be SHOWN goes to the deck/console ladder (decisions-plane.cjs).
wireWindowRouter();

function createTray() {
  const iconPath = path.join(__dirname, "..", "build", "icon.png");
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 20, height: 20 });
  setTrayBaseIcon(icon);
  tray = new Tray(icon);
  refreshTrayMenu();
  refreshNotificationBadges();
  tray.on("click", toggleOverlay);
  // The console is the front door; the tray is the doorbell.
  tray.on("double-click", () => openConsole());
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
    // A Windows jump-list task (right-click the taskbar icon): `--run=<command id>`.
    const asked = argv.find((part) => part.startsWith("--run="));
    if (asked) {
      const id = asked.slice("--run=".length);
      if (commandRegistry.byId(id)) runCommand(id, undefined, { surface: "jumplist" });
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
    if (!handled && !argv.includes("--background")) showOverlay({ focus: !quietMode.isQuiet() });
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleProtocolUrl(url);
  });

  app.whenReady().then(async () => {
    // Microphone permission: Electron DENIES getUserMedia by default, so the
    // push-to-talk renderer captured nothing and Ctrl+Shift+Space "had no effect"
    // (owner 2026-09-22). Grant audio/media to the desk's own windows.
    try {
      const { session } = require("electron");
      const grantMic = (p) => p === "media" || p === "audioCapture" || p === "microphone";
      session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(grantMic(permission)));
      session.defaultSession.setPermissionCheckHandler((_wc, permission) => grantMic(permission));
    } catch { /* permission API absent: capture would fail, not silently pass */ }
    // Ahead of batch work on a saturated host (process-priority.cjs). The first
    // sweep runs once the GPU process and the windows exist; the timer catches later ones.
    setTimeout(() => require("./process-priority.cjs").keepDeskResponsive(app), 5000);
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
      const avatarWindow = getAvatarWindow();
      if (avatarWindow && !avatarWindow.isDestroyed()) {
        replaySlots();
        // A fresh renderer has no mic open; open mic survives a reload.
        if (isOpenMic()) avatarWindow.webContents.send("desk:event", { type: "open-mic", on: true });
      }
      // The snapshot the renderer asked for is the LAST STATE event; capture it
      // before the physics replay below, which goes through emitToRenderer and
      // would otherwise overwrite it with a tune-avatar the renderer's
      // `type === "state"` check ignores -- leaving the voice state unset.
      const snapshot = getLatestEvent();
      const liveWindow = getAvatarWindow();
      if (liveWindow && !liveWindow.isDestroyed()) {
        // The physics knobs live only in cast.json + this process (never in
        // the renderer's storage), so a fresh renderer is told them here, for
        // the resident and every slot just replayed. Same no-race argument.
        try {
          roomStageHost.replayPhysics(roomStageDeps(), stagePaneImpl().bodies());
        } catch (error) {
          debugLog("replayPhysics failed", error?.message || error);
        }
      }
      return snapshot;
    });
    ipcMain.on("desk:hide", () => void hideOverlay());

    // desk:deck-bulk / desk:deck-answer / desk:deck-steer (decisions-plane.cjs).
    registerDeckIpc();
    // Marketplace browse + character thumbnail / full-body / turntable writes.
    registerRosterIpc();
    // Settings: voice input, hotkeys, account link, bricks (hotkeys-settings.cjs).
    registerSettingsIpc();
    // Push-to-talk: voice-heard / voice-listen-state / voice-transcribe (voice-input.cjs).
    registerVoiceIpc();
    // The bead deck's doors: desk:deck-action, the deck state/open/close, the relay
    // thread, the five system snapshots, run-command, file-dropped, command-rows
    // (deck-actions.cjs).
    registerDeckActions();

    // The MCP handler and the loopback bridge: integration-doors.cjs.
    await integrationDoors.startBridge();

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

    // Native card notifications are REMOVED (2026-08-31, owner decision) — the
    // tray, deck and Discord fanout are the bells. The deck's feeds and the
    // company room (relay feed, wakes watch, RoomPublisher + startRoomStage,
    // settings sync, RelayPoller, room feed): feeds.cjs, same order as before.
    startFeeds();

    // Quiet mode, then the card watcher: badges, deck, and the spoken prompt for
    // a card that needs the owner (decisions-plane.cjs).
    await startDecisionWatch();

    // 🚩 register() RETURNS whether it got the accelerator, and the answer was
    // thrown away. Another app holding Ctrl+Shift+= takes the only keyboard path
    // to window size with no error anywhere -- the keys simply stop working,
    // which is exactly what "i cant control the size anymore" looks like. Say it
    // out loud; the tray menu is the path that does not depend on this.
    // The keys are DATA on their registry records (`accel`), so the shortcut a
    // menu advertises and the one that is registered cannot be two lists. A key
    // we could not get lands in deadAccels and its label stops promising it.
    // (CommandOrControl+Shift+= / - / A / Space / D at the time of writing.)
    applyHotkeys();
    // Open mic from Settings comes back on at boot (voice-input.cjs).
    restoreOpenMicAtBoot();
    refreshJumpList();
    handleProtocolArgv(process.argv);

    startAudioListener();

    if (!startInBackground) {
      createWindow();
      // INACTIVE at launch. Nobody is waiting to type into the avatar when it
      // comes up: it is started by the logon shim, by restart_persona.py, or by
      // a peer session rebuilding it -- measured 2026-09-20, the fresh Desk
      // window took the foreground on every relaunch, in the middle of the
      // owner's typing ("stealing context"). The window is alwaysOnTop, so it
      // is seen either way; the owner's own gestures (tray "Show avatar", a
      // second launch, macOS activate) still pass { focus: true } below.
      showOverlay();
    }
    if (deckIsRequested) createDeckWindow();
    if (consoleIsRequested) openConsole();
  });
}

app.on("activate", () => showOverlay({ focus: true }));

app.on("before-quit", () => {
  quietMode.stop();
  isQuitting = true;
  stopAvatarWindow();
  stopFeeds();
  stopDecisionWatch();
  stopAudioListener();
  globalShortcut.unregisterAll();
  integrationDoors.closeBridge();
});

app.on("window-all-closed", () => {
  // The tray, protocol handler, and adapter server keep Desk available.
});
