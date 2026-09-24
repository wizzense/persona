"use strict";

/**
 * home-ipc.cjs -- the Home pane's IPC (console-window PANES "home"): one summary
 * read, three verbs, plus the bounded gateway probe the summary shows. Moved out
 * of main.cjs as slice 3 of docs/UX-REIMPLEMENTATION.md (main.cjs getting
 * SMALLER); a pure move. Every verb is an existing path -- a registry command,
 * focusPane, the deck's own answer -- so Home adds no second way to do anything.
 *
 * Everything main-only arrives as a dep. State main REPLACES or builds later
 * (the avatar window, the voice switches, the deck's open list) comes through
 * getters, so a handler never reads a stale window. home-summary.cjs and
 * sessions-client.cjs stay lazy requires, as they were in main. Loads without
 * Electron.
 */

function createHomeIpc({
  ipcMain,
  decisionCards,
  commandRegistry,
  visibleDecisions = () => [],
  pendingRemovals,
  voicesMuted = () => false,
  micMuted = () => false,
  talkMode = () => "",
  inputPrefs = () => ({}),
  isAvatarShown = () => false,
  avatarBodies = () => 0,
  getActiveCharacter = () => "",
  runCommand,
  focusPane,
  sendDeckState = () => {},
  postToRelay,
  RELAY_CHANNEL,
  refreshRelayFeed = () => {},
} = {}) {
  /** Registered once, on the console's first open. */
  let homeIpcWired = false;
  function ensureHomeIpc() {
    if (homeIpcWired) return;
    homeIpcWired = true;
    const { buildHomeSummary, HOME_COMMANDS, planHomeSet } = require("./home-summary.cjs");
    ipcMain.handle("desk:home-summary", async () => {
      const { listSessions } = require("./sessions-client.cjs");
      const [sessions, gateway] = await Promise.all([
        listSessions({ timeoutMs: 3000 }).catch((error) => ({ ok: false, note: String(error?.message || error) })),
        probeGateway(),
      ]);
      return buildHomeSummary({
        cards: visibleDecisions(),
        triage: (card) => decisionCards.triageCard(card),
        sessions,
        gateway,
        voice: { voicesMuted: voicesMuted(), micMuted: micMuted(), talkMode: talkMode(),
          doNotDisturb: Boolean(inputPrefs().doNotDisturb) },
        avatars: {
          shown: isAvatarShown(),
          bodies: avatarBodies(),
          character: getActiveCharacter() || "",
        },
      });
    });
    ipcMain.handle("desk:home-run", (_event, id) => {
      // Home's own switches only: not tray-only `quit`, not fleet verbs (review #10).
      if (!HOME_COMMANDS.includes(id) || !commandRegistry.byId(id)) return { ok: false, error: `Home cannot run ${id}` };
      runCommand(id, undefined, { surface: "home" });
      return { ok: true };
    });
    // The DESIRED state, read against the live one here, so a stale switch cannot
    // invert the owner's click (review #3).
    ipcMain.handle("desk:home-set", (_event, desired) => {
      const live = {
        voicesMuted: voicesMuted(),
        micMuted: micMuted(),
        avatarShown: isAvatarShown(),
        doNotDisturb: Boolean(inputPrefs().doNotDisturb),
      };
      const ran = planHomeSet(desired, live);
      for (const id of ran) runCommand(id, undefined, { surface: "home" });
      return { ok: true, ran };
    });
    ipcMain.handle("desk:home-open", (_event, paneId, param) => {
      focusPane(paneId, param || null);
      return { ok: true };
    });
    ipcMain.handle("desk:home-answer", async (_event, id, choice) => {
      // The renderer names the card and the option; main checks both against its
      // own open list, and #agents hears "answered" only once awask accepted it (review #9).
      const card = visibleDecisions().find((c) => c && c.id === id);
      if (!card) return { ok: false, error: "that card is no longer open" };
      if (!(card.options || []).some((o) => o && o.key === choice)) return { ok: false, error: `"${choice}" is not an option on that card` };
      pendingRemovals.add(id);
      const verdict = await decisionCards.answerCardConfirmed(id, choice);
      if (!verdict.ok) {
        pendingRemovals.delete(id);
        return { ok: false, error: verdict.error || "awask refused the answer" };
      }
      sendDeckState();
      void postToRelay(RELAY_CHANNEL, `answered ${id}: ${choice} (via desk)`).then(() => refreshRelayFeed());
      return { ok: true };
    });
  }

  /** The MCP gateway's /health, bounded. 127.0.0.1, never localhost (::1 refuses). */
  async function probeGateway() {
    try {
      const res = await fetch("http://127.0.0.1:8182/health", { signal: AbortSignal.timeout(1500) });
      return res.ok ? { ok: true } : { ok: false, note: `HTTP ${res.status}` };
    } catch (error) {
      return { ok: false, note: error?.name === "TimeoutError" ? "no answer in 1.5 s" : "not reachable" };
    }
  }

  return { ensureHomeIpc, probeGateway };
}

module.exports = { createHomeIpc };
