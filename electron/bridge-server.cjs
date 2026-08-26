"use strict";

const http = require("node:http");

const DEFAULT_PORT = 47831;
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
  "https://portal.aitherium.com",
  "https://veil.aitherium.com",
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
}) {
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
  createBridgeServer,
  decisionsReadOriginAllowed,
  hostAllowed,
  isVoiceState,
  normalizeEvent,
  originAllowed,
};
