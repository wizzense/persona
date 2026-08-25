"use strict";

/**
 * decision-cards — Persona's window onto the decision-card plane.
 *
 * Persona is the surface that is ALWAYS on the owner's screen, which makes it the
 * right carrier for "a card is waiting on you": tray badge, native notification,
 * and one click into the queue window. Until 2026-08-25 nothing joined the two —
 * cards piled up in ~/.aither/decisions while every Persona surface stayed silent.
 *
 * READ side: the store directory directly. Same box, plain JSON files, and a
 * directory-signature fast path so polling costs two stats, not a full parse.
 *
 * WRITE side: deliberately NOT here. Answering a card must also deliver the
 * answer into the raising session's steer mailbox; that logic lives in the awask
 * store and re-implementing it in JS would be a rival store that drifts
 * (the DCS001 class). Persona opens the queue window (`awask window`) and the
 * owner answers there — one implementation, every surface.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

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
    cards.push({
      id: raw.id,
      title: typeof raw.title === "string" ? raw.title : "Decision needed",
      summary: typeof raw.summary === "string" ? raw.summary : "",
      urgency: typeof raw.urgency === "string" ? raw.urgency : "normal",
      createdAt: Number(raw.created_at) || 0,
    });
  }
  cards.sort((a, b) => a.createdAt - b.createdAt);
  return cards;
}

/**
 * Open the shared queue window. Detached so Persona never holds the window's
 * lifetime, windowless spawn so nothing flashes (the gate-1t class).
 */
function openQueueWindow() {
  try {
    const child = spawn("awask", ["window"], {
      detached: true,
      stdio: "ignore",
      shell: process.platform === "win32", // awask is a pip console script (.exe shim)
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
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

module.exports = { storeDir, signature, listOpen, openQueueWindow, watch };
