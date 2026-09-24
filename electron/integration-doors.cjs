"use strict";

/**
 * integration-doors.cjs -- the two doors other programs use to reach the desk:
 * the MCP handler (play_animation, speak, ask, spawn_avatar, desktop_open ...) and
 * the loopback bridge server (POST /speak, /commands, /console/open, /fleet,
 * /desktop, /command, /roster/capture ...). Moved out of main.cjs as slice 3 of
 * docs/UX-REIMPLEMENTATION.md (main.cjs getting SMALLER); a pure move.
 *
 * Everything main-only arrives as a dep. State main REPLACES (the avatar window,
 * the latest voice/listener status, the wakes feed) comes through getters, so a
 * door never answers from a stale window. quietMode is passed as itself: every
 * door here that can put something on screen asks it first (quiet-mode.test reads
 * this file for that). Loads without Electron.
 */

const fs = require("node:fs");
const path = require("node:path");
const { createBridgeServer, DEFAULT_PORT } = require("./bridge-server.cjs");
const {
  createDeskMcpHandler,
  getAnimationEventName,
  ANIMATION_EVENT_NAMES,
} = require("./mcp-server.cjs");
const { getActiveCharacter, listCharacters } = require("./character-roster.cjs");
const { loadMap: loadAgentAvatars } = require("./agent-avatars.cjs");
const { exportToAitherShell } = require("./aithershell-export.cjs");

function createIntegrationDoors({
  quietMode,
  voiceAsk,
  decisionCards,
  commandRegistry,
  roomStageHost,
  mainLag,
  presentState,
  getAvatarWindow,
  getVoiceState,
  getListenerStatus,
  getWakesFeed,
  holdWhileQuiet,
  showOverlay,
  hideOverlay,
  handleBridgeEvent,
  applyCharacter,
  applyAgentAvatar,
  captureRoster,
  captureRosterStatus,
  spawnAvatarSlot,
  removeAvatarSlot,
  fleetAction,
  commandAction,
  speakAloud,
  openInbox,
  openConsole,
  focusPane,
  runCommand,
  commandContext,
  showLivingDesktop,
  showDesktopApp,
  desktopStatus,
  getCommandAgent,
  getFleetControl,
  createCommandWindow,
  createFleetWindow,
  debugLog = () => {},
} = {}) {
  let bridge = null;
  let mcpAnimationRequestId = 0;

  async function handleMcpWindowAction(action) {
    // An AGENT asked (MCP). While quiet it may show the avatar but never take focus.
    const focus = !quietMode.isQuiet();
    if (action === "show") showOverlay({ focus });
    else if (action === "hide") await hideOverlay();
    else if (getAvatarWindow()?.isVisible()) await hideOverlay();
    else showOverlay({ focus });
    return getAvatarWindow()?.isVisible() ?? false;
  }

  function getMcpStatus() {
    return {
      windowVisible: getAvatarWindow()?.isVisible() ?? false,
      voiceState: getVoiceState(),
      listener: getListenerStatus(),
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

  /** Build both doors and start listening. A bridge that cannot bind is logged and
   *  left null: the desk still comes up, it just has no loopback door. */
  async function startBridge() {
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
        return exportToAitherShell(getAvatarWindow(), name, handleBridgeEvent);
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
      // U28: the MCP `speak` tool door -- origin STAMPED here, same reason as
      // the bridge's speakHandler below.
      onSpeak: ({ text, voice, speed }) => speakAloud(text, voice, speed, undefined, "mcp:speak"),
      onAsk: ({ question, timeoutMs }) => voiceAsk.ask(question, { timeoutMs }),
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
      decisionsProvider: () => decisionCards.lastOpen(),
      // Read-only: the hosted web surfaces see the same wake snapshot the deck
      // does. Mutations are NOT offered here — they go to the daemon window.
      wakesProvider: () => getWakesFeed(),
      fleetHandler: (verb, { fresh = false } = {}) => fleetAction(verb === "open" ? "open_panel" : verb, { fresh }),
      // awsh /desktop, adk desk desktop, awconnect's popup and `desk://` all land here.
      // U28: this is the POST /speak door -- origin STAMPED here, never read
      // off the request body (see speakAloud's own doc).
      speakHandler: ({ text, voice, speed, slot }) => speakAloud(text, voice, speed, slot, "bridge:/speak"),
      // The registry over loopback: what `awsh /desk` and `adk desk` list and run.
      commandsHandler: {
        list: () => commandRegistry.paletteRows(commandContext()),
        run: async (id, arg) => {
          const command = commandRegistry.byId(id);
          if (!command || !command.surfaces.includes("palette") || command.dynamic) {
            return { ok: false, error: `unknown command "${id}" -- GET /commands lists them` };
          }
          const verdict = await runCommand(id, arg, { surface: "bridge" });
          return { ok: true, id, label: commandRegistry.labelOf(command, commandContext()), ...(verdict && typeof verdict === "object" ? { verdict } : {}) };
        },
      },
      consoleHandler: (pane) => {
        // POST /console/open is the escalation ladder's desk rung (and any script).
        // While quiet it is HELD and says so, so the caller retries after the game
        // instead of marking the rung delivered.
        if (quietMode.isQuiet()) {
          holdWhileQuiet();
          return { ok: false, held: true, reason: `quiet: ${quietMode.state().reason}`, pane };
        }
        if (pane === "inbox" || pane === "cards") return { ok: openInbox() !== false, pane: "inbox" };
        openConsole();
        return { ok: focusPane(pane) !== false, pane };
      },
      stageStatusProvider: () => ({ ...(roomStageHost.status() || { room: false }), mainLag, present: { mode: presentState.present, gpu: presentState.gpu } }),
      // POST /roster/capture (bearer): full-body frames for the rater. GET: progress.
      rosterCaptureHandler: (req) => (req.method === "GET" ? captureRosterStatus() : captureRoster(req)),
      avatarBoundsProvider: () => {
        const avatarWindow = getAvatarWindow();
        return avatarWindow && !avatarWindow.isDestroyed() && avatarWindow.isVisible()
          ? avatarWindow.getBounds()
          : null;
      },
      desktopHandler: (mode) => {
        if (mode !== "status" && quietMode.isQuiet()) {
          return { ok: false, held: true, reason: `quiet: ${quietMode.state().reason}`, ...desktopStatus() };
        }
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
          if (quietMode.isQuiet()) return { ok: false, held: true, reason: `quiet: ${quietMode.state().reason}` };
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
  }

  function closeBridge() {
    void bridge?.close().catch((error) => debugLog("integration server close failed", error));
  }

  return { startBridge, closeBridge, handleMcpWindowAction, getMcpStatus, listAvailableAnimations };
}

module.exports = { createIntegrationDoors };
