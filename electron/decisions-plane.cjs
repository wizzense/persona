"use strict";

/**
 * decisions-plane.cjs -- the decision-card plane as the desk carries it: the open
 * queue and its ONE count, the badges (tray, taskbar overlay, Inbox tab, dock),
 * quiet mode + Do Not Disturb, the spoken prompt and voice answer for a new card,
 * the window router, and the deck's answer/steer/bulk IPC.
 *
 * Moved out of main.cjs in slice 3 of docs/UX-REIMPLEMENTATION.md (main.cjs getting
 * SMALLER). Pure move: every channel name and spoken line is what main.cjs had.
 * Everything main-only arrives as a dep (the tray and the avatar window are replaced,
 * so both are read through getters); Electron itself is never required here, so the
 * module loads in a plain `node`.
 *
 * Native notifications were REMOVED 2026-08-31 (owner decision) -- the tray badge,
 * deck and Discord fanout carry the push; DNT001 (check_desk_no_card_toasts.py)
 * scans this file for them.
 */

function createDecisionsPlane({
  decisionCards,
  app,
  nativeImage,
  ipcMain,
  getTray = () => null,
  getAvatarWindow = () => null,
  setInboxBadge,
  badgeBitmap,
  badgeTooltip,
  drawBadge,
  speakAloud,
  voiceAsk,
  micMuted,
  openInbox,
  postToRelay,
  RELAY_CHANNEL,
  refreshRelayFeed,
  refreshTrayMenu,
  sendDeckState,
  debugLog = () => {},
} = {}) {
  // Decision-card plane (see decision-cards.cjs): the open queue drives the tray
  // label/tooltip and the deck badge.
  let openDecisions = [];
  // Cards a desk surface answered/dismissed that the 15 s watcher still lists:
  // every surface reads visibleDecisions(), so a push between the write and the
  // next poll does not bring them back (review #1). TTL-bound in decision-cards.
  const pendingRemovals = decisionCards.createPendingRemovals();
  const visibleDecisions = () => pendingRemovals.filter(openDecisions);
  let decisionWatchStop = null;

  /** Every place Windows reserves for a count, from ONE number: the tray icon
   *  (a drawn disc — the notification area), the console's taskbar button
   *  (overlay icon) and its Inbox tab, and the tooltip. Native toasts stay
   *  removed (owner decision 2026-08-31); a badge is a fact, a toast is noise. */
  let trayBaseIcon = null;
  function setTrayBaseIcon(icon) {
    trayBaseIcon = icon;
  }
  function badgedImage(base, count) {
    const { width, height } = base.getSize();
    const bmp = Buffer.from(base.toBitmap());
    drawBadge(bmp, width, height, count, { diameter: Math.round(Math.min(width, height) * 0.6) });
    return nativeImage.createFromBitmap(bmp, { width, height });
  }
  function refreshNotificationBadges(cards = openDecisions) {
    const waiting = decisionCards.actionableCount(cards);
    const tooltip = badgeTooltip(waiting, cards.length);
    const tray = getTray();
    if (tray) {
      tray.setToolTip(tooltip);
      if (trayBaseIcon) tray.setImage(badgedImage(trayBaseIcon, waiting));
    }
    setInboxBadge({
      count: waiting,
      image: waiting > 0
        ? nativeImage.createFromBitmap(badgeBitmap(waiting, 16), { width: 16, height: 16 })
        : null,
      tooltip,
    });
    // The dock (macOS) and Unity launcher draw their own numeral; on Windows the
    // overlay above IS the taskbar badge, and setBadgeCount would fight it.
    if (process.platform !== "win32") app.setBadgeCount?.(waiting);
  }

  /**
   * ONE answer to "how many are waiting".
   *
   * Measured on the owner's screen 2026-09-20: the tray said 20, the console rail
   * said 20, the Inbox pane's pill said "22 waiting" and the bell said 22 -- four
   * readings of one inbox, two values. `waiting` is what needs a decision
   * (decision-cards triage); `total` also counts the FYI cards. The tray and rail
   * used `waiting`, the pane and the bell used `total` under the word "waiting".
   * Every surface reads THIS now, so "waiting" means one thing.
   */
  function inboxCounts() {
    const visible = visibleDecisions();
    return {
      waiting: decisionCards.actionableCount(visible),
      total: visible.length,
    };
  }

  /** Push the open-count badge to the avatar window's floating beads. */
  function sendDecisionBadge() {
    const avatarWindow = getAvatarWindow();
    if (!avatarWindow || avatarWindow.isDestroyed()) return;
    avatarWindow.webContents.send("desk:event", {
      type: "decisions-changed",
      openCount: inboxCounts().waiting,
      totalCount: inboxCounts().total,
    });
  }

  /**
   * Ask a decision card aloud and apply the spoken reply: a number or an
   * option's words answers it, anything else steers the raising session. A card
   * answered by click while the question was out is left alone.
   */
  async function answerCardByVoice(card) {
    const { cardPrompt, matchReply } = require("./voice-card.cjs");
    let res;
    try {
      res = await voiceAsk.ask(cardPrompt(card), { timeoutMs: 90000 });
    } catch (error) {
      debugLog("voice card ask failed", error && error.message);
      return;
    }
    if (!res || !res.ok) return; // unanswered: the popup and the inbox still have it
    if (!openDecisions.some((c) => c && c.id === card.id)) {
      void speakAloud("That one was already answered.", undefined, undefined, "slot0", "service:awdesk-voice");
      return;
    }
    const reply = matchReply(card, res.answer);
    if (reply.kind === "answer") {
      const ok = decisionCards.answerCard(card.id, reply.key, "answered by voice");
      void speakAloud(ok ? `Answered: ${reply.label}.` : "I could not record that answer.", undefined, undefined, "slot0", "service:awdesk-voice");
    } else if (reply.kind === "steer") {
      const ok = decisionCards.steerCard(card.id, reply.text);
      void speakAloud(ok ? "Sent that to the session." : "I could not send that.", undefined, undefined, "slot0", "service:awdesk-voice");
    }
  }

  // Quiet mode (owner, 2026-09-23: cards "popping up on my main screen while im playing
  // games"): every path that interrupts -- a card popup, the console jumping forward,
  // speech -- asks quietMode first. Cards that arrive while quiet are HELD and summed up
  // once when the game ends; nothing is dropped.
  let heldWhileQuiet = 0;
  function holdWhileQuiet(n = 1) {
    heldWhileQuiet += n;
  }
  function inputPrefs() {
    try {
      const { load, resolveInput } = require("./cast-config.cjs");
      return resolveInput(load().snapshot);
    } catch {
      return {};
    }
  }
  const quietMode = require("./quiet-mode.cjs").createQuietMode({
    readPrefs: () => inputPrefs(),
    ownPids: () => {
      try { return app.getAppMetrics().map((m) => m.pid); } catch { return [process.pid]; }
    },
    onChange: (now, was) => {
      debugLog("quiet", now.quiet ? `ON (${now.reason})` : "off", was.quiet ? `(was: ${was.reason})` : "");
      if (getTray()) refreshTrayMenu();
      if (!now.quiet && was.quiet && heldWhileQuiet > 0) {
        const n = heldWhileQuiet;
        heldWhileQuiet = 0;
        // ONE line, never the popups it held: the owner just came back, not asked.
        void speakAloud(n === 1 ? "One decision came in while you were busy." : `${n} decisions came in while you were busy.`,
          undefined, undefined, "slot0", "service:awdesk-decisions");
      }
    },
    log: (...args) => debugLog(...args),
  });

  function toggleDoNotDisturb() {
    try {
      const { write } = require("./cast-config.cjs");
      const next = !inputPrefs().doNotDisturb;
      write((draft) => { draft.input = { ...(draft.input || {}), doNotDisturb: next }; return draft; });
      quietMode.state();
      refreshTrayMenu();
    } catch (error) {
      debugLog("toggleDoNotDisturb failed", error && error.message);
    }
  }

  // The LAST independent popup source folds in (owner, 2026-09-08: "I WANT TO
  // CONSOLIDATE AND DEDUPE"). A decision card had three unrelated homes -- awask's
  // own Tk window, the deck panel, and now the console's Cards pane -- and none of
  // them knew the others existed, so answering a card in one left it sitting open
  // in another. The ladder is now explicit and every rung is a surface that already
  // exists: the deck window if the Cards pane is DETACHED into it, otherwise the
  // console, and awask's popup only when neither is there to take it.
  function wireWindowRouter() {
    decisionCards.setWindowRouter((_kind, id) => {
      // A card asking to be SHOWN while a game is full-screen waits in the badge.
      if (quietMode.isQuiet()) { heldWhileQuiet += 1; return true; }
      return openInbox(id);
    });
  }

  // ---- Deck IPC: answer, steer, bulk -----------------------------------------
  function registerDeckIpc() {
    // The Decisions page's bulk bar: 298 cards cannot be triaged one click at a time.
    // ONE relay line per batch, not one per card (decisions-bulk.cjs builds it).
    // Each write is awaited to awask's exit (review #9) and hidden as pending
    // until the watcher confirms it; a refused one comes straight back (#1).
    const confirmedWrite = (id, write) => {
      pendingRemovals.add(id);
      return write().then((verdict) => {
        if (!verdict.ok) pendingRemovals.delete(id);
        return verdict;
      });
    };
    ipcMain.handle("desk:deck-bulk", async (_event, payload) => {
      const result = await require("./decisions-bulk.cjs").handleBulk(payload, {
        listOpen: () => visibleDecisions(),
        answerCard: (id, key, note) => confirmedWrite(id, () => decisionCards.answerCardConfirmed(id, key, note)),
        cancelCard: (id, note) => confirmedWrite(id, () => decisionCards.cancelCardConfirmed(id, note)),
      });
      sendDeckState();
      if (result && result.summary) void postToRelay(RELAY_CHANNEL, result.summary).then(() => refreshRelayFeed());
      return result;
    });
    ipcMain.handle("desk:deck-answer", async (_event, payload) => {
      const { id, choice } = payload || {};
      const ok = (await confirmedWrite(id, () => decisionCards.answerCardConfirmed(id, choice))).ok;
      if (ok) {
        sendDeckState();
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
  }

  /** Start quiet mode, then the card watcher (app.whenReady). */
  async function startDecisionWatch() {
    // Bridge the decision plane into the voice + proactive surface the desk
    // already has. A passive badge is why cards piled up unseen (owner,
    // 2026-09-21: "it doesnt prompt me, ask permission, give me anything to
    // click or respond to"). speakAloud + openInbox exist; wire them here.
    const announceDecisions = (list, isBacklog) => {
      if (quietMode.isQuiet()) {
        // Held, not dropped: the badge still counts them and the end of the game
        // gets ONE spoken line (quietMode onChange). No popup, no voice, no focus.
        heldWhileQuiet += list.length;
        return;
      }
      try {
        const lead = (list[isBacklog ? 0 : list.length - 1]) || {};
        const title = String(lead.title || "a decision").slice(0, 120);
        const n = list.length;
        const phrase = isBacklog
          ? (n === 1
              ? `You have one decision waiting: ${title}.`
              : `You have ${n} decisions waiting. The oldest is: ${title}.`)
          : (n === 1
              ? `A decision needs you: ${title}.`
              : `${n} decisions need you. The latest is: ${title}.`);
        // A NEW card is a spoken question the owner can answer out loud
        // (voice-card.cjs); a backlog, a muted mic or an ask already waiting
        // keeps the plain announcement. The popups below still open either way.
        if (!isBacklog && lead.id && !micMuted() && !voiceAsk.waiting) {
          void answerCardByVoice(lead);
        } else {
          try { void speakAloud(phrase, "nova", undefined, "slot0", "service:awdesk-decisions"); } catch { /* best-effort */ }
        }
        try {
          if (isBacklog) {
            openInbox();                          // backlog: ONE console, no 30-popup storm
          } else {
            const _cp = require("node:child_process"); // spawn the REAL topmost popup,
            for (const c of list.slice(0, 3)) {                // bypassing the deck router
              if (!c || !c.id) continue;
              try {
                _cp.spawn(require("./command-agent.cjs").resolveBin("python", "AWDESK_PYTHON_BIN"), ["-m", "awask.popup", String(c.id)], {
                  detached: true, stdio: "ignore",
                  // No forced AITHER_DECISIONS_POPUP=1: the owner's own off switches
                  // (.popup-off, the env var) and awask's quiet gate must apply here too.
                  env: { ...process.env },
                }).unref();
              } catch { /* best-effort */ }
            }
          }
        } catch { /* best-effort */ }
      } catch { /* a prompt must never crash the poll */ }
    };
    let decisionsAnnounced = null; // null until the first poll seeds the backlog
    quietMode.start();
    await quietMode.ready();
    decisionWatchStop = decisionCards.watch({
      onChange: (cards) => {
        pendingRemovals.reconcile(cards);
        openDecisions = cards;
        refreshTrayMenu();
        refreshNotificationBadges(visibleDecisions());
        sendDeckState();
        sendDecisionBadge();

        // Only cards actually WAITING on the owner (the badge predicate) are
        // spoken -- never info digests (the noise class of the removed toasts).
        let actionable;
        try {
          actionable = cards.filter((c) => decisionCards.triageCard(c) === "decision");
        } catch {
          return; // triage threw: keep the badge, never crash the poll
        }
        const ids = new Set(actionable.map((c) => c && c.id).filter(Boolean));
        if (decisionsAnnounced === null) {
          decisionsAnnounced = ids;                 // first poll: surface backlog ONCE
          if (actionable.length > 0) announceDecisions(actionable, true);
          return;
        }
        const fresh = actionable.filter((c) => c && !decisionsAnnounced.has(c.id));
        decisionsAnnounced = ids;
        if (fresh.length > 0) announceDecisions(fresh, false);
      },
    });
  }

  function stopDecisionWatch() {
    decisionWatchStop?.();
  }

  return {
    quietMode,
    inputPrefs,
    toggleDoNotDisturb,
    holdWhileQuiet,
    visibleDecisions,
    pendingRemovals,
    inboxCounts,
    refreshNotificationBadges,
    sendDecisionBadge,
    setTrayBaseIcon,
    wireWindowRouter,
    registerDeckIpc,
    startDecisionWatch,
    stopDecisionWatch,
  };
}

module.exports = { createDecisionsPlane };
