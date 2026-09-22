"use strict";

/**
 * cast-config — the ONE config plane for the room's cast: who gets a body, who
 * may speak, what they sound like, and where they stand.
 *
 * Owner, 2026-09-18: avatars, voices and presence were guessed. Three rival
 * planes decided them and none of them was a file the owner could author:
 *   - `.agent-avatars.json` (agent -> character), repo-root, per-name
 *   - `AGENT_VOICES` + a second hash, hardcoded in room-stage.cjs
 *   - `DESK_ROOM_MAX_BODIES` / `DESK_ROOM_IDLE_S` / `DESK_VOICE_SPEED` env vars
 * Nothing keyed on the room ACTOR, so every parallel Claude Code session in one
 * repo shared a name, a voice and (before slotFor's id suffix) a body; and
 * `Number(env) || 3` could not express "zero bodies" at all.
 *
 * This module is that one file: `cast.json` under app.getPath("userData"),
 * read through a PURE validator and a FIELD-LEVEL resolver that reports WHY
 * every value is what it is. The pane has to be able to say "this agent sounds
 * like that because of authors.aitheros-fresh.seats[1]", not "because of a
 * hash somewhere".
 *
 * Shape (v1) and the resolution order are documented at validateCast() and
 * resolveActor() below. Two rules earn their own line:
 *
 *   FAIL SOFT, NEVER THROW. Every settings reader in this tree fails soft
 *   (loadSavedSize, sanitizeLayout, content-rating). A loader that
 *   throws on a bad byte would be the only thing here that can brick launch,
 *   so a malformed file keeps the LAST GOOD snapshot, copies the bad bytes to
 *   cast.invalid.json and surfaces an `error` string — it never silently
 *   substitutes defaults, and it never takes the process down.
 *
 *   DROP, DO NOT CLAMP, PER FIELD. Straight from useAvatarLayout.ts sane():
 *   clamping a nonsense value pins the owner to something he never chose. One
 *   bad `speed` costs that one field (it falls through to the next tier and
 *   lands in problems[] with path + value + reason); it never costs the file.
 *   zod is deliberately not used: it is this tree's MCP-tool-input validator,
 *   it throws, and it would be the only reader here that can brick launch.
 *
 * 🚩 RESIDUAL RISK — THIS IS A GRANT LIST, NOT CALLER AUTHORIZATION.
 * Origin keys are STAMPED locally at each call site (see originOf); an
 * origin/actor field arriving in a request body is ignored, never honoured.
 * But `actor.id` is itself a payload field the room echoes, so a process that
 * can publish to the room can claim another actor's id and inherit its grant.
 * Treat cast.json as "what the owner has chosen to hear", not as authentication.
 * The refusal funnel that actually matters is speakAloud; this file decides
 * presence, bodies and voices.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// ─── where the file lives ────────────────────────────────────────────────────

/** userData, resolved LAZILY. app.getPath() is not ready at require time, so
 *  this is a function and never a module-level const — the same shape as
 *  main.cjs's SIZE_STATE_PATH (main.cjs:206). Outside Electron (tests, the
 *  CAST00x checker, a one-off script) it mirrors app.setName("Desk")
 *  (main.cjs:317). 🚩 That mirror is a COPY of a name defined elsewhere: if
 *  main.cjs ever calls setName() with something else, this fallback lies and
 *  the checker reads an empty file while the desk reads a full one. */
function userDataDir() {
  try {
    // In plain node `require("electron")` resolves to the module that exports
    // the executable PATH (a string), not the Electron API — hence the
    // typeof check rather than a bare truthiness test.
    const electron = require("electron");
    const app = electron && electron.app;
    if (app && typeof app.getPath === "function") return app.getPath("userData");
  } catch {
    /* not running inside Electron — fall through to the mirrored path */
  }
  const name = "Desk";
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), name);
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", name);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), name);
}

/** The cast file. DESK_CAST_FILE is a TEST SEAM, not configuration — the same
 *  role DESK_ADULT_CONTENT_MIRROR plays for the content gate, because
 *  `node --test` runs test files as parallel child processes that would
 *  otherwise race on one real file. */
function CAST_FILE() {
  const override = process.env.DESK_CAST_FILE;
  if (override && String(override).trim()) return path.resolve(String(override).trim());
  return path.join(userDataDir(), "cast.json");
}

/** Siblings derived from the cast file's own basename, so two fixtures in one
 *  tmpdir (cast-a.json / cast-b.json) do not share a seen-book. */
function sibling(file, suffix) {
  const resolved = path.resolve(file || CAST_FILE());
  const dir = path.dirname(resolved);
  const base = path.basename(resolved).replace(/\.json$/i, "");
  return path.join(dir, `${base}${suffix}`);
}

/** Origins seen but not configured: how a muted agent is discoverable in one
 *  click instead of by reading code. */
const SEEN_FILE = (file) => sibling(file, "-seen.json");
/** The bytes that did not parse, kept verbatim so the owner can fix them. */
const INVALID_FILE = (file) => sibling(file, ".invalid.json");

/** The legacy avatar map this module migrates ONCE. Copied, never renamed or
 *  deleted (ownerDecisions: deleting the hand-authored dotfiles is the only
 *  irreversible step in the plan and was not authorised). */
function LEGACY_AVATARS_FILE() {
  const override = process.env.DESK_AGENT_AVATARS_FILE;
  if (override && String(override).trim()) return path.resolve(String(override).trim());
  return path.join(__dirname, "..", ".agent-avatars.json");
}

// ─── the built-in tier (the floor under the file, the env and the hash) ──────

const SPEED_MIN = 0.25;
const SPEED_MAX = 4.0;
/** Same bound, and the same reason, as useAvatarLayout.ts POSITION_BOUND:
 *  full-body framing shows about ±2 units of stage, so an entry at x=8 is not
 *  a placement, it is an avatar the owner can neither see nor grab. */
const POSITION_BOUND = 2;
const SCALE_MIN = 0.05;
const SCALE_MAX = 10;

const PRESENCE_LEVELS = ["off", "quiet", "normal", "chatty"];

/** Loudness is a MIXER, not an override: the effective gain is the master
 *  fader times the speaker's own fader. An override would make "turn everyone
 *  down" a walk through every record, and would let one authored actor ignore
 *  the master the owner just pulled. The master stops at 1 (it is the ceiling
 *  the owner set for the room); an actor may go to 2 because voices are not
 *  equally loud at the source and a quiet one needs a boost to MATCH. */
const MASTER_VOLUME_MAX = 1;
const ACTOR_VOLUME_MAX = 2;

/** AitherVoice's voice names. A voice that is not in this list is still legal
 *  in the file (the service may know more than the desk does); this is only
 *  the pool the stable hash draws from. */
const VOICES = ["nova", "alloy", "echo", "fable", "onyx", "shimmer"];

const BUILTIN_STAGE = Object.freeze({
  maxBodies: 3,
  idleSeconds: 600,
  cooldownSeconds: 20,
  gapMs: 350,
  pollMs: 2000,
  resident: null,
  bubbles: true,
});

const BUILTIN_VOICE = Object.freeze({
  defaultVoice: "nova",
  defaultSpeed: 1.35,
  maxChars: 2000,
  endpoint: Object.freeze({ host: "127.0.0.1", port: 8084, path: "/voice/synthesize" }),
  speechFilter: Object.freeze({ maxChars: 220, allowCode: false }),
  affectIntensity: 1,
  volume: 1,
  muted: false,
});

/** The desk's own content ceiling. It is NOT the adult gate: the gate is the
 *  platform's two halves (an explicit opt-in AND age verification, mirrored to
 *  ~/.aither/adult_content.json by UserPersonaConfig) and nothing in this file
 *  or this app can open it. This is a SECOND limit under it, which the owner
 *  sets per machine: "even when mature content is unlocked, this desk shows
 *  nothing above <rating>". Default r18 = "whatever the gate allows".
 *
 *  It can only ever hide more, so it is safe to sync between machines (the
 *  awsettings DESK domain carries it): an r18 ceiling arriving on a machine
 *  whose gate is shut still shows nothing.
 *
 *  `hideUnrated` is the other half of the owner's 2026-09-20 ask -- a character
 *  nobody has judged is hidden with the adult ones. It defaults ON and lives
 *  here so a roster being rated can be browsed deliberately, never by accident. */
const CONTENT_RATINGS = ["general", "r15", "r18"];

const BUILTIN_CONTENT = Object.freeze({
  maxRating: "r18",
  hideUnrated: true,
});

const CONTENT_FIELDS = Object.freeze({
  maxRating: (v) => vEnum(v, CONTENT_RATINGS),
  hideUnrated: vBool,
});

const BUILTIN_ACTOR = Object.freeze({
  presence: "normal",
  speak: true,
  body: true,
  volume: 1,
  bubble: true,
});

/** The origin keys that are hardcoded at their injection sites. Exported so a
 *  caller stamps a CONSTANT instead of retyping a string that would silently
 *  never match a record. */
const ORIGIN_LITERALS = Object.freeze({
  BRIDGE_SPEAK: "bridge:/speak",
  MCP_SPEAK: "mcp:speak",
  DESK_DROP: "desk:drop",
  SERVICE_AWDESK: "service:awdesk",
});

/** A FROZEN COPY of room-stage.cjs's AGENT_VOICES as it stood on 2026-09-18.
 *  Deliberately duplicated rather than required: migration's whole job is to
 *  write out what the owner ALREADY recognises, so unifying the two rival
 *  hashes cannot reshuffle those ten agents. Requiring the live constant would
 *  make the migration's output move when that file changes, which is the
 *  opposite of a migration. */
const LEGACY_AGENT_VOICES = Object.freeze({
  aither: "nova",
  atlas: "onyx",
  demiurge: "echo",
  lyra: "shimmer",
  hydra: "fable",
  athena: "alloy",
  apollo: "echo",
  prometheus: "onyx",
  scribe: "fable",
  awdesk: "nova",
});

// ─── small pure helpers ──────────────────────────────────────────────────────

/** h=7, h*33 — the SAME constants room-stage's pickCharacter used, kept so a
 *  seed that already had a body keeps it across this change. */
function hash33(text) {
  const s = String(text == null ? "" : text);
  let h = 7;
  for (let i = 0; i < s.length; i += 1) h = (h * 33 + s.charCodeAt(i)) >>> 0;
  return h;
}

function normaliseAuthor(author) {
  return String(author == null ? "" : author).trim().toLowerCase().slice(0, 80);
}

/** Channel keys are stored and looked up as "#name", lowercased, so a file
 *  written as "agents" still matches a stamped "#Agents". Normalising is not
 *  dropping: nothing is discarded here. */
function channelKey(channel) {
  const s = String(channel == null ? "" : channel).trim().toLowerCase();
  if (!s) return null;
  return s.startsWith("#") ? s.slice(0, 80) : `#${s}`.slice(0, 80);
}

/** Origin-key tokens: printable, no separators that could forge another tier.
 *  An id may NOT contain ":" — that is what stops a room row whose actor.id is
 *  a payload field from claiming `relay:#agents` or another kind's namespace.
 *  "*" survives only as the whole token (the class form). */
function safeToken(value, { allowSlash = false } = {}) {
  let s = String(value == null ? "" : value).trim();
  if (s === "*") return "*";
  const keep = allowSlash ? /[^A-Za-z0-9._#/@+-]+/g : /[^A-Za-z0-9._#@+-]+/g;
  s = s.replace(keep, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, 120);
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function quoteKey(key) {
  return JSON.stringify(String(key));
}

function statMtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  // tmp + renameSync, so a reader (or a crash) never sees half a file. The tmp
  // name carries the pid because parallel `node --test` children share a dir.
  const tmp = `${resolved}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, resolved);
}

// ─── field validators (pure; every one returns a verdict, never throws) ─────

function vString(value, { max = 120 } = {}) {
  if (typeof value !== "string") return { ok: false, reason: "expected a string" };
  const s = value.trim();
  if (!s) return { ok: false, reason: "expected a non-empty string" };
  if (s.length > max) return { ok: false, reason: `longer than ${max} characters` };
  return { ok: true, value: s };
}

function vBool(value) {
  return typeof value === "boolean"
    ? { ok: true, value }
    : { ok: false, reason: "expected true or false" };
}

function vNumber(value, { min = -Infinity, max = Infinity } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, reason: "expected a finite number" };
  }
  if (value < min || value > max) {
    return { ok: false, reason: `outside ${min}..${max === Infinity ? "∞" : max}` };
  }
  return { ok: true, value };
}

function vInt(value, { min = -Infinity, max = Infinity } = {}) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return { ok: false, reason: "expected a whole number" };
  }
  return vNumber(value, { min, max });
}

function vEnum(value, allowed) {
  if (typeof value !== "string" || !allowed.includes(value)) {
    return { ok: false, reason: `expected one of ${allowed.join(" | ")}` };
  }
  return { ok: true, value };
}

/** A placement is all-or-nothing, exactly like sane() in useAvatarLayout.ts:
 *  a half-valid transform is not a placement. The verdict names the offending
 *  sub-path (`at`) so problems[] can point at position[0], not at "place". */
function vPlace(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "expected {position:[x,y,z], scale, yaw?}" };
  }
  const pos = value.position;
  if (!Array.isArray(pos) || pos.length !== 3) {
    return { ok: false, at: "position", value: pos, reason: "position must be [x,y,z]" };
  }
  for (let i = 0; i < 3; i += 1) {
    const v = pos[i];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return { ok: false, at: `position[${i}]`, value: v, reason: "not a finite number" };
    }
    if (Math.abs(v) > POSITION_BOUND) {
      return {
        ok: false,
        at: `position[${i}]`,
        value: v,
        reason: `outside the visible stage (|v| <= ${POSITION_BOUND})`,
      };
    }
  }
  const scaleVerdict = vNumber(value.scale, { min: SCALE_MIN, max: SCALE_MAX });
  if (!scaleVerdict.ok) {
    return { ok: false, at: "scale", value: value.scale, reason: scaleVerdict.reason };
  }
  const yaw = value.yaw;
  if (yaw !== undefined && yaw !== null) {
    const yawVerdict = vNumber(yaw);
    if (!yawVerdict.ok) {
      return { ok: false, at: "yaw", value: yaw, reason: `${yawVerdict.reason} (radians)` };
    }
  }
  const unknown = Object.keys(value).filter((k) => !["position", "scale", "yaw"].includes(k));
  if (unknown.length) {
    return { ok: false, value: unknown, reason: `unknown key(s): ${unknown.join(", ")}` };
  }
  const out = { position: [pos[0], pos[1], pos[2]], scale: scaleVerdict.value };
  if (typeof yaw === "number") out.yaw = yaw;
  return { ok: true, value: out };
}

// ─── spring-bone physics: how much a body moves ──────────────────────────────
// Owner, 2026-09-20: "I love it but sometimes it's a little too much and I'd
// like to be able to tune it per avatar/agent." The renderer's springs were
// fixed at what the model authored (plus the defaults useVrmLoader.ts
// invents); nothing the owner could write reached them. These five knobs are
// MULTIPLIERS over the authored values (1 = as the model's author meant it),
// so a model that is already gentle stays gentle at the default and the same
// file works on every model in the roster. The renderer applies them per
// joint in useVrmLoader.ts's applySpringScale, on top of the size compensation.
//
//   enabled    false freezes every chain at its authored rest pose.
//   weight     × gravityPower -- how hard hair/tails/cloth hang down.
//   stiffness  × stiffness -- how fast a chain springs back to its shape
//                (higher = less swing).
//   damping    × dragForce -- how quickly motion dies out (higher = fewer
//                bounces; the renderer clamps the product to three-vrm's 0..1).
//   jiggle     the BODY chains only (chest and hips, useVrmLoader.ts's
//                BODY_JIGGLE_CHAIN): 1 as authored, 0 pins them still, 2 twice
//                as loose. Separate from the others because those chains are
//                the ones the owner named, and a hair fader must not touch them.
//
// Resolved PER SUB-KEY across the tiers (an actor row may set only `jiggle`
// and inherit `weight` from defaults), each with its own provenance string,
// so the pane can say "jiggle 0.5 from actors[...].physics.jiggle".
const PHYSICS_MULTIPLIER_MAX = 3;
const JIGGLE_MAX = 2;

const BUILTIN_PHYSICS = Object.freeze({
  enabled: true,
  weight: 1,
  stiffness: 1,
  damping: 1,
  jiggle: 1,
});

const PHYSICS_FIELDS = Object.freeze({
  enabled: vBool,
  weight: (v) => vNumber(v, { min: 0, max: PHYSICS_MULTIPLIER_MAX }),
  stiffness: (v) => vNumber(v, { min: 0, max: PHYSICS_MULTIPLIER_MAX }),
  damping: (v) => vNumber(v, { min: 0, max: PHYSICS_MULTIPLIER_MAX }),
  jiggle: (v) => vNumber(v, { min: 0, max: JIGGLE_MAX }),
});

/** A physics block is validated as a WHOLE like vPlace: one bad sub-value or
 *  unknown key costs this tier's block (it lands in problems[] with the
 *  sub-path) and the sub-keys fall through to the next tier. `null` on a
 *  sub-key is an explicit "unset here", dropped from the value so the tier
 *  below answers it. */
function vPhysics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: `expected {${Object.keys(PHYSICS_FIELDS).join("?, ")}?}` };
  }
  const unknown = Object.keys(value).filter((k) => !(k in PHYSICS_FIELDS));
  if (unknown.length) {
    return { ok: false, value: unknown, reason: `unknown key(s): ${unknown.join(", ")}` };
  }
  const out = {};
  for (const [key, validate] of Object.entries(PHYSICS_FIELDS)) {
    const v = value[key];
    if (v === undefined || v === null) continue;
    const verdict = validate(v);
    if (!verdict.ok) return { ok: false, at: key, value: v, reason: verdict.reason };
    out[key] = verdict.value;
  }
  return { ok: true, value: out };
}

/** One ActorConfig field table, used BOTH by validateCast (file time) and by
 *  resolveActor (resolve time). One table means a value the file rejects can
 *  never be honoured by a caller that hands resolveActor a raw object. */
const ACTOR_FIELDS = Object.freeze({
  displayName: (v) => vString(v, { max: 64 }),
  character: (v) => vString(v, { max: 120 }),
  voice: (v) => vString(v, { max: 40 }),
  speed: (v) => vNumber(v, { min: SPEED_MIN, max: SPEED_MAX }),
  volume: (v) => vNumber(v, { min: 0, max: ACTOR_VOLUME_MAX }),
  bubble: vBool,
  presence: (v) => vEnum(v, PRESENCE_LEVELS),
  speak: vBool,
  body: vBool,
  place: vPlace,
  physics: vPhysics,
  cooldownSeconds: (v) => vNumber(v, { min: 0 }),
  idleSeconds: (v) => vInt(v, { min: 30 }),
  maxChars: (v) => vInt(v, { min: 40, max: 2000 }),
});

const STAGE_FIELDS = Object.freeze({
  maxBodies: (v) => vInt(v, { min: 0, max: 6 }),
  idleSeconds: (v) => vInt(v, { min: 30 }),
  cooldownSeconds: (v) => vNumber(v, { min: 0 }),
  gapMs: (v) => vInt(v, { min: 0 }),
  pollMs: (v) => vInt(v, { min: 250 }),
  resident: (v) => vString(v, { max: 120 }),
  bubbles: vBool,
});

const VOICE_FIELDS = Object.freeze({
  defaultVoice: (v) => vString(v, { max: 40 }),
  defaultSpeed: (v) => vNumber(v, { min: SPEED_MIN, max: SPEED_MAX }),
  maxChars: (v) => vInt(v, { min: 40, max: 2000 }),
  affectIntensity: (v) => vNumber(v, { min: 0, max: 1 }),
  volume: (v) => vNumber(v, { min: 0, max: MASTER_VOLUME_MAX }),
  muted: vBool,
});

const ENDPOINT_FIELDS = Object.freeze({
  host: (v) => vString(v, { max: 200 }),
  port: (v) => vInt(v, { min: 1, max: 65535 }),
  path: (v) => {
    const verdict = vString(v, { max: 200 });
    if (!verdict.ok) return verdict;
    if (!verdict.value.startsWith("/")) return { ok: false, reason: "must start with /" };
    return verdict;
  },
});

const SPEECH_FILTER_FIELDS = Object.freeze({
  maxChars: (v) => vInt(v, { min: 40, max: 2000 }),
  allowCode: vBool,
});

// Plan: voice INPUT + configurable hotkeys (owner, 2026-09-22: "configure voice
// input and speaker output... give us hotkeys thats are configurable"). Separate
// from `voice` (output/TTS) on purpose -- input is capture + a talk MODE, output
// is synthesis; conflating them is how a mute toggle ends up muting the avatar's
// mouth instead of the microphone.
const TALK_MODES = Object.freeze(["toggle", "hold", "open"]);

const INPUT_FIELDS = Object.freeze({
  micDeviceId: (v) => vString(v, { max: 200 }),
  // Chromium deviceIds are per-machine/per-origin and can rotate on a driver
  // update; the LABEL is what a human recognizes and what re-matching falls
  // back to when the id no longer resolves.
  micDeviceLabel: (v) => vString(v, { max: 200 }),
  micMuted: vBool,
  talkMode: (v) => vEnum(v, TALK_MODES),
});

const BUILTIN_INPUT = Object.freeze({
  micDeviceId: "",
  micDeviceLabel: "",
  micMuted: false,
  talkMode: "toggle",
});

// hotkeys{} is a dynamic id->accel map (command-registry ids), not a fixed
// record, so it is validated inline in validateCast rather than via
// validateRecord/FIELDS like every other section.
function vAccelString(v) {
  return vString(v, { max: 60 });
}

const CHANNEL_FIELDS = Object.freeze({
  voiced: vBool,
  presence: (v) => vEnum(v, PRESENCE_LEVELS),
});

// ─── the desk's OWN behaviour: which model, which words, which eyes ─────────
// Each of these existed already -- as an environment variable nobody could
// author from a pane, or as a string constant in one module. They are in THIS
// file for the same reason the cast is: one place the owner writes, with a
// provenance string saying why each value is what it is. None is decoration;
// every field below names the consumer it changes.

/** A launcher profile id: the shape claude-backend's own table uses. Tight on
 *  purpose -- this string is handed to a helper script as an ARGUMENT. */
function vProfile(value) {
  const verdict = vString(value, { max: 40 });
  if (!verdict.ok) return verdict;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(verdict.value)) {
    return { ok: false, reason: "letters, digits, dot, underscore and dash only" };
  }
  return verdict;
}

function vHttpUrl(value) {
  const verdict = vString(value, { max: 400 });
  if (!verdict.ok) return verdict;
  if (!/^https?:\/\/[^\s]+$/i.test(verdict.value)) return { ok: false, reason: "must be an http(s) URL" };
  return verdict;
}

/** models.commandProfile -> backend-profile.cjs: the backend the Command pane's
 *  agent runs on. Was AWDESK_CLAUDE_PROFILE, which is now the tier below. */
const MODELS_FIELDS = Object.freeze({
  commandProfile: vProfile,
});

/** prompts.* -> command-agent.cjs. Both are ADDED to the built-in instruction,
 *  never a replacement for it: the built-in carries the "raise a decision card,
 *  do not ask questions" protocol, and an owner tuning a persona must not be
 *  able to delete the thing that stops a headless agent from hanging. */
const PROMPTS_FIELDS = Object.freeze({
  commandPersona: (v) => vString(v, { max: 400 }),
  commandAppend: (v) => vString(v, { max: 2000 }),
});

/** vision.* -> drop-router.cjs's image lane (a dropped picture or a video's
 *  first frame). `enabled: false` skips the look entirely and says so. */
const VISION_FIELDS = Object.freeze({
  enabled: vBool,
  imagePrompt: (v) => vString(v, { max: 1000 }),
});

/** sync.* -> settings-sync.cjs. DEVICE-LOCAL by construction: `profile` and
 *  `tokenFile` are paths on THIS machine, so the sync tool never sends this
 *  section and refuses one that arrives. Off until the owner turns it on. */
const SYNC_FIELDS = Object.freeze({
  enabled: vBool,
  profile: (v) => vString(v, { max: 400 }),
  url: vHttpUrl,
  tokenFile: (v) => vString(v, { max: 400 }),
  pullOnStart: vBool,
  pushOnChange: vBool,
});

const BUILTIN_DESK = Object.freeze({
  models: Object.freeze({ commandProfile: "deepseek" }),
  prompts: Object.freeze({ commandPersona: null, commandAppend: null }),
  vision: Object.freeze({ enabled: true, imagePrompt: null }),
  sync: Object.freeze({
    enabled: false, profile: null, url: null, tokenFile: null, pullOnStart: true, pushOnChange: true,
  }),
});

const DESK_SECTIONS = Object.freeze({
  models: MODELS_FIELDS,
  prompts: PROMPTS_FIELDS,
  vision: VISION_FIELDS,
  sync: SYNC_FIELDS,
});

function pushProblem(problems, prefix, field, raw, verdict) {
  const at = verdict && verdict.at ? `${field}.${verdict.at}` : field;
  problems.push({
    path: prefix ? `${prefix}.${at}` : at,
    value: verdict && verdict.value !== undefined ? verdict.value : raw,
    reason: (verdict && verdict.reason) || "rejected",
  });
}

/**
 * Validate one record against a field table. SPARSE by design: only keys that
 * are present AND valid come out. That is what makes field-level precedence
 * possible — a record holding just `voice` must not shadow the tier below it
 * for `presence`, and `null` must mean "unset", not "off".
 */
function validateRecord(raw, fields, prefix, problems, { extraKeys = [] } = {}) {
  const out = {};
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    problems.push({ path: prefix, value: raw, reason: "expected an object" });
    return out;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (extraKeys.includes(key)) continue; // handled by the caller (e.g. seats)
    const validate = fields[key];
    if (!validate) {
      // Reported, never dropped in silence: a typo'd key is the difference
      // between "the file does nothing" and "the file has a typo on line 12".
      problems.push({
        path: prefix ? `${prefix}.${key}` : key,
        value,
        reason: `unknown key (known: ${Object.keys(fields).sort().join(", ")})`,
      });
      continue;
    }
    if (value === null || value === undefined) continue; // explicit "unset"
    const verdict = validate(value);
    if (!verdict.ok) {
      pushProblem(problems, prefix, key, value, verdict);
      continue;
    }
    out[key] = verdict.value;
  }
  return out;
}

function emptyConfig() {
  return {
    version: 1,
    stage: {},
    voice: { endpoint: {}, speechFilter: {} },
    defaults: {},
    authors: {},
    actors: {},
    channels: {},
    models: {},
    prompts: {},
    vision: {},
    sync: {},
    content: {},
    input: {},
    hotkeys: {},
    appearance: { ...BUILTIN_APPEARANCE },
    migratedLegacyAt: null,
  };
}

const TOP_LEVEL_KEYS = [
  "version", "stage", "voice", "input", "hotkeys", "defaults", "authors", "actors",
  "channels", "models", "prompts", "vision", "sync", "content", "appearance",
  "migratedLegacyAt",
];

/**
 * appearance -- which of the FAMILY's themes the desk wears, and how big.
 *
 * Owner, 2026-09-20: the desk "needs to be better integrated into the design" of
 * awsh, the workspace and the Living Desktop. Those share eleven theme ids; the
 * desk had seven private palettes and no theme at all. The ids are not typed here:
 * they are read from aither-themes.json, which gen_desk_tokens.py GENERATES from
 * Veil's themes.ts, so a theme Veil adds is a theme the desk accepts and a typo is
 * a named problem instead of a silently unstyled window.
 *
 * It lives in cast.json (not a new file) because cast.json is the desk's one
 * synced settings file: the awsettings `desk` domain carries it between machines.
 */
const BUILTIN_APPEARANCE = Object.freeze({ theme: "dark-glass", uiScale: 1 });
const UI_SCALE_MIN = 0.85;
const UI_SCALE_MAX = 1.35;

function knownThemes() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(__dirname, "aither-themes.json"), "utf8"));
    const ids = (parsed.themes || []).map((theme) => String(theme.id));
    if (ids.length) return ids;
  } catch {
    /* fall through: a missing generated file must not make every theme invalid */
  }
  return [BUILTIN_APPEARANCE.theme];
}

function validateAppearance(raw, problems) {
  const out = { ...BUILTIN_APPEARANCE };
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    problems.push({ path: "appearance", value: raw, reason: "expected an object" });
    return out;
  }
  for (const key of Object.keys(raw)) {
    if (key !== "theme" && key !== "uiScale") {
      problems.push({ path: `appearance.${key}`, value: raw[key], reason: "unknown key (known: theme, uiScale)" });
    }
  }
  if (raw.theme !== undefined) {
    const themes = knownThemes();
    if (typeof raw.theme === "string" && themes.includes(raw.theme)) out.theme = raw.theme;
    else problems.push({ path: "appearance.theme", value: raw.theme, reason: `expected one of: ${themes.join(", ")}` });
  }
  if (raw.uiScale !== undefined) {
    const n = Number(raw.uiScale);
    if (Number.isFinite(n) && n >= UI_SCALE_MIN && n <= UI_SCALE_MAX) out.uiScale = n;
    else problems.push({ path: "appearance.uiScale", value: raw.uiScale, reason: `expected ${UI_SCALE_MIN}-${UI_SCALE_MAX}` });
  }
  return out;
}

/**
 * validateCast — the pure reader of the v1 file shape. Never throws.
 *
 * {
 *   version: 1,
 *   stage:   { maxBodies 0-6, idleSeconds >=30, cooldownSeconds >=0,
 *              gapMs >=0, pollMs >=250, resident string|null },
 *   voice:   { defaultVoice, defaultSpeed 0.25-4, maxChars 40-2000,
 *              endpoint {host, port, path}, speechFilter {maxChars, allowCode},
 *              affectIntensity 0-1 },
 *   defaults: ActorConfig,
 *   authors:  { "<lowercased author>": ActorConfig & { seats: ActorConfig[] } },
 *   actors:   { "<origin key>": ActorConfig },
 *   channels: { "#chan": { voiced (default FALSE), presence|null } }
 * }
 * ActorConfig.physics: { enabled, weight 0-3, stiffness 0-3, damping 0-3,
 *   jiggle 0-2 } -- multipliers over the model's authored springs, resolved
 *   per sub-key (see PHYSICS_FIELDS). The resident avatar (slot0) reads
 *   `actors["service:awdesk"]`, the same key its own voice does.
 *
 * @returns {{config: object|null, problems: Array<{path,value,reason}>, fatal: boolean}}
 *   `fatal` marks a whole-file, parse-class refusal (not an object, or a
 *   version this build does not read): load() then keeps the last good
 *   snapshot instead of pretending the file said nothing.
 */
function validateCast(raw) {
  const problems = [];
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    problems.push({ path: "", value: raw, reason: "cast.json must be a JSON object" });
    return { config: null, problems, fatal: true };
  }
  if (raw.version === undefined) {
    problems.push({ path: "version", value: undefined, reason: "missing; read as version 1" });
  } else if (raw.version !== 1) {
    problems.push({
      path: "version",
      value: raw.version,
      reason: "unsupported cast.json version (this build reads version 1)",
    });
    return { config: null, problems, fatal: true };
  }

  const config = emptyConfig();
  config.stage = validateRecord(raw.stage, STAGE_FIELDS, "stage", problems);
  const voice = validateRecord(raw.voice, VOICE_FIELDS, "voice", problems, {
    extraKeys: ["endpoint", "speechFilter"],
  });
  voice.endpoint = validateRecord(plainObject(raw.voice).endpoint, ENDPOINT_FIELDS, "voice.endpoint", problems);
  voice.speechFilter = validateRecord(
    plainObject(raw.voice).speechFilter,
    SPEECH_FILTER_FIELDS,
    "voice.speechFilter",
    problems,
  );
  config.voice = voice;
  config.input = validateRecord(raw.input, INPUT_FIELDS, "input", problems);
  config.defaults = validateRecord(raw.defaults, ACTOR_FIELDS, "defaults", problems);
  config.content = validateRecord(raw.content, CONTENT_FIELDS, "content", problems);
  for (const [section, fields] of Object.entries(DESK_SECTIONS)) {
    config[section] = validateRecord(raw[section], fields, section, problems);
  }

  const hotkeysRaw = raw.hotkeys;
  config.hotkeys = {};
  if (hotkeysRaw && typeof hotkeysRaw === "object" && !Array.isArray(hotkeysRaw)) {
    for (const [id, accel] of Object.entries(hotkeysRaw)) {
      const verdict = vAccelString(accel);
      if (verdict.ok) config.hotkeys[id] = verdict.value;
      else problems.push({ path: `hotkeys[${quoteKey(id)}]`, value: accel, reason: verdict.reason });
    }
  }

  // authors: keyed on the lowercased author name, with an optional seats[] for
  // the parallel-session case (two Claude Code tabs of one repo are one author
  // and two seats).
  const authorsRaw = raw.authors;
  if (authorsRaw !== undefined && authorsRaw !== null) {
    if (typeof authorsRaw !== "object" || Array.isArray(authorsRaw)) {
      problems.push({ path: "authors", value: authorsRaw, reason: "expected an object" });
    } else {
      for (const [rawKey, value] of Object.entries(authorsRaw)) {
        const key = normaliseAuthor(rawKey);
        if (!key) {
          problems.push({ path: `authors[${quoteKey(rawKey)}]`, value: rawKey, reason: "empty author name" });
          continue;
        }
        if (config.authors[key]) {
          problems.push({
            path: `authors[${quoteKey(rawKey)}]`,
            value: rawKey,
            reason: `duplicate of authors[${quoteKey(key)}] once lowercased`,
          });
          continue;
        }
        const prefix = `authors.${key}`;
        const record = validateRecord(value, ACTOR_FIELDS, prefix, problems, { extraKeys: ["seats"] });
        const seatsRaw = plainObject(value).seats;
        if (seatsRaw !== undefined && seatsRaw !== null) {
          if (!Array.isArray(seatsRaw)) {
            problems.push({ path: `${prefix}.seats`, value: seatsRaw, reason: "expected an array" });
          } else {
            record.seats = seatsRaw.map((seat, i) =>
              validateRecord(seat, ACTOR_FIELDS, `${prefix}.seats[${i}]`, problems),
            );
          }
        }
        config.authors[key] = record;
      }
    }
  }

  // actors: keyed on a STAMPED origin key, kept verbatim (it is already a
  // sanitised token by construction — see originOf).
  const actorsRaw = raw.actors;
  if (actorsRaw !== undefined && actorsRaw !== null) {
    if (typeof actorsRaw !== "object" || Array.isArray(actorsRaw)) {
      problems.push({ path: "actors", value: actorsRaw, reason: "expected an object" });
    } else {
      for (const [rawKey, value] of Object.entries(actorsRaw)) {
        const key = String(rawKey).trim();
        if (!key || !key.includes(":")) {
          problems.push({
            path: `actors[${quoteKey(rawKey)}]`,
            value: rawKey,
            reason: 'origin keys look like "<kind>:<id>" (e.g. claude_code:7f3a, relay:#agents, mcp:speak)',
          });
          continue;
        }
        config.actors[key] = validateRecord(value, ACTOR_FIELDS, `actors[${quoteKey(key)}]`, problems);
      }
    }
  }

  const channelsRaw = raw.channels;
  if (channelsRaw !== undefined && channelsRaw !== null) {
    if (typeof channelsRaw !== "object" || Array.isArray(channelsRaw)) {
      problems.push({ path: "channels", value: channelsRaw, reason: "expected an object" });
    } else {
      for (const [rawKey, value] of Object.entries(channelsRaw)) {
        const key = channelKey(rawKey);
        if (!key) {
          problems.push({ path: `channels[${quoteKey(rawKey)}]`, value: rawKey, reason: "empty channel name" });
          continue;
        }
        config.channels[key] = validateRecord(value, CHANNEL_FIELDS, `channels[${quoteKey(key)}]`, problems);
      }
    }
  }

  config.appearance = validateAppearance(raw.appearance, problems);

  if (typeof raw.migratedLegacyAt === "string" && raw.migratedLegacyAt.trim()) {
    config.migratedLegacyAt = raw.migratedLegacyAt.trim();
  } else if (raw.migratedLegacyAt !== undefined && raw.migratedLegacyAt !== null) {
    problems.push({
      path: "migratedLegacyAt",
      value: raw.migratedLegacyAt,
      reason: "expected an ISO timestamp string",
    });
  }

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      problems.push({ path: key, value: raw[key], reason: `unknown key (known: ${TOP_LEVEL_KEYS.join(", ")})` });
    }
  }

  return { config, problems, fatal: false };
}

// ─── load / watch / write ────────────────────────────────────────────────────

/** Last GOOD config per resolved path. Keyed by path, not a single module
 *  global, so a test (or a checker reading two fixtures) cannot bleed one
 *  file's snapshot into another's. */
const lastGoodByPath = new Map();
/** Our own writes, so fs.watch does not re-enter the loader on a save we made. */
const selfWrites = new Map();
const SELF_WRITE_GUARD_MS = 2000;

function withMeta(config, meta) {
  return { ...config, meta: { loadedAt: Date.now(), ...meta } };
}

function failSoft(resolved, rawText, error, problems) {
  // The bytes that did not parse are kept verbatim beside the file: an owner
  // who mistypes a comma gets his edit back, not a truncated default.
  try {
    if (typeof rawText === "string") fs.writeFileSync(INVALID_FILE(resolved), rawText, "utf8");
  } catch {
    /* best-effort — a failed copy must not make a bad file worse */
  }
  const keep = lastGoodByPath.get(resolved);
  return {
    snapshot: withMeta(keep ? structuredClone(keep) : emptyConfig(), {
      path: resolved,
      source: keep ? "last-good" : "builtin",
      mtimeMs: statMtime(resolved),
    }),
    problems,
    error,
    invalidCopy: INVALID_FILE(resolved),
  };
}

/**
 * load — read + validate cast.json. Never throws.
 * @returns {{snapshot: object, problems: Array, error: string|null}}
 *   `snapshot.meta.source` is "file" | "last-good" | "builtin", which is the
 *   only honest way for a banner to say "you are NOT looking at your file".
 */
function load({ file = CAST_FILE() } = {}) {
  const resolved = path.resolve(file);
  let rawText;
  try {
    rawText = fs.readFileSync(resolved, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      // No file yet is the normal first-run state, not an error.
      return {
        snapshot: withMeta(emptyConfig(), { path: resolved, source: "builtin", mtimeMs: null }),
        problems: [],
        error: null,
      };
    }
    const keep = lastGoodByPath.get(resolved);
    return {
      snapshot: withMeta(keep ? structuredClone(keep) : emptyConfig(), {
        path: resolved,
        source: keep ? "last-good" : "builtin",
        mtimeMs: null,
      }),
      problems: [],
      error: `cast.json unreadable: ${err && err.message ? err.message : String(err)}`,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    return failSoft(resolved, rawText, `cast.json is not valid JSON: ${err && err.message ? err.message : String(err)}`, [
      { path: "", value: null, reason: "JSON parse failed" },
    ]);
  }

  const { config, problems, fatal } = validateCast(parsed);
  if (fatal) {
    const first = problems[0];
    return failSoft(resolved, rawText, `cast.json: ${first ? first.reason : "unusable"}`, problems);
  }
  lastGoodByPath.set(resolved, structuredClone(config));
  return {
    snapshot: withMeta(config, { path: resolved, source: "file", mtimeMs: statMtime(resolved) }),
    problems,
    error: null,
  };
}

/**
 * watch — call onChange({snapshot, problems, error}) when the file changes.
 *
 * Watches the CONTAINING DIRECTORY, not the file: an atomic save (tmp +
 * rename) replaces the inode, and a watcher bound to the old inode goes deaf
 * without an error — the failure mode where "the pane never updates" and the
 * log is clean. Debounced 250 ms because one save fires several events, and
 * guarded by mtime + our own last write so a save made THROUGH write() does
 * not re-enter the loader.
 *
 * @returns {() => void} unwatch
 */
function watch(onChange, { file = CAST_FILE(), debounceMs = 250 } = {}) {
  const resolved = path.resolve(file);
  const dir = path.dirname(resolved);
  const base = path.basename(resolved);
  let timer = null;
  let watcher = null;
  let closed = false;
  // Stamp = mtime AND size: two writes in one timestamp tick share an mtime,
  // and an mtime-only guard dropped the real edit as "a touch that changed
  // nothing" (measured 2026-09-22 on the Windows CI runner).
  const statStamp = (f) => {
    try {
      const st = fs.statSync(f);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return null;
    }
  };
  let lastStamp = statStamp(resolved);

  const fire = () => {
    timer = null;
    if (closed) return;
    const mtimeMs = statMtime(resolved);
    const self = selfWrites.get(resolved);
    if (self && mtimeMs !== null && self.mtimeMs === mtimeMs) return; // our own renameSync
    if (self && Date.now() - self.at < SELF_WRITE_GUARD_MS && mtimeMs !== null && mtimeMs <= self.mtimeMs) return;
    const stamp = statStamp(resolved);
    if (stamp !== null && stamp === lastStamp) return; // a touch that changed nothing
    lastStamp = stamp;
    let result;
    try {
      result = load({ file: resolved });
    } catch {
      return; // load() is fail-soft, but a listener must never see a throw from here
    }
    try {
      onChange(result);
    } catch {
      /* a throwing listener must not kill the watcher */
    }
  };

  try {
    fs.mkdirSync(dir, { recursive: true });
    // Watch the LONG path. libuv asserts (fs-event.c:72) and kills the process
    // when a watched Windows dir is an 8.3 short name (C:/Users/RUNNER~1/...,
    // GitHub's Windows runner temp dir) and the event names come back long.
    let watchDir = dir;
    try {
      watchDir = fs.realpathSync.native(dir);
    } catch {
      /* unresolvable: watch what we were given */
    }
    watcher = fs.watch(watchDir, (_event, name) => {
      if (name && path.basename(String(name)) !== base) return; // ignore the .tmp siblings
      if (timer) clearTimeout(timer);
      timer = setTimeout(fire, debounceMs);
      if (typeof timer.unref === "function") timer.unref();
    });
    if (typeof watcher.unref === "function") watcher.unref();
  } catch {
    return () => {}; // no watch available (odd filesystem) — the pane still reloads on demand
  }

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    try {
      if (watcher) watcher.close();
    } catch {
      /* already closed */
    }
  };
}

/**
 * write — read, mutate a draft, validate, then tmp + renameSync.
 *
 * The draft is the RAW parsed file, not the validated config: writing back the
 * validated shape would delete any key this build does not know, which is how
 * a newer pane's settings vanish when an older build saves. A mutation whose
 * result is fatally invalid is REFUSED, not written.
 *
 * @param {(draft: object) => object|void} mutation
 * @returns {{ok: boolean, snapshot: object|null, problems: Array, error: string|null}}
 */
function write(mutation, { file = CAST_FILE() } = {}) {
  const resolved = path.resolve(file);
  let draft = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) draft = parsed;
  } catch {
    /* missing or unparseable — start from an empty v1 draft rather than refuse
       to ever write again (the bad bytes are already kept by load()) */
  }
  if (draft.version === undefined) draft.version = 1;

  let next;
  try {
    next = (mutation ? mutation(draft) : draft) || draft;
  } catch (err) {
    return {
      ok: false,
      snapshot: null,
      problems: [],
      error: `cast.json mutation failed: ${err && err.message ? err.message : String(err)}`,
    };
  }

  const { config, problems, fatal } = validateCast(next);
  if (fatal) {
    const first = problems[0];
    return {
      ok: false,
      snapshot: null,
      problems,
      error: `refusing to write cast.json: ${first ? first.reason : "unusable"}`,
    };
  }

  try {
    writeJsonAtomic(resolved, next);
  } catch (err) {
    return {
      ok: false,
      snapshot: null,
      problems,
      error: `cast.json write failed: ${err && err.message ? err.message : String(err)}`,
    };
  }
  lastGoodByPath.set(resolved, structuredClone(config));
  selfWrites.set(resolved, { at: Date.now(), mtimeMs: statMtime(resolved) });
  return {
    ok: true,
    snapshot: withMeta(config, { path: resolved, source: "file", mtimeMs: statMtime(resolved) }),
    problems,
    error: null,
  };
}

// ─── the origin grammar ──────────────────────────────────────────────────────

/**
 * originOf — the stamped identity of a speaker, and the key chain to look it up.
 *
 *   room row      ->  `${actor.kind}:${actor.id}`      e.g. claude_code:7f3a
 *   relay         ->  relay:#channel[:nick]
 *   class         ->  `${kind}:*`                      e.g. claude_code:*
 *   literals      ->  bridge:/speak · mcp:speak · desk:drop · service:awdesk
 *
 * 🚩 Callers STAMP this. Pass the kind/id/channel you derived locally; never a
 * field lifted straight out of a request body (see the header's residual risk).
 *
 * @returns {{key: string, keys: string[], kind: string, id: string, channel: string|null, nick: string|null}}
 *   `keys` is the lookup chain, most specific first: exact, then
 *   relay:<channel> for a nick, then <kind>:*.
 */
function originOf(row = {}) {
  const src = plainObject(row);
  const literal = typeof src.key === "string" ? src.key.trim() : "";
  if (literal) {
    const colon = literal.indexOf(":");
    const kind = safeToken(colon === -1 ? literal : literal.slice(0, colon)).toLowerCase() || "unknown";
    const id = colon === -1 ? "" : safeToken(literal.slice(colon + 1), { allowSlash: true });
    const key = id ? `${kind}:${id}` : `${kind}:*`;
    const keys = id && id !== "*" ? [key, `${kind}:*`] : [key];
    return { key, keys, kind, id, channel: channelKey(src.channel), nick: null };
  }

  const kind = safeToken(src.kind ?? src.actorKind ?? "").toLowerCase() || "unknown";
  const channel = channelKey(src.channel);
  const nick = safeToken(src.nick ?? "").toLowerCase() || null;

  if (kind === "relay" || (channel && !src.id && !src.actorId)) {
    const ch = channel || "#unknown";
    const key = nick ? `relay:${ch}:${nick}` : `relay:${ch}`;
    const keys = nick ? [key, `relay:${ch}`, "relay:*"] : [key, "relay:*"];
    return { key, keys, kind: "relay", id: nick ? `${ch}:${nick}` : ch, channel: ch, nick };
  }

  const id = safeToken(src.id ?? src.actorId ?? "");
  if (!id) {
    // No id to key on: the CLASS grant is the only honest record to consult.
    return { key: `${kind}:*`, keys: [`${kind}:*`], kind, id: "*", channel, nick: null };
  }
  const key = `${kind}:${id}`;
  const keys = id === "*" ? [key] : [key, `${kind}:*`];
  return { key, keys, kind, id, channel, nick: null };
}

/**
 * seatIndexFor — which seat a parallel session of one author occupies.
 *
 * Arrival-ordered and STICKY: the first Claude Code tab of `aitheros-fresh` is
 * seat 0 for as long as the desk runs, so `authors.aitheros-fresh.seats[1]`
 * means a stable second body rather than "whoever spoke last". `state` is the
 * caller's own object (start with {}); this mutates it.
 *
 * A seat is never released — a session that goes quiet and comes back keeps its
 * body and voice, which is the point. Past SEAT_LIMIT distinct sessions of ONE
 * author the index is hashed instead of appended (measured 2026-09-18: four
 * bodies already took the renderer heap to 2.36 GB, so 64 is far past anything
 * real; this only bounds the bookkeeping).
 */
const SEAT_LIMIT = 64;
function seatIndexFor(state, { author, actorId } = {}) {
  const id = String(actorId == null ? "" : actorId).trim();
  if (!id) return 0; // one body, nothing to tell apart
  if (!state || typeof state !== "object") return hash33(id) % SEAT_LIMIT;
  if (!state.seats || typeof state.seats !== "object") state.seats = {};
  const key = normaliseAuthor(author) || "agent";
  const arrivals = Array.isArray(state.seats[key]) ? state.seats[key] : (state.seats[key] = []);
  const found = arrivals.indexOf(id);
  if (found !== -1) return found;
  if (arrivals.length >= SEAT_LIMIT) return hash33(id) % SEAT_LIMIT;
  arrivals.push(id);
  return arrivals.length - 1;
}

// ─── the stable hashes ───────────────────────────────────────────────────────

/**
 * characterOrder — the order a seed prefers the roster in. A seed-dependent
 * permutation (rendezvous hashing), NOT a modulo index.
 *
 * This is the fix for "the same agent changes body between runs". Two bugs, one
 * cause — a pick whose INDEX depends on the size of the pool:
 *   1. today's pickCharacter filters `taken`/`resident` BEFORE the modulo, so
 *      a newcomer arriving shrinks the pool and re-indexes everyone already on
 *      stage;
 *   2. hashing the seed into `sorted[h % len]` also re-indexes every agent the
 *      moment a character is ADDED to the roster (a new VRM in the directory,
 *      a content pack installed) — the same symptom, on a slower clock.
 * Ranking each name by hash(seedHash:name) removes the length from the
 * arithmetic: taken/resident become SKIPS in a fixed order, and adding a name
 * only moves a seed's pick if the newcomer outranks it (1 in n+1), instead of
 * almost always.
 */
function characterOrder(seed, roster) {
  const names = [
    ...new Set((Array.isArray(roster) ? roster : []).filter((n) => typeof n === "string" && n)),
  ].sort();
  const seedHash = hash33(String(seed == null ? "" : seed).toLowerCase());
  return names
    .map((name) => ({ name, rank: hash33(`${seedHash}:${name}`) }))
    .sort((a, b) => b.rank - a.rank || (a.name < b.name ? -1 : 1))
    .map((entry) => entry.name);
}

/**
 * stableCharacter — a body for a seed with no configured character: the first
 * name in its own preference order that is neither the resident nor already on
 * stage. Pure. null when nothing is free to wear.
 */
function stableCharacter(seed, roster, { taken = [], resident = null } = {}) {
  const blocked = new Set([resident, ...(Array.isArray(taken) ? taken : [])].filter(Boolean));
  for (const name of characterOrder(seed, roster)) {
    if (!blocked.has(name)) return name;
  }
  return null;
}

/**
 * stableVoice — a voice for a seed with no configured voice, from the SAME
 * `author:seat` (or origin-key) seed the character came from. Never the author
 * alone: that is exactly what made every parallel session of one repo sound
 * identical while their bodies differed.
 *
 * @param {string} seed
 * @param {{voices?: string[]}|string[]} [resolution] the resolution being built
 *   (or a bare pool). Defaults to the six AitherVoice voices.
 */
function stableVoice(seed, resolution) {
  const pool = Array.isArray(resolution)
    ? resolution
    : Array.isArray(plainObject(resolution).voices)
      ? plainObject(resolution).voices
      : VOICES;
  const names = pool.filter((v) => typeof v === "string" && v);
  if (names.length === 0) return BUILTIN_VOICE.defaultVoice;
  return names[hash33(String(seed == null ? "" : seed).toLowerCase()) % names.length];
}

// ─── resolution ──────────────────────────────────────────────────────────────

function normaliseSnapshot(snapshot) {
  const base = emptyConfig();
  if (!snapshot || typeof snapshot !== "object") return base;
  const voice = plainObject(snapshot.voice);
  return {
    version: 1,
    stage: plainObject(snapshot.stage),
    voice: { ...voice, endpoint: plainObject(voice.endpoint), speechFilter: plainObject(voice.speechFilter) },
    defaults: plainObject(snapshot.defaults),
    authors: plainObject(snapshot.authors),
    actors: plainObject(snapshot.actors),
    channels: plainObject(snapshot.channels),
    models: plainObject(snapshot.models),
    prompts: plainObject(snapshot.prompts),
    vision: plainObject(snapshot.vision),
    sync: plainObject(snapshot.sync),
    content: plainObject(snapshot.content),
    input: plainObject(snapshot.input),
    hotkeys: plainObject(snapshot.hotkeys),
    migratedLegacyAt: typeof snapshot.migratedLegacyAt === "string" ? snapshot.migratedLegacyAt : null,
  };
}

/** Read one field out of one record through its OWN validator, so a caller
 *  that hands us a raw (unvalidated) object gets the same answers the file
 *  would give. Returns null when the record does not speak to this field. */
function readField(record, field, prefix, problems, validate) {
  const rec = plainObject(record);
  if (!(field in rec)) return null;
  const value = rec[field];
  if (value === null || value === undefined) return null; // explicit "unset"
  const verdict = (validate || ACTOR_FIELDS[field])(value);
  if (!verdict.ok) {
    pushProblem(problems, prefix, field, value, verdict);
    return null; // drop, do not clamp — fall through to the next tier
  }
  return { value: verdict.value, from: `${prefix}.${field}` };
}

function envNumber(env, name, validate, problems) {
  const raw = env ? env[name] : undefined;
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const parsed = Number(String(raw).trim());
  const verdict = Number.isNaN(parsed) ? { ok: false, reason: "not a number" } : validate(parsed);
  if (!verdict.ok) {
    problems.push({ path: `env.${name}`, value: raw, reason: verdict.reason });
    return null;
  }
  return { value: verdict.value, from: `env.${name}` };
}

/**
 * resolveContent — the desk's content ceiling, field by field, with provenance.
 * Pure and synchronous: content-rating.cjs reads it on every roster listing.
 */
function resolveContent(snapshot) {
  const cfg = normaliseSnapshot(snapshot);
  const problems = [];
  const record = plainObject(cfg.content);
  const out = { ...BUILTIN_CONTENT };
  const from = {};
  for (const field of Object.keys(CONTENT_FIELDS)) {
    const hit = readField(record, field, "content", problems, CONTENT_FIELDS[field]);
    out[field] = hit ? hit.value : BUILTIN_CONTENT[field];
    from[field] = hit ? hit.from : "builtin";
  }
  return { ...out, from, problems };
}

/**
 * resolveStage — the stage-wide numbers, with provenance.
 *
 * The file is the TOP tier and is SPARSE, which is the whole point: `maxBodies:
 * 0` (no bodies, everyone ventriloquised from slot0) is expressible, and unset
 * still means 3. `Number(process.env.DESK_ROOM_MAX_BODIES) || 3` could not tell
 * those two apart — 0 read as 3. The three legacy env vars stay as a tier BELOW
 * the file and ABOVE the built-in, and are not presented to the owner as
 * configuration.
 */
function resolveStage(snapshot, { env = process.env } = {}) {
  const cfg = normaliseSnapshot(snapshot);
  const problems = [];
  const out = {};
  const pick = (field, envName) => {
    const hit =
      readField(cfg.stage, field, "stage", problems, STAGE_FIELDS[field]) ||
      (envName ? envNumber(env, envName, STAGE_FIELDS[field], problems) : null);
    out[field] = hit ? hit.value : BUILTIN_STAGE[field];
    out[`${field}From`] = hit ? hit.from : "builtin";
  };
  pick("maxBodies", "DESK_ROOM_MAX_BODIES");
  pick("idleSeconds", "DESK_ROOM_IDLE_S");
  pick("cooldownSeconds", null);
  pick("gapMs", null);
  pick("pollMs", null);
  pick("resident", null);
  pick("bubbles", null);
  out.problems = problems;
  return out;
}

/**
 * resolveDesk — models / prompts / vision / sync, FIELD BY FIELD, with provenance.
 *
 * Order per field: the file, then a legacy environment variable where one
 * existed (so a box configured the old way keeps working and the pane can SAY
 * that is why), then the built-in. Same drop-do-not-clamp rule as everything
 * else here: a bad value costs that one field and lands in problems[].
 *
 * @returns {{models, prompts, vision, sync, problems}} -- never throws.
 */
const DESK_LEGACY_ENV = Object.freeze({
  "models.commandProfile": "AWDESK_CLAUDE_PROFILE",
});

function resolveDesk(snapshot, { env = process.env } = {}) {
  const cfg = normaliseSnapshot(snapshot);
  const problems = [];
  const out = {};
  for (const [section, fields] of Object.entries(DESK_SECTIONS)) {
    const resolved = {};
    for (const field of Object.keys(fields)) {
      let hit = readField(cfg[section], field, section, problems, fields[field]);
      const envName = DESK_LEGACY_ENV[`${section}.${field}`];
      if (!hit && envName) {
        const raw = env ? env[envName] : undefined;
        if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
          const verdict = fields[field](String(raw).trim());
          if (verdict.ok) hit = { value: verdict.value, from: `env.${envName}` };
          else problems.push({ path: `env.${envName}`, value: raw, reason: verdict.reason });
        }
      }
      resolved[field] = hit ? hit.value : BUILTIN_DESK[section][field];
      resolved[`${field}From`] = hit ? hit.from : "builtin";
    }
    out[section] = resolved;
  }
  out.problems = problems;
  return out;
}

/**
 * resolveInput / resolveHotkeys -- companions to resolveVoice for the input
 * half of Plan: configurable voice + hotkeys.
 */
function resolveInput(snapshot) {
  const cfg = normaliseSnapshot(snapshot);
  const problems = [];
  const out = {};
  const pick = (field) => {
    const hit = readField(cfg.input, field, "input", problems, INPUT_FIELDS[field]);
    out[field] = hit ? hit.value : BUILTIN_INPUT[field];
    out[`${field}From`] = hit ? hit.from : "builtin";
  };
  pick("micDeviceId");
  pick("micDeviceLabel");
  pick("micMuted");
  pick("talkMode");
  out.problems = problems;
  return out;
}

/** id -> accel string overrides, already validated by validateCast. Never
 *  throws on a missing/malformed hotkeys section -- an empty map means every
 *  command-registry entry keeps its DEFAULT accel, which is the safe state. */
function resolveHotkeys(snapshot) {
  const cfg = normaliseSnapshot(snapshot);
  const out = {};
  if (cfg.hotkeys && typeof cfg.hotkeys === "object") {
    for (const [id, accel] of Object.entries(cfg.hotkeys)) {
      if (typeof accel === "string" && accel.trim()) out[id] = accel.trim();
    }
  }
  return out;
}

/**
 * resolveVoice — the voice-service defaults, with provenance. The endpoint is
 * configurable because nothing was listening on 127.0.0.1:8084 when this was
 * written: a hardcoded host is a verdict nobody can correct from the pane.
 */
function resolveVoice(snapshot, { env = process.env } = {}) {
  const cfg = normaliseSnapshot(snapshot);
  const problems = [];
  const out = {};
  const pick = (field, envName) => {
    const hit =
      readField(cfg.voice, field, "voice", problems, VOICE_FIELDS[field]) ||
      (envName ? envNumber(env, envName, VOICE_FIELDS[field], problems) : null);
    out[field] = hit ? hit.value : BUILTIN_VOICE[field];
    out[`${field}From`] = hit ? hit.from : "builtin";
  };
  pick("defaultVoice", null);
  pick("defaultSpeed", "DESK_VOICE_SPEED");
  pick("maxChars", null);
  pick("affectIntensity", null);
  pick("volume", null);
  pick("muted", null);

  const endpoint = {};
  for (const field of Object.keys(ENDPOINT_FIELDS)) {
    const hit = readField(cfg.voice.endpoint, field, "voice.endpoint", problems, ENDPOINT_FIELDS[field]);
    endpoint[field] = hit ? hit.value : BUILTIN_VOICE.endpoint[field];
    endpoint[`${field}From`] = hit ? hit.from : "builtin";
  }
  out.endpoint = endpoint;

  const speechFilter = {};
  for (const field of Object.keys(SPEECH_FILTER_FIELDS)) {
    const hit = readField(cfg.voice.speechFilter, field, "voice.speechFilter", problems, SPEECH_FILTER_FIELDS[field]);
    speechFilter[field] = hit ? hit.value : BUILTIN_VOICE.speechFilter[field];
    speechFilter[`${field}From`] = hit ? hit.from : "builtin";
  }
  out.speechFilter = speechFilter;
  out.problems = problems;
  return out;
}

/**
 * resolveActor — everything about one speaker, FIELD BY FIELD, with provenance.
 *
 * Order (per field, not per record — a record holding only `voice` does not
 * shadow the tier below it for `presence`):
 *
 *   actors[<exact origin key>]
 *   actors["relay:<channel>"]          (a nick inherits its channel's record)
 *   channels["<channel>"]              (presence only; `voiced` is its own gate)
 *   actors["<kind>:*"]                 (the class grant)
 *   authors.<author>.seats[<seat>]     (this parallel session)
 *   authors.<author>
 *   defaults
 *   voice.defaultVoice / voice.defaultSpeed / voice.maxChars,
 *   stage.cooldownSeconds / stage.idleSeconds    (file-wide defaults)
 *   env DESK_ROOM_IDLE_S / DESK_VOICE_SPEED      (legacy, below the file)
 *   built-in constant
 *   stable hash                        (character and voice ONLY)
 *
 * The hash is LAST for character and voice, and there is no built-in constant
 * above it for them: a built-in "nova" above the hash would mute the whole
 * point of per-agent voices, while an explicitly authored voice.defaultVoice is
 * an owner's choice and does beat it.
 *
 * Every value carries `<field>From`, a string like `authors.aitheros-fresh.seats[1]`,
 * `actors["claude_code:7f3a"]`, `defaults.voice`, `env.DESK_VOICE_SPEED`,
 * `hash` or `builtin`. The pane must be able to say WHY.
 *
 * @param {object} snapshot  from load()
 * @param {object} ctx
 *   {author, actorId, actorKind|kind, id, channel, nick, key, origin, seat,
 *    roster (SAFE character names), taken, resident, voices, env}
 * @returns {object} ActorResolution — never throws.
 */
function resolveActor(snapshot, ctx = {}) {
  const cfg = normaliseSnapshot(snapshot);
  const problems = [];
  const env = ctx.env || process.env;
  const origin =
    ctx.origin && Array.isArray(ctx.origin.keys)
      ? ctx.origin
      : originOf({
          kind: ctx.actorKind ?? ctx.kind,
          id: ctx.actorId ?? ctx.id,
          channel: ctx.channel,
          nick: ctx.nick,
          key: ctx.key,
        });
  const author = normaliseAuthor(ctx.author);
  const seat = Number.isInteger(ctx.seat) && ctx.seat >= 0 ? ctx.seat : null;
  const chKey = origin.channel;
  const channelRecord = chKey ? plainObject(cfg.channels[chKey]) : null;

  // ── the tier list, most specific first ──
  const tiers = [];
  const relayChannelKey = chKey ? `relay:${chKey}` : null;
  for (const key of origin.keys) {
    if (cfg.actors[key]) tiers.push({ prefix: `actors[${quoteKey(key)}]`, record: cfg.actors[key] });
    if (relayChannelKey && key === relayChannelKey && channelRecord) {
      // The channel record slots in right here: it is the same scope as
      // actors["relay:#chan"], and it may only speak to `presence`.
      tiers.push({ prefix: `channels[${quoteKey(chKey)}]`, record: channelRecord, only: ["presence"] });
    }
  }
  if (channelRecord && !tiers.some((t) => t.prefix === `channels[${quoteKey(chKey)}]`)) {
    tiers.push({ prefix: `channels[${quoteKey(chKey)}]`, record: channelRecord, only: ["presence"] });
  }
  const authorRecord = author ? plainObject(cfg.authors[author]) : null;
  if (authorRecord && seat !== null && Array.isArray(authorRecord.seats) && authorRecord.seats[seat]) {
    tiers.push({ prefix: `authors.${author}.seats[${seat}]`, record: authorRecord.seats[seat] });
  }
  if (authorRecord) tiers.push({ prefix: `authors.${author}`, record: authorRecord });
  tiers.push({ prefix: "defaults", record: cfg.defaults });

  const pick = (field, validate) => {
    for (const tier of tiers) {
      if (tier.only && !tier.only.includes(field)) continue;
      const hit = readField(tier.record, field, tier.prefix, problems, validate || ACTOR_FIELDS[field]);
      if (hit) return hit;
    }
    return null;
  };

  // The seed is `author:seat`, never `author:actorId`: an actor id is minted
  // per process and changes every launch, which is precisely why "the same
  // agent changes body between runs". A seat is arrival order, and it repeats.
  const seed = author ? `${author}:${seat === null ? 0 : seat}` : origin.key;

  // ── character: configured, else hashed into the safe roster ──
  const roster = Array.isArray(ctx.roster) ? ctx.roster.filter((n) => typeof n === "string" && n) : null;
  const inRoster = (value) => {
    if (!roster || roster.length === 0) return { ok: true, value }; // nothing to judge against
    if (roster.includes(value)) return { ok: true, value };
    return { ok: false, reason: "not in the safe roster (content rating / missing model)" };
  };
  const characterHit = pick("character", (v) => {
    const verdict = ACTOR_FIELDS.character(v);
    return verdict.ok ? inRoster(verdict.value) : verdict;
  });
  const resident = ctx.resident !== undefined ? ctx.resident : resolveStage(snapshot, { env }).resident;
  let character = characterHit ? characterHit.value : null;
  let characterFrom = characterHit ? characterHit.from : null;
  if (!character) {
    const hashed = stableCharacter(seed, roster || [], { taken: ctx.taken || [], resident });
    character = hashed;
    characterFrom = hashed ? "hash" : "none";
  }

  // ── voice ──
  const voiceHit =
    pick("voice") || readField(cfg.voice, "defaultVoice", "voice", problems, VOICE_FIELDS.defaultVoice);
  const voice = voiceHit ? voiceHit.value : stableVoice(seed, { voices: ctx.voices || VOICES });
  const voiceFrom = voiceHit ? (voiceHit.from === "voice.defaultVoice" ? "voice.defaultVoice" : voiceHit.from) : "hash";

  // ── the numbers ──
  const speedHit =
    pick("speed") ||
    readField(cfg.voice, "defaultSpeed", "voice", problems, VOICE_FIELDS.defaultSpeed) ||
    envNumber(env, "DESK_VOICE_SPEED", ACTOR_FIELDS.speed, problems);
  const maxCharsHit = pick("maxChars") || readField(cfg.voice, "maxChars", "voice", problems, VOICE_FIELDS.maxChars);
  const idleHit =
    pick("idleSeconds") ||
    readField(cfg.stage, "idleSeconds", "stage", problems, STAGE_FIELDS.idleSeconds) ||
    envNumber(env, "DESK_ROOM_IDLE_S", ACTOR_FIELDS.idleSeconds, problems);
  const cooldownHit =
    pick("cooldownSeconds") ||
    readField(cfg.stage, "cooldownSeconds", "stage", problems, STAGE_FIELDS.cooldownSeconds);

  // ── loudness: master fader x this speaker's fader (see MASTER_VOLUME_MAX) ──
  // `volume` is read per TIER like every other actor field, so "everyone in
  // this author's sessions at 0.5" and "this one seat at 1.4" both work.
  const volumeHit = pick("volume");
  const volume = volumeHit ? volumeHit.value : BUILTIN_ACTOR.volume;
  const masterVolumeHit = readField(cfg.voice, "volume", "voice", problems, VOICE_FIELDS.volume);
  const masterVolume = masterVolumeHit ? masterVolumeHit.value : BUILTIN_VOICE.volume;
  const mutedHit = readField(cfg.voice, "muted", "voice", problems, VOICE_FIELDS.muted);
  const muted = mutedHit ? mutedHit.value : BUILTIN_VOICE.muted;
  const effectiveVolume = muted ? 0 : masterVolume * volume;

  // ── presence / speak / body / place ──
  const presenceHit = pick("presence");
  const presence = presenceHit ? presenceHit.value : BUILTIN_ACTOR.presence;
  const speakHit = pick("speak");
  const speak = speakHit ? speakHit.value : BUILTIN_ACTOR.speak;
  const bodyHit = pick("body");
  const body = bodyHit ? bodyHit.value : BUILTIN_ACTOR.body;
  const placeHit = pick("place");
  const displayNameHit = pick("displayName");

  // A relay channel grants nothing until it is named: mirroring another
  // channel into the room must not make its nicks audible by accident.
  let channelVoiced = true;
  let channelVoicedFrom = "not-a-channel";
  if (origin.kind === "relay") {
    const hit = channelRecord
      ? readField(channelRecord, "voiced", `channels[${quoteKey(chKey)}]`, problems, CHANNEL_FIELDS.voiced)
      : null;
    channelVoiced = hit ? hit.value : false;
    channelVoicedFrom = hit ? hit.from : "builtin (relay channels are silent until named)";
  }

  // `chatty` is "no cooldown", not "no filter": readsLikeSpeech still applies
  // downstream, which is what keeps 50 transcript lines out of the speaker.
  const cooldownSeconds = presence === "chatty" ? 0 : cooldownHit ? cooldownHit.value : BUILTIN_STAGE.cooldownSeconds;
  const cooldownSecondsFrom =
    presence === "chatty" ? `presence=chatty (${presenceHit ? presenceHit.from : "builtin"})` : cooldownHit ? cooldownHit.from : "builtin";

  let voiced = true;
  let voicedReason = null;
  if (muted) {
    // The global switch is named FIRST: when the whole room is muted, "this
    // agent has speak=false" is true and beside the point.
    voiced = false;
    voicedReason = `voice.muted (${mutedHit ? mutedHit.from : "builtin"})`;
  } else if (speak === false) {
    // A hard mute BEATS presence and keeps the body: "be here, say nothing".
    voiced = false;
    voicedReason = `speak=false (${speakHit ? speakHit.from : "builtin"})`;
  } else if (presence === "off") {
    voiced = false;
    voicedReason = `presence=off (${presenceHit ? presenceHit.from : "builtin"})`;
  } else if (presence === "quiet") {
    voiced = false;
    voicedReason = `presence=quiet (${presenceHit ? presenceHit.from : "builtin"})`;
  } else if (!channelVoiced) {
    voiced = false;
    voicedReason = `${chKey} is not voiced (${channelVoicedFrom})`;
  } else if (effectiveVolume === 0) {
    // Refused HERE, before synthesis: a fader at zero that still spends a TTS
    // call is a mute that costs GPU time to say nothing.
    voiced = false;
    voicedReason =
      masterVolume === 0
        ? `voice.volume=0 (${masterVolumeHit ? masterVolumeHit.from : "builtin"})`
        : `volume=0 (${volumeHit ? volumeHit.from : "builtin"})`;
  }

  // ── the caption: what the speaker SAID, shown over its body ──
  // Decided separately from `voiced`, because the whole point is the case where
  // they differ: a muted room is one the owner still wants to READ. It follows
  // the speaker being PRESENT, not the speaker being audible -- so every mute
  // (voice.muted, speak=false, presence=quiet, a fader at zero) keeps its
  // caption, while `presence=off` and a relay channel nobody named do not.
  // Without those two exclusions every unconfigured relay line would land in
  // the resident avatar's bubble, which is the flood `voiced` exists to stop.
  const bubbleHit = pick("bubble");
  const bubble = bubbleHit ? bubbleHit.value : BUILTIN_ACTOR.bubble;
  const stageBubblesHit = readField(cfg.stage, "bubbles", "stage", problems, STAGE_FIELDS.bubbles);
  const stageBubbles = stageBubblesHit ? stageBubblesHit.value : BUILTIN_STAGE.bubbles;
  let captioned = true;
  let captionedReason = null;
  if (!stageBubbles) {
    captioned = false;
    captionedReason = `stage.bubbles=false (${stageBubblesHit ? stageBubblesHit.from : "builtin"})`;
  } else if (bubble === false) {
    captioned = false;
    captionedReason = `bubble=false (${bubbleHit ? bubbleHit.from : "builtin"})`;
  } else if (presence === "off") {
    captioned = false;
    captionedReason = `presence=off (${presenceHit ? presenceHit.from : "builtin"})`;
  } else if (!channelVoiced) {
    captioned = false;
    captionedReason = `${chKey} is not voiced (${channelVoicedFrom})`;
  }

  // Physics resolves PER SUB-KEY: each of the five knobs walks the tiers on
  // its own, so `actors[x].physics = {jiggle: 0.3}` inherits weight/stiffness/
  // damping from `defaults.physics` instead of resetting them. `pick` cannot
  // do that (it returns the first tier's whole block), so the walk is inline.
  const physics = { ...BUILTIN_PHYSICS };
  const physicsFrom = {};
  for (const knob of Object.keys(PHYSICS_FIELDS)) physicsFrom[knob] = "builtin";
  for (const tier of tiers) {
    if (tier.only && !tier.only.includes("physics")) continue;
    const hit = readField(tier.record, "physics", tier.prefix, problems, vPhysics);
    if (!hit) continue;
    for (const [knob, value] of Object.entries(hit.value)) {
      if (physicsFrom[knob] !== "builtin") continue; // a more specific tier already answered
      physics[knob] = value;
      physicsFrom[knob] = `${hit.from}.${knob}`;
    }
  }

  return {
    key: origin.key,
    keys: origin.keys,
    kind: origin.kind,
    channel: chKey,
    author,
    seat,
    seed,
    displayName: displayNameHit ? displayNameHit.value : null,
    displayNameFrom: displayNameHit ? displayNameHit.from : "builtin",
    character,
    characterFrom,
    voice,
    voiceFrom,
    speed: speedHit ? speedHit.value : BUILTIN_VOICE.defaultSpeed,
    speedFrom: speedHit ? speedHit.from : "builtin",
    volume,
    volumeFrom: volumeHit ? volumeHit.from : "builtin",
    masterVolume,
    masterVolumeFrom: masterVolumeHit ? masterVolumeHit.from : "builtin",
    muted,
    mutedFrom: mutedHit ? mutedHit.from : "builtin",
    effectiveVolume,
    bubble,
    bubbleFrom: bubbleHit ? bubbleHit.from : "builtin",
    captioned,
    captionedReason,
    maxChars: maxCharsHit ? maxCharsHit.value : BUILTIN_VOICE.maxChars,
    maxCharsFrom: maxCharsHit ? maxCharsHit.from : "builtin",
    idleSeconds: idleHit ? idleHit.value : BUILTIN_STAGE.idleSeconds,
    idleSecondsFrom: idleHit ? idleHit.from : "builtin",
    cooldownSeconds,
    cooldownSecondsFrom,
    presence,
    presenceFrom: presenceHit ? presenceHit.from : "builtin",
    speak,
    speakFrom: speakHit ? speakHit.from : "builtin",
    body,
    bodyFrom: bodyHit ? bodyHit.from : "builtin",
    place: placeHit ? placeHit.value : null,
    placeFrom: placeHit ? placeHit.from : "builtin",
    physics,
    physicsFrom,
    channelVoiced,
    channelVoicedFrom,
    // Derived verdicts, so every consumer answers them the same way.
    dropped: presence === "off",
    bodied: presence !== "off" && body !== false,
    voiced,
    voicedReason,
    problems,
  };
}

// ─── the seen-book ───────────────────────────────────────────────────────────

const SEEN_LIMIT = 300;
const SEEN_SAMPLE_CHARS = 160;

/**
 * noteSeen — record an origin the file does not configure, with a text sample.
 *
 * This is what keeps fail-soft defaults honest: an agent nobody granted is
 * discoverable in one click ("seen but silent") instead of by reading code.
 * Best-effort by construction — it NEVER throws and never blocks a speaker.
 */
function noteSeen(origin, sample, { file = undefined, now = Date.now } = {}) {
  try {
    const target = file || SEEN_FILE(CAST_FILE());
    const o = origin && Array.isArray(origin.keys) ? origin : originOf(origin || {});
    const at = new Date(now()).toISOString();
    let book = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) book = parsed;
    } catch {
      /* first sighting, or a book we will simply rewrite */
    }
    const previous = plainObject(book[o.key]);
    const row = {
      count: Number.isFinite(Number(previous.count)) ? Number(previous.count) + 1 : 1,
      firstSeen: typeof previous.firstSeen === "string" ? previous.firstSeen : at,
      lastSeen: at,
      kind: o.kind,
    };
    if (o.channel) row.channel = o.channel;
    const text = String(sample == null ? "" : sample).replace(/\s+/g, " ").trim().slice(0, SEEN_SAMPLE_CHARS);
    if (text) row.sample = text;
    else if (typeof previous.sample === "string") row.sample = previous.sample;
    book[o.key] = row;

    const keys = Object.keys(book);
    if (keys.length > SEEN_LIMIT) {
      // Bounded: a busy room must not grow this file forever. Oldest sighting out.
      keys
        .sort((a, b) => String(plainObject(book[a]).lastSeen).localeCompare(String(plainObject(book[b]).lastSeen)))
        .slice(0, keys.length - SEEN_LIMIT)
        .forEach((key) => delete book[key]);
    }
    writeJsonAtomic(target, book);
    return row;
  } catch {
    return null;
  }
}

function readSeen({ file = undefined } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file || SEEN_FILE(CAST_FILE()), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// ─── one-shot migration ──────────────────────────────────────────────────────

/**
 * migrateLegacy — fold the two legacy planes into cast.json, once.
 *
 *   .agent-avatars.json  ->  authors[<agent>].character
 *   AGENT_VOICES (x10)   ->  authors[<agent>].voice   (written out EXPLICITLY)
 *
 * The voices are written out rather than left to the new hash on purpose:
 * unifying two rival hashes would otherwise silently reshuffle the ten agents
 * the owner already recognises by sound.
 *
 * The legacy file is COPIED, never renamed or deleted (ownerDecisions), and
 * `.active-character` is NOT subsumed — stage.resident is an optional override
 * and installCharacter stays that file's writer. Nothing here touches
 * localStorage: the renderer never reads cast.json.
 *
 * Guarded by the `migratedLegacyAt` marker, so it runs once even when the
 * legacy file is absent.
 */
function migrateLegacy({ file = CAST_FILE(), avatarsFile = undefined, now = Date.now } = {}) {
  const resolved = path.resolve(file);
  const legacyFile = avatarsFile ? path.resolve(avatarsFile) : LEGACY_AVATARS_FILE();
  const current = load({ file: resolved });
  if (current.snapshot && current.snapshot.migratedLegacyAt) {
    return {
      ok: true,
      migrated: false,
      reason: `already migrated at ${current.snapshot.migratedLegacyAt}`,
      characters: 0,
      voices: 0,
      legacyFile,
      legacyKept: fs.existsSync(legacyFile),
    };
  }

  let legacy = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(legacyFile, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) legacy = parsed;
  } catch {
    /* no legacy map on this machine — the marker is still written, once */
  }

  let characters = 0;
  let voices = 0;
  const result = write(
    (draft) => {
      draft.version = 1;
      if (!draft.authors || typeof draft.authors !== "object" || Array.isArray(draft.authors)) draft.authors = {};
      const row = (agent) => {
        const key = normaliseAuthor(agent);
        if (!key) return null;
        if (!draft.authors[key] || typeof draft.authors[key] !== "object" || Array.isArray(draft.authors[key])) {
          draft.authors[key] = {};
        }
        return draft.authors[key];
      };
      for (const [agent, character] of Object.entries(legacy)) {
        if (typeof character !== "string" || !character.trim()) continue;
        const record = row(agent);
        if (!record) continue;
        // Never overwrite what the owner has already authored here.
        if (record.character === undefined || record.character === null) {
          record.character = character.trim();
          characters += 1;
        }
      }
      for (const [agent, voice] of Object.entries(LEGACY_AGENT_VOICES)) {
        const record = row(agent);
        if (!record) continue;
        if (record.voice === undefined || record.voice === null) {
          record.voice = voice;
          voices += 1;
        }
      }
      draft.migratedLegacyAt = new Date(now()).toISOString();
      return draft;
    },
    { file: resolved },
  );

  return {
    ok: result.ok,
    migrated: result.ok,
    reason: result.error || null,
    characters,
    voices,
    legacyFile,
    legacyKept: fs.existsSync(legacyFile),
    problems: result.problems,
    snapshot: result.snapshot,
  };
}

module.exports = {
  ACTOR_FIELDS,
  BUILTIN_INPUT,
  INPUT_FIELDS,
  TALK_MODES,
  resolveInput,
  resolveHotkeys,
  BUILTIN_ACTOR,
  BUILTIN_APPEARANCE,
  knownThemes,
  BUILTIN_CONTENT,
  BUILTIN_DESK,
  BUILTIN_PHYSICS,
  BUILTIN_STAGE,
  BUILTIN_VOICE,
  CAST_FILE,
  INVALID_FILE,
  LEGACY_AGENT_VOICES,
  LEGACY_AVATARS_FILE,
  ORIGIN_LITERALS,
  PHYSICS_FIELDS,
  PHYSICS_MULTIPLIER_MAX,
  JIGGLE_MAX,
  POSITION_BOUND,
  PRESENCE_LEVELS,
  SCALE_MAX,
  SCALE_MIN,
  SEAT_LIMIT,
  SEEN_FILE,
  SPEED_MAX,
  SPEED_MIN,
  VOICES,
  channelKey,
  characterOrder,
  hash33,
  load,
  migrateLegacy,
  normaliseAuthor,
  noteSeen,
  originOf,
  readSeen,
  CONTENT_RATINGS,
  resolveActor,
  resolveContent,
  resolveDesk,
  resolveStage,
  resolveVoice,
  seatIndexFor,
  stableCharacter,
  stableVoice,
  validateCast,
  watch,
  write,
};
