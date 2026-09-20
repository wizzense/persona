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
 * or by rate-characters.py for models that predate this file.
 *
 * 🚩 A CHARACTER NOBODY JUDGED IS HIDDEN LIKE AN ADULT ONE (owner, 2026-09-20:
 * "make the lewd avatars hard to find unless you've checked a box"). Until that
 * day an unrated character -- no file, or the rater's step-5 stamp `source:
 * "default"`, which means "nothing matched, nobody looked" -- read as `general`
 * and was listed to everyone; measured that morning, 62 of 66 installed
 * characters were exactly that. Browsing an unjudged roster IS how a lewd
 * model gets found, so `unrated` now sits in the hidden set while the gate is
 * closed, next to r15/r18. The cost the old comment feared (hiding the whole
 * roster) is paid ONCE by judging it: `python rate-characters.py --apply
 * --vision` looks at every model and writes a verdict with a source that is
 * not "default". See ratingReport() for what is still unjudged.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
// Same test seam as character-roster.cjs: the env var points both rating and
// roster at a per-process temp dir so parallel test processes never collide
// on the real characters/ tree (see character-roster.cjs for the measured
// incident). Production never sets the var.
const ROSTER_DIR =
  process.env.DESK_ROSTER_DIR || path.join(ROOT, "characters");
/**
 * The gate mirror. Tests point this at a per-process temp file via the env
 * var, because node --test runs test files as PARALLEL child processes and
 * two of them (content-rating, pack-roster) each wrote the real mirror —
 * measured 2026-08-25: they raced and both flaked, in different processes.
 * Production never sets the var, so the real path is unchanged.
 */
const MIRROR =
  process.env.DESK_ADULT_CONTENT_MIRROR ||
  path.join(os.homedir(), ".aither", "adult_content.json");
const RATING_FILE = "character.json";
/** Where the desk records what it OBSERVED the gate to be, and when it moved. */
const AUDIT_LOG =
  process.env.DESK_ADULT_CONTENT_LOG ||
  path.join(os.homedir(), ".aither", "adult_content.log");
const AUDIT_STATE = `${AUDIT_LOG}.state`;

/** Ratings that are hidden while the gate is closed. `unrated` is what
 *  getRating() answers for a missing file AND for a rater stamp nobody judged. */
const ADULT_RATINGS = new Set(["r18", "r15", "unrated"]);
/** Rating-file sources that mean "nobody looked": treated as unrated. */
const UNJUDGED_SOURCES = new Set(["", "default"]);

/** How restrictive each rating is, for the ceiling below. */
const RATING_ORDER = { general: 0, r15: 1, r18: 2 };

/**
 * THE THREE LIMITS, and which of them this app may change.
 *
 *   1. THE PLATFORM GATE (mirror) -- an explicit opt-in AND age verification,
 *      decided by UserPersonaConfig and mirrored to this file. The desk READS
 *      it and can never open it. Fails closed.
 *   2. THE LIVE SAFETY PLANE -- AitherSafety's own level, pushed in by main
 *      (safety-gate.cjs). It may only TIGHTEN: a plane saying "no explicit"
 *      closes what the mirror opened, and a plane that never answers changes
 *      nothing, because failing closed on an unreachable fleet service would
 *      hide the owner's whole roster every time a container restarts.
 *   3. THE DESK'S OWN CEILING -- cast.json `content.maxRating` /
 *      `content.hideUnrated`, the owner's per-machine "even when it is
 *      unlocked, not above this". Also tightening-only, which is why it is
 *      safe for awsettings to sync it between machines.
 *
 * All three AND together, and every one of them can only hide more.
 */
let safetyExplicitAllowed = null; // null = the plane has not answered

/** main pushes AitherSafety's verdict here; null forgets it (tests, a restart). */
function setSafetyExplicitAllowed(value) {
  safetyExplicitAllowed = value === null || value === undefined ? null : value === true;
}

function getSafetyExplicitAllowed() {
  return safetyExplicitAllowed;
}

/** The desk's own ceiling, from cast.json. Fails SOFT to the built-in (r18 +
 *  hideUnrated), because this file must never be the reason a roster empties. */
function contentCeiling() {
  try {
    const cast = require("./cast-config.cjs");
    const loaded = cast.load({});
    const resolved = cast.resolveContent(loaded.snapshot);
    return { maxRating: resolved.maxRating, hideUnrated: resolved.hideUnrated };
  } catch {
    return { maxRating: "r18", hideUnrated: true };
  }
}

let gateCache = null;
const GATE_CACHE_MS = 5000;

/** Whether adult characters may be listed at all. Fails CLOSED. */
function isAdultContentVisible() {
  const now = Date.now();
  if (gateCache && now - gateCache.at < GATE_CACHE_MS) return gateCache.value;
  let visible;
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

/** The recorded rating for a character, or "unrated" when none was written --
 *  or when the file carries the rater's "default" stamp, which records only
 *  that nothing matched the name and nobody looked at the model. */
function getRating(name) {
  try {
    const raw = fs.readFileSync(path.join(ROSTER_DIR, name, RATING_FILE), "utf8");
    const parsed = JSON.parse(raw);
    const rating = String(parsed.rating || "").toLowerCase();
    if (!rating) return "unrated";
    if (UNJUDGED_SOURCES.has(String(parsed.source || ""))) return "unrated";
    return rating;
  } catch {
    return "unrated";
  }
}

/** Record a rating. Returns false when it could not be written. */
function setRating(name, rating, source = "manual") {
  const dir = path.join(ROSTER_DIR, name);
  if (!fs.existsSync(dir)) return false;
  let existing;
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

/** Why this character is hidden right now, or null when it is not. */
function hiddenReason(name, ceiling = contentCeiling()) {
  const rating = getRating(name);
  const gateOpen = isAdultContentVisible() && safetyExplicitAllowed !== false;
  if (!gateOpen) {
    // Below the gate, an unjudged character is hidden WITH the adult ones: a
    // roster nobody has rated is exactly how a lewd model gets found by
    // browsing. `content.hideUnrated: false` is the owner's opt-out for a
    // roster being rated.
    if (rating === "unrated") return ceiling.hideUnrated === false ? null : "unjudged";
    if (ADULT_RATINGS.has(rating)) return "gate";
    return null;
  }
  // The gate is OPEN: the owner has said they are an adult, so an unjudged
  // character is their call, not ours -- `hideUnrated` is about being FOUND by
  // accident, which is only possible below the gate. The ceiling still applies.
  if (rating === "unrated") return null;
  const rank = RATING_ORDER[rating];
  const cap = RATING_ORDER[ceiling.maxRating];
  if (rank != null && cap != null && rank > cap) return "ceiling";
  return null;
}

/** True when this character must be hidden right now. */
function isHidden(name) {
  return hiddenReason(name) !== null;
}

/** Drop every character the three limits hide. One ceiling read per list. */
function filterCharacters(names) {
  const ceiling = contentCeiling();
  return names.filter((name) => hiddenReason(name, ceiling) === null);
}

/**
 * WHY a character cannot be used right now — null when it can.
 *
 * 🚩 Every door already refused a hidden character correctly (`installCharacter`,
 * `planSlotInstall`, `listCharacters`), and every one of them said the same
 * wrong thing on the way out: "No character named X is installed." The character
 * IS installed. It is hidden by the safety gate, and a refusal that names the
 * wrong cause sends the owner looking for a missing file that is sitting right
 * there -- exactly the "everything is broken" reading this gate is supposed to
 * avoid. Plan 40 slice F: the setting is enforced everywhere, and it SAYS SO.
 */
function refusalFor(name) {
  // An ABSENT character is the caller's message ("no such character"), never a
  // rating excuse -- `unrated` is also what getRating answers for a missing dir.
  if (!fs.existsSync(path.join(ROSTER_DIR, name))) return null;
  const ceiling = contentCeiling();
  const why = hiddenReason(name, ceiling);
  if (!why) return null;
  const rating = getRating(name);
  const reason = {
    unjudged: `${name} has not been rated yet, and an unjudged character stays hidden. `
      + "Rate the roster (python rate-characters.py --apply --vision --capture), "
      + "or set content.hideUnrated false in cast.json to browse it anyway.",
    ceiling: `${name} is rated ${rating}, above this desk's own ceiling `
      + `(content.maxRating = ${ceiling.maxRating}). Raise it with `
      + "awsettings --domain desk set content.maxRating r18.",
    gate: `${name} is rated ${rating} and mature content is currently hidden. `
      + "Turn it on in the platform's safety setting (the desk only reads it; it needs "
      + "an adult opt-in AND age verification).",
  }[why];
  return { code: "rating-hidden", rating, why, reason };
}

/**
 * Note the gate's current state, and append a line the FIRST time it changes.
 *
 * The plan asks for the flip to be auditable. The desk cannot authenticate the
 * flip -- it only reads the mirror the platform writes -- so what it records is
 * what it OBSERVED and when, which is the part a desk can honestly attest.
 * Returns the state, and whether this call saw a transition.
 */
function noteGateState(now = new Date()) {
  const visible = isAdultContentVisible();
  let previous;
  try {
    previous = JSON.parse(fs.readFileSync(AUDIT_STATE, "utf8")).visible;
  } catch {
    // No state file yet (first run) reads as "we have never seen it", so the
    // first observation is recorded rather than swallowed as "no change".
    previous = null;
  }
  if (previous === visible) return { visible, changed: false };
  let by = "unknown";
  try {
    const mirror = JSON.parse(fs.readFileSync(MIRROR, "utf8"));
    by = String(mirror.by || mirror.source || "unknown");
  } catch {
    /* an unreadable mirror is already "hidden"; the audit says who as best it can */
  }
  try {
    fs.mkdirSync(path.dirname(AUDIT_STATE), { recursive: true });
    fs.appendFileSync(
      AUDIT_LOG,
      `${now.toISOString()} mature=${visible ? "allowed" : "hidden"} by=${by}
`,
    );
    fs.writeFileSync(AUDIT_STATE, JSON.stringify({ visible, at: now.toISOString() }));
  } catch {
    // An audit that cannot be written must not stop the gate from being ENFORCED.
    return { visible, changed: true, recorded: false };
  }
  return { visible, changed: true, recorded: true };
}

/** Roster ratings, for `rate-characters.py --report` and diagnostics. */
function ratingReport() {
  let entries;
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
  RATING_ORDER,
  contentCeiling,
  hiddenReason,
  setSafetyExplicitAllowed,
  getSafetyExplicitAllowed,
  AUDIT_LOG,
  filterCharacters,
  noteGateState,
  refusalFor,
  getRating,
  invalidateGate,
  isAdultContentVisible,
  isHidden,
  ratingReport,
  setRating,
};
