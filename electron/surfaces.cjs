"use strict";

/**
 * surfaces — the control-plane doors, probed from the host.
 *
 * The Fleet window showed a pill and four numbers and nothing about WHERE the
 * owner could look next (owner, 2026-09-08: why aren't the tunnel, the edge
 * pulse, genesis and the dashboards in here?). This
 * is that strip: every row is a real URL, probed the way the fallback worker's
 * status grid probes hosts (anything that answers below 500 is UP — a 302 to
 * login or a 401 means the door is there; 5xx, a refused socket or a timeout
 * means it is not). Pulse is read as JSON so the row can say "HELD by owner"
 * instead of a bare UP.
 *
 * In-fleet doors (genesis, registry) are reached through the two host-visible
 * front doors that exist: the MCP gateway (:8182, rung 1 of the dispatch
 * ladder) and the awdk daemon (:8362, rooms + decisions). Genesis itself
 * publishes no host port — that is deliberate and documented in
 * .claude/rules/aitheros-dispatch.md — so its row IS the gateway's health.
 */

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const https = require("node:https");
const path = require("node:path");

// Doors every install has: its own loopback front doors.
const LOCAL_SURFACES = [
  { id: "mcp", label: "Genesis via MCP gateway", open: "http://127.0.0.1:8182/health", probe: "http://127.0.0.1:8182/health", scope: "fleet" },
  { id: "daemon", label: "awdk daemon (rooms, decisions)", open: "http://127.0.0.1:8362/health", probe: "http://127.0.0.1:8362/health", scope: "host" },
  { id: "registry", label: "Registry", open: "https://127.0.0.1:8149/health", probe: "https://127.0.0.1:8149/health", scope: "fleet" },
];

// An operator's PUBLIC doors (their tunnel, edge pulse, dashboards) are their own
// hostnames, so they are configuration, not source: a JSON array of rows (or
// { "surfaces": [...] }) in AWDESK_SURFACES_FILE, else ~/.aither/desk-surfaces.json.
// No file is the normal install. A file that exists but cannot be used says so on
// stderr and contributes nothing -- the loopback rows still render.
function defaultSurfacesFile() {
  return process.env.AWDESK_SURFACES_FILE || path.join(os.homedir(), ".aither", "desk-surfaces.json");
}

// open feeds shell.openExternal via OPENABLE, so only http(s) rows are admitted.
function validSurface(s) {
  return Boolean(s) && typeof s.id === "string" && typeof s.label === "string"
    && /^https?:\/\//.test(String(s.open || "")) && /^https?:\/\//.test(String(s.probe || ""));
}

function loadOperatorSurfaces(file = defaultSurfacesFile()) {
  if (!file || !fs.existsSync(file)) return [];
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    const rows = Array.isArray(doc) ? doc : doc?.surfaces;
    if (!Array.isArray(rows)) throw new Error("expected an array of surface rows");
    const good = rows.filter(validSurface);
    if (good.length !== rows.length) {
      console.warn(`[surfaces] ${file}: ignored ${rows.length - good.length} row(s) without id, label and http(s) open+probe`);
    }
    return good;
  } catch (error) {
    console.warn(`[surfaces] ${file}: unusable (${error?.message || error}); showing loopback doors only`);
    return [];
  }
}

const SURFACES = [...loadOperatorSurfaces(), ...LOCAL_SURFACES];

const OPENABLE = new Set(SURFACES.map((s) => s.open));

function internalCa() {
  const candidates = [];
  if (process.env.AITHEROS_ROOT) {
    candidates.push(path.join(process.env.AITHEROS_ROOT, "Library", "Data", "tls", "ca-chain.pem"));
  }
  candidates.push(
    "C:\\AitherOS-Data\\Library\\Data\\tls\\ca-chain.pem",
    "C:\\AitherOS-Fresh\\AitherOS\\Library\\Data\\tls\\ca-chain.pem",
  );
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p);
    } catch {
      /* next candidate */
    }
  }
  return undefined;
}

/** GET a URL; resolve { status, body, ms } — status 0 on any transport failure. */
function defaultRequest(url, { timeoutMs = 3000, ca } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const done = (status, body, detail) => {
      if (settled) return;
      settled = true;
      resolve({ status, body: body || "", ms: Date.now() - started, detail: detail || "" });
    };
    let target;
    try {
      target = new URL(url);
    } catch {
      done(0, "", "bad url");
      return;
    }
    const lib = target.protocol === "https:" ? https : http;
    const isLoopback = target.hostname === "127.0.0.1" || target.hostname === "localhost";
    const req = lib.request(
      target,
      {
        method: "GET",
        timeout: timeoutMs,
        headers: { accept: "application/json, text/html", "user-agent": "awdesk-surfaces/1" },
        // In-fleet TLS is the internal CA; public hosts are Cloudflare's.
        ...(target.protocol === "https:" && isLoopback && ca ? { ca } : {}),
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => {
          if (chunks.length < 64) chunks.push(c);
        });
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8").slice(0, 4096);
          if (settled) return;
          settled = true;
          resolve({
            status: res.statusCode || 0,
            body,
            ms: Date.now() - started,
            detail: "",
            headers: {
              location: String(res.headers.location || ""),
              fallback: String(res.headers["x-aither-fallback"] || ""),
            },
          });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", (error) => done(0, "", error?.code || error?.message || "error"));
    req.end();
  });
}

/** Pure: classify one probe result the way the status page does. */
function judge(surface, result) {
  const status = Number(result?.status) || 0;
  const headers = result?.headers || {};
  const body = String(result?.body || "");
  let up = status > 0 && status < 500;
  let detail = up ? `HTTP ${status}` : status ? `HTTP ${status}` : result?.detail || "no answer";
  // Three answers that LOOK like a door and are not — measured 2026-09-08 with
  // the fleet down: tunnel answered 503 + X-Aither-Fallback (our own
  // maintenance page), prometheus answered 200 with a "Coming Soon"
  // placeholder (nothing deployed behind the name), grafana answered 302 to
  // Cloudflare Access (a real door, but the origin is not probed from here).
  if (headers.fallback) {
    up = false;
    detail = "maintenance page (origin down)";
  } else if (/cloudflareaccess\.com/i.test(headers.location || "")) {
    up = true;
    detail = "Cloudflare Access login (origin not probed)";
  } else if (up && /<title>[^<]*coming soon/i.test(body)) {
    up = false;
    detail = "placeholder page (nothing deployed behind it)";
  }
  if (surface.json && up) {
    try {
      const doc = JSON.parse(result.body || "{}");
      if (doc && typeof doc === "object") {
        if (doc.held === true) {
          detail = `HELD by owner${doc.held_since ? ` since ${doc.held_since}` : ""}`;
        } else if (typeof doc.summary === "string" && doc.summary) {
          detail = doc.summary.slice(0, 80);
        }
      }
    } catch {
      /* not JSON: HTTP status stands */
    }
  }
  return {
    id: surface.id,
    label: surface.label,
    url: surface.open,
    scope: surface.scope,
    up,
    status,
    ms: Number(result?.ms) || 0,
    detail,
  };
}

/** Probe every surface concurrently. Never rejects; a failed probe is a DOWN row. */
async function probeSurfaces({ requestImpl = defaultRequest, timeoutMs = 3000, surfaces = SURFACES } = {}) {
  const ca = internalCa();
  return Promise.all(
    surfaces.map(async (surface) => {
      try {
        return judge(surface, await requestImpl(surface.probe, { timeoutMs, ca }));
      } catch (error) {
        return judge(surface, { status: 0, detail: error?.message || String(error) });
      }
    }),
  );
}

/** "surfaces 3/7 up" plus the down names, for the one-line summary. */
function summarizeSurfaces(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return "";
  const up = rows.filter((r) => r.up).length;
  const down = rows.filter((r) => !r.up).map((r) => r.id);
  return `surfaces ${up}/${rows.length} up${down.length ? ` (down: ${down.join(", ")})` : ""}`;
}

module.exports = {
  LOCAL_SURFACES,
  OPENABLE,
  SURFACES,
  defaultRequest,
  judge,
  loadOperatorSurfaces,
  probeSurfaces,
  summarizeSurfaces,
};
