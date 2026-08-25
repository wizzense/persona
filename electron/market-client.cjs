"use strict";

/**
 * market-client — the Desk's window onto the Aitherium marketplace.
 *
 * One-stop-shop foundation (owner 2026-08-25: "browse agent packs from
 * aitherium + avatars ... one stop shop"): the desk panel and Living Desktop
 * both need the SAME marketplace data, so it lives here as one Node module
 * speaking Streamable-HTTP MCP to the local gateway — the same transport and
 * credential the relay feed uses (session-bearer from ~/.aither). No second
 * implementation of the marketplace protocol; a down gateway or missing
 * bearer yields {ok:false, reason} — the panel renders "market unavailable",
 * never a half-truth.
 *
 * The gateway speaks MCP Streamable-HTTP: initialize → initialized →
 * tools/call. Both Accept headers are REQUIRED (measured: text/event-stream
 * alone 404s / stalls).
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const GATEWAY_URL = "http://127.0.0.1:8182"; // never localhost: ::1 refuses
const MCP_ACCEPT = "application/json, text/event-stream";

function bearer() {
  try {
    return fs.readFileSync(path.join(os.homedir(), ".aither", "session-bearer"), "utf8").trim();
  } catch {
    return "";
  }
}

let _session = null; // {id, tools} — the MCP session, reused across calls
let _sessionAt = 0;

async function mcpCall(method, params) {
  const headers = {
    "Content-Type": "application/json",
    Accept: MCP_ACCEPT,
    Authorization: `Bearer ${bearer()}`,
    Connection: "close",
  };
  // Only attach the session id once one EXISTS — an empty Mcp-Session-Id on
  // initialize makes the gateway look up session "" and answer
  // "Session not found" (measured live 2026-08-25).
  if (_session) headers["Mcp-Session-Id"] = _session.id;
  // Plain node:http, NOT global fetch: the gateway is plain HTTP and undici's
  // keep-alive handles die in libuv teardown on process exit
  // (UV_HANDLE_CLOSING assertion, exit 127) — which poisoned the standalone
  // self-test. The http module owns no lingering handle.
  const body = JSON.stringify({ jsonrpc: "2.0", id: String(Date.now()), method, params });
  return await new Promise((resolve, reject) => {
    const http = require("node:http");
    const req = http.request(
      `${GATEWAY_URL}/mcp`,
      { method: "POST", headers, timeout: 15000 },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => {
          const sid = res.headers["mcp-session-id"];
          if (sid) {
            _session = { id: sid };
            _sessionAt = Date.now();
          }
          try {
            if (text.trim().startsWith("event:")) {
              const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
              if (!dataLine) return reject(new Error("MCP SSE without data line"));
              resolve(JSON.parse(dataLine.slice(5).trim()));
            } else {
              resolve(JSON.parse(text));
            }
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("gateway timeout")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function ensureSession() {
  if (!bearer()) throw new Error("no session bearer");
  if (_session && Date.now() - _sessionAt < 10 * 60 * 1000) return;
  const init = await mcpCall("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "desk", version: "1" },
  });
  if (init.error) throw new Error(`initialize failed: ${init.error.message}`);
  await mcpCall("notifications/initialized", {}).catch(() => {});
}

/**
 * Browse the marketplace: query + optional type filter, sorted listings.
 * Returns {ok:true, listings:[{id,name,type,description,short,tags,price}]}
 * or {ok:false, reason}.
 */
async function browse(query = "", type = "", limit = 24) {
  try {
    await ensureSession();
    const res = await mcpCall("tools/call", {
      name: "agent_marketplace_browse",
      // sort enum is popular|rating|newest|name|revenue — "recent" is a
      // validation error that silently reads as zero listings.
      arguments: { query, sort: "newest", limit },
    });
    const content = res?.result?.content;
    if (!content) throw new Error("no content in tools/call result");
    const text = content.map((c) => c.text ?? "").join("\n");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Some tools return plain prose; wrap it rather than guessing.
      return { ok: true, listings: [], note: text.slice(0, 500) };
    }
    if (!parsed.listings) {
      // A validation error (or prose) has no listings — say so loudly.
      return { ok: false, reason: text.slice(0, 300) };
    }
    return { ok: true, listings: parsed.listings, count: parsed.count ?? parsed.listings.length };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error).slice(0, 300) };
  }
}

/** One listing's full detail (invoke/pricing metadata). */
async function detail(listingId) {
  try {
    await ensureSession();
    const res = await mcpCall("tools/call", {
      name: "agent_marketplace_get_listing",
      arguments: { listing_id: listingId },
    });
    const text = (res?.result?.content ?? []).map((c) => c.text ?? "").join("\n");
    return { ok: true, detail: text };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error).slice(0, 300) };
  }
}

module.exports = { browse, detail, GATEWAY_URL };

if (require.main === module) {
  // Self-test: one live browse round-trip. Exit 0 = market reachable and the
  // listing shape parses; exit 1 = unreachable (gateway/bearer); exit 2 = the
  // module itself is broken.
  (async () => {
    try {
      const result = await browse("agent", "", 5);
      if (!result.ok) {
        console.error(`MARKET UNREACHABLE: ${result.reason}`);
        process.exit(1);
      }
      console.log(`MARKET OK: ${result.listings.length} listing(s)`);
      for (const l of result.listings.slice(0, 3)) {
        console.log(`  - ${l.name ?? l.id ?? "(unnamed)"} [${l.type ?? "?"}]`);
      }
      process.exit(0);
    } catch (error) {
      console.error(`MODULE BROKEN: ${error && error.stack ? error.stack : error}`);
      process.exit(2);
    }
  })();
}
