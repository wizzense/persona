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
    if (!raw || typeof raw !== "object" || raw.status !== "open") continue;
    if (typeof raw.id !== "string" || raw.id.length === 0) continue;
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
    cards.push({
      id: raw.id,
      title: typeof raw.title === "string" ? raw.title : "Decision needed",
      summary: typeof raw.summary === "string" ? raw.summary : "",
      urgency: typeof raw.urgency === "string" ? raw.urgency : "normal",
      createdAt: Number(raw.created_at) || 0,
      options,
      defaultKey: typeof raw.default_key === "string" ? raw.default_key : "",
      // WHERE the ask came from — a toast with no identity is noise the owner
      // cannot act on when a dozen sessions are open (owner report 2026-08-25).
      tab: typeof source.tab_title === "string" ? source.tab_title : "",
      cwd: typeof source.cwd === "string" ? source.cwd : "",
      agent: typeof source.agent === "string" ? source.agent : "",
    });
  }
  cards.sort((a, b) => a.createdAt - b.createdAt);
  return cards;
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
 * Open the shared queue window. Detached so Desk never holds the window's
 * lifetime, windowless spawn so nothing flashes (the gate-1t class).
 */
function openQueueWindow() {
  return runAwask(["window"]);
}

/** Open ONE card's own pop-out answer window (the flipper's "Pop out" button —
 *  the Tk surface stays reachable FROM the deck, one card at a time). */
function openCardWindow(id) {
  if (typeof id !== "string" || id.length === 0) return false;
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
 * Poll the store; call onChange(cards) whenever the signature moves (and once at
 * start). Injectable timers/dir for tests. Returns a stop function.
 */
function watch({ intervalMs = 15000, onChange, dir = storeDir(), setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
  if (typeof onChange !== "function") throw new TypeError("watch requires onChange");
  let lastSig = null;
  const poll = () => {
    const sig = signature(dir);
    if (sig === lastSig) return;
    lastSig = sig;
    let cards;
    try {
      cards = listOpen(dir);
    } catch {
      cards = [];
    }
    try {
      onChange(cards);
    } catch {
      /* a bad consumer must not kill the watcher */
    }
  };
  poll();
  const handle = setIntervalFn(poll, intervalMs);
  return () => clearIntervalFn(handle);
}

module.exports = {
  storeDir,
  signature,
  listOpen,
  openQueueWindow,
  openCardWindow,
  answerCard,
  cancelCard,
  watch,
};
