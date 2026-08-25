"use strict";

/**
 * relay-feed — the Desk panel's window onto AitherRelay (#agents).
 *
 * The owner asked 2026-08-25: "why would awask + awdesk not be integrated into
 * awrelay". The desk is the cockpit that is ALWAYS on screen, and the relay
 * channels are where the sessions coordinate — a cockpit that cannot see the
 * coordination channel is a window onto half the fleet. This joins the two the
 * same way decision-cards.cjs joins the card plane: READ via the awrelay CLI,
 * WRITE via the same CLI, never a second implementation of the relay protocol
 * (one transport, one identity story).
 *
 * Identity comes from ~/.aither/session-bearer (the device-flow token the
 * owner's other surfaces already use) and the endpoint is pinned to the local
 * relay rather than whatever env happens to leak into the process. A missing
 * bearer or a down relay yields [] / false — the desk renders "relay
 * unavailable", never a half-truth.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");

const RELAY_URL = "https://127.0.0.1:8205";
const RELAY_CHANNEL = "#agents";
const HISTORY_LIMIT = 12;

function bearer() {
  try {
    return fs.readFileSync(path.join(os.homedir(), ".aither", "session-bearer"), "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * The ABSOLUTE path to the awrelay binary, resolved once. Spawning a bare
 * "awrelay" inherits this process's PATH, and an app launched from a context
 * whose PATH lacks the Python Scripts dir gets ENOENT — which reads as "the
 * relay is empty" ([], no error anywhere). An absolute path cannot drift.
 */
let _awrelayBin = null;
function awrelayBin() {
  if (_awrelayBin !== null) return _awrelayBin;
  try {
    const where = process.platform === "win32" ? "where.exe" : "which";
    const out = execFileSync(where, ["awrelay"], { encoding: "utf8" });
    const first = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    _awrelayBin = first || "awrelay";
  } catch {
    _awrelayBin = "awrelay"; // last resort; the close code reports the failure
  }
  return _awrelayBin;
}

/** Run the awrelay CLI detached + windowless; resolve({code, stdout}). */
function runAwrelay(args, execFn = spawn) {
  return new Promise((resolve) => {
    // Global flags must come BEFORE the subcommand: a --token appended after
    // `history` is parsed as a history option and refused ("unrecognized
    // arguments") — measured live 2026-08-25, the deck then rendered the
    // healthy relay as empty.
    const token = bearer();
    const fullArgs = ["--url", RELAY_URL];
    if (token) fullArgs.push("--token", token);
    fullArgs.push(...args);
    let stdout = "";
    let child;
    try {
      child = execFn(awrelayBin(), fullArgs, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve({ code: 2, stdout: "" });
      return;
    }
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.on("error", () => resolve({ code: 2, stdout }));
    child.on("close", (code) => resolve({ code: code ?? 2, stdout }));
  });
}

/**
 * Recent #agents messages, shaped for the deck: [{channel, author, text, at}].
 * [] on any failure — a cockpit section must show "unavailable" rather than
 * pretend the channel is empty (security-review-patterns #5).
 */
async function fetchHistory(channel = RELAY_CHANNEL, limit = HISTORY_LIMIT, execFn = spawn) {
  const { code, stdout } = await runAwrelay(
    ["--json", "history", channel, "--limit", String(limit)],
    execFn,
  );
  if (code !== 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : parsed?.messages;
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    // The relay's REAL envelope: {channel, nick, content, timestamp}. Measured
    // live 2026-08-25 — a parser built on a guessed shape (text/author/at)
    // returned [] from a healthy relay, which reads as "channel empty".
    const text = typeof row.content === "string" ? row.content
      : typeof row.text === "string" ? row.text : "";
    const author = typeof row.nick === "string" && row.nick ? row.nick
      : typeof row.author === "string" ? row.author : "";
    // Text is required: a reaction/presence event with no body is noise in a
    // cockpit feed, not a message.
    if (!text) continue;
    let at;
    if (typeof row.timestamp === "string") {
      at = Math.floor(Date.parse(row.timestamp) / 1000) || 0;
    } else {
      at = Number(row.at || row.created_at || row.ts) || 0;
    }
    out.push({
      channel: typeof row.channel === "string" ? row.channel : channel,
      author,
      text: text.slice(0, 500),
      at,
    });
  }
  return out.slice(0, limit);
}

/** Post a message to #agents as the owner. False when the relay refused. */
async function post(channel = RELAY_CHANNEL, text, execFn = spawn) {
  if (typeof text !== "string" || !text.trim()) return false;
  const { code } = await runAwrelay(["send", channel, text.trim().slice(0, 1500)], execFn);
  return code === 0;
}

module.exports = { fetchHistory, post, RELAY_URL, RELAY_CHANNEL };
