"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// Operator rows are CONFIGURATION (their own hostnames), so the suite supplies them the
// way an operator does: a file named by AWDESK_SURFACES_FILE, set BEFORE surfaces.cjs
// loads, because the row list is built at module load.
const FIXTURE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "awdesk-surfaces-"));
const OPERATOR_FILE = path.join(FIXTURE_DIR, "desk-surfaces.json");
fs.writeFileSync(OPERATOR_FILE, JSON.stringify([
  { id: "tunnel", label: "Tunnel", open: "https://tunnel.example.test/", probe: "https://tunnel.example.test/", scope: "public" },
  { id: "pulse", label: "Pulse (edge)", open: "https://pulse.example.test/", probe: "https://pulse.example.test/status", scope: "edge", json: true },
  { id: "grafana", label: "Grafana", open: "https://grafana.example.test/", probe: "https://grafana.example.test/", scope: "public" },
  { id: "prometheus", label: "Prometheus", open: "https://prometheus.example.test/", probe: "https://prometheus.example.test/", scope: "public" },
]));
process.env.AWDESK_SURFACES_FILE = OPERATOR_FILE;

const {
  LOCAL_SURFACES,
  OPENABLE,
  SURFACES,
  judge,
  loadOperatorSurfaces,
  probeSurfaces,
  summarizeSurfaces,
} = require("./surfaces.cjs");

test("SURFACES names every door the owner asked for, each with an openable URL", () => {
  const ids = SURFACES.map((s) => s.id);
  for (const id of ["tunnel", "pulse", "grafana", "prometheus", "mcp", "daemon", "registry"]) {
    assert.ok(ids.includes(id), `missing ${id}`);
  }
  for (const s of SURFACES) {
    assert.ok(OPENABLE.has(s.open), `${s.id} is not openable`);
    assert.match(s.probe, /^https?:\/\//);
  }
});

test("judge: anything below 500 is UP (a login redirect is a door), 5xx/timeout/refused is DOWN", () => {
  const tunnel = SURFACES.find((s) => s.id === "tunnel");
  assert.equal(judge(tunnel, { status: 302, ms: 40 }).up, true);
  assert.equal(judge(tunnel, { status: 401, ms: 40 }).up, true);
  assert.equal(judge(tunnel, { status: 503, ms: 40 }).up, false);
  const refused = judge(tunnel, { status: 0, ms: 3000, detail: "ECONNREFUSED" });
  assert.equal(refused.up, false);
  assert.equal(refused.detail, "ECONNREFUSED");
  assert.equal(judge(tunnel, { status: 0 }).detail, "no answer");
});

test("judge: our own maintenance page, a Coming-Soon placeholder and an Access login are told apart", () => {
  const tunnel = SURFACES.find((s) => s.id === "tunnel");
  const maint = judge(tunnel, { status: 503, headers: { fallback: "1" } });
  assert.equal(maint.up, false);
  assert.equal(maint.detail, "maintenance page (origin down)");
  const placeholder = judge(tunnel, { status: 200, body: "<html><head><title>Prometheus — Coming Soon</title>" });
  assert.equal(placeholder.up, false);
  assert.match(placeholder.detail, /placeholder/);
  const access = judge(tunnel, { status: 302, headers: { location: "https://aitherium.cloudflareaccess.com/cdn-cgi/access/login/x" } });
  assert.equal(access.up, true);
  assert.match(access.detail, /Cloudflare Access/);
});

test("judge: the pulse row reads the edge worker's JSON and says HELD by owner", () => {
  const pulse = SURFACES.find((s) => s.id === "pulse");
  const held = judge(pulse, { status: 200, body: JSON.stringify({ held: true, held_since: "2026-09-07T21:19:00-0700" }) });
  assert.equal(held.up, true);
  assert.equal(held.detail, "HELD by owner since 2026-09-07T21:19:00-0700");
  const free = judge(pulse, { status: 200, body: JSON.stringify({ held: false, summary: "3 hosts, 187 running" }) });
  assert.equal(free.detail, "3 hosts, 187 running");
  const html = judge(pulse, { status: 200, body: "<html>" });
  assert.equal(html.detail, "HTTP 200");
});

test("probeSurfaces probes every door concurrently and a throwing probe is a DOWN row, never a rejection", async () => {
  const seen = [];
  const rows = await probeSurfaces({
    requestImpl: async (url) => {
      seen.push(url);
      if (url.includes("pulse")) return { status: 200, body: '{"held":true}', ms: 12 };
      if (url.includes("8182")) throw new Error("ECONNREFUSED");
      return { status: 200, ms: 30 };
    },
  });
  assert.equal(rows.length, SURFACES.length);
  assert.equal(seen.length, SURFACES.length);
  const mcp = rows.find((r) => r.id === "mcp");
  assert.equal(mcp.up, false);
  assert.equal(mcp.detail, "ECONNREFUSED");
  assert.equal(rows.find((r) => r.id === "pulse").detail, "HELD by owner");
  assert.equal(summarizeSurfaces(rows), `surfaces ${SURFACES.length - 1}/${SURFACES.length} up (down: mcp)`);
  assert.equal(summarizeSurfaces([]), "");
});

test("operator doors are configuration: no file means the loopback doors only", () => {
  assert.deepEqual(loadOperatorSurfaces(path.join(FIXTURE_DIR, "absent.json")), []);
  assert.deepEqual(LOCAL_SURFACES.map((s) => s.id), ["mcp", "daemon", "registry"]);
});

test("an unusable operator file contributes nothing, and a non-http(s) row never becomes openable", () => {
  const broken = path.join(FIXTURE_DIR, "broken.json");
  fs.writeFileSync(broken, "{not json");
  assert.deepEqual(loadOperatorSurfaces(broken), []);
  const mixed = path.join(FIXTURE_DIR, "mixed.json");
  fs.writeFileSync(mixed, JSON.stringify({ surfaces: [
    { id: "ok", label: "OK", open: "https://ok.example.test/", probe: "https://ok.example.test/" },
    { id: "js", label: "JS", open: "javascript:alert(1)", probe: "https://x.example.test/" },
  ] }));
  assert.deepEqual(loadOperatorSurfaces(mixed).map((s) => s.id), ["ok"]);
});
