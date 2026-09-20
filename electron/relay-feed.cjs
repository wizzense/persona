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
 *
 * DOORS (2026-09-18). The relay's write path for #agents sits behind the
 * `channel:#agents` door: a plain POST answers 403 "#agents is behind the
 * channel:#agents door. Knock at /doors/knock, present your evidence at
 * /doors/present, then send with X-Door-Attestation". Reads (history,
 * thread) are NOT door-gated. This module is a CLIENT of that protocol — it
 * adds no privilege, it presents the evidence the server already demands:
 *
 *   1. POST {gateway}/doors/knock   {door:"channel:#agents"}      -> describe
 *   2. POST {gateway}/doors/present {door, attestation:<humanity>} -> {attestation, expires_at}
 *   3. relay write carries header  X-Door-Attestation: <attestation>
 *
 * The door attestation is cached PER BEARER and discarded when the bearer
 * rotates, when expires_at passes, or when the relay answers 403-door anyway
 * (then it is re-presented once and the write retried once — never a loop).
 * The relay is the authority on whether a door exists: a channel is written
 * plainly until the relay says "door", after which every write to it presents
 * first. A stale "the door is gone" memory would otherwise keep the desk dead.
 *
 * The HUMANITY attestation (what is presented at the door) is the owner's own
 * Identity `/auth/me` -> metadata.humanity_attestation, saved to
 * ~/.aither/humanity-attestation (mode 600, the value only). The source is
 * injectable (setHumanityAttestationSource); the default reads that file and
 * yields "" when it is absent. Detail strings name the failing rung exactly
 * so the cockpit says which step to fix, not a flat "refused".
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const http = require("node:http");
const https = require("node:https");

const RELAY_URL = "https://127.0.0.1:8205";
const RELAY_CHANNEL = "#agents";
const HISTORY_LIMIT = 12;
const RELAY_NICK = "david";
// The door protocol is served by genesis THROUGH the MCP gateway (rung 1 of
// the dispatch ladder — genesis publishes no host port). Today the gateway
// answers 404 for /doors/*; when the passthrough goes live it is these paths.
const GATEWAY_URL = "http://127.0.0.1:8182";
const DOOR_KNOCK_URL = `${GATEWAY_URL}/doors/knock`;
const DOOR_PRESENT_URL = `${GATEWAY_URL}/doors/present`;
const DOOR_HEADER = "X-Door-Attestation";
const HUMANITY_ATTESTATION_FILE = path.join(os.homedir(), ".aither", "humanity-attestation");
const DETAIL_DOORS_NOT_LIVE = "doors passthrough not live on the gateway (HTTP 404)";
const DETAIL_NO_HUMANITY = "no humanity attestation on this machine -- take the humanity "
  + "check once (Identity /auth/me/verify-humanity) and save it to ~/.aither/humanity-attestation";
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
const { internalCaOptions: relayCa } = require("./internal-ca.cjs");

/**
 * One JSON request as the owner. `urlPath` is relay-relative ("/v1/...") or
 * an absolute URL (the gateway's door endpoints); `headers` are extra request
 * headers (the door attestation). The injectable requestFn in post() /
 * postThreadReply() has this same (method, urlPath, body, {headers}) shape.
 */
function relayRequest(method, urlPath, body, { headers = {} } = {}) {
  return new Promise((resolve) => {
    const token = bearer();
    if (!token) {
      resolve({ status: 0, body: "" });
      return;
    }
    const payload = JSON.stringify(body);
    let target;
    if (/^https?:\/\//i.test(urlPath)) {
      const u = new URL(urlPath);
      target = {
        client: u.protocol === "https:" ? https : http,
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        tls: u.protocol === "https:" ? relayCa() : {},
      };
    } else {
      target = { client: https, hostname: "127.0.0.1", port: 8205, path: urlPath, tls: relayCa() };
    }
    const req = target.client.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.path,
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Content-Length": Buffer.byteLength(payload),
          ...headers,
        },
        ...target.tls,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => resolve({ status: res.statusCode || 0, body: data }));
      },
    );
    req.on("error", () => resolve({ status: 0, body: "" }));
    // A hard timeout: the relay's RBAC can stall on Identity resolution
    // (measured 2.5s, the relay instrumentation) and a hung socket otherwise
    // eats the user's message with no answer at all.
    req.setTimeout(15000, () => req.destroy(new Error("relay request timed out")));
    req.end(payload);
  });
}

/** The relay's refusal REASON, extracted from its JSON body when present. */
function refusalDetail(body, max = 160) {
  if (typeof body !== "string" || !body) return "";
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed.detail === "string" && parsed.detail) {
      return parsed.detail.slice(0, max);
    }
    if (parsed && typeof parsed.message === "string" && parsed.message) {
      return parsed.message.slice(0, max);
    }
  } catch {
    // not JSON — the raw body is the message
  }
  return body.slice(0, max);
}

let joinState = "pending"; // "pending" | "joined" | "failed"
let joinPromise = null;
let joinedBearer = null;
let lastJoinDetail = ""; // the relay's OWN refusal reason from the last join
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
    if (!ok) {
      lastJoinDetail = r.status === 0
        ? "the relay did not answer (it may be restarting)"
        : `join refused: HTTP ${r.status}${refusalDetail(r.body) ? ` — ${refusalDetail(r.body)}` : ""}`;
      joinPromise = null;
    }
    return ok;
  })();
  return joinPromise;
}

let bearerSource = null; // test-only override; null = the session-bearer file
function bearer() {
  if (bearerSource) {
    try { return String(bearerSource() || ""); } catch { return ""; }
  }
  try {
    return fs.readFileSync(path.join(os.homedir(), ".aither", "session-bearer"), "utf8").trim();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// The door plane (see the module header).
// ---------------------------------------------------------------------------

/** Default humanity source: the VALUE saved at ~/.aither/humanity-attestation. */
function fileHumanityAttestation() {
  try {
    return fs.readFileSync(HUMANITY_ATTESTATION_FILE, "utf8").trim();
  } catch {
    return "";
  }
}
let humanitySource = fileHumanityAttestation;
/** Inject where the humanity attestation comes from (a () => string). */
function setHumanityAttestationSource(fn) {
  humanitySource = typeof fn === "function" ? fn : fileHumanityAttestation;
}
function humanityAttestation() {
  try {
    const v = humanitySource();
    return typeof v === "string" ? v.trim() : "";
  } catch {
    return "";
  }
}

function doorFor(channel) {
  return `channel:${channel}`;
}

/** expires_at as epoch ms: ISO string, epoch seconds, or epoch ms. null = none given. */
function parseExpiry(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string" && value) {
    const n = Number(value);
    if (Number.isFinite(n)) return parseExpiry(n);
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

// door -> {bearer, attestation, expiresAtMs}. One entry per door, per bearer.
const doorAttestations = new Map();
// door -> in-flight present, so two racing writes present once.
const doorPresenting = new Map();
// doors the relay has TOLD us exist (a 403-door answer). Written plainly
// until then — the relay, not a memory, decides whether a door is there.
const knownDoors = new Set();

function cachedAttestation(door) {
  const c = doorAttestations.get(door);
  if (!c) return "";
  if (c.bearer !== bearer()) { doorAttestations.delete(door); return ""; }
  // 5 s of skew: an attestation about to lapse would be refused mid-flight.
  if (c.expiresAtMs !== null && Date.now() >= c.expiresAtMs - 5000) {
    doorAttestations.delete(door);
    return "";
  }
  return c.attestation;
}

function discardAttestation(door) {
  doorAttestations.delete(door);
}

/**
 * Knock, then present the humanity attestation; cache and return the door
 * attestation. {ok, attestation, detail} — detail names the rung that failed.
 */
function ensureDoorAttestation(door, requestFn = relayRequest) {
  const cached = cachedAttestation(door);
  if (cached) return Promise.resolve({ ok: true, attestation: cached, detail: "" });
  if (doorPresenting.has(door)) return doorPresenting.get(door);
  const token = bearer();
  const p = (async () => {
    const knock = await requestFn("POST", DOOR_KNOCK_URL, { door });
    if (knock.status === 404) return { ok: false, attestation: "", detail: DETAIL_DOORS_NOT_LIVE };
    if (knock.status === 0) {
      return { ok: false, attestation: "", detail: "the gateway did not answer the door knock (is aitheros-mcpgateway up?)" };
    }
    if (knock.status < 200 || knock.status >= 300) {
      return {
        ok: false,
        attestation: "",
        detail: `door knock refused: HTTP ${knock.status}${refusalDetail(knock.body) ? ` — ${refusalDetail(knock.body)}` : ""}`,
      };
    }
    const humanity = humanityAttestation();
    if (!humanity) return { ok: false, attestation: "", detail: DETAIL_NO_HUMANITY };
    const present = await requestFn("POST", DOOR_PRESENT_URL, { door, attestation: humanity });
    if (present.status === 404) return { ok: false, attestation: "", detail: DETAIL_DOORS_NOT_LIVE };
    if (present.status === 0) {
      return { ok: false, attestation: "", detail: "the gateway did not answer the door present (is aitheros-mcpgateway up?)" };
    }
    if (present.status < 200 || present.status >= 300) {
      const why = refusalDetail(present.body) || `HTTP ${present.status}`;
      return { ok: false, attestation: "", detail: `door refused: ${why}` };
    }
    let parsed;
    try { parsed = JSON.parse(present.body); } catch { parsed = null; }
    if (parsed && parsed.admitted === false) {
      const why = refusalDetail(present.body) || "not admitted";
      return { ok: false, attestation: "", detail: `door refused: ${why}` };
    }
    const attestation = parsed && typeof parsed.attestation === "string" ? parsed.attestation : "";
    if (!attestation) {
      return { ok: false, attestation: "", detail: "door present answered without an attestation" };
    }
    doorAttestations.set(door, {
      bearer: token,
      attestation,
      expiresAtMs: parseExpiry(parsed.expires_at),
    });
    return { ok: true, attestation, detail: "" };
  })().finally(() => doorPresenting.delete(door));
  doorPresenting.set(door, p);
  return p;
}

/** A relay 403 whose reason names the door — the cue to (re)present. */
function isDoorRefusal(r) {
  return r.status === 403 && /\bdoor\b/i.test(refusalDetail(r.body, 4000));
}

/**
 * The id the relay assigned to the record it just stored.
 *
 * 🚩 MEASURED in AitherRelay.py 2026-09-19, because a guess here is what made
 * loop protection dead code: a message POST answers
 * `{"success":true,"message":{…model_dump()}}` (AitherRelay.py:8586 ff) and a
 * thread reply answers `{"success":true,"reply":{…},"thread_info":{…}}`
 * (9494 ff). NEITHER carries the id at the top level, so `result.body.id` —
 * the only thing noteOursToRoom could read before — was always undefined and
 * the desk's own posts came back on the next poll as somebody else's words.
 * `message_id` is accepted too: the forge-dispatch branch answers with that.
 */
function storedMessageId(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  const candidates = [
    parsed.id,
    parsed.message_id,
    parsed.message && typeof parsed.message === "object" ? parsed.message.id : null,
    parsed.reply && typeof parsed.reply === "object" ? parsed.reply.id : null,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c) return c;
  }
  return null;
}

/**
 * One relay write with the door protocol around it. The write goes plainly
 * unless the relay has already told us this channel has a door; a 403-door
 * answer discards any cached attestation, presents once, and retries once.
 *
 * On 2xx the verdict CARRIES the relay's record: {ok, detail, id, body}. The
 * id is the whole point — it is the only thing that identifies what THIS desk
 * wrote (we post under the owner's own nick, so nick-based self-detection
 * silences the owner instead, measured 2026-09-19). `ok` and `detail` keep
 * their exact old meaning: main.cjs and relay-poller.cjs read only those two.
 */
async function doorGatedWrite(channel, urlPath, payload, requestFn) {
  const door = doorFor(channel);
  const sendOnce = async (headers) => {
    let r = await requestFn("POST", urlPath, payload, { headers });
    if (r.status === 0) {
      // one transient transport blip (TLS reset, restart window), never a loop
      await new Promise((resolve) => setTimeout(resolve, 250));
      r = await requestFn("POST", urlPath, payload, { headers });
    }
    return r;
  };
  let headers = {};
  if (knownDoors.has(door)) {
    const a = await ensureDoorAttestation(door, requestFn);
    if (!a.ok) return { ok: false, detail: a.detail };
    headers = { [DOOR_HEADER]: a.attestation };
  }
  let r = await sendOnce(headers);
  if (isDoorRefusal(r)) {
    knownDoors.add(door);
    discardAttestation(door);
    const a = await ensureDoorAttestation(door, requestFn);
    if (!a.ok) return { ok: false, detail: a.detail };
    r = await sendOnce({ [DOOR_HEADER]: a.attestation });
  }
  if (r.status >= 200 && r.status < 300) {
    let parsed;
    try { parsed = JSON.parse(r.body); } catch { parsed = null; }
    // A relay that answers 2xx with an unparseable body still stored the
    // message; it just cannot tell us WHICH — id stays null and the bridge
    // falls back to the room marker for loop protection.
    return { ok: true, detail: "", id: storedMessageId(parsed), body: parsed };
  }
  return {
    ok: false,
    detail: r.status === 0
      ? "the relay did not answer (it may be restarting)"
      : `relay HTTP ${r.status}${refusalDetail(r.body) ? ` — ${refusalDetail(r.body)}` : ""}`,
  };
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
      // The relay's own message type (message | system | join | part | action | ...).
      // A "system" row is the channel narrating itself ("Channel #command created
      // by david"), never something a human asked for -- the relay poller must not
      // execute one. Absent on older payloads, so default to a real message.
      type: typeof row.type === "string" && row.type ? row.type : "message",
    });
  }
  return out.slice(0, limit);
}

/**
 * Recent messages in a channel, shaped for the deck: [{channel, author,
 * text, at, id, threadId, replyCount, agent}]. [] on any failure.
 *
 * Every successful read also feeds relay-room-bridge, which turns what is NEW
 * in a voiced channel into room events — so the agents coordinating in #agents
 * get bodies on the stage instead of scrolling past in a panel (owner,
 * 2026-09-18: "make the room more connected to ... awrelay/AitherRelay").
 * Fire-and-forget on purpose: the panel must render at poll speed whether or
 * not the room daemon is up, and the bridge swallows its own failures.
 */
async function fetchHistory(channel = RELAY_CHANNEL, limit = HISTORY_LIMIT, execFn = spawn) {
  const { code, stdout } = await runAwrelay(
    ["--json", "history", channel, "--limit", String(limit)],
    execFn,
  );
  if (code !== 0) return [];
  try {
    const rows = shapeRows(JSON.parse(stdout), channel, limit);
    mirrorToRoom(channel, rows);
    return rows;
  } catch {
    return [];
  }
}

/** Hand fresh rows to the room bridge. Never throws, never awaited. */
function mirrorToRoom(channel, rows) {
  try {
    const { sharedBridge } = require("./relay-room-bridge.cjs");
    // NOT selfNicks: [RELAY_NICK]. This desk posts under the OWNER's nick, so
    // treating that nick as "ours" silenced the owner completely — measured
    // 2026-09-19, the bridge read every message, advanced its watermark and
    // mirrored nothing. What we wrote is identified by message id (noteOurs).
    const bridge = sharedBridge();
    void Promise.resolve(bridge.mirror(channel, rows)).catch(() => {});
  } catch {
    /* the bridge is optional: a desk with no room daemon just shows the panel */
  }
}

/**
 * The channel names the relay lists for this identity. [] on any failure.
 * The Console filters this to `#session-*` -- the live Claude Code sessions
 * the mirror hook publishes -- so attaching to a running session is one pick
 * in the chat target menu, from any machine that reads the relay.
 */
async function fetchChannels(execFn = spawn) {
  const { code, stdout } = await runAwrelay(["--json", "channels"], execFn);
  if (code !== 0) return [];
  try {
    const parsed = JSON.parse(stdout);
    const rows = Array.isArray(parsed) ? parsed : parsed?.channels;
    if (!Array.isArray(rows)) return [];
    return rows
      .map((row) => (typeof row === "string" ? row : row && typeof row.name === "string" ? row.name : ""))
      .filter(Boolean);
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

/**
 * Post a message to a channel as the owner. Returns {ok: true} on success,
 * {ok: false, detail} when the relay refused — the DETAIL is the relay's own
 * refusal reason, so the cockpit shows WHY instead of a flat "refused".
 * A single transient transport blip (status 0 — TLS reset, restart window)
 * is retried once; a real 4xx is reported honestly, never auto-retried.
 */
async function post(channel = RELAY_CHANNEL, text, requestFn = relayRequest) {
  if (typeof text !== "string" || !text.trim()) return { ok: false, detail: "empty message" };
  // Join first (lazy, once per bearer): #agents is agent-only and an
  // unjoined identity is silently 403'd.
  if (!(await ensureJoined(requestFn))) {
    return { ok: false, detail: lastJoinDetail || "could not join the relay identity" };
  }
  const q = channel.replace("#", "%23");
  const payload = {
    channel,
    nick: RELAY_NICK,
    content: text.trim().slice(0, 1500),
  };
  const result = await doorGatedWrite(channel, `/v1/channels/${q}/messages`, payload, requestFn);
  // Tell the room bridge this row is OURS, by id: the desk posts under the
  // owner's own nick, so nothing else distinguishes what we wrote from what
  // the owner wrote, and mirroring our own post would loop the room and the
  // channel into each other.
  noteOursToRoom(result);
  return result;
}

/** Hand the id of a message WE just posted to the room bridge. Never throws. */
function noteOursToRoom(result) {
  try {
    const id = result && (result.id || result.message_id || (result.body && result.body.id));
    if (!id) return;
    const { sharedBridge } = require("./relay-room-bridge.cjs");
    sharedBridge().noteOurs(String(id));
  } catch {
    /* the bridge is optional */
  }
}

/** Reply into a message's thread — the per-agent direct chat send path. */
async function postThreadReply(channel, messageId, text, requestFn = relayRequest) {
  if (typeof messageId !== "string" || !messageId) {
    return { ok: false, detail: "missing message id" };
  }
  if (typeof text !== "string" || !text.trim()) return { ok: false, detail: "empty reply" };
  if (!(await ensureJoined(requestFn))) {
    return { ok: false, detail: lastJoinDetail || "could not join the relay identity" };
  }
  const q = channel.replace("#", "%23");
  const payload = {
    channel,
    nick: RELAY_NICK,
    content: text.trim().slice(0, 1500),
  };
  const result = await doorGatedWrite(
    channel,
    `/v1/channels/${q}/messages/${encodeURIComponent(messageId)}/thread`,
    payload,
    requestFn,
  );
  // A reply is ours too. The relay's history read can surface thread replies
  // (reply_count walks the same records), and relay-poller.cjs acks every
  // command order through THIS path — an unrecorded ack is the most repetitive
  // thing the room could read back at the owner.
  noteOursToRoom(result);
  return result;
}

/** Test-only: clear the per-bearer join cache so a test can force a re-join. */
function _resetJoinForTests() {
  joinState = "pending";
  joinPromise = null;
  joinedBearer = null;
  lastJoinDetail = "";
}

/** Test-only: forget every door, attestation and injected source. */
function _resetDoorForTests() {
  doorAttestations.clear();
  doorPresenting.clear();
  knownDoors.clear();
  humanitySource = fileHumanityAttestation;
  bearerSource = null;
}

/** Test-only: where bearer() reads from (a () => string); null = the file. */
function _setBearerSourceForTests(fn) {
  bearerSource = typeof fn === "function" ? fn : null;
}

module.exports = {
  fetchChannels,
  fetchHistory,
  fetchThread,
  post,
  postThreadReply,
  setHumanityAttestationSource,
  _relayRequestForTests: relayRequest,
  _resetJoinForTests,
  _resetDoorForTests,
  _setBearerSourceForTests,
  RELAY_URL,
  RELAY_CHANNEL,
  RELAY_NICK,
  GATEWAY_URL,
  DOOR_KNOCK_URL,
  DOOR_PRESENT_URL,
  DOOR_HEADER,
  HUMANITY_ATTESTATION_FILE,
};
