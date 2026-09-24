"use strict";

/**
 * deck-actions.cjs -- the deck's IPC doors: the desk:deck-action verb switch (a
 * registry id first, then the deck's own data verbs: relay-*, wake-*, market-*,
 * room-steer, the slot verbs and the older renderers' spellings), and the deck's
 * read-side handles (state, open/close, the relay thread, the five system
 * snapshots, run-command, file-dropped, command-rows).
 *
 * Moved out of main.cjs in slice 3 of docs/UX-REIMPLEMENTATION.md (main.cjs getting
 * SMALLER). Pure move: same channels, same verbs, same refusals, same return
 * values. Electron arrives as deps (Menu, BrowserWindow, shell) so the module loads
 * in a plain `node`; every window main replaces over the desk's life is a getter
 * read at call time, never a captured reference. register() runs once, from
 * app.whenReady, beside main's other register*Ipc() calls.
 */

// Full system awareness (#9): the five snapshot clients the deck's System
// section renders. Each fails soft (ok:true + per-source ERROR notes) -- a
// down gateway is a rendered state, never a broken panel.
const { systemSnapshot } = require("./system-client.cjs");
const { voiceSnapshot } = require("./voice-client.cjs");
const { visionSnapshot } = require("./vision-client.cjs");
const { desktopSnapshot } = require("./browser-client.cjs");
const { connectSnapshot } = require("./connect-client.cjs");
const { routeDrop } = require("./drop-router.cjs");
// room-address (U19): "which of these parallel tabs am I talking to?" -- the
// text-address fallback the "room-steer" deck-action uses when the renderer
// hands over free text instead of an already-picked session id.
const { resolveAddress } = require("./room-address.cjs");

function createDeckActions({
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
  // roster (roster-surface.cjs / character-roster.cjs)
  buildCharacterMenu,
  applyCharacter,
  enrollNewestDownloadChecked,
  openVroidHub,
  fsMkdirSafe,
  ROSTER_DIR,
  // relay (relay-feed.cjs) + the deck feeds (feeds.cjs)
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
  // the company room
  roomStageHost,
  steerEvent,
  // avatar slots (avatar-slots.cjs)
  addressForSlot,
  spawnAgent,
  removeAvatarSlot,
  detachAvatarToOwnWindow,
  // windows and surfaces
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
  // main owns isQuitting; this sets it and quits, in that order.
  quitDesk,
  speakAloud,
  debugLog = () => {},
} = {}) {
  function register() {
    // ---- Desk panel IPC (the bead deck) -------------------------------------
    // The deck is a VIEW over main's state: it pulls deckState() once on mount,
    // subscribes to desk:event pushes for updates, and routes every action
    // back through the same functions the old menus used — no second path to
    // drift from.
    ipcMain.handle("desk:deck-get-state", () => deckState());
    ipcMain.on("desk:deck-open", () => createDeckWindow());
    ipcMain.on("desk:deck-close", () => {
      const deckWindow = getDeckWindow();
      if (deckWindow && !deckWindow.isDestroyed()) deckWindow.close();
    });
    // The per-avatar direct chat READ side: every reply under one message
    // (the thread = the conversation with that agent). [] on any failure.
    ipcMain.handle("desk:relay-thread", (_event, messageId) =>
      fetchRelayThread(RELAY_CHANNEL, typeof messageId === "string" ? messageId : ""));
    // System awareness snapshots (#9) — read-only, fail-soft by contract.
    ipcMain.handle("desk:system-snapshot", () => systemSnapshot());
    ipcMain.handle("desk:run-command", (_event, id) => {
      try {
        runCommand(String(id || ""), undefined, { surface: "avatar" });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) };
      }
    });
    ipcMain.handle("desk:voice-snapshot", () => voiceSnapshot());
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
      // never fail the drop itself). U28: origin STAMPED "desk:drop" -- same
      // funnel as bridge:/speak and mcp:speak, so a channel/actor grant in
      // cast.json can mute this lane without a code change.
      void speakAloud(speakText, undefined, undefined, undefined, "desk:drop");
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
    // The bead rail's rows, resolved against the same context as every menu.
    ipcMain.handle("desk:command-rows", (_event, surface) =>
      commandRegistry.rowsFor(String(surface || "beads"), commandContext()));
    ipcMain.handle("desk:deck-action", async (_event, name, arg) => {
      // 🚩 A registry id is a command, whoever sends it. This switch grew 31 verbs
      // of its own beside the registry -- "talk", "console", "inbox", "overlay" --
      // each a second spelling of a command with its own label on its own button.
      // New callers send the id; the verbs below stay for the deck's own data
      // calls (relay-*, wake-*, market-*) and for older renderers.
      if (commandRegistry.byId(name)) {
        runCommand(name, arg, { surface: "deck" });
        return true;
      }
      switch (name) {
        // Right-click on a bead: the SAME menu the tray shows, at the cursor. It
        // used to open the inbox, which made the avatar's corner the one place
        // with no way to reach anything else.
        case "menu": {
          const avatarWindow = getAvatarWindow();
          Menu.buildFromTemplate(commandRegistry.buildMenu("tray", runCommand, {
            ctx: commandContext(),
            submenus: { "characters.pick": buildCharacterMenu() },
          }).filter((row, i, all) => !(row.label === "Quit" || (row.type === "separator" && i === all.length - 1))))
            .popup(avatarWindow && !avatarWindow.isDestroyed() ? { window: avatarWindow } : {});
          return true;
        }
        case "models":
          openModelBrowser();
          return true;
        case "marketplace":
          // The aitherium agent-pack + avatar marketplace. Portal is the
          // platform surface; the deep marketplace route gets pinned when the
          // Living-Desktop app phase lands.
          // The old `portal.` host is RETIRED: it 301s to the apex (measured
          // 2026-09-19). Open the apex directly so the app does not depend on a
          // redirect that exists only for old links.
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
              click: async () => {
                // Same funnel as the tray path: the verdict comes before the copy.
                const result = await enrollNewestDownloadChecked();
                if (result.ok) applyCharacter(result.name);
                else debugLog("enrollment refused or unavailable:", result.reason);
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
        // awrise wakes. Every verb goes to the harness daemon's /wakes window:
        // it holds the bearer check, the name gate, the argv control and the
        // per-name in-flight slot. The desk spawns no awrise and writes no
        // scheduler state — one implementation, every surface.
        case "wake-enable":
        case "wake-disable":
        case "wake-run": {
          if (typeof arg !== "string" || !wakesFeedClient.WAKE_NAME_RE.test(arg)) {
            return { ok: false, detail: "invalid wake name" };
          }
          const verb = name.slice("wake-".length);
          const key = `${verb}:${arg}`;
          // Client-side single-flight: the daemon's 409 is the backstop, not
          // the first line — a double-click should not need a round trip to be
          // refused, and `run` holds its request open for 15 s.
          if (wakesPending.has(key)) return { ok: false, detail: "already in flight" };
          wakesPending.add(key);
          try {
            const result = await wakesFeedClient.mutate({ name: arg, verb });
            await refreshWakesFeed();
            return result;
          } finally {
            wakesPending.delete(key);
          }
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
        case "toggle-window-outline":
          toggleWindowOutline();
          return true;
        case "reset-layout":
          resetAvatarLayout();
          return true;
        // The bell, the badge and every "N waiting" label land HERE.
        case "inbox":
          openInbox(typeof arg === "string" && arg ? arg : null);
          return true;
        case "quit":
          quitDesk();
          return true;
        case "relay-post": {
          if (typeof arg !== "string" || arg.length === 0) return false;
          // Two payload shapes: the legacy bare string posts to the company
          // room; a JSON {channel, text} posts to ONE live session channel
          // (`#session-*` only -- the multiplayer attach lane, 2026-09-19).
          // Anything else as a channel is refused here, not forwarded: the
          // renderer must never be able to aim the owner's identity at an
          // arbitrary channel through this verb.
          let channel = RELAY_CHANNEL;
          let text = arg;
          if (arg.startsWith("{")) {
            let parsed;
            try { parsed = JSON.parse(arg); } catch { return "malformed relay-post payload"; }
            if (!parsed || typeof parsed.text !== "string" || !parsed.text.trim()) return false;
            if (typeof parsed.channel === "string" && parsed.channel) {
              if (!/^#session-[a-f0-9]{8}$/.test(parsed.channel)) return "refused: not a live session channel";
              channel = parsed.channel;
            }
            text = parsed.text;
          }
          // AWAIT and report the real result: the fire-and-forget version
          // returned true while the relay 403'd the post (agent-only channel,
          // unjoined identity) -- the chat window then believed the message
          // sent. False must reach the renderer. A failure returns the
          // relay's OWN refusal reason (a string) so the chat window shows
          // WHY, not just "refused".
          const sent = await postToRelay(channel, text);
          if (sent && sent.ok && channel === RELAY_CHANNEL) void refreshRelayFeed();
          return sent && sent.ok ? true : (sent && sent.detail) || "the relay refused";
        }
        // Multiplayer attach (PRD REQ-1/9, 2026-09-19): the live session
        // channels the relay lists, and one channel's history. Both are
        // READS of the relay through the same CLI + bearer as the feed.
        case "relay-channels": {
          const names = await fetchRelayChannels();
          return names.filter((n) => /^#session-[a-f0-9]{8}$/.test(n));
        }
        case "relay-history": {
          if (typeof arg !== "string" || !arg.startsWith("{")) return [];
          let parsed;
          try { parsed = JSON.parse(arg); } catch { return []; }
          if (!parsed || typeof parsed.channel !== "string") return [];
          if (!/^#session-[a-f0-9]{8}$/.test(parsed.channel)) return [];
          const limit = Math.max(1, Math.min(200, Number(parsed.limit) || 80));
          return fetchRelayHistory(parsed.channel, limit);
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
        // room-steer (U28 item 7): an ADDRESSED message to ONE live session,
        // through the room spine's `to` field (U10/U18) and steer_dispatch.py's
        // mailbox (U11/U13) -- explicitly NOT through CommandAgent, which would
        // spawn a fresh `claude -p` at a hardcoded cwd and answer from an EMPTY
        // context (room-address.cjs's own header names this trap). ChatView.tsx
        // calls `.action('room-steer', JSON.stringify({ to, text, label }))`
        // with an already-picked session id; the avatar menu's "Message this
        // session…" item (popupAvatarMenu) currently just opens the pane for
        // the owner to pick from there (a pre-targeted send is a possible
        // follow-up, not wired here — see this unit's own report).
        case "room-steer": {
          if (typeof arg !== "string" || !arg.trim()) return false;
          // Set once in app.whenReady (feeds.cjs) and never cleared.
          const roomPublisher = getRoomPublisher();
          let parsed;
          try {
            parsed = JSON.parse(arg);
          } catch {
            return { ok: false, channel: "none", detail: "malformed room-steer payload" };
          }
          if (!parsed || typeof parsed !== "object") {
            return { ok: false, channel: "none", detail: "malformed room-steer payload" };
          }
          const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
          if (!text) return { ok: false, channel: "none", detail: "nothing to send" };
          let to = typeof parsed.to === "string" && parsed.to ? parsed.to : null;
          let label = typeof parsed.label === "string" ? parsed.label : "";
          // The avatar-menu path knows the SLOT, not the session id.
          if (!to && typeof parsed.slotId === "string" && parsed.slotId) {
            const addr = addressForSlot(parsed.slotId);
            if (addr && addr.actorId) to = addr.actorId;
          }
          // No explicit target at all: fall back to room-address's text
          // resolver over the live stage -- it REFUSES rather than guesses
          // when a phrase matches more than one body (room-address.cjs's own
          // header). `to` is a routing hint only either way; authority never
          // travels through it (see steerEvent's doc in room-publisher.cjs).
          if (!to) {
            const st = roomStageHost.status();
            const onStage = st && Array.isArray(st.onStage) ? st.onStage : [];
            const titles = roomPublisher ? await roomPublisher.sessionTitles() : {};
            const bodies = onStage.map((b) => ({
              slotId: b.slotId, agent: b.agent, actorId: b.actorId, actorKind: b.actorKind,
              title: titles[b.actorId] || null,
            }));
            const resolved = resolveAddress(text, bodies);
            if (!resolved.to) {
              return { ok: false, channel: "none", detail: resolved.reason || "could not address that session" };
            }
            to = resolved.to;
            label = resolved.label || label;
          }
          if (!roomPublisher) return { ok: false, channel: "none", detail: "room publisher not started" };
          const id = require("node:crypto").randomUUID();
          const event = steerEvent({
            id, text, to: [to], label, source: "desk:chat",
            actor: { kind: "human", id: "owner", name: "owner" },
          });
          const published = await roomPublisher.publishSteer(event);
          if (!published.ok) {
            return { ok: false, channel: "none", detail: published.error || "the room refused the steer" };
          }
          // The publish only proves the SPINE took it -- steer_dispatch.py's
          // OWN steering_receipt (U11) says what actually happened. Poll
          // briefly rather than claim delivery from the publish alone
          // (ChatView.tsx's own receiptFor() risk note names this exactly:
          // "claiming delivery for something that is only queued").
          const deadline = Date.now() + 4000;
          const sinceSeq = Number(published.seq) || 0;
          while (Date.now() < deadline) {
            const receipts = await roomPublisher.recentReceipts({ sinceSeq });
            const mine = receipts.find((r) => r.correlationId === id);
            if (mine) return { ok: true, channel: mine.channel, landed_now: mine.channel === "pty", detail: mine.detail, queued: mine.queued };
            await new Promise((resolve) => setTimeout(resolve, 400));
          }
          // No receipt within the budget: still ok (the spine took it), but
          // NO channel fact yet -- ChatView.tsx's receiptFor() reads this as
          // "still queued", never as delivered.
          return { ok: true, channel: null, detail: "queued" };
        }
        case "spawn-agent":
          return spawnAgent(arg);
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
  }

  return { register };
}

module.exports = { createDeckActions };
