"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// Test seams, set BEFORE the modules under test are required: content-rating and
// character-roster read DESK_ROSTER_DIR / DESK_ADULT_CONTENT_MIRROR at require
// time, and node --test runs files as parallel child processes that would race
// on the real roster and the real gate mirror (see content-rating.cjs header).
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "desk-party-"));
const rosterDir = path.join(scratch, "characters");
const mirror = path.join(scratch, "adult_content.json");
process.env.DESK_ROSTER_DIR = rosterDir;
process.env.DESK_ADULT_CONTENT_MIRROR = mirror;
process.env.DESK_ADULT_CONTENT_LOG = path.join(scratch, "adult_content.log");

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { createBridgeServer } = require("./bridge-server.cjs");
const { createDeskMcpHandler } = require("./mcp-server.cjs");
const { invalidateGate } = require("./content-rating.cjs");
const party = require("./party-manifest.cjs");

/** The schema of record lives in the monorepo. The desk repo is standalone, so
 *  when it is reachable the test judges against the REAL schema; when it is not
 *  (a checkout without C:\AitherOS-Fresh) it judges against the module's own
 *  validator and says so. check_party_manifest.py PM002 holds the two together. */
const SCHEMA_FILE =
  process.env.PARTY_SCHEMA_FILE ||
  path.join("C:", "AitherOS-Fresh", "AitherOS", "config", "schemas", "party-manifest.schema.json");

function character(name, files = {}, json = null) {
  const dir = path.join(rosterDir, name);
  fs.mkdirSync(path.join(dir, "animations"), { recursive: true });
  fs.writeFileSync(path.join(dir, "model.vrm"), "glTF-fixture");
  for (const clip of files.animations || []) fs.writeFileSync(path.join(dir, "animations", clip), "vrma");
  if (json) fs.writeFileSync(path.join(dir, "character.json"), JSON.stringify(json));
}

function setGate(visible) {
  fs.writeFileSync(mirror, JSON.stringify({ visible }));
  invalidateGate();
}

character("aria", { animations: ["idle.vrma", "talk.vrma", "notes.txt"] }, { rating: "general", source: "vroid" });
character("zz-hidden", {}, { rating: "r18", source: "vroid" });
character("nyx", { animations: ["idle.vrma"] }, {
  rating: "r15",
  persona_id: "nyx-prime",
  saga: { project_id: "proj-1", character_id: "char-9", junk: 1 },
  sprite: { sprite_id: "sprite-nyx" },
});
character("unbound", {}, null);
fs.mkdirSync(path.join(rosterDir, "no-model-here"), { recursive: true }); // not a character

const castFile = path.join(scratch, "cast.json");
fs.writeFileSync(
  castFile,
  JSON.stringify({
    version: 1,
    actors: {
      "service:awdesk": { character: "aria", voice: "nova", speed: 1.2, displayName: "Aria" },
      "relay:#agents:lyra": { character: "zz-hidden", presence: "quiet" },
    },
    authors: { "aitheros-fresh": { seats: [{ character: "nyx", voice: "echo" }] } },
  }),
);

// ─── a tiny JSON-Schema (draft 2020-12 subset) validator, no dependency ────────
function schemaErrors(schema, value, root = schema, at = "$") {
  const errs = [];
  if (schema.$ref) {
    const ref = schema.$ref.replace(/^#\//, "").split("/").reduce((o, k) => o[k], root);
    return schemaErrors(ref, value, root, at);
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : null;
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (types && !types.includes(actual) && !(actual === "number" && types.includes("integer") && Number.isInteger(value))) {
    errs.push(`${at}: type ${actual} not in ${types}`);
    return errs;
  }
  if ("const" in schema && value !== schema.const) errs.push(`${at}: const ${schema.const}`);
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${at}: enum ${schema.enum}`);
  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${at}: pattern ${schema.pattern}`);
    if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${at}: minLength`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errs.push(`${at}: maxLength`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${at}: minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${at}: maximum`);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((v, i) => errs.push(...schemaErrors(schema.items, v, root, `${at}[${i}]`)));
  }
  if (actual === "object") {
    for (const r of schema.required || []) if (!(r in value)) errs.push(`${at}: missing ${r}`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties && k in schema.properties) errs.push(...schemaErrors(schema.properties[k], v, root, `${at}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${at}: unexpected ${k}`);
    }
  }
  return errs;
}

function judge(manifest) {
  const own = party.validateParty(manifest);
  assert.deepEqual(own, [], "module validator must accept the built manifest");
  if (fs.existsSync(SCHEMA_FILE)) {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_FILE, "utf8"));
    assert.deepEqual(schemaErrors(schema, manifest), [], "manifest must validate against the schema of record");
    assert.deepEqual([...party.MEMBER_FIELDS], schema.$defs.member.required, "MEMBER_FIELDS must be the schema's required list");
    return "schema";
  }
  return "module-only";
}

test("gate CLOSED: every member has a persona_id, hidden characters are EXCLUDED, and the manifest validates", () => {
  setGate(false);
  const { manifest, excluded } = party.buildParty({ castFile, rosterDir, now: () => new Date("2026-09-20T00:00:00Z") });

  assert.equal(manifest.version, 1);
  assert.equal(manifest.source, "awdesk");
  assert.equal(manifest.roster_dir, path.resolve(rosterDir));
  assert.ok(manifest.members.length >= 1);
  for (const m of manifest.members) {
    assert.match(m.persona_id, party.PERSONA_ID_RE, `persona_id missing/invalid on ${JSON.stringify(m)}`);
    for (const f of party.MEMBER_FIELDS) assert.ok(f in m, `${m.persona_id} lacks ${f}`);
  }

  const names = manifest.members.map((m) => m.character);
  assert.ok(!names.includes("zz-hidden"), "an r18 character must not be exported while the gate is closed");
  assert.ok(!names.includes("nyx"), "an r15 character must not be exported while the gate is closed");
  assert.deepEqual(
    excluded.map((e) => e.character).sort(),
    ["nyx", "zz-hidden"],
    "the exclusion is REPORTED, not silent",
  );
  assert.ok(names.includes("aria"));
  assert.ok(names.includes("unbound"), "a roster character no row binds is still a persona");

  const aria = manifest.members.find((m) => m.origin_key === "service:awdesk");
  assert.equal(aria.persona_id, "aria");
  assert.equal(aria.display_name, "Aria");
  assert.equal(aria.vrm, "aria/model.vrm");
  assert.deepEqual(aria.animations, ["aria/animations/idle.vrma", "aria/animations/talk.vrma"]);
  assert.deepEqual(aria.voice, { voice: "nova", speed: 1.2 });
  assert.equal(aria.presence, "normal");
  assert.equal(aria.rating, "g");
  assert.equal(aria.saga, null);
  assert.equal(aria.sprite, null);

  const unbound = manifest.members.find((m) => m.character === "unbound");
  assert.equal(unbound.origin_key, null);
  assert.equal(unbound.rating, "unknown", "no character.json reads as unknown, never as g");

  const how = judge(manifest);
  console.log(`[party] judged against: ${how} (${SCHEMA_FILE})`);
});

test("gate OPEN: rated characters appear with their rating, persona_id honours character.json, saga/sprite ids carry", () => {
  setGate(true);
  const { manifest, excluded } = party.buildParty({ castFile, rosterDir });
  assert.deepEqual(excluded, []);
  const hidden = manifest.members.find((m) => m.character === "zz-hidden");
  assert.equal(hidden.rating, "r18");
  assert.equal(hidden.origin_key, "relay:#agents:lyra");
  assert.equal(hidden.presence, "quiet");
  const nyx = manifest.members.find((m) => m.character === "nyx");
  assert.equal(nyx.persona_id, "nyx-prime", "character.json persona_id pins the join key");
  assert.equal(nyx.origin_key, "author:aitheros-fresh:0");
  assert.equal(nyx.voice.voice, "echo");
  assert.deepEqual(nyx.saga, { project_id: "proj-1", character_id: "char-9" }, "unknown saga keys are dropped");
  assert.deepEqual(nyx.sprite, { sprite_id: "sprite-nyx" });
  judge(manifest);
  setGate(false);
});

test("validateParty can FAIL: a member without persona_id, an unknown field and a bad version are all named", () => {
  setGate(false);
  const { manifest } = party.buildParty({ castFile, rosterDir });
  const broken = structuredClone(manifest);
  delete broken.members[0].persona_id;
  broken.members[0].colour = "red";
  broken.version = 2;
  const problems = party.validateParty(broken);
  const paths = problems.map((p) => p.path);
  assert.ok(paths.includes("members[0].persona_id"), paths.join(","));
  assert.ok(paths.includes("members[0].colour"));
  assert.ok(paths.includes("version"));
  assert.deepEqual(party.validateParty("nope").length, 1);
});

test("exportParty writes party.json atomically where DESK_PARTY_FILE says, and refuses an invalid build", () => {
  setGate(false);
  const file = path.join(scratch, "out", "party.json");
  process.env.DESK_PARTY_FILE = file;
  try {
    assert.equal(party.PARTY_FILE(), path.resolve(file));
    const result = party.exportParty({ castFile, rosterDir });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.file, path.resolve(file));
    assert.deepEqual(result.excluded.map((e) => e.character).sort(), ["nyx", "zz-hidden"]);
    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(written.members.length, result.members);
    judge(written);
    assert.ok(!fs.readdirSync(path.dirname(file)).some((f) => f.endsWith(".tmp")), "no temp file left behind");
  } finally {
    delete process.env.DESK_PARTY_FILE;
  }
  // A missing roster dir + missing cast is still a VALID (empty) party, not a crash.
  const empty = party.exportParty({ castFile: path.join(scratch, "absent.json"), rosterDir: path.join(scratch, "nope"), file: path.join(scratch, "empty.json") });
  assert.equal(empty.ok, true);
  assert.equal(empty.members, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(scratch, "empty.json"), "utf8")).roster_dir, null);
});

test("party_export is an MCP tool on the Desk server and returns the export result", async (context) => {
  setGate(false);
  const calls = [];
  const mcpHandler = createDeskMcpHandler({
    onAnimation: () => true,
    onWindowAction: () => true,
    getStatus: () => ({ windowVisible: true }),
    partyExport: (opts) => {
      calls.push(opts);
      return party.exportParty({ castFile, rosterDir, file: path.join(scratch, "mcp-party.json") });
    },
  });
  const bridge = createBridgeServer({ port: 0, onEvent: () => {}, mcpHandler });
  const address = await bridge.listen();
  const client = new Client({ name: "desk-test-party", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
  context.after(async () => { await client.close(); await bridge.close(); });
  await client.connect(transport);

  const tools = await client.listTools();
  const tool = tools.tools.find((t) => t.name === "party_export");
  assert.ok(tool, "party_export must be registered");
  assert.equal(tool.annotations?.readOnlyHint, false, "it writes a file; it must not claim to be read-only");

  const result = await client.callTool({ name: "party_export", arguments: {} });
  const body = JSON.parse(result.content[0].text);
  assert.equal(result.isError, false);
  assert.equal(body.ok, true);
  assert.ok(body.members >= 2, JSON.stringify(body));
  assert.equal(calls.length, 1);
  assert.ok(fs.existsSync(path.join(scratch, "mcp-party.json")));
});
