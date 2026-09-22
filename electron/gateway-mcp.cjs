"use strict";

/**
 * gateway-mcp — the ONE MCP transport for the desk's platform data.
 *
 * Extracted from market-client.cjs (2026-08-25) when the system-awareness
 * client needed the same plumbing: Streamable-HTTP MCP to the LOCAL gateway
 * (127.0.0.1:8182), the session-bearer credential, node:http transport. One
 * transport, one identity story — every desk data client (market, system,
 * voice/vision when they land) speaks through this module.
 *
 * Measured traps this module exists to remember:
 * - `localhost` never: ::1:8182 refuses after ~2s while 127.0.0.1 answers in
 *   ms (monorepo CLAUDE.md doctrine).
 * - Both Accept headers are REQUIRED (text/event-stream alone 404s/stalls).
 * - An EMPTY Mcp-Session-Id on initialize makes the gateway look up session
 *   "" and answer "Session not found" — attach the header only once a
 *   session exists.
 * - node:http, NOT global fetch: the gateway is plain HTTP and undici's
 *   keep-alive handles die in libuv teardown (UV_HANDLE_CLOSING, exit 127),
 *   which poisoned the standalone self-test.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// AWDESK_GATEWAY_URL exists for the test harness (a fake gateway on an
// ephemeral port) and for a box whose gateway is not on :8182. It is never
// `localhost` by default -- see the trap above.
const GATEWAY_URL = String(process.env.AWDESK_GATEWAY_URL || "http://127.0.0.1:8182").replace(/\/+$/, "");
const MCP_ACCEPT = "application/json, text/event-stream";
const SESSION_TTL_MS = 10 * 60 * 1000;
const BEARER_FILE = process.env.AWDESK_SESSION_BEARER_FILE
  || path.join(os.homedir(), ".aither", "session-bearer");

function bearer() {
  try {
    return fs.readFileSync(BEARER_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

let _session = null; // {id} — the MCP session, reused across calls
let _sessionAt = 0;

/** Forget the MCP session (tests; a gateway that restarted answers 404 on the
 *  old id, and the next ensureSession re-initializes). */
function resetSession() {
  _session = null;
  _sessionAt = 0;
}

async function mcpCall(method, params) {
  const headers = {
    "Content-Type": "application/json",
    Accept: MCP_ACCEPT,
    Authorization: `Bearer ${bearer()}`,
    Connection: "close",
  };
  if (_session) headers["Mcp-Session-Id"] = _session.id;
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
          // A non-2xx is the gateway's OWN verdict (503 billing_unavailable
          // {"error":"identity_unreachable",...} when Identity is down, 401/403
          // on a bad bearer), not a JSON-RPC envelope: its `error` is a STRING,
          // so reading `.error.message` off it printed "initialize failed:
          // undefined" to the palette (measured 2026-09-19). Reject with the
          // status and the sentence the gateway gave, so an outage reads as
          // UNREACHABLE (exit 1), never as MODULE BROKEN (exit 2).
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const j = parseMaybeJson(text) || {};
            const why = j.message || j.reason || j.error || text.slice(0, 120) || res.statusMessage;
            const retry = res.headers["retry-after"] ? ` (retry-after ${res.headers["retry-after"]})` : "";
            return reject(new Error(`HTTP ${res.statusCode}: ${why}${retry}`));
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

/** A JSON-RPC error is `{code,message}`; a gateway verdict is a plain string
 *  or `{error,reason,message}`. One reader for both, never "undefined". */
function errorText(e) {
  if (e == null) return "unknown error";
  if (typeof e === "string") return e;
  return e.message || e.reason || e.error || JSON.stringify(e);
}

async function ensureSession() {
  if (!bearer()) throw new Error("no session bearer");
  if (_session && Date.now() - _sessionAt < SESSION_TTL_MS) return;
  const init = await mcpCall("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "desk", version: "1" },
  });
  if (init.error) throw new Error(`initialize failed: ${errorText(init.error)}`);
  await mcpCall("notifications/initialized", {}).catch(() => {});
}

/**
 * Call one gateway tool by name; resolves the joined text content. Throws on
 * any failure — callers wrap and turn it into their {ok:false, reason} shape.
 */
async function callTool(name, args = {}) {
  await ensureSession();
  const res = await mcpCall("tools/call", { name, arguments: args });
  if (res?.error) throw new Error(`${name}: ${errorText(res.error)}`);
  const content = res?.result?.content;
  if (!content) throw new Error(`${name}: no content`);
  return content.map((c) => c.text ?? "").join("\n");
}

/** Some tools answer prose, some JSON — try JSON, else hand back the prose. */
function parseMaybeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

module.exports = { bearer, callTool, errorText, parseMaybeJson, resetSession, GATEWAY_URL };

if (require.main === module) {
  // Self-test: one live round-trip through a cheap, side-effect-free tool.
  // Exit 0 = gateway reachable and the transport works; exit 1 = unreachable
  // (gateway/bearer); exit 2 = the module itself is broken.
  (async () => {
    try {
      const now = await callTool("time_now", {});
      console.log(`GATEWAY MCP OK: ${String(now).slice(0, 80)}`);
      process.exit(0);
    } catch (error) {
      const msg = String(error?.message || error);
      if (/bearer|ECONNREFUSED|timeout|ETIMEDOUT|HTTP 5\d\d|HTTP 40[13]|unreachable/i.test(msg)) {
        console.error(`GATEWAY UNREACHABLE: ${msg.slice(0, 200)}`);
        process.exit(1);
      }
      console.error(`MODULE BROKEN: ${error && error.stack ? error.stack : error}`);
      process.exit(2);
    }
  })();
}
