"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

// 47931, not 47831 (2026-09-06). 47831 sits inside a Windows reserved TCP exclusion
// range (47736-47835, one of 107 on the owner's host; Hyper-V/WSL claims them and they
// MOVE across reboots), so the bind failed EACCES while the window drew fine and awsh's
// bridge latched its 30s dead-endpoint cooldown forever. DESK_BRIDGE_PORT still
// overrides; the aitheros launcher passes what pickPort() actually found free.
const DEFAULT_PORT = 47931;
const MAX_BODY_BYTES = 64 * 1024;
const TRUSTED_ORIGIN =
  /^(?:https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?|codex-app:\/\/[A-Za-z0-9._~-]*)$/i;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const ANIMATIONS = new Set([
  "IDLE",
  "GREETING",
  "TALK",
  "HAPPY",
  "FINGER_GUN",
  "DANCE",
]);

const FILE_ANIMATION_PATTERN = /^FILE:[\w.-]+\.vrma$/;

function isVoiceState(value) {
  return (
    value != null &&
    typeof value === "object" &&
    ["inactive", "starting", "active", "stopping"].includes(value.phase) &&
    ["idle", "listening", "speaking"].includes(value.activity) &&
    typeof value.microphoneMuted === "boolean" &&
    typeof value.outputMuted === "boolean"
  );
}

function normalizeEvent(value) {
  if (value?.type === "state" && isVoiceState(value.state)) {
    return { type: "state", state: value.state };
  }
  if (value?.type === "audio-level" && Number.isFinite(value.level)) {
    const level = Math.max(0, Math.min(1, Number(value.level)));
    const bands =
      value.bands != null && typeof value.bands === "object" ? value.bands : undefined;
    return { type: "audio-level", level, ...(bands ? { bands } : {}) };
  }
  if (value?.type === "animation") {
    if (ANIMATIONS.has(value.animation)) {
      return { type: "animation", animation: value.animation };
    }
    if (typeof value.animation === "string" && FILE_ANIMATION_PATTERN.test(value.animation)) {
      return { type: "animation", animation: value.animation };
    }
  }
  return null;
}

function originAllowed(origin) {
  return origin == null || TRUSTED_ORIGIN.test(origin);
}

// Mutating routes (POST /fleet/<verb> except open, POST /command) need a bearer.
// Host+Origin alone let ANY local process stop ~200 containers or run `claude -p`
// as the owner (2026-09-08, integration-map gap 5). The credential is the awdk
// daemon's own: AITHER_HARNESS_TOKEN, else ~/.aither/harness_token -- the same
// order awsh's daemonToken() and adk use, so every existing client already has it.
function readBridgeToken({ env = process.env, home = os.homedir() } = {}) {
  const fromEnv = String(env.AITHER_HARNESS_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const value = fs.readFileSync(path.join(home, ".aither", "harness_token"), "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

function bearerOk(request, token) {
  if (!token) return false;
  const header = String(request.headers.authorization || "");
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match) return false;
  const given = Buffer.from(match[1], "utf8");
  const want = Buffer.from(token, "utf8");
  // Length leaks nothing useful here (the token is not secret-length), but a
  // compare that stops at the first differing byte would leak the prefix.
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

// Fails CLOSED: no configured token means no mutation, not open mutation.
function denyUnlessBearer(request, response, token) {
  if (bearerOk(request, token)) return false;
  const status = token ? 401 : 503;
  response.writeHead(status, {
    "content-type": "application/json",
    ...(status === 401 ? { "www-authenticate": 'Bearer realm="awdesk"' } : {}),
  });
  response.end(
    JSON.stringify({
      ok: false,
      error: token
        ? "bearer required: Authorization: Bearer <AITHER_HARNESS_TOKEN or ~/.aither/harness_token>"
        : "no bridge token configured (start the adk daemon once, or set AITHER_HARNESS_TOKEN)",
    }),
  );
  return true;
}

//: Web surfaces allowed to READ the decision queue over this loopback bridge.
//: The Aitheros Online surface that Desk hosts is the STATIC aitherium.com export,
//: whose /api/decisions is a build-time stub — so without this route the
//: notification bell can never see a card on exactly the surface the owner watches
//: (measured 2026-08-25: "No notifications" over a 673-card queue). Read-only,
//: loopback interface only (hostAllowed), and the response is CORS-readable
//: ONLY by these origins — any other site's fetch gets no ACAO header and the
//: browser withholds the body.
const DECISIONS_READ_ORIGINS = new Set([
  "https://aitherium.com",
  "https://www.aitherium.com",
]);

function decisionsReadOriginAllowed(origin) {
  // Local surfaces (the overlay's own file:// -> null origin, dev servers)
  // keep the same trust the rest of the bridge gives them.
  return originAllowed(origin) || DECISIONS_READ_ORIGINS.has(origin);
}

function hostAllowed(hostHeader) {
  if (typeof hostHeader !== "string" || hostHeader.length === 0) return false;
  try {
    const url = new URL(`http://${hostHeader}`);
    return (
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

function jsonRpcError(response, status, code, message) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    }),
  );
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];

    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        const error = new Error("Request body is too large");
        error.code = "BODY_TOO_LARGE";
        reject(error);
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (bytes > MAX_BODY_BYTES) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        const error = new Error("Request body is not valid JSON");
        error.code = "INVALID_JSON";
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function createBridgeServer({
  host = "127.0.0.1",
  port = DEFAULT_PORT,
  onEvent,
  mcpHandler = null,
  decisionsProvider = null,
  fleetHandler = null,
  commandHandler = null,
  // The two desktop surfaces: POST /desktop/overlay | /desktop/app raise a
  // window (no bearer — same class as /fleet/open); GET /desktop/status reads.
  desktopHandler = null,
  // undefined = resolve from env/file at start; null = none configured (mutators 503).
  bridgeToken = undefined,
}) {
  const token = bridgeToken === undefined ? readBridgeToken() : bridgeToken;
  let lastStateEvent = null;
  const server = http.createServer((request, response) => {
    const origin = request.headers.origin;
    if (!hostAllowed(request.headers.host)) {
      response.writeHead(403);
      response.end();
      return;
    }

    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, lastState: lastStateEvent?.state ?? null }));
      return;
    }

    // Read-only decision queue for the web surfaces Desk hosts. Answering
    // stays with the shared queue window / daemon — this bridge never mutates
    // the store, so a compromised page could at worst READ titles, not answer
    // an ask on the owner's behalf.
    if (request.url === "/decisions") {
      if (!decisionsReadOriginAllowed(origin)) {
        response.writeHead(403);
        response.end();
        return;
      }
      const cors = origin
        ? { "access-control-allow-origin": origin, vary: "Origin" }
        : {};
      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          ...cors,
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-allow-headers": "content-type",
        });
        response.end();
        return;
      }
      if (request.method !== "GET") {
        response.writeHead(405, { allow: "GET, OPTIONS" });
        response.end();
        return;
      }
      if (decisionsProvider == null) {
        response.writeHead(404);
        response.end();
        return;
      }
      let decisions;
      try {
        decisions = decisionsProvider();
      } catch {
        decisions = [];
      }
      response.writeHead(200, { ...cors, "content-type": "application/json" });
      response.end(JSON.stringify({ decisions, count: decisions.length }));
      return;
    }

    // Fleet control over loopback (2026-09-07): GET /fleet/status, POST
    // /fleet/<down|up|gaming|resume|adopt|open>. Same trust as /mcp — loopback
    // host, no foreign Origin — and every verb lands on main's ONE FleetControl,
    // so `game`, the window, MCP and this route cannot disagree. POST only for
    // anything that changes the fleet: a GET that stops 200 containers is a
    // The desktop surfaces (owner, 2026-09-08): overlay = the aitherium.com
    // Living Desktop over the Windows desktop, app = the full AitherDesktop
    // window. Raising a window on the owner's own screen needs no bearer.
    if (request.url === "/desktop/status" || request.url.startsWith("/desktop/")) {
      if (!originAllowed(origin)) {
        response.writeHead(403);
        response.end();
        return;
      }
      if (desktopHandler == null) {
        response.writeHead(404);
        response.end();
        return;
      }
      const mode = request.url.slice("/desktop/".length).split("?")[0];
      const isStatus = mode === "status";
      if ((isStatus && request.method !== "GET") || (!isStatus && request.method !== "POST")) {
        response.writeHead(405, { allow: isStatus ? "GET" : "POST" });
        response.end();
        return;
      }
      if (!isStatus && mode !== "overlay" && mode !== "app") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, error: `unknown desktop surface "${mode}" (overlay | app)` }));
        return;
      }
      Promise.resolve()
        .then(() => desktopHandler(mode))
        .then((result) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(result ?? { ok: true }));
        })
        .catch((error) => {
          if (response.headersSent) return;
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: false, error: error?.message || String(error) }));
        });
      return;
    }

    // prefetch away from an outage.
    if (request.url === "/fleet/status" || request.url.startsWith("/fleet/")) {
      if (!originAllowed(origin)) {
        response.writeHead(403);
        response.end();
        return;
      }
      if (fleetHandler == null) {
        response.writeHead(404);
        response.end();
        return;
      }
      const verb = request.url.slice("/fleet/".length).split("?")[0];
      const isStatus = verb === "status";
      if ((isStatus && request.method !== "GET") || (!isStatus && request.method !== "POST")) {
        response.writeHead(405, { allow: isStatus ? "GET" : "POST" });
        response.end();
        return;
      }
      // status is a read; open only raises the owner's own window. Everything
      // else stops or starts containers and needs the bearer.
      if (!isStatus && verb !== "open" && denyUnlessBearer(request, response, token)) {
        return;
      }
      Promise.resolve()
        .then(() => fleetHandler(verb))
        .then((verdict) => {
          const status = verdict?.unknown ? 404 : verdict?.busy ? 409 : verdict?.cannotJudge ? 503 : 200;
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(verdict ?? { ok: false, error: "no verdict" }));
        })
        .catch((error) => {
          if (response.headersSent) return;
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: false, error: error?.message || String(error) }));
        });
      return;
    }

    // Command chat over loopback: GET /command/history?limit=N, POST /command with
    // JSON body {text}. Same trust as /fleet — loopback, no foreign Origin. Every
    // request lands on main's ONE CommandAgent so windows, bridge, and MCP share
    // the same queue and history.
    if (request.url.startsWith("/command")) {
      if (!originAllowed(origin)) {
        response.writeHead(403);
        response.end();
        return;
      }
      if (commandHandler == null) {
        response.writeHead(404);
        response.end();
        return;
      }
      if (request.url.startsWith("/command/history")) {
        if (request.method !== "GET") {
          response.writeHead(405, { allow: "GET" });
          response.end();
          return;
        }
        const url = new URL(`http://127.0.0.1${request.url}`);
        const limit = Number(url.searchParams.get("limit")) || 50;
        try {
          const history = commandHandler({ action: "history", limit });
          response.writeHead(200, { "content-type": "application/json" });
          // `items` is the contract awsh /command, adk desk history and the
          // window poll on ({id, at, source, text, reply, kind}); `history` stays
          // as an alias for the first build's callers.
          response.end(JSON.stringify({ items: history, history }));
        } catch (error) {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: false, error: error?.message || String(error) }));
        }
        return;
      }
      if (request.url === "/command/open") {
        // Raise the Command window for the owner (`game command`, `adk desk command --open`).
        if (request.method !== "POST") {
          response.writeHead(405, { allow: "POST" });
          response.end();
          return;
        }
        try {
          const opened = commandHandler({ action: "open" });
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(opened ?? { ok: true }));
        } catch (error) {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: false, error: error?.message || String(error) }));
        }
        return;
      }
      if (request.url === "/command") {
        if (request.method !== "POST") {
          response.writeHead(405, { allow: "POST" });
          response.end();
          return;
        }
        // A command runs `claude -p` as the owner from the repo root: bearer required.
        if (denyUnlessBearer(request, response, token)) {
          return;
        }
        void readJsonBody(request)
          .then((body) => {
            const text = String(body?.text ?? "");
            if (!text) {
              response.writeHead(400, { "content-type": "application/json" });
              response.end(JSON.stringify({ ok: false, error: "missing text field" }));
              return;
            }
            return commandHandler({ action: "send", text });
          })
          .then((result) => {
            // If result is a promise, wait for it (async run).
            // If it finishes within 25s, return 200. Otherwise 202 with id.
            if (result && typeof result.then === "function") {
              const timer = setTimeout(() => {
                if (!response.headersSent) {
                  response.writeHead(202, { "content-type": "application/json" });
                  response.end(JSON.stringify({ id: result.id ?? null }));
                }
              }, 25_000);
              result.then((res) => {
                if (!response.headersSent) {
                  clearTimeout(timer);
                  response.writeHead(200, { "content-type": "application/json" });
                  response.end(JSON.stringify({ ok: res.ok, id: res.id, reply: res.reply }));
                }
              }).catch((error) => {
                if (!response.headersSent) {
                  clearTimeout(timer);
                  response.writeHead(500, { "content-type": "application/json" });
                  response.end(JSON.stringify({ ok: false, error: error?.message || String(error) }));
                }
              });
            } else {
              response.writeHead(200, { "content-type": "application/json" });
              response.end(JSON.stringify({ ok: result?.ok, id: result?.id, reply: result?.reply }));
            }
          })
          .catch((error) => {
            if (response.headersSent) return;
            if (error?.code === "BODY_TOO_LARGE") {
              response.writeHead(413, { "content-type": "application/json" });
              response.end(JSON.stringify({ ok: false, error: "Request body too large" }));
            } else if (error?.code === "INVALID_JSON") {
              response.writeHead(400, { "content-type": "application/json" });
              response.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
            } else {
              response.writeHead(500, { "content-type": "application/json" });
              response.end(JSON.stringify({ ok: false, error: error?.message || String(error) }));
            }
          });
        return;
      }
      response.writeHead(404);
      response.end();
      return;
    }

    if (request.url === "/mcp") {
      if (!originAllowed(origin)) {
        response.writeHead(403);
        response.end();
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405, { allow: "POST" });
        response.end();
        return;
      }
      if (mcpHandler == null) {
        response.writeHead(404);
        response.end();
        return;
      }
      void readJsonBody(request)
        .then((body) => mcpHandler(request, response, body))
        .catch((error) => {
          if (response.headersSent) return;
          if (error?.code === "BODY_TOO_LARGE") {
            jsonRpcError(response, 413, -32000, "Request body is too large");
          } else if (error?.code === "INVALID_JSON") {
            jsonRpcError(response, 400, -32700, "Parse error");
          } else {
            jsonRpcError(response, 500, -32603, "Internal server error");
          }
        });
      return;
    }

    if (request.method === "OPTIONS" && request.url === "/events" && originAllowed(origin)) {
      response.writeHead(204, {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        vary: "Origin",
      });
      response.end();
      return;
    }

    if (request.method !== "POST" || request.url !== "/events" || !originAllowed(origin)) {
      response.writeHead(404);
      response.end();
      return;
    }

    void readJsonBody(request)
      .then((body) => {
        const event = normalizeEvent(body);
        if (event == null) {
          response.writeHead(422);
          response.end();
          return;
        }
        if (event.type === "state") lastStateEvent = event;
        onEvent(event);
        response.writeHead(202, {
          ...(origin ? { "access-control-allow-origin": origin, vary: "Origin" } : {}),
          "content-type": "application/json",
        });
        response.end('{"accepted":true}');
      })
      .catch((error) => {
        if (response.headersSent) return;
        response.writeHead(error?.code === "BODY_TOO_LARGE" ? 413 : 400);
        response.end();
      });
  });

  return {
    getLastStateEvent: () => lastStateEvent,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve(server.address());
        });
      }),
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

module.exports = {
  ANIMATIONS,
  DEFAULT_PORT,
  bearerOk,
  createBridgeServer,
  readBridgeToken,
  decisionsReadOriginAllowed,
  hostAllowed,
  isVoiceState,
  normalizeEvent,
  originAllowed,
};
