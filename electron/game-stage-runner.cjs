"use strict";

/**
 * game-stage-runner — starts the Dark Matters stage subscriber (game-stage-subscriber.cjs) and
 * routes what it delivers into the desk's EXISTING speech door.
 *
 * Two ways to run it, ONE subscriber:
 *
 *   in-process (main.cjs, one registration line next to relayPoller.start()):
 *     require("./game-stage-runner.cjs").startGameStage({ speakAloud, handleBridgeEvent });
 *   speech goes straight to speakAloud(text, voice, speed, slot, origin) and animations to the
 *   "animation" bridge event — no HTTP hop.
 *
 *   standalone (a terminal, a scheduled task, a CI proof):
 *     node electron/game-stage-runner.cjs
 *   speech goes through the bridge's own door, POST http://127.0.0.1:47931/speak with the
 *   harness bearer (~/.aither/harness_token) — the same door the MCP `speak` tool and awvoice use,
 *   so a line from the game sounds exactly like a line from anywhere else. Animations have no
 *   standalone door and are counted as undeliverable.
 *
 * Where the events come from: DESK_GAME_STAGE_URL, else the owner's box engine directly
 * (http://127.0.0.1:8799/api/party-stage/events); through the gate that would be
 * http://127.0.0.1:8798/dark-matters/api/party-stage/events. The engine filters by the viewer's
 * ceiling; the subscriber filters AGAIN by the desk's (content-rating.cjs contentCeiling()).
 *
 * Every delivery and every drop is logged, one JSON line each, to stdout and to
 * ~/.aither/game-stage.log — that log IS the proof that a game turn reached an avatar.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const { createGameStageSubscriber, GAME_ORIGIN } = require("./game-stage-subscriber.cjs");

const ENGINE_DEFAULT = "http://127.0.0.1:8799/api/party-stage/events";
const BRIDGE_DEFAULT = "http://127.0.0.1:47931";
const LOG_FILE = path.join(os.homedir(), ".aither", "game-stage.log");

function logLine(kind, payload) {
  const line = JSON.stringify({ ts: new Date().toISOString(), kind, ...payload });
  try { process.stdout.write(line + "\n"); } catch { /* no stdout */ }
  try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); fs.appendFileSync(LOG_FILE, line + "\n"); } catch { /* no log dir */ }
}

function harnessToken() {
  if (process.env.AITHER_HARNESS_TOKEN) return String(process.env.AITHER_HARNESS_TOKEN).trim();
  try { return fs.readFileSync(path.join(os.homedir(), ".aither", "harness_token"), "utf8").trim(); } catch { return ""; }
}

/** POST {text, voice?, slot?} to the bridge's /speak door. Resolves {ok, status, body}; never throws. */
function bridgeSpeak({ text, voice, slot }, { bridge = process.env.DESK_BRIDGE_URL || BRIDGE_DEFAULT, token = harnessToken() } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL("/speak", bridge); } catch { resolve({ ok: false, status: 0, body: "bad bridge url" }); return; }
    const payload = JSON.stringify({ text, ...(voice ? { voice } : {}), ...(slot ? { slot } : {}) });
    const req = http.request({
      hostname: u.hostname, port: u.port || 80, path: u.pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), Authorization: `Bearer ${token}` },
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ ok: res.statusCode === 200, status: res.statusCode || 0, body: data.slice(0, 400) }));
    });
    req.on("error", (e) => resolve({ ok: false, status: 0, body: String(e && e.message || e) }));
    req.setTimeout(20000, () => { req.destroy(new Error("bridge timeout")); });
    req.end(payload);
  });
}

/**
 * Start the subscriber. `deps.speakAloud` (main.cjs) makes it in-process; without it, speech goes
 * through the bridge door. Returns the subscriber (stop()/state()).
 */
function startGameStage(deps = {}) {
  const url = deps.url || process.env.DESK_GAME_STAGE_URL || ENGINE_DEFAULT;
  const inProcess = typeof deps.speakAloud === "function";
  const sub = createGameStageSubscriber({
    url,
    bearer: deps.bearer,
    ceiling: deps.ceiling,
    log: (msg, extra) => logLine("subscriber", { msg, ...(extra || {}) }),
    speak: async ({ persona_id, text, voice, rating }) => {
      const slot = typeof deps.slotFor === "function" ? deps.slotFor(persona_id) : undefined;
      let result;
      if (inProcess) {
        try { result = await deps.speakAloud(text, voice || "nova", undefined, slot || "slot0", GAME_ORIGIN); }
        catch (e) { result = { ok: false, reason: String(e && e.message || e) }; }
      } else {
        result = await bridgeSpeak({ text, voice, slot });
      }
      logLine("speak", { persona_id, rating, chars: text.length, via: inProcess ? "speakAloud" : "bridge:/speak", result });
      if (!result || result.ok === false) throw new Error((result && (result.reason || result.body)) || "speak failed");
    },
    animate: typeof deps.handleBridgeEvent === "function"
      ? ({ persona_id, animation, rating }) => { deps.handleBridgeEvent({ type: "animation", animation, source: "game" }); logLine("animation", { persona_id, animation, rating }); }
      : undefined,
  });
  // drops are visible too: poll the counters into the log when they move
  let lastDropped = "";
  const tick = setInterval(() => {
    const s = sub.state();
    const d = JSON.stringify(s.dropped);
    if (d !== lastDropped) { lastDropped = d; logLine("drops", { dropped: s.dropped, delivered: s.delivered, connected: s.connected, lastError: s.lastError }); }
  }, 2000);
  if (tick.unref) tick.unref();
  logLine("start", { url, via: inProcess ? "in-process" : "bridge", bridge: inProcess ? null : (process.env.DESK_BRIDGE_URL || BRIDGE_DEFAULT) });
  sub.start();
  const stop = sub.stop.bind(sub);
  sub.stop = () => { clearInterval(tick); stop(); logLine("stop", {}); };
  return sub;
}

module.exports = { startGameStage, bridgeSpeak, ENGINE_DEFAULT, BRIDGE_DEFAULT, LOG_FILE };

if (require.main === module) {
  const sub = startGameStage();
  const bye = () => { sub.stop(); process.exit(0); };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}
