"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  bearerOk,
  createBridgeServer,
  decisionsReadOriginAllowed,
  readBridgeToken,
  hostAllowed,
  normalizeEvent,
  originAllowed,
} = require("./bridge-server.cjs");

function requestServer(address, { path, method = "GET", headers = {}, body = "" }) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port: address.port,
        path,
        method,
        headers,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
            status: response.statusCode,
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

test("normalizes state and clamps audio level events", () => {
  const state = {
    activity: "speaking",
    microphoneMuted: false,
    outputMuted: false,
    phase: "active",
  };
  assert.deepEqual(normalizeEvent({ type: "state", state }), { type: "state", state });
  assert.deepEqual(normalizeEvent({ type: "audio-level", level: 4 }), {
    type: "audio-level",
    level: 1,
  });
  assert.deepEqual(normalizeEvent({ type: "animation", animation: "DANCE" }), {
    type: "animation",
    animation: "DANCE",
  });
  assert.deepEqual(normalizeEvent({ type: "animation", animation: "HAPPY" }), {
    type: "animation",
    animation: "HAPPY",
  });
  assert.deepEqual(normalizeEvent({ type: "animation", animation: "FINGER_GUN" }), {
    type: "animation",
    animation: "FINGER_GUN",
  });
  assert.deepEqual(normalizeEvent({ type: "animation", animation: "FILE:custom-anim.vrma" }), {
    type: "animation",
    animation: "FILE:custom-anim.vrma",
  });
  assert.deepEqual(normalizeEvent({ type: "animation", animation: "FILE:anim-name_01.vrma" }), {
    type: "animation",
    animation: "FILE:anim-name_01.vrma",
  });
  assert.equal(normalizeEvent({ type: "animation", animation: "FILE:../x.vrma" }), null);
  assert.equal(normalizeEvent({ type: "animation", animation: "FILE:/etc/passwd" }), null);
  assert.equal(normalizeEvent({ type: "animation", animation: "CELEBRATE" }), null);
  assert.equal(normalizeEvent({ type: "animation", animation: "UNKNOWN" }), null);
  assert.equal(normalizeEvent({ type: "state", state: { phase: "wat" } }), null);
});

test("only accepts supported app and local webview origins", () => {
  assert.equal(originAllowed("http://127.0.0.1:5175"), true);
  assert.equal(originAllowed("http://localhost:5175"), true);
  assert.equal(originAllowed("codex-app://codex"), true);
  assert.equal(originAllowed("null"), false);
  assert.equal(originAllowed("https://example.com"), false);
  assert.equal(originAllowed("codex://settings"), false);
  assert.equal(originAllowed(undefined), true);
});

test("only accepts loopback Host headers", () => {
  assert.equal(hostAllowed("127.0.0.1:47931"), true);
  assert.equal(hostAllowed("localhost:47931"), true);
  assert.equal(hostAllowed("[::1]:47931"), true);
  assert.equal(hostAllowed("desk.example"), false);
  assert.equal(hostAllowed("127.0.0.1.example"), false);
  assert.equal(hostAllowed(undefined), false);
});

test("bridge rejects a non-loopback Host header", async (context) => {
  const bridge = createBridgeServer({ port: 0, onEvent: () => {} });
  const address = await bridge.listen();
  context.after(() => bridge.close());

  const response = await requestServer(address, {
    path: "/health",
    headers: { host: "desk.example" },
  });

  assert.equal(response.status, 403);
});

test("bridge accepts a valid native adapter state event", async (context) => {
  const events = [];
  const bridge = createBridgeServer({ port: 0, onEvent: (event) => events.push(event) });
  const address = await bridge.listen();
  context.after(() => bridge.close());

  const body = JSON.stringify({
    type: "state",
    state: {
      activity: "listening",
      microphoneMuted: false,
      outputMuted: false,
      phase: "active",
    },
  });
  const response = await requestServer(address, {
    path: "/events",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    },
    body,
  });

  assert.equal(response.status, 202);
  assert.equal(events.length, 1);
  assert.equal(events[0].state.phase, "active");
});

test("bridge routes only valid local JSON requests to MCP", async (context) => {
  const bodies = [];
  const bridge = createBridgeServer({
    port: 0,
    onEvent: () => {},
    mcpHandler: (_request, response, body) => {
      bodies.push(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    },
  });
  const address = await bridge.listen();
  context.after(() => bridge.close());

  const accepted = await requestServer(address, {
    path: "/mcp",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"jsonrpc":"2.0"}',
  });
  const blockedOrigin = await requestServer(address, {
    path: "/mcp",
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://example.com",
    },
    body: "{}",
  });
  const unsupportedMethod = await requestServer(address, {
    path: "/mcp",
  });
  const invalidJson = await requestServer(address, {
    path: "/mcp",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  const oversized = await requestServer(address, {
    path: "/mcp",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: "x".repeat(64 * 1024) }),
  });

  assert.equal(accepted.status, 200);
  assert.equal(blockedOrigin.status, 403);
  assert.equal(unsupportedMethod.status, 405);
  assert.equal(unsupportedMethod.headers.allow, "POST");
  assert.equal(invalidJson.status, 400);
  assert.equal(JSON.parse(invalidJson.body).error.code, -32700);
  assert.equal(oversized.status, 413);
  assert.deepEqual(bodies, [{ jsonrpc: "2.0" }]);
});

test("decision reads: hosted web surfaces may read, strangers may not", () => {
  assert.equal(decisionsReadOriginAllowed("https://aitherium.com"), true);
  assert.equal(decisionsReadOriginAllowed("https://www.aitherium.com"), true);
  assert.equal(decisionsReadOriginAllowed("http://127.0.0.1:5173"), true); // local dev keeps bridge trust
  assert.equal(decisionsReadOriginAllowed(undefined), true); // overlay's own null origin
  assert.equal(decisionsReadOriginAllowed("https://evil.example"), false);
  assert.equal(decisionsReadOriginAllowed("https://aitherium.com.evil.example"), false);
});

test("bridge serves the decision queue read-only to an allowed origin", async (context) => {
  const cards = [{ id: "d-1", title: "A real ask", urgency: "high", createdAt: 1 }];
  const bridge = createBridgeServer({
    port: 0,
    onEvent: () => {},
    decisionsProvider: () => cards,
  });
  const address = await bridge.listen();
  context.after(() => bridge.close());

  const ok = await requestServer(address, {
    path: "/decisions",
    headers: { origin: "https://aitherium.com" },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers["access-control-allow-origin"], "https://aitherium.com");
  assert.deepEqual(JSON.parse(ok.body), { decisions: cards, count: 1 });

  const denied = await requestServer(address, {
    path: "/decisions",
    headers: { origin: "https://evil.example" },
  });
  assert.equal(denied.status, 403);

  const mutated = await requestServer(address, {
    path: "/decisions",
    method: "POST",
    headers: { origin: "https://aitherium.com" },
    body: "{}",
  });
  assert.equal(mutated.status, 405, "the bridge must never accept a decision WRITE");
});

test("a throwing decisions provider answers an empty queue, never a 500", async (context) => {
  const bridge = createBridgeServer({
    port: 0,
    onEvent: () => {},
    decisionsProvider: () => {
      throw new Error("store unreadable");
    },
  });
  const address = await bridge.listen();
  context.after(() => bridge.close());
  const res = await requestServer(address, {
    path: "/decisions",
    headers: { origin: "https://aitherium.com" },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { decisions: [], count: 0 });
});

test("without a provider the route is absent (404), not an empty success", async (context) => {
  const bridge = createBridgeServer({ port: 0, onEvent: () => {} });
  const address = await bridge.listen();
  context.after(() => bridge.close());
  const res = await requestServer(address, {
    path: "/decisions",
    headers: { origin: "https://aitherium.com" },
  });
  assert.equal(res.status, 404);
});

test("command route: GET /command/history returns history from handler", async (context) => {
  const mockHistory = [
    { id: "1", text: "test1", reply: "ok1" },
    { id: "2", text: "test2", reply: "ok2" },
  ];
  const bridge = createBridgeServer({
    port: 0,
    onEvent: () => {},
    commandHandler: (req) => {
      if (req.action === "history") return mockHistory;
    },
  });
  const address = await bridge.listen();
  context.after(() => bridge.close());
  const res = await requestServer(address, {
    path: "/command/history?limit=50",
    method: "GET",
  });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(body.history, mockHistory);
});

test("command route: POST /command sends text and returns result within 25s", async (context) => {
  const bridge = createBridgeServer({
    port: 0,
    onEvent: () => {},
    bridgeToken: "test-token",
    commandHandler: async (req) => {
      if (req.action === "send") {
        return {
          ok: true,
          id: "test-id",
          reply: `Processed: ${req.text}`,
          kind: "agent",
        };
      }
    },
  });
  const address = await bridge.listen();
  context.after(() => bridge.close());
  const res = await requestServer(address, {
    path: "/command",
    method: "POST",
    body: JSON.stringify({ text: "hello" }),
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
  });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.match(body.reply, /Processed: hello/);
});

test("command route: rejects non-loopback origin", async (context) => {
  const bridge = createBridgeServer({
    port: 0,
    onEvent: () => {},
    commandHandler: () => ({}),
  });
  const address = await bridge.listen();
  context.after(() => bridge.close());
  const res = await requestServer(address, {
    path: "/command/history",
    headers: { origin: "https://example.com" },
  });
  assert.equal(res.status, 403);
});

test("command route: 404 without handler", async (context) => {
  const bridge = createBridgeServer({ port: 0, onEvent: () => {} });
  const address = await bridge.listen();
  context.after(() => bridge.close());
  const res = await requestServer(address, { path: "/command/history" });
  assert.equal(res.status, 404);
});

// ---- bearer on mutators (2026-09-08) ------------------------------------------
// Host+Origin alone let any local process stop ~200 containers. The mutating
// routes now need the awdk daemon's bearer; reads and window-raises do not.

function fleetBridge(context, extra = {}) {
  const bridge = createBridgeServer({
    port: 0,
    onEvent: () => {},
    bridgeToken: "test-token",
    fleetHandler: (verb) => ({ ok: true, verb }),
    commandHandler: async (req) => (req.action === "send" ? { ok: true, id: "c1", reply: "PONG" } : null),
    ...extra,
  });
  context.after(() => bridge.close());
  return bridge.listen();
}

test("bearer: POST /fleet/down without a bearer is 401, never a stopped fleet", async (context) => {
  const address = await fleetBridge(context);
  const none = await requestServer(address, { path: "/fleet/down", method: "POST" });
  assert.equal(none.status, 401);
  assert.match(none.headers["www-authenticate"] || "", /Bearer/);
  assert.equal(JSON.parse(none.body).ok, false);
  const wrong = await requestServer(address, {
    path: "/fleet/down",
    method: "POST",
    headers: { authorization: "Bearer test-tokem" },
  });
  assert.equal(wrong.status, 401);
  const basic = await requestServer(address, {
    path: "/fleet/down",
    method: "POST",
    headers: { authorization: "Basic dGVzdC10b2tlbg==" },
  });
  assert.equal(basic.status, 401);
});

test("bearer: the right bearer reaches the fleet handler", async (context) => {
  const address = await fleetBridge(context);
  const ok = await requestServer(address, {
    path: "/fleet/down",
    method: "POST",
    headers: { authorization: "bearer test-token" }, // scheme is case-insensitive
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body), { ok: true, verb: "down" });
});

test("bearer: GET /fleet/status and POST /fleet/open stay open on loopback", async (context) => {
  const address = await fleetBridge(context);
  const status = await requestServer(address, { path: "/fleet/status" });
  assert.equal(status.status, 200);
  const open = await requestServer(address, { path: "/fleet/open", method: "POST" });
  assert.equal(open.status, 200);
  assert.equal(JSON.parse(open.body).verb, "open");
});

test("bearer: POST /command needs it; history and open do not", async (context) => {
  const address = await fleetBridge(context);
  const denied = await requestServer(address, {
    path: "/command",
    method: "POST",
    body: JSON.stringify({ text: "fleet down" }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(denied.status, 401);
  const allowed = await requestServer(address, {
    path: "/command",
    method: "POST",
    body: JSON.stringify({ text: "ping" }),
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
  });
  assert.equal(allowed.status, 200);
  assert.equal(JSON.parse(allowed.body).reply, "PONG");
  const history = await requestServer(address, { path: "/command/history" });
  assert.equal(history.status, 200);
});

test("bearer: no token configured fails CLOSED (503), not open", async (context) => {
  const address = await fleetBridge(context, { bridgeToken: null });
  const down = await requestServer(address, {
    path: "/fleet/down",
    method: "POST",
    headers: { authorization: "Bearer anything" },
  });
  assert.equal(down.status, 503);
  assert.match(JSON.parse(down.body).error, /no bridge token/);
  const status = await requestServer(address, { path: "/fleet/status" });
  assert.equal(status.status, 200);
});

test("bearer: token resolves env first, then ~/.aither/harness_token, else null", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "desk-bridge-token-"));
  try {
    assert.equal(readBridgeToken({ env: {}, home }), null);
    fs.mkdirSync(path.join(home, ".aither"));
    fs.writeFileSync(path.join(home, ".aither", "harness_token"), "  from-file \n");
    assert.equal(readBridgeToken({ env: {}, home }), "from-file");
    assert.equal(readBridgeToken({ env: { AITHER_HARNESS_TOKEN: " from-env " }, home }), "from-env");
    fs.writeFileSync(path.join(home, ".aither", "harness_token"), "\n");
    assert.equal(readBridgeToken({ env: {}, home }), null); // blank file is no token
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("bearer: bearerOk is exact and never matches an empty token", () => {
  const req = (authorization) => ({ headers: authorization ? { authorization } : {} });
  assert.equal(bearerOk(req("Bearer abc"), "abc"), true);
  assert.equal(bearerOk(req("Bearer abcd"), "abc"), false);
  assert.equal(bearerOk(req("Bearer ab"), "abc"), false);
  assert.equal(bearerOk(req("Bearer "), ""), false);
  assert.equal(bearerOk(req(undefined), "abc"), false);
  assert.equal(bearerOk(req("Bearer abc"), null), false);
});

// ---- the two desktop surfaces (2026-09-08) --------------------------------------

test("desktop routes: POST /desktop/overlay|app raise a window with no bearer, GET /desktop/status reads, unknown surface is 404", async (context) => {
  const opened = [];
  const bridge = createBridgeServer({
    port: 0,
    onEvent: () => {},
    bridgeToken: "test-token",
    desktopHandler: (mode) => {
      opened.push(mode);
      return { ok: true, opened: mode === "status" ? null : mode, overlay: { open: mode === "overlay" }, app: { open: mode === "app" } };
    },
  });
  const address = await bridge.listen();
  context.after(() => bridge.close());
  const app = await requestServer(address, { path: "/desktop/app", method: "POST" });
  assert.equal(app.status, 200);
  assert.equal(JSON.parse(app.body).opened, "app");
  const overlay = await requestServer(address, { path: "/desktop/overlay", method: "POST" });
  assert.equal(overlay.status, 200);
  const status = await requestServer(address, { path: "/desktop/status" });
  assert.equal(status.status, 200);
  assert.deepEqual(opened, ["app", "overlay", "status"]);
  const unknown = await requestServer(address, { path: "/desktop/taskbar", method: "POST" });
  assert.equal(unknown.status, 404);
  assert.match(JSON.parse(unknown.body).error, /overlay \| app/);
  const wrongMethod = await requestServer(address, { path: "/desktop/app" });
  assert.equal(wrongMethod.status, 405);
  const denied = await requestServer(address, { path: "/desktop/app", method: "POST", headers: { origin: "https://evil.example" } });
  assert.equal(denied.status, 403);
});

test("desktop routes: absent without a handler (404), never an empty success", async (context) => {
  const bridge = createBridgeServer({ port: 0, onEvent: () => {}, bridgeToken: "t" });
  const address = await bridge.listen();
  context.after(() => bridge.close());
  assert.equal((await requestServer(address, { path: "/desktop/status" })).status, 404);
});
