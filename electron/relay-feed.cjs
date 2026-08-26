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
const https = require("node:https");

const RELAY_URL = "https://127.0.0.1:8205";
const RELAY_CHANNEL = "#agents";
const HISTORY_LIMIT = 12;
const RELAY_NICK = "david";
// RELAY_NICK is the OWNER identity, derived server-side from
// fleet_trust.json by link_relay_identity.py. The relay's write paths
// (/v1/agent/join, /v1/channels/*/messages, thread replies) REQUIRE
// req.nick to equal the authenticated identity's name for a non-ACTA
// bearer -- a session alias like david+<sid> is refused there (403
// "Requested nick does not match authenticated identity", measured
// 2026-08-25). The awrelay CLI cannot reach an agent-only room at all,
// so posts go DIRECT to the HTTP API -- the same recipe the
// link_relay_identity.py proof uses.

// The AitherNet CA chain, same file the python services trust
// (lib/security/TLSConfig.py -> Library/Data/tls/ca-chain.pem).
function relayCa() {
  const candidates = [];
  if (process.env.AITHEROS_ROOT) {
    candidates.push(path.join(process.env.AITHEROS_ROOT, "Library", "Data", "tls", "ca-chain.pem"));
  }
  candidates.push(
    "C:\\AitherOS-Data\\Library\\Data\\tls\\ca-chain.pem",
    "C:\\AitherOS-Fresh\\AitherOS\\Library\\Data\\tls\\ca-chain.pem",
  );
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return { ca: fs.readFileSync(p) };
    } catch {}
  }
  return {};
}

function relayRequest(method, urlPath, body) {
  return new Promise((resolve) => {
    const token = bearer();
    if (!token) {
      resolve({ status: 0, body: "" });
      return;
    }
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        hostname: "127.0.0.1",
        port: 8205,
        path: urlPath,
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Content-Length": Buffer.byteLength(payload),
        },
        ...relayCa(),
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => resolve({ status: res.statusCode || 0, body: data }));
      },
    );
    req.on("error", () => resolve({ status: 0, body: "" }));
    req.end(payload);
  });
}

let joinState = "pending"; // "pending" | "joined" | "failed"
let joinPromise = null;
let joinedBearer = null;
function ensureJoined(requestFn = relayRequest) {
  // The bearer ROTATES on device-flow refresh: a new bearer is a new
  // identity and must join again. Compare before trusting the cache.
  if (joinState === "joined" && joinedBearer !== bearer()) {
    joinState = "pending";
    joinPromise = null;
  }
  if (joinPromise) return joinPromise;
  if (joinState === "joined") return Promise.resolve(true);
  joinState = "pending";
  joinPromise = (async () => {
    const r = await requestFn("POST", "/v1/agent/join", {
      nick: RELAY_NICK,
      channel: RELAY_CHANNEL,
    });
    const ok = r.status >= 200 && r.status < 300 && r.body.includes("is_agent");
    if (ok) joinedBearer = bearer();
    joinState = ok ? "joined" : "failed";
    if (!ok) joinPromise = null;
    return ok;
  })();
  return joinPromise;
}

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
 * Shape raw relay envelopes into deck rows. The relay's REAL envelope is
 * {id, channel, nick, content, timestamp, agent, thread_id, reply_count} —
 * measured live 2026-08-25; a parser built on a guessed shape (text/author/at)
 * returned [] from a healthy relay, which reads as "channel empty".
 * Text is required: a reaction/presence event with no body is noise in a
 * cockpit feed, not a message. [] on any failure — a cockpit section must
 * show "unavailable" rather than pretend the channel is empty
 * (security-review-patterns #5).
 */
function shapeRows(parsed, channel, limit) {
  const rows = Array.isArray(parsed) ? parsed : parsed?.messages;
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
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
      id: typeof row.id === "string" ? row.id : null,
      threadId: typeof row.thread_id === "string" ? row.thread_id : null,
      replyCount: Number(row.reply_count) || 0,
      agent: row.agent === true,
    });
  }
  return out.slice(0, limit);
}

/**
 * Recent messages in a channel, shaped for the deck: [{channel, author,
 * text, at, id, threadId, replyCount, agent}]. [] on any failure.
 */
async function fetchHistory(channel = RELAY_CHANNEL, limit = HISTORY_LIMIT, execFn = spawn) {
  const { code, stdout } = await runAwrelay(
    ["--json", "history", channel, "--limit", String(limit)],
    execFn,
  );
  if (code !== 0) return [];
  try {
    return shapeRows(JSON.parse(stdout), channel, limit);
  } catch {
    return [];
  }
}

/**
 * Every reply under one message — the per-avatar DIRECT chat view: a spawned
 * avatar slot is an agent, and the conversation with that agent is the thread
 * under its message (the relay has no per-agent channels; threads are the
 * direct-chat primitive the CLI exposes as `thread` / `thread-reply`).
 */
async function fetchThread(channel, messageId, execFn = spawn) {
  if (typeof messageId !== "string" || !messageId) return [];
  const { code, stdout } = await runAwrelay(
    ["--json", "thread", channel, messageId],
    execFn,
  );
  if (code !== 0) return [];
  try {
    return shapeRows(JSON.parse(stdout), channel, 200);
  } catch {
    return [];
  }
}

/** Post a message to a channel as the owner. False when the relay refused. */
async function post(channel = RELAY_CHANNEL, text, requestFn = relayRequest) {
  if (typeof text !== "string" || !text.trim()) return false;
  // Join first (lazy, once per bearer): #agents is agent-only and an
  // unjoined identity is silently 403'd.
  if (!(await ensureJoined(requestFn))) return false;
  const q = channel.replace("#", "%23");
  const r = await requestFn("POST", `/v1/channels/${q}/messages`, {
    channel,
    nick: RELAY_NICK,
    content: text.trim().slice(0, 1500),
  });
  return r.status >= 200 && r.status < 300;
}

/** Reply into a message's thread — the per-agent direct chat send path. */
async function postThreadReply(channel, messageId, text, requestFn = relayRequest) {
  if (typeof messageId !== "string" || !messageId) return false;
  if (typeof text !== "string" || !text.trim()) return false;
  if (!(await ensureJoined(requestFn))) return false;
  const q = channel.replace("#", "%23");
  const r = await requestFn("POST",
    `/v1/channels/${q}/messages/${encodeURIComponent(messageId)}/thread`,
    {
      channel,
      nick: RELAY_NICK,
      content: text.trim().slice(0, 1500),
    },
  );
  return r.status >= 200 && r.status < 300;
}

module.exports = {
  fetchHistory,
  fetchThread,
  post,
  postThreadReply,
  RELAY_URL,
  RELAY_CHANNEL,
};
