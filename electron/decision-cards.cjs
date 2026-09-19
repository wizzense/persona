"use strict";

/**
 * decision-cards — Desk's window onto the decision-card plane.
 *
 * Desk is the surface that is ALWAYS on the owner's screen, which makes it the
 * right carrier for "a card is waiting on you": tray badge, native notification,
 * and one click into the queue window. Until 2026-08-25 nothing joined the two —
 * cards piled up in ~/.aither/decisions while every Desk surface stayed silent.
 *
 * READ side: the store directory directly. Same box, plain JSON files, and a
 * directory-signature fast path so polling costs two stats, not a full parse.
 *
 * WRITE side: deliberately NOT here. Answering a card must also deliver the
 * answer into the raising session's steer mailbox; that logic lives in the awask
 * store and re-implementing it in JS would be a rival store that drifts
 * (the DCS001 class). Desk opens the queue window (`awask window`) and the
 * owner answers there — one implementation, every surface.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");

/**
 * The ABSOLUTE path to the awask binary, resolved once. Spawning a bare
 * "awask" inherits this process's PATH; an app launched from a context whose
 * PATH lacks the Python Scripts dir gets a shell that says "not recognized"
 * on a hidden console — and the spawn has already reported success, so an
 * answer that never ran reads as delivered (the silent no-op class). An
 * absolute path removes the PATH dependency; the close code reports the rest.
 */
let _awaskBin = null;
function awaskBin() {
  if (_awaskBin !== null) return _awaskBin;
  try {
    const where = process.platform === "win32" ? "where.exe" : "which";
    const out = execFileSync(where, ["awask"], { encoding: "utf8" });
    const first = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    _awaskBin = first || "awask";
  } catch {
    _awaskBin = "awask";
  }
  return _awaskBin;
}

function storeDir() {
  const env = (process.env.AITHER_DECISIONS_DIR || "").trim();
  return env || path.join(os.homedir(), ".aither", "decisions");
}

function isCardFile(name) {
  return name.startsWith("d-") && name.endsWith(".json");
}

/**
 * Cheap change token: "count:newestMtimeNs:totalBytes". Mirrors
 * awask.store.DecisionStore.signature() — the two must agree that "changed"
 * means a file was written, created or removed. An unreadable directory yields
 * a token no real directory produces, so the caller re-lists rather than
 * treating silence as "no change".
 */
function signature(dir = storeDir()) {
  let count = 0;
  let newest = 0n;
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return "unreadable";
  }
  for (const name of entries) {
    if (!isCardFile(name)) continue;
    let info;
    try {
      info = fs.statSync(path.join(dir, name), { bigint: true });
    } catch {
      continue;
    }
    count += 1;
    total += Number(info.size);
    if (info.mtimeNs > newest) newest = info.mtimeNs;
  }
  return `${count}:${newest}:${total}`;
}

/** One stored card → the shape every desk surface reads, or null when it is not an open card. */
function cardFromRaw(raw) {
if (!raw || typeof raw !== "object" || raw.status !== "open") return null;
if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  const source = raw.source && typeof raw.source === "object" ? raw.source : {};
  // The card's OWN answer choices, so a desk surface can offer exactly what
  // the raiser defined (a waiting notice is ack/later; a product decision may
  // be three options) instead of hardcoding buttons that do not exist on the
  // card. `defaultKey` is the raiser's "I recommend this one" hint.
  const options = Array.isArray(raw.options)
    ? raw.options
        .filter((o) => o && typeof o === "object" && typeof o.key === "string")
        .map((o) => ({
          key: o.key,
          label: typeof o.label === "string" ? o.label : o.key,
          recommended: Boolean(o.recommended),
        }))
    : [];
  return {
    id: raw.id,
    title: typeof raw.title === "string" ? raw.title : "Decision needed",
    summary: typeof raw.summary === "string" ? raw.summary : "",
    kind: typeof raw.kind === "string" ? raw.kind : "decision",
    urgency: typeof raw.urgency === "string" ? raw.urgency : "normal",
    createdAt: Number(raw.created_at) || 0,
    options,
    defaultKey: typeof raw.default_key === "string" ? raw.default_key : "",
    // WHERE the ask came from — a toast with no identity is noise the owner
    // cannot act on when a dozen sessions are open (owner report 2026-08-25).
    tab: typeof source.tab_title === "string" ? source.tab_title : "",
    cwd: typeof source.cwd === "string" ? source.cwd : "",
    agent: typeof source.agent === "string" ? source.agent : "",
  };
}

/** Open cards, oldest first — the one blocking longest is the one to surface. */
function listOpen(dir = storeDir()) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const cards = [];
  for (const name of entries) {
    if (!isCardFile(name)) continue;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    } catch {
      continue; // a half-written card must not take the list down
    }
    const card = cardFromRaw(raw);
    if (card) cards.push(card);
  }
  cards.sort((a, b) => a.createdAt - b.createdAt);
  return cards;
}

/**
 * Classify a card as DECISION or CONTEXT using triage rules.
 *
 * DECISION: has options, has a deadline, or is credential/blocked kind.
 * CONTEXT: info-only (status updates, hourly digests, etc).
 *
 * Returns "decision" or "context".
 */
// What the daemon's /decisions/triage-patterns says when it cannot be asked.
// The early `return "decision"` that stood here counted EVERY card while the
// daemon was down or the caller passed no patterns (main.cjs's bell does) --
// i.e. "3 decisions waiting" was one ask and two facts again, the exact noise
// the bell was rebuilt to stop (measured 2026-09-08 by the actionableCount test).
const DEFAULT_TRIAGE_PATTERNS = Object.freeze({
  decision_kinds: ["credential", "blocked"],
  context_phrases: [],
});

function triageCard(card, patterns) {
  if (!patterns || typeof patterns !== "object") patterns = DEFAULT_TRIAGE_PATTERNS;

  const kind = (card.kind || "decision").toLowerCase();
  const options = Array.isArray(card.options) ? card.options : [];
  const hasDeadline = card.deadline !== null && card.deadline !== undefined;

  // Credentials and blocked cards are always decisions.
  if (patterns.decision_kinds && patterns.decision_kinds.includes(kind)) {
    return "decision";
  }

  // Has a future deadline? Decision.
  if (hasDeadline && card.deadline > Date.now() / 1000) {
    return "decision";
  }

  // Has actionable options? Decision.
  if (options.length > 0) {
    // Check if all options are status-only phrases (not actionable).
    const actionable = options.filter((o) => {
      const label = o.label || "";
      // Check against each status-only pattern.
      if (patterns.context_phrases) {
        for (const pattern of patterns.context_phrases) {
          try {
            const re = new RegExp(pattern, "i");
            if (re.test(label)) {
              return false; // status-only
            }
          } catch {
            // bad regex, skip
          }
        }
      }
      return true; // actionable
    });
    if (actionable.length > 0) {
      return "decision";
    }
  }

  // No options, no deadline, not credential/blocked. Info-only.
  return "context";
}

/**
 * How many of these cards are actually WAITING on the owner — i.e., DECISIONS.
 * Using triage classification to filter out context/info cards.
 * The tray bell counts decisions only, not digests or status updates.
 */
function actionableCount(cards, patterns) {
  return cards.filter((c) => triageCard(c, patterns) === "decision").length;
}

/**
 * Run an awask CLI subcommand detached and windowless (never blocks the app,
 * nothing flashes — the gate-1t class). Injectable spawnFn for tests.
 * awask is the single WRITE implementation of the card plane (store + steer
 * mailbox delivery); spawning it keeps Desk a read-only consumer, so the
 * two can never become rival stores (the DCS001 class).
 */
function runAwask(args, spawnFn = spawn) {
  try {
    const child = spawnFn(awaskBin(), args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Where a card surface should OPEN.
 *
 * Owner, 2026-09-08, on being shown the console: "I WANT TO CONSOLIDATE AND DEDUPE".
 * The awask Tk window was the last independent popup source on this box -- a third
 * place decision cards could appear, alongside the deck panel and the console's
 * Cards pane, none of which knew about the others. So these two functions no longer
 * decide; they ASK. main.cjs installs a router that lands the card in the console,
 * and only if the router declines (no console, or it failed) does the Tk window
 * spawn. Nothing is removed: the popup is still the fallback and still what awask
 * itself opens for other sessions.
 */
let windowRouter = null;

/** @param fn (kind: "queue"|"card", id: string|null) => boolean -- true = handled. */
function setWindowRouter(fn) {
  windowRouter = typeof fn === "function" ? fn : null;
}

function routed(kind, id) {
  if (!windowRouter) return false;
  try {
    return windowRouter(kind, id) === true;
  } catch {
    // A throwing router must not swallow the card: fall through to the popup,
    // which is the whole reason the fallback was kept.
    return false;
  }
}

/**
 * Open the shared queue. The console's Cards pane first; the detached Tk window
 * only if nothing hosted it. Detached so Desk never holds the window's lifetime,
 * windowless spawn so nothing flashes (the gate-1t class).
 */
function openQueueWindow() {
  if (routed("queue", null)) return true;
  return runAwask(["window"]);
}

/** Open ONE card. Same ladder: the console's Cards pane, else that card's own Tk
 *  pop-out (the flipper's "Pop out" button, one card at a time). */
function openCardWindow(id) {
  if (typeof id !== "string" || id.length === 0) return false;
  if (routed("card", id)) return true;
  return runAwask(["window", id]);
}

/**
 * Answer a card from a desk surface. `choice` is the card's OWN option key
 * (listOpen carries options for exactly this), and the awask store delivers
 * the answer into the raising session's steer mailbox — never re-implemented
 * here, so a desk button and the popup window are one implementation.
 */
function answerCard(id, choice, note = "", spawnFn = spawn) {
  if (typeof id !== "string" || id.length === 0) return false;
  if (typeof choice !== "string" || choice.length === 0) return false;
  const args = ["answer", id, choice, "--via", "desk"];
  if (note) args.push("--note", String(note).slice(0, 2000));
  return runAwask(args, spawnFn);
}

/**
 * Withdraw a card from a desk surface (the "this is not now" path for cards
 * whose own options do not include a defer choice). The awask store cancels
 * it AND notifies the raising session, so the agent stops waiting.
 */
function cancelCard(id, note = "", spawnFn = spawn) {
  if (typeof id !== "string" || id.length === 0) return false;
  const args = ["cancel", id, "--note", String(note || "").slice(0, 2000)];
  return runAwask(args, spawnFn);
}

/**
 * STEER a card: send the raising session a work order instead of picking one of
 * its options. This is the verb that turns a card from a multiple-choice quiz
 * into a conversation -- "none of these; do X instead" -- and until 2026-09-08
 * the deck could answer and cancel but not steer, so every card whose right
 * answer was not on the card had to be retyped in a terminal (integration-map
 * gap 3). Same doctrine as answer/cancel: awask is the single WRITE
 * implementation, Desk stays a read-only consumer of the store.
 */
function steerCard(id, text, spawnFn = spawn) {
  if (typeof id !== "string" || id.length === 0) return false;
  const body = String(text || "").trim();
  if (!body) return false;
  // `awask steer <id> <text...>` -- the text is positional and variadic; pass it
  // as ONE argv element so a sentence is not re-split into flags.
  return runAwask(["steer", id, body.slice(0, 2000), "--via", "desk"], spawnFn);
}

/**
 * The store, read WITHOUT blocking the event loop.
 *
 * Answered cards are never removed from the directory: measured 2026-09-18 it
 * held 2,788 files, the 15 s watcher `statSync`ed every one (903 ms of blocked
 * main process per 25 s, scripts/main-profile.cjs) and every change -- and every
 * /decisions request -- `readFileSync`ed and parsed all of them (1.4-3.6 s
 * blocks on /health.stage.mainLag; the perf gate's first MCP call was reset).
 *
 * `scanAsync` stats in bounded batches and re-reads ONLY files whose
 * (mtimeNs, size) moved; `cache` carries the parsed result between scans.
 * Returns the same signature token as `signature()` plus the open cards.
 */
async function scanAsync(dir = storeDir(), cache = new Map(), fsp = fs.promises, batch = 64) {
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return { signature: "unreadable", cards: [] };
  }
  const names = entries.filter(isCardFile);
  let count = 0;
  let newest = 0n;
  let total = 0;
  const seen = new Set();
  for (let i = 0; i < names.length; i += batch) {
    await Promise.all(
      names.slice(i, i + batch).map(async (name) => {
        let info;
        try {
          info = await fsp.stat(path.join(dir, name), { bigint: true });
        } catch {
          return;
        }
        count += 1;
        total += Number(info.size);
        if (info.mtimeNs > newest) newest = info.mtimeNs;
        seen.add(name);
        const stamp = `${info.mtimeNs}:${info.size}`;
        const hit = cache.get(name);
        if (hit && hit.stamp === stamp) return;
        let card;
        try {
          card = cardFromRaw(JSON.parse(await fsp.readFile(path.join(dir, name), "utf8")));
        } catch {
          return; // half-written: leave it uncached so the next scan retries
        }
        cache.set(name, { stamp, card });
      }),
    );
  }
  for (const name of [...cache.keys()]) if (!seen.has(name)) cache.delete(name);
  const cards = [...cache.values()].map((v) => v.card).filter(Boolean);
  cards.sort((a, b) => a.createdAt - b.createdAt);
  return { signature: `${count}:${newest}:${total}`, cards };
}

// What the watcher last saw -- the answer for synchronous readers (the bridge's
// /decisions, the deck state) that must not walk the store themselves.
let lastOpenCards = null;
function lastOpen(dir = storeDir()) {
  return lastOpenCards ?? listOpen(dir);
}

/**
 * Poll the store; call onChange(cards) whenever the signature moves (and once at
 * start). Injectable timers/dir for tests. Returns a stop function.
 */
function watch({ intervalMs = 15000, onChange, dir = storeDir(), setIntervalFn = setInterval, clearIntervalFn = clearInterval, scanFn = scanAsync } = {}) {
  if (typeof onChange !== "function") throw new TypeError("watch requires onChange");
  let lastSig = null;
  let running = false;
  const cache = new Map();
  const poll = async () => {
    if (running) return; // a slow disk must not stack scans
    running = true;
    try {
      const { signature: sig, cards } = await scanFn(dir, cache);
      if (dir === storeDir()) lastOpenCards = cards;
      if (sig === lastSig) return;
      lastSig = sig;
      try {
        onChange(cards);
      } catch {
        /* a bad consumer must not kill the watcher */
      }
    } finally {
      running = false;
    }
  };
  void poll();
  const handle = setIntervalFn(() => poll(), intervalMs);
  return () => clearIntervalFn(handle);
}

module.exports = {
  storeDir,
  signature,
  listOpen,
  lastOpen,
  scanAsync,
  cardFromRaw,
  triageCard,
  actionableCount,
  setWindowRouter,
  openQueueWindow,
  openCardWindow,
  answerCard,
  cancelCard,
  steerCard,
  watch,
};
