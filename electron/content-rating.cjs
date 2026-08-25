"use strict";

/**
 * Per-character content rating + the adult-content gate for the Desk roster.
 *
 * Desk is loopback-only and cannot reach the fleet, so it reads the gate from
 * the mirror the platform writes on every toggle:
 *
 *     ~/.aither/adult_content.json   ->  {"visible": true|false, ...}
 *
 * A missing, unreadable or malformed mirror is LOCKED. That is the common case
 * (the file does not exist until the user first toggles the setting), and it is
 * the correct default: an avatar app that cannot read the gate must not put an
 * R18 character in a quick-switch menu.
 *
 * A character's rating lives at characters/<name>/character.json:
 *
 *     {"rating": "general" | "r15" | "r18", "source": "vroid" | "manual" | "heuristic"}
 *
 * Written at enroll time from VRoid Hub's own age_limit flags (authoritative),
 * or by rate-characters.py for models that predate this file. `general` is the
 * default for an unrated character, because hiding the whole roster the moment
 * metadata is missing would make the avatar unusable — see ratingReport() for
 * how to find the unrated ones.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const ROSTER_DIR = path.join(ROOT, "characters");
const MIRROR = path.join(os.homedir(), ".aither", "adult_content.json");
const RATING_FILE = "character.json";

/** Ratings that are hidden while the gate is closed. */
const ADULT_RATINGS = new Set(["r18", "r15"]);

let gateCache = null;
const GATE_CACHE_MS = 5000;

/** Whether adult characters may be listed at all. Fails CLOSED. */
function isAdultContentVisible() {
  const now = Date.now();
  if (gateCache && now - gateCache.at < GATE_CACHE_MS) return gateCache.value;
  let visible = false;
  try {
    visible = JSON.parse(fs.readFileSync(MIRROR, "utf8")).visible === true;
  } catch {
    visible = false;
  }
  gateCache = { value: visible, at: now };
  return visible;
}

/** Drop the gate cache (the mirror changed, or a test wants a fresh read). */
function invalidateGate() {
  gateCache = null;
}

/** The recorded rating for a character, or "unrated" when none was written. */
function getRating(name) {
  try {
    const raw = fs.readFileSync(path.join(ROSTER_DIR, name, RATING_FILE), "utf8");
    const rating = String(JSON.parse(raw).rating || "").toLowerCase();
    return rating || "unrated";
  } catch {
    return "unrated";
  }
}

/** Record a rating. Returns false when it could not be written. */
function setRating(name, rating, source = "manual") {
  const dir = path.join(ROSTER_DIR, name);
  if (!fs.existsSync(dir)) return false;
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(path.join(dir, RATING_FILE), "utf8"));
  } catch {
    existing = {};
  }
  try {
    fs.writeFileSync(
      path.join(dir, RATING_FILE),
      JSON.stringify({ ...existing, rating, source }, null, 2),
    );
    return true;
  } catch {
    return false;
  }
}

/** True when this character must be hidden right now. */
function isHidden(name) {
  if (isAdultContentVisible()) return false;
  return ADULT_RATINGS.has(getRating(name));
}

/** Drop every adult-rated character from a list while the gate is closed. */
function filterCharacters(names) {
  if (isAdultContentVisible()) return names;
  return names.filter((name) => !ADULT_RATINGS.has(getRating(name)));
}

/** Roster ratings, for `rate-characters.py --report` and diagnostics. */
function ratingReport() {
  let entries = [];
  try {
    entries = fs.readdirSync(ROSTER_DIR, { withFileTypes: true });
  } catch {
    return { adultVisible: isAdultContentVisible(), characters: [] };
  }
  return {
    adultVisible: isAdultContentVisible(),
    characters: entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, rating: getRating(entry.name) })),
  };
}

module.exports = {
  ADULT_RATINGS,
  filterCharacters,
  getRating,
  invalidateGate,
  isAdultContentVisible,
  isHidden,
  ratingReport,
  setRating,
};
