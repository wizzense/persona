"use strict";

/** Per-agent avatar assignment: Aither, Atlas, Demiurge, Lyra… each get a character,
 *  so switching who you are talking to switches who is on screen.
 *
 *  U05, owner 2026-09-18: this is now a THIN SHIM over cast-config.cjs's
 *  `authors[*].character`, not a second store. cast.json (userData) is the
 *  one real config plane; .agent-avatars.json (cast-config.LEGACY_AVATARS_FILE(),
 *  the repo-root dotfile) is read ONCE, by cast-config.migrateLegacy(), to
 *  fold its rows in — never renamed or deleted (ownerDecisions: that is the
 *  one irreversible step in the plan and was not authorised), never read
 *  again after that. The legacy file path is left to cast-config's own
 *  resolution (not re-hardcoded here) so its DESK_AGENT_AVATARS_FILE test
 *  seam still applies to this module's one migration call.
 *
 *  The three live consumers of this module — the room-stage io, the tray
 *  Agents submenu, and deckState's agentCharacters (main.cjs) — keep their
 *  EXACT signatures: getAgentAvatar/setAgentAvatar/clearAgentAvatar/loadMap
 *  still take a bare agent name and a bare character string, so none of
 *  them, nor the peer-held Deck.tsx that renders agentCharacters, need to
 *  change for this to be true. */

const fs = require("node:fs");
const path = require("node:path");
const castConfig = require("./cast-config.cjs");

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
 *     `python AitherOS/dev/tools/gen_desk_agent_roster.py` into agent-roster.generated.json.
 *  2. AitherOS/Library/packs/<pack-name>/{agent.yaml,brain_pack.yaml} — the REAL, larger, growing set
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

/** Has cast-config's one-shot migration been asked to run, for this resolved
 *  cast file, in THIS process? cast-config.migrateLegacy() already guards
 *  itself with the on-disk `migratedLegacyAt` marker (so MAP_FILE is read at
 *  most once ever, even across process restarts) — this Set is a cheap extra
 *  tier so a hot path like listAgents() does not pay for a load()-and-return
 *  round trip into cast-config on every call once this process already knows
 *  the answer. Keyed on the resolved file, not global, because node --test
 *  runs every test in one file inside a SHARED process and different arms
 *  point DESK_CAST_FILE at different fixtures. */
const migrationAttempted = new Set();

function ensureMigrated() {
  let file;
  try {
    file = castConfig.CAST_FILE();
  } catch {
    return; // no Electron, no APPDATA, nothing resolvable — migration is skipped, not thrown
  }
  if (migrationAttempted.has(file)) return;
  migrationAttempted.add(file);
  try {
    // No avatarsFile override: cast-config resolves .agent-avatars.json
    // itself (LEGACY_AVATARS_FILE(), DESK_AGENT_AVATARS_FILE-overridable),
    // which is the seam a test fixture uses to avoid folding this
    // machine's REAL dotfile into a test's cast file.
    castConfig.migrateLegacy({ file });
  } catch {
    /* fail-soft: a migration failure must never block an avatar read/write */
  }
}

/** Pull a bare character string out of one authors[*] row. Back-compat reads
 *  BOTH shapes on purpose: the shape cast-config's schema produces today
 *  (a record, `{character, voice, ...}`) and a bare legacy-shaped string —
 *  the exact shape .agent-avatars.json held, and the shape a hand-edited or
 *  not-yet-normalised cast.json row could still carry. Neither caller of
 *  this module has ever seen anything but a string or null; that contract
 *  does not change here. */
function characterOf(row) {
  if (typeof row === "string") {
    const trimmed = row.trim();
    return trimmed ? trimmed : null;
  }
  if (row && typeof row === "object" && typeof row.character === "string" && row.character.trim()) {
    return row.character;
  }
  return null;
}

/** Read authors{} straight off disk, RAW — not through cast-config.load()'s
 *  validated snapshot. load() runs every authors[*] row through
 *  validateRecord(), which requires an object and turns a bare legacy-shaped
 *  string into {} (a dropped field, "expected an object"), which is exactly
 *  the shape characterOf() above exists to still accept. Reading raw here is
 *  what makes that contract real instead of aspirational.
 *
 *  Fail-soft to {} on anything — missing file, bad JSON, wrong top-level
 *  shape — because a missing/unreadable cast file must read as "no avatars
 *  assigned yet", not as an error surfaced to a caller that never checked
 *  for one before. */
function readAuthorsRaw() {
  let file;
  try {
    file = castConfig.CAST_FILE();
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const authors = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed.authors : null;
    return authors && typeof authors === "object" && !Array.isArray(authors) ? authors : {};
  } catch {
    return {};
  }
}

/** loadMap — {agent: characterString}, same flat shape .agent-avatars.json
 *  always held, now sourced from cast.json's authors{}. Only agents with a
 *  character actually assigned appear, same as before. */
function loadMap() {
  ensureMigrated();
  const map = {};
  try {
    for (const [key, row] of Object.entries(readAuthorsRaw())) {
      const character = characterOf(row);
      if (character) map[key] = character;
    }
  } catch {
    return {};
  }
  return map;
}

/** saveMap — writes a WHOLE {agent: characterString} map through
 *  cast-config.write() in one mutation, each entry landing at
 *  authors[<normalised agent>].character. Kept for back-compat with any
 *  caller that still holds a full map from loadMap() and wants to persist
 *  it verbatim (setAgentAvatar/clearAgentAvatar below are the per-agent
 *  path everything live actually uses). */
function saveMap(map) {
  ensureMigrated();
  try {
    const result = castConfig.write((draft) => {
      if (!draft.authors || typeof draft.authors !== "object" || Array.isArray(draft.authors)) {
        draft.authors = {};
      }
      for (const [agent, character] of Object.entries(map || {})) {
        const key = castConfig.normaliseAuthor(agent);
        if (!key) continue;
        if (!draft.authors[key] || typeof draft.authors[key] !== "object" || Array.isArray(draft.authors[key])) {
          draft.authors[key] = {};
        }
        draft.authors[key].character = character;
      }
      return draft;
    });
    return Boolean(result && result.ok);
  } catch {
    return false;
  }
}

function getAgentAvatar(agent) {
  ensureMigrated();
  try {
    const key = castConfig.normaliseAuthor(agent);
    if (!key) return null;
    return characterOf(readAuthorsRaw()[key]);
  } catch {
    return null;
  }
}

function setAgentAvatar(agent, character) {
  ensureMigrated();
  try {
    const key = castConfig.normaliseAuthor(agent);
    if (!key) return false;
    const result = castConfig.write((draft) => {
      if (!draft.authors || typeof draft.authors !== "object" || Array.isArray(draft.authors)) {
        draft.authors = {};
      }
      if (!draft.authors[key] || typeof draft.authors[key] !== "object" || Array.isArray(draft.authors[key])) {
        draft.authors[key] = {};
      }
      draft.authors[key].character = character;
      return draft;
    });
    return Boolean(result && result.ok);
  } catch {
    return false;
  }
}

/** Removes only this agent's character, leaving its voice (and anything
 *  else already authored on that row, e.g. presence, speed) untouched —
 *  a full authors[key] delete would silently undo a voice the owner picked
 *  separately. */
function clearAgentAvatar(agent) {
  ensureMigrated();
  try {
    const key = castConfig.normaliseAuthor(agent);
    if (!key) return false;
    const result = castConfig.write((draft) => {
      const row = draft.authors && typeof draft.authors === "object" ? draft.authors[key] : null;
      if (row && typeof row === "object" && !Array.isArray(row)) {
        delete row.character;
      }
      return draft;
    });
    return Boolean(result && result.ok);
  } catch {
    return false;
  }
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
  saveMap,
  setAgentAvatar,
};
