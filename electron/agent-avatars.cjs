"use strict";

/** Per-agent avatar assignment: Aither, Atlas, Demiurge, Lyra… each get a character,
 *  so switching who you are talking to switches who is on screen.
 *
 *  Stored in .agent-avatars.json as {agent: characterName}. Any surface that knows which
 *  agent is replying (AitherShell, adk, the MCP set_agent tool) can call this and the
 *  window follows. */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const MAP_FILE = path.join(ROOT, ".agent-avatars.json");

/** Agents that exist in the platform roster; the map may hold any name, these are just
 *  what the menu offers out of the box.
 *
 *  TWO real sources, unioned LIVE on every call — not a hand-typed list, and not even a
 *  generate-once mirror (that was this file's PREVIOUS fix: it corrected the count but was
 *  still "a list someone has to remember to regenerate", the same class of staleness one
 *  layer up). This scans the actual filesystem every time, so a NEW agent pack the owner
 *  adds shows up in the menu with no regeneration step:
 *
 *  1. AGENT_ROSTER in awdk/adk/harnesses/agents.py — the "sovereign" platform agents
 *     (aither, aeon, plutus, viviane, ...) that route through Genesis /chat/stream and
 *     have no local pack of their own. Mirrored (still generated, because it's Python and
 *     Desk is Node — a cross-language read needs SOME artifact) by
 *     `python AitherOS/dev/tools/gen_persona_agent_roster.py` into agent-roster.generated.json.
 *  2. AitherOS/Library/packs/*​/{agent.yaml,brain_pack.yaml} — the REAL, larger, growing set
 *     of pack-defined agents (gargbot, saga, dgg, vera, chaos, jgames, ...) that the
 *     sovereign roster does not and should not know about (it is Genesis's list, not the
 *     owner's product-agent list). Discovery rule taken directly from awdk's own
 *     adk/pack_discovery.py (`_find_library_packs` / `discover_agent_yaml`), not
 *     reinvented — either file present means "this directory is a real agent pack", never
 *     a bare capability/tool pack like `git-github` or `skillpack-devops`, which have
 *     neither.
 *
 *  Measured 2026-08-24: source (1) alone had 13 names and was MISSING 9 real agents that
 *  exist as packs (gargbot, saga, dgg, dgg-devops, vera, chaos, jgames, gobbonet,
 *  lyra-wiki, aitherium) — a "fixed" roster that was still a stub of the owner's actual
 *  fleet, just a bigger one. */
const GENERATED_ROSTER_FILE = path.join(__dirname, "agent-roster.generated.json");
// Overridable because Desk and the monorepo can live on different drives/paths per
// machine (this repo's own storage-topology doctrine: C:\AitherOS-Fresh is canonical,
// D:\AitherOS-Fresh is not — a sibling module here, aithershell-export.cjs, still hardcodes
// the stale D: path; not fixed here, out of scope for this change, flagged for follow-up).
const AITHEROS_REPO_ROOT = process.env.AITHEROS_REPO_ROOT || "C:\\AitherOS-Fresh";
const LIBRARY_PACKS_DIR = path.join(AITHEROS_REPO_ROOT, "AitherOS", "Library", "packs");
const FALLBACK_AGENTS = ["aither"]; // deliberately minimal — a visible sign BOTH sources failed

function sovereignAgentsFromGeneratedMirror() {
  try {
    const parsed = JSON.parse(fs.readFileSync(GENERATED_ROSTER_FILE, "utf8"));
    if (Array.isArray(parsed?.agents) && parsed.agents.length > 0) return parsed.agents;
  } catch {
    /* mirror missing or unreadable — the live pack scan below still runs */
  }
  return [];
}

function packAgentsFromLibrary() {
  let entries;
  try {
    entries = fs.readdirSync(LIBRARY_PACKS_DIR, { withFileTypes: true });
  } catch {
    return []; // monorepo unreachable from this machine — pack scan contributes nothing,
    // the generated sovereign mirror (and its own fallback) still applies
  }
  const agents = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(LIBRARY_PACKS_DIR, entry.name);
    const hasAgentYaml = fs.existsSync(path.join(dir, "agent.yaml"));
    const hasBrainPack = fs.existsSync(path.join(dir, "brain_pack.yaml"));
    if (hasAgentYaml || hasBrainPack) agents.push(entry.name);
  }
  return agents;
}

function loadKnownAgents() {
  const union = new Set([...sovereignAgentsFromGeneratedMirror(), ...packAgentsFromLibrary()]);
  if (union.size === 0) return FALLBACK_AGENTS;
  return [...union].sort();
}

const KNOWN_AGENTS = loadKnownAgents();

function loadMap() {
  try {
    const parsed = JSON.parse(fs.readFileSync(MAP_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveMap(map) {
  try {
    fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 2));
    return true;
  } catch {
    return false;
  }
}

function getAgentAvatar(agent) {
  return loadMap()[String(agent).toLowerCase()] ?? null;
}

function setAgentAvatar(agent, character) {
  const map = loadMap();
  map[String(agent).toLowerCase()] = character;
  return saveMap(map);
}

function clearAgentAvatar(agent) {
  const map = loadMap();
  delete map[String(agent).toLowerCase()];
  return saveMap(map);
}

/** Agents to show in menus: the known set plus anything already assigned.
 *
 *  Re-scans live (loadKnownAgents(), not the module-level KNOWN_AGENTS constant) so a
 *  pack added to Library/packs/ while Desk is already running appears the next time
 *  the menu opens — no restart needed. The readdir + a couple of existsSync per directory
 *  is cheap enough (~80 packs) to redo on every menu build; this is not a hot path. */
function listAgents() {
  const assigned = Object.keys(loadMap());
  return [...new Set([...loadKnownAgents(), ...assigned])].sort();
}

module.exports = {
  KNOWN_AGENTS,
  clearAgentAvatar,
  getAgentAvatar,
  listAgents,
  loadMap,
  setAgentAvatar,
};
