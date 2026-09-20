"use strict";

/** safety-gate — the ONE place awdesk asks AitherSafety before output becomes visible.
 *
 *  The plan (`.AITHERIUM/CAPABILITY/AVATAR-FORGE-PIPELINE.md`, stage 6) says safety is a
 *  FUNNEL, not a stage: consulted at the two places output becomes visible — a character
 *  being installed into the roster, and words being spoken aloud — with the verdict
 *  recorded rather than swallowed. Measured 2026-09-19, before this file existed: neither
 *  `character-roster.cjs` nor `voice-resolve.cjs` mentioned safety at all, so the rating
 *  gate answered "which character may have a body" and NOTHING asked about the output.
 *
 *  🚩 THE ROUTE THAT ANSWERS IS NOT THE ONE THE SERVICE ADVERTISES. AitherSafety runs as
 *  a sub-service of the CognitionCore compound on :8097. Its `/v1/unified` endpoint — the
 *  one with filter/level/status/config — is declared on the service's STANDALONE `app`,
 *  so in compound (deployed) mode it is not mounted: `POST /v1/unified` answers
 *  "Unified API not implemented for CognitionCore" and `POST /safety/v1/unified` is a
 *  404. Only what hangs off the service's `router` is served, under `/safety`:
 *
 *      GET  /safety/health   -> {"status":"healthy","service":"Safety",...}
 *      GET  /safety/level    -> {"level":"unrestricted","name":"Unrestricted"}
 *      POST /safety/filter   -> {"original","filtered","changed","level"}   <- the verdict
 *      GET  /safety/status   -> {"current_level","patterns_loaded",...}
 *
 *  All four measured live on 2026-09-19. `/safety/filter` takes `content` (NOT `text` —
 *  that is a 422) and an optional `level`; it FILTERS rather than refusing, so "refused"
 *  here means "the safety plane rewrote this", which is a different decision for each
 *  call site and why the two helpers below differ.
 *
 *  Speech FAILS OPEN, exactly like `voice-resolve.cjs`: a dead safety service must not be
 *  able to mute the fleet, and a mute is how this gate would get switched off. A roster
 *  INSTALL also proceeds — refusing every install whenever a container is restarting
 *  would be an outage the funnel invented — but the degraded verdict is written to the
 *  status file, so "we asked and nobody answered" is visible instead of silent.
 *
 *  TLS: the AitherNet internal CA, the same chain `relay-feed.cjs` loads and the Python
 *  services trust. Never `rejectUnauthorized: false` — plain `http://` into a fleet
 *  service closes the socket and reads as "down".
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");

const SAFETY_ORIGIN = process.env.DESK_SAFETY_ORIGIN || "https://127.0.0.1:8097";
const FILTER_PATH = "/safety/filter";
const LEVEL_PATH = "/safety/level";
// Short on purpose: this sits in front of speech. A safety plane that needs longer than
// this is, for the purpose of a talking avatar, unreachable.
const DEFAULT_TIMEOUT_MS = 1500;
// The level is a platform setting the owner flips, not a per-utterance decision, so it is
// cached. Speech asks the filter route (which resolves the level server-side) — this cache
// exists for the status file and for callers that want to show the level.
const LEVEL_TTL_MS = 60_000;

const STATUS_FILE = process.env.DESK_SAFETY_STATUS_FILE
  || path.join(os.homedir(), ".aither", "desk-safety-gate.json");

const { internalCaOptions: internalCa } = require("./internal-ca.cjs");

/** One JSON request to the safety plane. Resolves {status, json}; never rejects. */
function safetyRequest(method, urlPath, body, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(urlPath, SAFETY_ORIGIN);
    } catch (error) {
      resolve({ status: 0, json: null, error: String(error && error.message ? error.message : error) });
      return;
    }
    const payload = body == null ? null : JSON.stringify(body);
    const req = https.request(
      {
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        method,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : {},
        ...internalCa(),
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          let json;
          try {
            json = JSON.parse(raw);
          } catch {
            // A body that is not JSON is not a verdict; `consult` treats it as DOWN.
            json = null;
          }
          resolve({ status: res.statusCode || 0, json });
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`safety plane did not answer in ${timeoutMs} ms`));
    });
    req.on("error", (error) => {
      resolve({ status: 0, json: null, error: String(error && error.message ? error.message : error) });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

let levelCache = { level: null, at: 0 };

/** The platform safety level, cached. `null` = the plane did not answer. */
async function safetyLevel({ requestFn = safetyRequest, now = () => Date.now(), timeoutMs } = {}) {
  if (levelCache.level && now() - levelCache.at < LEVEL_TTL_MS) return levelCache.level;
  const res = await requestFn("GET", LEVEL_PATH, null, { timeoutMs });
  const level = res && res.status === 200 && res.json && typeof res.json.level === "string"
    ? res.json.level
    : null;
  if (level) levelCache = { level, at: now() };
  return level;
}

/** Test seam: forget the cached level. */
function resetLevelCache() {
  levelCache = { level: null, at: 0 };
}

function writeStatus(entry, { file = STATUS_FILE } = {}) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let prior = {};
    try {
      prior = JSON.parse(fs.readFileSync(file, "utf8")) || {};
    } catch {
      prior = {};
    }
    const counts = prior.counts && typeof prior.counts === "object" ? prior.counts : {};
    const key = `${entry.kind}:${entry.verdict}`;
    counts[key] = (Number(counts[key]) || 0) + 1;
    fs.writeFileSync(
      file,
      `${JSON.stringify({ ...prior, last: entry, counts, at: new Date(entry.atMs).toISOString() }, null, 2)}\n`,
      "utf8",
    );
  } catch {
    // The status file is EVIDENCE, not control flow: a full disk must not stop speech.
  }
}

/**
 * consult — ask the safety plane about one piece of output.
 *
 * @param {object} ctx {kind: "speech"|"install", content: string}
 * @returns {{allow: boolean, content: string, changed: boolean, level: string|null,
 *            reachable: boolean, reason: string|null}}
 *   `content` is what the caller must USE: for speech that is the filtered text, so a
 *   filtered utterance is spoken in its filtered form rather than refused. `allow:false`
 *   happens only where a rewrite cannot be honoured (an install name — see below).
 */
async function consult(ctx = {}) {
  const kind = ctx.kind === "install" ? "install" : "speech";
  const content = ctx.content == null ? "" : String(ctx.content);
  const requestFn = typeof ctx.requestFn === "function" ? ctx.requestFn : safetyRequest;
  const statusFile = ctx.statusFile || STATUS_FILE;
  const nowMs = typeof ctx.now === "function" ? ctx.now() : Date.now();

  if (!content.trim()) {
    return { allow: true, content, changed: false, level: null, reachable: true, reason: null };
  }

  // `safetyRequest` resolves rather than rejects, but this gate sits in front of speech and
  // a transport that throws (a future client, an injected one, a DNS layer that raises)
  // must not turn into an exception two frames above the microphone.
  let res;
  try {
    res = await requestFn("POST", FILTER_PATH, { content }, { timeoutMs: ctx.timeoutMs });
  } catch (error) {
    res = { status: 0, json: null, error: String(error && error.message ? error.message : error) };
  }
  const ok = res && res.status === 200 && res.json && typeof res.json.filtered === "string";

  if (!ok) {
    // Fail OPEN, loudly: the verdict line says we asked and got nothing.
    const verdict = "degraded";
    const reason = res && res.status
      ? `safety plane answered HTTP ${res.status}`
      : `safety plane unreachable${res && res.error ? `: ${res.error}` : ""}`;
    writeStatus({ kind, verdict, reason, chars: content.length, atMs: nowMs }, { file: statusFile });
    return { allow: true, content, changed: false, level: null, reachable: false, reason };
  }

  const filtered = res.json.filtered;
  const changed = res.json.changed === true || filtered !== content;
  const level = typeof res.json.level === "string" ? res.json.level : null;

  // An INSTALL is a folder name and a roster key. A name the safety plane rewrites cannot
  // be silently renamed (the pack, the cast binding and the VRM file all join on it), so
  // this is the one arm that refuses — and it refuses with the plane's own verdict, not a
  // local word list.
  const allow = !(kind === "install" && changed);

  writeStatus(
    {
      kind,
      verdict: changed ? (allow ? "filtered" : "refused") : "passed",
      level,
      chars: content.length,
      atMs: nowMs,
    },
    { file: statusFile },
  );

  return {
    allow,
    content: kind === "install" ? content : filtered,
    changed,
    level,
    reachable: true,
    reason: allow ? null : `the safety plane rewrote "${content}" at level ${level}`,
  };
}

/** Speech arm: returns the text to speak (filtered), never refuses on its own. */
async function consultSpeech(text, options = {}) {
  return consult({ ...options, kind: "speech", content: text });
}

/** Roster arm: allow:false means do not write this character. */
async function consultInstall(name, options = {}) {
  return consult({ ...options, kind: "install", content: name });
}

module.exports = {
  consult,
  consultSpeech,
  consultInstall,
  safetyLevel,
  resetLevelCache,
  safetyRequest,
  STATUS_FILE,
  SAFETY_ORIGIN,
  FILTER_PATH,
  LEVEL_PATH,
};
