"use strict";

/**
 * feeds.cjs -- the deck's live feeds and the company-room wiring that fills them:
 * the #agents relay feed (60 s), the awrise wakes snapshot (daemon watch), the local
 * room's chat rows (15 s + on every command completion), the RoomPublisher that
 * writes each request/reply into the awdk daemon room, the RelayPoller that turns a
 * relay message into a work order, and cast.json settings sync.
 *
 * Moved out of main.cjs in slice 3 of docs/UX-REIMPLEMENTATION.md (main.cjs getting
 * SMALLER). Pure move: same intervals, same start order, same log lines. Everything
 * main-only arrives as a dep; Electron is never required here, so the module loads
 * in a plain `node`.
 *
 * startRoomStage() stays DEFINED in main.cjs and arrives as a dep: CAST004
 * (check_desk_cast_config.py) asserts main.cjs delegates the room stage to
 * room-stage-host.cjs, and it is called here at the exact point main called it --
 * right after the room publisher exists, before settings sync.
 */

function createFeeds({
  fetchRelayHistory,
  postRelayThreadReply,
  RELAY_NICK,
  wakesFeedClient,
  RoomPublisher,
  RelayPoller,
  getCommandAgent,
  getFleetControl,
  sendDeckState,
  startRoomStage,
  debugLog = () => {},
} = {}) {
  let relayFeed = [];
  let relayFeedTimer = null;
  // The awrise wake snapshot the deck renders. `source` is "none" until the first
  // poll answers, then "daemon" or "stale" — the panel says which, because a
  // cached list presented as live is the failure this feed exists to prevent.
  let wakesFeed = wakesFeedClient.emptyFeed({ source: "none" });
  let wakesWatchStop = null;
  // Names with a mutation in flight, so a double-click cannot fire a wake twice
  // before the daemon's own 409 answers.
  const wakesPending = new Set();
  // The local room (awdk daemon :8362, works with the fleet down) and the relay
  // poller that turns messages typed anywhere in the relay into work orders.
  let roomFeed = [];
  let roomFeedTimer = null;
  let roomPublisher = null;
  /** cast.json <-> the owner's other machines (settings-sync.cjs). Null until
   *  app.whenReady; OFF unless cast.json's own `sync` section turns it on. */
  let settingsSync = null;
  let relayPoller = null;

  /** Poll #agents for the deck's relay section. [] on refusal — the section
   *  renders "relay unavailable" rather than pretending the channel is empty. */
  async function refreshRelayFeed() {
    const rows = await fetchRelayHistory();
    relayFeed = rows;
    sendDeckState();
  }

  /** Pull the wake list from the harness daemon. Keeps the previous snapshot so
   *  an unreachable daemon renders as "stale, showing X from N ago" instead of an
   *  empty list that reads as "no jobs configured". */
  async function refreshWakesFeed() {
    const before = wakesFeedClient.feedSignature(wakesFeed);
    wakesFeed = await wakesFeedClient.fetchWakes({ previous: wakesFeed, nowMs: Date.now() });
    if (wakesFeedClient.feedSignature(wakesFeed) !== before) sendDeckState();
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

  /** Called from app.whenReady, after the tray and the fleet progress hook. */
  function start() {
    // Relay feed for the deck: first pull immediately, then every 60s. A cockpit
    // feed lags the channel by design — it is a summary, not a client.
    void refreshRelayFeed();
    relayFeedTimer = setInterval(() => void refreshRelayFeed(), 60_000);
    relayFeedTimer.unref?.();

    // awrise wakes: poll the daemon every 30 s and push only when something
    // moved (the feed signature excludes fetched_at, so a stable list does not
    // re-render every tick; it INCLUDES source/stale_since so the chip flips
    // the moment the daemon goes away).
    wakesWatchStop = wakesFeedClient.watch({
      onChange: (feed) => {
        wakesFeed = feed;
        sendDeckState();
      },
    }).stop;

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
    startRoomStage();
    // Never awaited and never able to throw into launch: offline is the normal
    // state of a laptop, and a sync that can delay the desk coming up is worse
    // than no sync. The Cast pane shows whatever it ended with.
    try {
      const { createSettingsSync } = require("./settings-sync.cjs");
      settingsSync = createSettingsSync({
        castFile: () => require("./cast-config.cjs").CAST_FILE(),
        settings: () => require("./desk-settings.cjs").current(),
        log: (...args) => debugLog(...args),
      });
      void settingsSync.start().catch((error) => debugLog("settings sync start failed", error?.message || error));
    } catch (error) {
      debugLog("settings sync unavailable", error?.message || error);
    }
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
  }

  /** before-quit. The room timer is unref'd and was never cleared here; left so. */
  function stop() {
    if (relayFeedTimer) clearInterval(relayFeedTimer);
    wakesWatchStop?.();
    settingsSync?.stop();
  }

  return {
    refreshRelayFeed,
    refreshWakesFeed,
    refreshRoomFeed,
    wakesPending,
    start,
    stop,
    // Getters: every one of these is reassigned after main wires the module.
    getRelayFeed: () => relayFeed,
    getWakesFeed: () => wakesFeed,
    getRoomFeed: () => roomFeed,
    getRoomPublisher: () => roomPublisher,
    getRelayPoller: () => relayPoller,
    getSettingsSync: () => settingsSync,
  };
}

module.exports = { createFeeds };
