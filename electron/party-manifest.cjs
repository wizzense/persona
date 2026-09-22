"use strict";

/**
 * party-manifest — the desk's WRITER of the party manifest contract.
 *
 * The party is "who appears, in which body, with which voice", exported so the
 * other avatar products (the Dark Matters guide slot, Saga, the sprite) can join
 * on ONE key: `persona_id` (AVATAR-FORGE-PIPELINE.md decision 2 — the persona id
 * names the roster folder, the cast.json binding and the guide slot; no filename
 * joins). Schema of record:
 *
 *     AitherOS/config/schemas/party-manifest.schema.json   (monorepo, version 1)
 *
 * Readers: engine/src/integrations/partyManifest.ts (Dark Matters) and
 * AitherOS/lib/avatars/party_manifest.py. `check_party_manifest.py` PM002 parses
 * MEMBER_FIELDS out of all three and the schema's `required` list and diffs them —
 * so this constant is the contract, spelled once per language, and a field added
 * here without the others fails a gate instead of a customer.
 *
 * What it reads (nothing else — "keep it to what cast.json + character-roster
 * already know"): cast.json through cast-config's own loader/resolver, the
 * characters/<name>/ tree (model.vrm, animations/*.vrma, character.json) and the
 * adult-content gate through content-rating.cjs.
 *
 * SAFETY: a character hidden by the content gate is EXCLUDED from the party, not
 * substituted. The desk hides r15/r18 bodies in every menu while the gate is
 * closed (content-rating.cjs); a manifest that still listed them would hand the
 * same body to another product that never asked the gate.
 */

const fs = require("node:fs");
const path = require("node:path");

const cast = require("./cast-config.cjs");
const roster = require("./character-roster.cjs");
const { ADULT_RATINGS, isAdultContentVisible } = require("./content-rating.cjs");

const SCHEMA_VERSION = 1;
const SOURCE = "awdesk";

/** The member field set, in the schema's order. PM002 diffs this list. */
const MEMBER_FIELDS = Object.freeze([
  "persona_id",
  "display_name",
  "character",
  "vrm",
  "animations",
  "voice",
  "presence",
  "rating",
  "saga",
  "sprite",
  "origin_key",
]);
const TOP_FIELDS = Object.freeze(["version", "exported_at", "source", "members"]);
const PRESENCE_LEVELS = Object.freeze(["off", "quiet", "normal", "chatty"]);
const RATINGS = Object.freeze(["g", "r15", "r18", "unknown"]);
const PERSONA_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PERSONA_ID_MAX = 128;

// ─── where the file lives ────────────────────────────────────────────────────

/** %APPDATA%\Desk\party.json, beside cast.json. DESK_PARTY_FILE is a TEST SEAM
 *  (same role as DESK_CAST_FILE): node --test runs files as parallel processes
 *  that would otherwise race on one real file. Outside Electron the directory is
 *  cast-config's mirrored userData path, so the checker and the desk agree. */
function PARTY_FILE() {
  const override = process.env.DESK_PARTY_FILE;
  if (override && String(override).trim()) return path.resolve(String(override).trim());
  return path.join(path.dirname(cast.CAST_FILE()), "party.json");
}

// ─── small pure helpers ──────────────────────────────────────────────────────

/** A persona id from any text: keep [A-Za-z0-9._-], collapse the rest to "-". */
function slugPersona(text) {
  const raw = String(text == null ? "" : text)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, PERSONA_ID_MAX);
  return PERSONA_ID_RE.test(raw) ? raw : "";
}

function readCharacterJson(rosterDir, name) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(rosterDir, name, "character.json"), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** character.json's rating in the schema's vocabulary. Same file and field
 *  content-rating.getRating reads; mapped, never invented. */
function ratingOf(characterJson) {
  const rating = String((characterJson && characterJson.rating) || "").toLowerCase();
  if (rating === "general" || rating === "g") return "g";
  if (rating === "r15" || rating === "r18") return rating;
  return "unknown";
}

/** Every folder under rosterDir with a model.vrm — the same test
 *  character-roster.listAllCharacters applies, over a caller-chosen dir. */
function listRoster(rosterDir) {
  try {
    return fs
      .readdirSync(rosterDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(rosterDir, e.name, "model.vrm")))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function listAnimations(rosterDir, name) {
  const dir = path.join(rosterDir, name, "animations");
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".vrma"))
      .sort()
      .map((f) => `${name}/animations/${f}`);
  } catch {
    return [];
  }
}

function pickIdObject(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out = {};
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key]) out[key] = value[key];
  }
  return Object.keys(out).length ? out : null;
}

/** Is this character hidden RIGHT NOW? The gate read is content-rating's own
 *  (fails closed: no mirror = hidden). */
function hiddenNow(rating) {
  if (isAdultContentVisible()) return false;
  return ADULT_RATINGS.has(rating);
}

// ─── building the party ──────────────────────────────────────────────────────

/** One member from a resolved actor (cast.resolveActor's return) or a bare
 *  roster character (`resolved` null). Returns { member, hidden }. */
function memberFor({ resolved, character, rosterDir, originKey }) {
  const characterJson = character ? readCharacterJson(rosterDir, character) : {};
  const rating = ratingOf(characterJson);
  const hidden = hiddenNow(rating);

  const personaId =
    slugPersona(characterJson.persona_id) ||
    slugPersona(character) ||
    slugPersona(originKey) ||
    "actor";
  const displayName =
    (resolved && resolved.displayName) || character || (resolved && resolved.kind === "relay" ? originKey.split(":").pop() : null) || personaId;

  const member = {
    persona_id: personaId,
    display_name: String(displayName).slice(0, 128),
    character: character || null,
    vrm: character ? `${character}/model.vrm` : null,
    animations: character ? listAnimations(rosterDir, character) : [],
    voice: {
      voice: resolved ? resolved.voice : cast.BUILTIN_VOICE.defaultVoice,
      speed: resolved ? resolved.speed : cast.BUILTIN_VOICE.defaultSpeed,
    },
    presence: resolved ? resolved.presence : cast.BUILTIN_ACTOR.presence,
    rating,
    saga: pickIdObject(characterJson.saga, ["project_id", "character_id"]),
    sprite: pickIdObject(characterJson.sprite, ["sprite_id"]),
    origin_key: originKey || null,
  };
  return { member, hidden };
}

/** The resolveActor ctx for a cast.json actors[...] key. A relay key is
 *  `relay:<#channel>[:<nick>]` and must be handed over as channel + nick:
 *  originOf() tokenises a bare `key` string and would fold the nick's colon
 *  into the channel, so the configured record would never match its own row. */
function ctxForKey(key) {
  const m = /^relay:(#[^:]+)(?::(.+))?$/.exec(String(key));
  if (m) return { kind: "relay", channel: m[1], nick: m[2] || undefined };
  return { key };
}

/**
 * buildParty — the manifest object, without writing it.
 *
 * Members, in order: every EXPLICITLY configured cast row (actors[...], then
 * authors and their seats), resolved with the FULL roster so a configured
 * r18 body resolves to itself and is then excluded by the gate rather than
 * silently swapped for a hashed safe one; then every roster character no row
 * claimed, with `origin_key: null` — a roster folder IS a persona (decision 2),
 * and the Dark Matters guide slot needs those too. De-duplicated on persona_id,
 * first wins.
 *
 * @returns {{manifest: object, excluded: Array<{persona_id, character, rating}>,
 *   problems: Array}}
 */
function buildParty({ castFile = undefined, rosterDir = roster.ROSTER_DIR, now = () => new Date() } = {}) {
  const loaded = cast.load(castFile ? { file: castFile } : {});
  const snapshot = loaded.snapshot || {};
  const cfg = snapshot && typeof snapshot === "object" ? snapshot : {};
  const names = listRoster(rosterDir);
  const problems = loaded.error ? [{ path: "", reason: loaded.error }] : [];

  // Two rosters, on purpose. A CONFIGURED character is judged against the full
  // roster so an r18 body resolves to itself and is then excluded (below) instead
  // of being swapped for a hashed one in silence. An UNCONFIGURED row hashes the
  // way the desk itself does -- into the SAFE roster -- so the gate never makes a
  // whole actor vanish from the party just because its fallback hash landed on a
  // hidden body.
  const safeNames = names.filter((n) => !hiddenNow(ratingOf(readCharacterJson(rosterDir, n))));
  const resolve = (ctx) => {
    const full = cast.resolveActor(snapshot, { roster: names, ...ctx });
    if (full.characterFrom !== "hash") return full;
    return cast.resolveActor(snapshot, { roster: safeNames, ...ctx });
  };

  const rows = [];
  for (const key of Object.keys(cfg.actors || {})) {
    rows.push({ originKey: key, resolved: resolve(ctxForKey(key)) });
  }
  for (const [author, record] of Object.entries(cfg.authors || {})) {
    // An author's top-level record is the TIER its seats inherit from; it is an
    // actor in its own right only when no seats are declared (then it is seat 0).
    // Emitting both would mint a phantom member per author whose hashed body
    // then shadows the real seat's persona.
    const seats = record && Array.isArray(record.seats) ? record.seats : [];
    if (seats.length === 0) {
      rows.push({ originKey: `author:${author}`, resolved: resolve({ author }) });
      continue;
    }
    seats.forEach((_seat, seat) => {
      rows.push({ originKey: `author:${author}:${seat}`, resolved: resolve({ author, seat }) });
    });
  }

  const members = [];
  const excluded = [];
  const seenPersona = new Set();
  const claimed = new Set();
  const admit = ({ member, hidden }) => {
    if (hidden) {
      if (!excluded.some((e) => e.character === member.character)) {
        excluded.push({ persona_id: member.persona_id, character: member.character, rating: member.rating });
      }
      return;
    }
    if (seenPersona.has(member.persona_id)) return;
    seenPersona.add(member.persona_id);
    if (member.character) claimed.add(member.character);
    members.push(member);
  };

  for (const row of rows) {
    const character = row.resolved.character && names.includes(row.resolved.character) ? row.resolved.character : null;
    admit(memberFor({ resolved: row.resolved, character, rosterDir, originKey: row.originKey }));
  }
  for (const name of names) {
    if (claimed.has(name)) continue;
    // What the desk WOULD resolve for this body with no row of its own: the
    // defaults tier and voice.defaultVoice, never a fresh invention.
    const resolved = cast.resolveActor(snapshot, { roster: names, key: `roster:${name}` });
    admit(memberFor({ resolved, character: name, rosterDir, originKey: null }));
  }

  const manifest = {
    version: SCHEMA_VERSION,
    exported_at: now().toISOString(),
    source: SOURCE,
    roster_dir: names.length ? path.resolve(rosterDir) : null,
    members,
  };
  return { manifest, excluded, problems };
}

// ─── the structural validator (mirrors the schema; no dependency) ────────────

/** Problems with a manifest, [] when it is a valid v1 party. Kept in the module
 *  (not only the test) so the writer REFUSES to write an invalid file. */
function validateParty(manifest) {
  const problems = [];
  const bad = (p, reason) => problems.push({ path: p, reason });
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    bad("", "manifest must be an object");
    return problems;
  }
  for (const f of TOP_FIELDS) if (!(f in manifest)) bad(f, "missing required field");
  for (const k of Object.keys(manifest)) {
    if (!TOP_FIELDS.includes(k) && k !== "roster_dir") bad(k, "unknown top-level field");
  }
  if (manifest.version !== SCHEMA_VERSION) bad("version", `must be ${SCHEMA_VERSION}`);
  if (typeof manifest.exported_at !== "string" || Number.isNaN(Date.parse(manifest.exported_at))) {
    bad("exported_at", "must be an ISO date-time string");
  }
  if (!["awdesk", "dark-matters", "saga", "forge"].includes(manifest.source)) bad("source", "unknown source");
  if (manifest.roster_dir !== undefined && manifest.roster_dir !== null && typeof manifest.roster_dir !== "string") {
    bad("roster_dir", "must be a string or null");
  }
  if (!Array.isArray(manifest.members)) {
    bad("members", "must be an array");
    return problems;
  }
  manifest.members.forEach((m, i) => {
    const at = (f) => `members[${i}].${f}`;
    if (!m || typeof m !== "object" || Array.isArray(m)) return bad(`members[${i}]`, "must be an object");
    for (const f of MEMBER_FIELDS) if (!(f in m)) bad(at(f), "missing required field");
    for (const k of Object.keys(m)) if (!MEMBER_FIELDS.includes(k)) bad(at(k), "unknown member field");
    if (typeof m.persona_id !== "string" || !PERSONA_ID_RE.test(m.persona_id) || m.persona_id.length > PERSONA_ID_MAX) {
      bad(at("persona_id"), "must match ^[A-Za-z0-9][A-Za-z0-9._-]*$ (1-128 chars)");
    }
    if (typeof m.display_name !== "string" || !m.display_name || m.display_name.length > 128) bad(at("display_name"), "1-128 chars");
    if (m.character !== null && typeof m.character !== "string") bad(at("character"), "string or null");
    if (m.vrm !== null && typeof m.vrm !== "string") bad(at("vrm"), "string or null");
    if (!Array.isArray(m.animations) || m.animations.some((a) => typeof a !== "string" || !/\.vrma$/.test(a))) {
      bad(at("animations"), "array of *.vrma paths");
    }
    const v = m.voice;
    if (!v || typeof v !== "object" || typeof v.voice !== "string" || !v.voice) bad(at("voice.voice"), "non-empty string");
    if (!v || typeof v.speed !== "number" || v.speed < 0.25 || v.speed > 4) bad(at("voice.speed"), "number 0.25-4");
    if (v && typeof v === "object" && Object.keys(v).some((k) => k !== "voice" && k !== "speed")) bad(at("voice"), "unknown key");
    if (!PRESENCE_LEVELS.includes(m.presence)) bad(at("presence"), `one of ${PRESENCE_LEVELS.join("|")}`);
    if (!RATINGS.includes(m.rating)) bad(at("rating"), `one of ${RATINGS.join("|")}`);
    if (m.saga !== null) {
      if (!m.saga || typeof m.saga !== "object" || Array.isArray(m.saga)) bad(at("saga"), "object or null");
      else for (const k of Object.keys(m.saga)) {
        if (!["project_id", "character_id"].includes(k) || typeof m.saga[k] !== "string") bad(at(`saga.${k}`), "unknown or non-string");
      }
    }
    if (m.sprite !== null) {
      if (!m.sprite || typeof m.sprite !== "object" || Array.isArray(m.sprite)) bad(at("sprite"), "object or null");
      else for (const k of Object.keys(m.sprite)) {
        if (k !== "sprite_id" || typeof m.sprite[k] !== "string") bad(at(`sprite.${k}`), "unknown or non-string");
      }
    }
    if (m.origin_key !== null && typeof m.origin_key !== "string") bad(at("origin_key"), "string or null");
    return undefined;
  });
  return problems;
}

// ─── the writer ──────────────────────────────────────────────────────────────

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

/**
 * exportParty — build, validate, write %APPDATA%\Desk\party.json.
 *
 * Never throws. An invalid build (a bug here, not bad input — cast.json is
 * read fail-soft) writes NOTHING and returns ok:false with the problems: a
 * half-right contract file is worse for its readers than a missing one.
 *
 * @returns {{ok: boolean, file: string, members: number, excluded: Array,
 *   problems: Array, error: string|null}}
 */
function exportParty({ castFile = undefined, rosterDir = roster.ROSTER_DIR, file = undefined, now = undefined } = {}) {
  const target = file ? path.resolve(file) : PARTY_FILE();
  let built;
  try {
    built = buildParty({ castFile, rosterDir, ...(now ? { now } : {}) });
  } catch (error) {
    return { ok: false, file: target, members: 0, excluded: [], problems: [], error: `build failed: ${error && error.message ? error.message : error}` };
  }
  const invalid = validateParty(built.manifest);
  if (invalid.length) {
    return { ok: false, file: target, members: 0, excluded: built.excluded, problems: [...built.problems, ...invalid], error: "manifest failed validation; nothing written" };
  }
  try {
    writeJsonAtomic(target, built.manifest);
  } catch (error) {
    return { ok: false, file: target, members: built.manifest.members.length, excluded: built.excluded, problems: built.problems, error: `write failed: ${error && error.message ? error.message : error}` };
  }
  return { ok: true, file: target, members: built.manifest.members.length, excluded: built.excluded, problems: built.problems, error: null };
}

module.exports = {
  MEMBER_FIELDS,
  PARTY_FILE,
  PERSONA_ID_RE,
  SCHEMA_VERSION,
  TOP_FIELDS,
  buildParty,
  exportParty,
  slugPersona,
  validateParty,
};
