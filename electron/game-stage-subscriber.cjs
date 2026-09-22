"use strict";

/**
 * game-stage-subscriber — the desk PULLS what the Dark Matters party stage does.
 *
 * The bridge is host/origin-gated and has no cast-write, so the game never
 * pushes into the desk. Instead the engine publishes stage events
 * (`{type: speak|animation|tf, persona_id, text?, voice?, animation?, rating}`,
 * engine/src/web/partyStageEvents.ts) on an SSE route behind the OWNER's gate,
 * and this module subscribes with the same bearer every other desk surface
 * already uses (~/.aither/session-bearer, see relay-feed.cjs), drops whatever
 * the desk's own content ceiling does not admit, and hands the rest to the
 * desk's EXISTING speak / animation paths (main.cjs speakAloud + the
 * "animation" bridge event) through injected deps. It adds no privilege and no
 * new door: it is a CLIENT of a gated stream, and the gate decides who may
 * even open it.
 *
 * TWO GATES, FAIL-CLOSED. The engine filters by the viewer's ceiling before an
 * event leaves the realm; this module filters AGAIN by the desk's
 * content-rating ceiling (content-rating.cjs contentCeiling().maxRating), with
 * the engine's pg/suggestive/explicit/brutal mapped onto the desk's
 * general/r15/r18 ladder exactly as build_character_pack.py AWDESK_RATING does.
 * An event with no rating, an unknown rating, or a rating above the ceiling is
 * DROPPED and counted — never spoken.
 *
 * `room-publisher.cjs CHAT_TYPES` is untouched: game speech reaches the room
 * only through speakAloud, the same funnel every other caller uses, under the
 * stamped origin GAME_ORIGIN ("game:dark-matters" — cast-config's ORIGIN KEY
 * GRAMMAR `<kind>:<id>`; never a value taken from an event).
 *
 * Reconnects with exponential backoff and `Last-Event-ID`, so a dropped socket
 * resumes where it left off (the engine replays its ring, ceiling-filtered).
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");

const DEFAULT_URL = process.env.DESK_GAME_STAGE_URL
  || "http://127.0.0.1:8798/dark-matters/api/party-stage/events";
const GAME_ORIGIN = "game:dark-matters";
/** Engine ContentRating -> desk rating (mirror of build_character_pack.py AWDESK_RATING). */
const ENGINE_TO_DESK = Object.freeze({ pg: "general", suggestive: "r15", explicit: "r18", brutal: "r18" });
const RATING_ORDER = Object.freeze({ general: 0, r15: 1, r18: 2 });
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const MAX_TEXT = 4000;

// ---------------------------------------------------------------------------
// Pure pieces (tested directly).
// ---------------------------------------------------------------------------

/** The desk rating an engine rating maps to, or null for anything unknown (fail-closed). */
function deskRatingOf(engineRating) {
  return typeof engineRating === "string" && Object.prototype.hasOwnProperty.call(ENGINE_TO_DESK, engineRating)
    ? ENGINE_TO_DESK[engineRating]
    : null;
}

/** May an event rated `engineRating` play on a desk whose ceiling is `maxRating`? Unknown on either side = no. */
function ratingAllowed(engineRating, maxRating) {
  const r = deskRatingOf(engineRating);
  if (r === null) return false;
  if (typeof maxRating !== "string" || !Object.prototype.hasOwnProperty.call(RATING_ORDER, maxRating)) return false;
  return RATING_ORDER[r] <= RATING_ORDER[maxRating];
}

/**
 * A stateful SSE parser: feed() bytes, get complete events `{id, event, data}`.
 * Handles chunks split mid-line, multi-line `data:`, comments (`:`), CRLF.
 */
function createSseParser() {
  let buffer = "";
  let cur = { id: null, event: "message", data: [] };
  function flush(out) {
    if (cur.data.length) out.push({ id: cur.id, event: cur.event, data: cur.data.join("\n") });
    cur = { id: cur.id, event: "message", data: [] };
  }
  return {
    feed(chunk) {
      buffer += String(chunk);
      const out = [];
      let idx;
      while ((idx = buffer.search(/\r\n|\n|\r/)) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + (buffer.startsWith("\r\n", idx) ? 2 : 1));
        if (line === "") { flush(out); continue; }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") cur.event = value || "message";
        else if (field === "data") cur.data.push(value);
        else if (field === "id" && !value.includes("\0")) cur.id = value;
        // `retry` is honoured by the reconnect loop's own backoff; ignored here.
      }
      return out;
    },
  };
}

/** Parse + shape-check one stage event; null when it is not one. */
function parseStageEvent(raw) {
  let ev;
  try { ev = JSON.parse(raw); } catch { return null; }
  if (!ev || typeof ev !== "object" || Array.isArray(ev)) return null;
  if (!["speak", "animation", "tf"].includes(ev.type)) return null;
  if (typeof ev.persona_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ev.persona_id)) return null;
  return ev;
}

function readBearerFile() {
  try {
    return fs.readFileSync(path.join(os.homedir(), ".aither", "session-bearer"), "utf8").trim();
  } catch {
    return "";
  }
}

function deskCeiling() {
  try {
    return require("./content-rating.cjs").contentCeiling();
  } catch {
    return { maxRating: "general", hideUnrated: true };
  }
}

// ---------------------------------------------------------------------------
// The subscriber.
// ---------------------------------------------------------------------------

/**
 * @param {object} deps
 * @param {string}   [deps.url]       the gated SSE route (default DESK_GAME_STAGE_URL / the owner gate)
 * @param {Function} [deps.bearer]    () => string; default ~/.aither/session-bearer
 * @param {Function} [deps.ceiling]   () => {maxRating}; default content-rating.contentCeiling()
 * @param {Function} [deps.speak]     ({persona_id, text, voice, origin}) => Promise|any — main.cjs wires speakAloud
 * @param {Function} [deps.animate]   ({persona_id, animation, origin}) => any — main.cjs wires the "animation" bridge event
 * @param {Function} [deps.transform] ({persona_id, tf, origin}) => any — optional (the tfTween path)
 * @param {Function} [deps.request]   (options, onResponse) => req — node http/https request (tests inject)
 * @param {Function} [deps.log]
 * @param {object}   [deps.tls]       extra TLS options (ca) for an https gate
 */
function createGameStageSubscriber(deps = {}) {
  const url = String(deps.url || DEFAULT_URL);
  const bearer = typeof deps.bearer === "function" ? deps.bearer : readBearerFile;
  const ceiling = typeof deps.ceiling === "function" ? deps.ceiling : deskCeiling;
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const timers = deps.timers || { setTimeout, clearTimeout };
  const state = {
    connected: false,
    stopped: false,
    attempts: 0,
    lastEventId: null,
    delivered: { speak: 0, animation: 0, tf: 0 },
    dropped: { rating: 0, shape: 0, undeliverable: 0 },
    lastError: null,
  };
  let req = null;
  let reconnectTimer = null;

  function handleEvent(ev) {
    if (!ev) { state.dropped.shape += 1; return false; }
    const max = (ceiling() || {}).maxRating;
    if (!ratingAllowed(ev.rating, max)) { state.dropped.rating += 1; return false; }
    const origin = GAME_ORIGIN;
    try {
      if (ev.type === "speak") {
        const text = typeof ev.text === "string" ? ev.text.slice(0, MAX_TEXT).trim() : "";
        if (!text || typeof deps.speak !== "function") { state.dropped.undeliverable += 1; return false; }
        deps.speak({ persona_id: ev.persona_id, text, voice: typeof ev.voice === "string" ? ev.voice : undefined, origin, rating: ev.rating });
      } else if (ev.type === "animation") {
        const clip = typeof ev.animation === "string" ? ev.animation.trim() : "";
        if (!clip || typeof deps.animate !== "function") { state.dropped.undeliverable += 1; return false; }
        deps.animate({ persona_id: ev.persona_id, animation: clip, origin, rating: ev.rating });
      } else if (ev.type === "tf") {
        if (typeof deps.transform !== "function") { state.dropped.undeliverable += 1; return false; }
        deps.transform({ persona_id: ev.persona_id, tf: ev.tf, origin, rating: ev.rating });
      } else {
        state.dropped.shape += 1;
        return false;
      }
    } catch (error) {
      state.lastError = String(error && error.message || error);
      state.dropped.undeliverable += 1;
      return false;
    }
    state.delivered[ev.type] += 1;
    return true;
  }

  function scheduleReconnect() {
    if (state.stopped) return;
    const ms = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(state.attempts, 5));
    reconnectTimer = timers.setTimeout(() => { reconnectTimer = null; connect(); }, ms);
  }

  function connect() {
    if (state.stopped) return;
    const token = bearer();
    if (!token) {
      state.lastError = "no session bearer (~/.aither/session-bearer)";
      state.attempts += 1;
      scheduleReconnect();
      return;
    }
    let u;
    try { u = new URL(url); } catch { state.lastError = `bad url ${url}`; state.stopped = true; return; }
    const client = u.protocol === "https:" ? https : http;
    const headers = { Accept: "text/event-stream", Authorization: `Bearer ${token}` };
    if (state.lastEventId !== null) headers["Last-Event-ID"] = String(state.lastEventId);
    const options = {
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: "GET",
      headers,
      ...(deps.tls || {}),
    };
    const doRequest = typeof deps.request === "function" ? deps.request : (o, cb) => client.request(o, cb);
    state.attempts += 1;
    try {
      req = doRequest(options, (res) => {
        if (!res || res.statusCode !== 200) {
          state.lastError = `stage answered ${res ? res.statusCode : "nothing"}`;
          try { if (res && typeof res.resume === "function") res.resume(); } catch { /* drained */ }
          scheduleReconnect();
          return;
        }
        state.connected = true;
        state.attempts = 0;
        const parser = createSseParser();
        if (res.setEncoding) res.setEncoding("utf8");
        res.on("data", (chunk) => {
          for (const frame of parser.feed(chunk)) {
            if (frame.id !== null && frame.id !== undefined) state.lastEventId = frame.id;
            handleEvent(parseStageEvent(frame.data));
          }
        });
        res.on("end", () => { state.connected = false; scheduleReconnect(); });
        res.on("error", (error) => { state.connected = false; state.lastError = String(error && error.message || error); scheduleReconnect(); });
      });
      req.on("error", (error) => { state.connected = false; state.lastError = String(error && error.message || error); scheduleReconnect(); });
      req.end();
    } catch (error) {
      state.lastError = String(error && error.message || error);
      scheduleReconnect();
    }
    log("game-stage: connecting", { url, attempt: state.attempts });
  }

  return {
    start() { state.stopped = false; connect(); return this; },
    stop() {
      state.stopped = true;
      if (reconnectTimer) { timers.clearTimeout(reconnectTimer); reconnectTimer = null; }
      try { if (req && typeof req.destroy === "function") req.destroy(); } catch { /* gone */ }
      req = null;
      state.connected = false;
    },
    state() { return { ...state, delivered: { ...state.delivered }, dropped: { ...state.dropped } }; },
    /** Feed one already-parsed event (tests / a WS bridge). Returns whether it was delivered. */
    handleEvent,
  };
}

module.exports = {
  createGameStageSubscriber,
  createSseParser,
  parseStageEvent,
  ratingAllowed,
  deskRatingOf,
  ENGINE_TO_DESK,
  GAME_ORIGIN,
  DEFAULT_URL,
};
