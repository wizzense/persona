"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// The transport every desk data client (market, system, vision, blog) rides.
// These arms pin the three measured traps the module header lists: no
// Mcp-Session-Id on initialize, session id captured from the response header
// and re-sent, both Accept types on every request -- plus the tools/call
// contract callers depend on (joined text, thrown errors, SSE-framed bodies).

/** A fake Streamable-HTTP gateway on an ephemeral port that records requests. */
function fakeGateway(answer) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const rpc = JSON.parse(body);
      seen.push({ headers: req.headers, rpc });
      const out = answer(rpc, seen.length);
      res.setHeader("Content-Type", out.sse ? "text/event-stream" : "application/json");
      if (out.sessionId) res.setHeader("Mcp-Session-Id", out.sessionId);
      res.statusCode = out.status || 200;
      const payload = JSON.stringify({ jsonrpc: "2.0", id: rpc.id, ...out.reply });
      res.end(out.sse ? `event: message\ndata: ${payload}\n\n` : payload);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ seen, server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function loadClient(url, bearerText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-gw-"));
  const bearerFile = path.join(dir, "session-bearer");
  if (bearerText !== null) fs.writeFileSync(bearerFile, bearerText);
  process.env.AWDESK_GATEWAY_URL = url;
  process.env.AWDESK_SESSION_BEARER_FILE = bearerFile;
  const modPath = require.resolve("./gateway-mcp.cjs");
  delete require.cache[modPath];
  const client = require(modPath);
  client.resetSession();
  return client;
}

function done(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

test("callTool: initialize carries NO session header, then re-sends the one the gateway issued", async () => {
  const gw = await fakeGateway((rpc) => {
    if (rpc.method === "initialize") return { sessionId: "sess-1", reply: { result: { protocolVersion: "2024-11-05" } } };
    if (rpc.method === "notifications/initialized") return { reply: { result: {} } };
    return { reply: { result: { content: [{ type: "text", text: "hello" }, { type: "text", text: "world" }] } } };
  });
  try {
    const client = loadClient(gw.url, "tok-abc\n");
    const text = await client.callTool("time_now", { a: 1 });
    assert.equal(text, "hello\nworld", "content text is joined with newlines");
    const [init, notified, call] = gw.seen;
    assert.equal(init.rpc.method, "initialize");
    assert.equal(init.headers["mcp-session-id"], undefined, "an EMPTY session id on initialize is the trap");
    assert.equal(init.headers.authorization, "Bearer tok-abc", "bearer file is trimmed and sent");
    assert.equal(init.headers.accept, "application/json, text/event-stream");
    assert.equal(notified.rpc.method, "notifications/initialized");
    assert.equal(notified.headers["mcp-session-id"], "sess-1");
    assert.equal(call.rpc.method, "tools/call");
    assert.deepEqual(call.rpc.params, { name: "time_now", arguments: { a: 1 } });
    assert.equal(call.headers["mcp-session-id"], "sess-1");
    // A second call reuses the session: no second initialize.
    await client.callTool("time_now", {});
    assert.equal(gw.seen.filter((r) => r.rpc.method === "initialize").length, 1);
  } finally {
    await done(gw.server);
  }
});

test("callTool: an SSE-framed answer is unwrapped like a JSON one", async () => {
  const gw = await fakeGateway((rpc) => {
    if (rpc.method === "initialize") return { sessionId: "s", sse: true, reply: { result: {} } };
    if (rpc.method === "notifications/initialized") return { reply: { result: {} } };
    return { sse: true, reply: { result: { content: [{ type: "text", text: "{\"ok\":true}" }] } } };
  });
  try {
    const client = loadClient(gw.url, "t");
    const text = await client.callTool("blog_list_posts", { include_drafts: true });
    assert.deepEqual(client.parseMaybeJson(text), { ok: true });
  } finally {
    await done(gw.server);
  }
});

test("callTool: a non-2xx gateway verdict (503 billing_unavailable) rejects with the status + sentence, and no tools/call is sent", async () => {
  // Measured live 2026-09-19 with Identity down: the gateway answers initialize
  // with HTTP 503 and a plain-object body whose `error` is a STRING. Reading
  // `.error.message` off it printed "initialize failed: undefined".
  const outage = {
    error: "billing_unavailable",
    reason: "identity_unreachable",
    message: "Authorization backend unreachable — retry shortly.",
  };
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push(JSON.parse(body));
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Retry-After", "5");
      res.end(JSON.stringify(outage));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const client = loadClient(`http://127.0.0.1:${server.address().port}`, "t");
    await assert.rejects(
      () => client.callTool("blog_list_posts", {}),
      /^Error: HTTP 503: Authorization backend unreachable — retry shortly\. \(retry-after 5\)$/,
    );
    assert.deepEqual(seen.map((r) => r.method), ["initialize"], "the outage stops at initialize; no tools/call follows");
    // The self-test's UNREACHABLE classifier (exit 1) must claim this sentence.
    assert.match("HTTP 503: Authorization backend unreachable", /HTTP 5\d\d|HTTP 40[13]|unreachable/i);
    // And a string-shaped JSON-RPC error never prints "undefined" either.
    assert.equal(client.errorText("plain"), "plain");
    assert.equal(client.errorText({ reason: "why" }), "why");
    assert.equal(client.errorText({ code: -1, message: "m" }), "m");
  } finally {
    await done(server);
  }
});

test("callTool: a tool error THROWS with the tool's name, and no bearer refuses before any request", async () => {
  const gw = await fakeGateway((rpc) => {
    if (rpc.method === "initialize") return { sessionId: "s", reply: { result: {} } };
    if (rpc.method === "notifications/initialized") return { reply: { result: {} } };
    return { reply: { error: { code: -32602, message: "unknown tool" } } };
  });
  try {
    const client = loadClient(gw.url, "t");
    await assert.rejects(() => client.callTool("blog_nope", {}), /blog_nope: unknown tool/);
    const bare = loadClient(gw.url, null);
    const before = gw.seen.length;
    await assert.rejects(() => bare.callTool("time_now", {}), /no session bearer/);
    assert.equal(gw.seen.length, before, "without a bearer nothing is sent");
  } finally {
    await done(gw.server);
    delete process.env.AWDESK_GATEWAY_URL;
    delete process.env.AWDESK_SESSION_BEARER_FILE;
    delete require.cache[require.resolve("./gateway-mcp.cjs")];
  }
});
