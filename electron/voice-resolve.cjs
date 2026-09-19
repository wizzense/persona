"use strict";

/**
 * voice-resolve — the ONE audibility gate every speech door consults.
 *
 * Three doors put text in front of AitherVoice today: a room-stage row (its
 * OWN gate already lives in room-stage.cjs/cast-config.resolveActor, which
 * drops "off"/"quiet"/speak:false rows before they ever reach the queue), the
 * HTTP `POST /speak` route, and the MCP `speak` tool. A room-only gate leaves
 * the last two wide open — main.cjs's speakAloud() is the single funnel that
 * calls resolveSpeech() for EVERY caller, so this file is what actually
 * enforces cast.json's presence/speak grants outside the room.
 *
 * Pure apart from a cached file read (see cache() below): no Electron import,
 * no daemon, no voice service — testable with `node electron/voice-resolve.test.cjs`.
 * A throwing loader must never take the avatar's voice down: every exported
 * function is fail-open on an internal error (see main.cjs's own comment at
 * its `resolveSpeech` call site — it treats a throw here the same as this
 * module not existing yet).
 */

const fs = require("node:fs");

const cast = require("./cast-config.cjs");

// ─── snapshot cache ──────────────────────────────────────────────────────────

/**
 * resolveSpeech runs on every utterance — potentially several a second once
 * a room is busy — so re-reading, re-parsing and re-validating cast.json on
 * every call would make the hot path pay disk I/O for no reason. Cached by
 * resolved path + mtime, which self-invalidates the instant an owner edit
 * (or cast-window's write()) lands; a missing file (mtimeMs === null) is
 * cached too, so a box with no cast.json yet does not stat() on every line.
 */
let cache = null; // { file, mtimeMs, snapshot, problems, error }

function statMtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function currentSnapshot({ file } = {}) {
  const resolved = file || cast.CAST_FILE();
  const mtimeMs = statMtime(resolved);
  if (cache && cache.file === resolved && cache.mtimeMs === mtimeMs) {
    return cache;
  }
  // cast.load() is itself fail-soft (malformed bytes -> its own last-good
  // snapshot, see cast-config.cjs's `failSoft`) — nothing extra to catch here.
  const { snapshot, problems, error } = cast.load({ file: resolved });
  cache = { file: resolved, mtimeMs, snapshot, problems, error };
  return cache;
}

// ─── origin round-trip ───────────────────────────────────────────────────────

/**
 * A caller hands resolveSpeech the STAMPED origin KEY as a flat string --
 * "bridge:/speak", "mcp:speak", "desk:drop", "service:awdesk", or a room
 * row's own origin.key (see main.cjs's speakAloud doc comment). Turning that
 * string back into cast-config's {kind, id, channel, nick} shape is NOT the
 * same as handing it to originOf({key}) directly:
 *
 *   originOf({key}) keeps only the FIRST colon (id = everything after it,
 *   slashes preserved) -- correct for "bridge:/speak" (id "/speak") but WRONG
 *   for a relay nick's own key, "relay:#chan:nick", where the general
 *   kind/channel/nick branch is what originOf actually uses when room-stage
 *   first MINTED that key (originOf({kind:"relay", channel, nick})). Re-
 *   parsing it through the {key} path would collapse "#chan:nick" into one
 *   mangled id and never match the actors["relay:#chan:nick"] tier the file
 *   was authored against.
 *
 * So: relay origins are decomposed by hand (channel = the segment right
 * after "relay:", nick = whatever follows its own colon, if any) and handed
 * to originOf as {kind, channel, nick} -- everything else round-trips
 * through the plain {key} form, which is the one that keeps a slash.
 */
function originFromKey(originKey) {
  const raw = String(originKey == null ? "" : originKey).trim() || cast.ORIGIN_LITERALS.SERVICE_AWDESK;
  const firstColon = raw.indexOf(":");
  const kind = (firstColon === -1 ? raw : raw.slice(0, firstColon)).toLowerCase();
  if (kind === "relay") {
    const rest = firstColon === -1 ? "" : raw.slice(firstColon + 1);
    const secondColon = rest.indexOf(":");
    const channel = secondColon === -1 ? rest : rest.slice(0, secondColon);
    const nick = secondColon === -1 ? null : rest.slice(secondColon + 1) || null;
    return cast.originOf({ kind: "relay", channel, nick });
  }
  return cast.originOf({ key: raw });
}

/**
 * matchedTier — did this origin match anything an owner actually authored
 * (actors[...] / channels[...] / authors.<x>), or is every field we care
 * about coming from `defaults`, `builtin` or a stable `hash`? This is the
 * SAME test noteSeen exists to answer, computed from resolveActor's own
 * provenance rather than re-deriving it, so the two can never disagree.
 */
function matchedTier(resolution) {
  const froms = [
    resolution.presenceFrom,
    resolution.speakFrom,
    resolution.voiceFrom,
    resolution.speedFrom,
    resolution.bodyFrom,
  ];
  return froms.some((from) => typeof from === "string" && /^(actors\[|channels\[|authors\.)/.test(from));
}

// ─── the gate ────────────────────────────────────────────────────────────────

/**
 * resolveSpeech — allowed?, and if so what to say it with.
 *
 * @param {object} ctx
 *   {origin: string, slotId?: string, text?: string, file?: string}
 *   `file` is a TEST SEAM (see cast-config.cjs's own DESK_CAST_FILE doc) --
 *   production never sets it, so cast.CAST_FILE() (which honours
 *   DESK_CAST_FILE) picks the snapshot.
 * @returns {{allowed: boolean, reason: string|null, voice: string,
 *            speed: number, maxChars: number, provenance: object}}
 *   Never throws. A caller that cannot even construct a valid ctx gets
 *   allowed:true with the built-in voice -- refusing to speak because OUR
 *   code broke would be a worse failure than an unfiltered "service:awdesk".
 */
function resolveSpeech(ctx = {}) {
  const slotId = ctx.slotId != null ? String(ctx.slotId) : null;
  const resolvedFile = ctx.file || cast.CAST_FILE();
  try {
    const { snapshot } = currentSnapshot({ file: resolvedFile });
    const origin = originFromKey(ctx.origin);
    const resolution = cast.resolveActor(snapshot, { origin, roster: null });

    if (!matchedTier(resolution)) {
      // Best-effort by construction (cast-config.noteSeen never throws) --
      // this is what lets the Cast pane offer "seen but silent" origins
      // instead of an agent staying mysteriously mute forever. The seen-book
      // is a SIBLING of the cast file actually in force for this call, not
      // whatever CAST_FILE() would resolve to right now (a test fixture
      // must not leak a row into the real %APPDATA%\Desk\cast-seen.json).
      cast.noteSeen(origin, ctx.text, { file: cast.SEEN_FILE(resolvedFile) });
    }

    const provenance = {
      key: resolution.key,
      slotId,
      presenceFrom: resolution.presenceFrom,
      speakFrom: resolution.speakFrom,
      voiceFrom: resolution.voiceFrom,
      speedFrom: resolution.speedFrom,
      maxCharsFrom: resolution.maxCharsFrom,
    };

    if (!resolution.voiced) {
      return {
        allowed: false,
        reason: resolution.voicedReason || `${resolution.key} is not audible`,
        voice: resolution.voice,
        speed: resolution.speed,
        maxChars: resolution.maxChars,
        provenance,
      };
    }

    return {
      allowed: true,
      reason: null,
      voice: resolution.voice,
      speed: resolution.speed,
      maxChars: resolution.maxChars,
      provenance,
    };
  } catch (error) {
    // Fail OPEN: a bug in this gate must not be able to silence the avatar
    // (see the module doc comment / main.cjs's own guarded-require fallback).
    return {
      allowed: true,
      reason: null,
      voice: "nova",
      speed: null,
      maxChars: 2000,
      provenance: { key: null, slotId, error: String(error && error.message ? error.message : error) },
    };
  }
}

module.exports = {
  resolveSpeech,
};

if (require.main === module) {
  // Self-test: no cast.json on disk (a bare-default "service:awdesk" call
  // must be allowed), then an authored mute and an authored grant, against a
  // real tmp fixture -- exit 0 = the gate holds, 2 = a contract broke.
  (async () => {
    const os = require("node:os");
    const path = require("node:path");
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-resolve-selftest-"));
      const file = path.join(dir, "cast.json");

      const bare = resolveSpeech({ origin: "service:awdesk", text: "hi", file });
      if (bare.allowed !== true) throw new Error(`bare default must be allowed: ${JSON.stringify(bare)}`);

      fs.writeFileSync(
        file,
        JSON.stringify({ version: 1, actors: { "mcp:speak": { speak: false } } }, null, 2),
        "utf8",
      );
      const muted = resolveSpeech({ origin: "mcp:speak", text: "hi", file });
      if (muted.allowed !== false) throw new Error(`speak:false must refuse: ${JSON.stringify(muted)}`);
      if (!/speak=false/.test(muted.reason || "")) throw new Error(`reason must name speak=false: ${muted.reason}`);

      const granted = resolveSpeech({ origin: "bridge:/speak", text: "hi", file });
      if (granted.allowed !== true) throw new Error(`ungated origin must be allowed: ${JSON.stringify(granted)}`);

      console.log("VOICE-RESOLVE OK: bare default, mute and grant all resolved correctly");
      fs.rmSync(dir, { recursive: true, force: true });
      process.exit(0);
    } catch (error) {
      console.error(`VOICE-RESOLVE BROKEN: ${error && error.stack ? error.stack : error}`);
      process.exit(2);
    }
  })();
}
