"use strict";

/**
 * room-stage-host — the composition module main.cjs delegates to.
 *
 * 2026-09-19, U07: main.cjs owned this wiring inline (startRoomStage() built
 * a RoomStage with an `io` object closing over half a dozen main-side
 * functions, plus a raw `Number(process.env...) || default` for the stage
 * knobs). A peer session is reducing main.cjs to a thin delegation, so every
 * one of those functions is now INJECTED rather than closed over -- see
 * `startRoomStage(deps)`'s doc for the exact shape -- and this file owns:
 *
 *   1. building the RoomStage `io` (recentChat/spawn/remove/speak/onEvict)
 *      and the ONE new thing U01/U02 added: `io.resolve(row)`, cast-config's
 *      ActorResolution for that row (character/voice/speed/place/presence/...).
 *      There is no more local roster/assignedAvatar/residentCharacter
 *      fallback in room-stage.cjs -- everything about who gets a body, what
 *      they sound like and where they stand now comes from cast.json via
 *      this resolver. See cast-config.cjs's header for the full precedence.
 *   2. the stage-wide knobs (maxBodies/idleSeconds/cooldownSeconds/gapMs/
 *      pollMs), file-first with the two PRE-cast.json env vars
 *      (DESK_ROOM_MAX_BODIES, DESK_ROOM_IDLE_S) as a legacy tier below it --
 *      see `resolveStageKnobs`'s doc for why that tier keeps its old bug.
 *   3. hot reload: cast-config.watch fires roomStage.setConfig(snapshot) AND
 *      reconciles who is already on stage against the new file -- a changed
 *      character gets RE-SPAWNED (never `applyCharacter`, which reloads the
 *      whole renderer; see risk below), a changed place gets ONE
 *      `place-avatar` event, and nothing else moves.
 *   4. the Cast pane's write surface (`castPaneImpl`) -- describe/setActor/
 *      clearActor/setStage/setVoice/setChannel/captureStage/muteOrigin/
 *      reveal, all thin wrappers over cast-config.write with the live
 *      on-stage rows resolved so the pane can show provenance (`voiceFrom`,
 *      `characterFrom`, ...).
 *
 * Every main-side capability arrives as `deps`, never a `require("./main.cjs")`
 * or an Electron import -- this file is as pure as room-stage.cjs and
 * cast-config.cjs, and its own tests stub every dep. The one thing it DOES
 * require directly is cast-config.cjs (co-located, pure, no Electron) and,
 * lazily inside startRoomStage, room-stage.cjs's RoomStage class (or
 * `deps.RoomStage`, a test seam -- see that function's doc).
 *
 * 🚩 RISK (plan's own words): this is the unit that keeps main.cjs small. If
 * its dep signatures drift from main's REAL functions the desk boots with no
 * room stage and the only symptom is silence. `startRoomStageTest001` below
 * (the regression arm cited in the plan) asserts `io.resolve` is actually a
 * function, not merely present -- the earlier `voices` option was plumbed
 * end to end through three files and never supplied by anything, which is
 * exactly this failure mode with a different field name.
 */

const cast = require("./cast-config.cjs");

// ─── module-level state: ONE room stage, ONE watcher, per process ───────────
//
// Mirrors main.cjs's own former `let roomStage = null;` -- there is exactly
// one company room per desk, so a module-level singleton (rather than an
// object main.cjs has to thread everywhere) is what lets evictSlot()/status()
// stay one-line calls from main without main holding a reference at all.
let activeStage = null;
let activeUnwatch = null;
let liveSnapshot = null; // the snapshot the LIVE stage's resolver reads -- kept
// in lockstep with roomStage.setConfig() by the same watch callback, so
// resolve() never re-reads the file per utterance (see buildResolver's doc).
const seatState = {}; // cast-config.seatIndexFor's own bookkeeping object --
// ONE instance shared by the live resolver AND castPaneImpl's, so a seat
// assigned while chatting is the SAME seat the Cast pane's provenance shows.
const placeCache = new Map(); // slotId -> JSON.stringify(place), so the
// watch-driven reconcile sends a place-avatar event only when the RESOLVED
// place actually changed, not on every file save.

//: A safe stage-center default `captureStage()` pins for an on-stage actor
//: that has never been placed -- position [0,0,0] and scale 1 pass vPlace's
//: own bounds (POSITION_BOUND=2, SCALE_MIN/MAX 0.05-10) unconditionally, so
//: the write this produces can never be the thing that makes cast.json
//: invalid. "Capture" is meant to freeze the CURRENT arrangement (explicit or
//: hashed) into the file for the owner to nudge from the pane afterward, not
//: to invent a placement no one asked for.
const DEFAULT_PLACE = Object.freeze({ position: [0, 0, 0], scale: 1, yaw: 0 });

/** The cast file this call should read/write: `deps.castFile` (a string or a
 *  zero-arg function -- accepted both ways so a test can hand a plain path
 *  and production can hand a lazy one) or cast-config's own CAST_FILE(). Every
 *  cast-config call in this file takes `{file}` explicitly rather than
 *  relying on the DESK_CAST_FILE env seam, because THIS module's own tests
 *  run many isolated cast-config fixtures inside one `node --test` process
 *  (sequential, not parallel-child-process racy) and env mutation across that
 *  many arms is exactly the trap cast-config.test.cjs's header warns about. */
function resolveCastFile(deps) {
  const raw = typeof deps.castFile === "function" ? deps.castFile() : deps.castFile;
  return raw || cast.CAST_FILE();
}

/** The SAFE roster (content-rating already applied) `resolveActor` hashes a
 *  character out of. Fail-soft: an empty roster means "nothing to judge
 *  against" to stableCharacter/resolveActor, not a thrown error mid-poll. */
function safeRoster(deps) {
  try {
    return deps.filterCharacters(deps.listCharacters());
  } catch {
    return [];
  }
}

/**
 * liveResident — the character NAME the resident avatar (slot0) currently
 * wears, so a hash-picked visitor never lands on the same body. `stage.resident`
 * in cast.json is an OWNER OVERRIDE of this (cast-config.migrateLegacy's own
 * doc: "`.active-character` is NOT subsumed -- stage.resident is an optional
 * override"); when the file does not set it, the live value from
 * `deps.getActiveCharacter()` is what resolveActor needs -- and resolveActor's
 * OWN fallback (when ctx.resident is left undefined) only ever reads the
 * file's value, defaulting to null, never the live one. So this file computes
 * the combined value itself and always passes it explicitly.
 */
function liveResident(deps, snapshot) {
  const fileOnly = cast.resolveStage(snapshot, { env: {} });
  if (fileOnly.residentFrom === "stage.resident" && fileOnly.resident) return fileOnly.resident;
  try {
    return deps.getActiveCharacter() || null;
  } catch {
    return null;
  }
}

/** Characters already worn on stage right now -- the `taken` set
 *  `stableCharacter`/`resolveActor` must skip so two agents never share a
 *  body. Read from the live stage's own bookkeeping when one is running;
 *  empty otherwise (nothing is taken if nothing is on stage). */
function takenCharacters() {
  if (!activeStage || typeof activeStage.status !== "function") return [];
  try {
    return activeStage
      .status()
      .onStage.map((s) => s.character)
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * buildResolver — the `resolve(row) -> ActorResolution` RoomStage requires
 * (io.resolve, see room-stage.cjs's constructor doc) and castPaneImpl's own
 * provenance calls share.
 *
 * `getSnapshot` decouples the two callers' freshness needs: the LIVE stage
 * (startRoomStage) keeps `liveSnapshot` in lockstep with every
 * cast-config.watch fire (the SAME event that calls roomStage.setConfig), so
 * a per-utterance resolve() never re-reads the file; castPaneImpl has no
 * watcher of its own (the pane is opened on demand, not polled) and passes
 * no `getSnapshot`, so it loads fresh every call -- correct over fast for a
 * human clicking a button, not a hot loop.
 */
function buildResolver(deps, castFile, getSnapshot) {
  return function resolve(row) {
    const r = row && typeof row === "object" ? row : {};
    const env = deps.env || process.env;
    const snapshot = getSnapshot ? getSnapshot() : cast.load({ file: castFile() }).snapshot;
    const origin =
      r.origin && Array.isArray(r.origin.keys)
        ? r.origin
        : cast.originOf({ kind: r.actorKind ?? r.kind, id: r.actorId ?? r.id, channel: r.channel, nick: r.nick });
    const seat = cast.seatIndexFor(seatState, { author: r.author, actorId: r.actorId });
    return cast.resolveActor(snapshot, {
      author: r.author,
      actorId: r.actorId,
      actorKind: r.actorKind,
      channel: r.channel,
      nick: r.nick,
      origin,
      seat,
      roster: safeRoster(deps),
      taken: takenCharacters(),
      resident: liveResident(deps, snapshot),
      env,
    });
  };
}

/**
 * resolveStageKnobs — the five stage-wide numbers, file-first, with the two
 * PRE-cast.json env vars (DESK_ROOM_MAX_BODIES, DESK_ROOM_IDLE_S -- the only
 * two that ever existed; cooldownSeconds/gapMs/pollMs had no env override
 * before cast.json either, so those three are simply file-or-builtin, which
 * is exactly what `cast.resolveStage` already gives with no env tier asked
 * for) below the file and above the built-in.
 *
 * 🚩 cast-config.resolveStage's OWN env tier (`envNumber`) does NOT have the
 * `Number(x) || default` bug -- it checks `undefined`/`""` explicitly, so
 * DESK_ROOM_MAX_BODIES=0 read straight through resolveStage's env tier would
 * come out 0. That is a BEHAVIOR CHANGE from the code this replaces
 * (main.cjs: `Math.max(0, Number(process.env.DESK_ROOM_MAX_BODIES) || 3)`,
 * where "0" and "unset" produce the identical 3 because both are falsy). An
 * operator who set that env var to silence the room before cast.json existed
 * must get the SAME silence-or-not behavior after this refactor, not a
 * quiet fix bundled into an unrelated file split -- so this function asks
 * cast-config for the FILE tier only (`env: {}`, stripping its env fallback)
 * and applies the legacy expression itself, bug included, as the tier below
 * it. The FILE tier is unaffected (JSON has a real absent/present
 * distinction `||` never had) -- `stage.maxBodies: 0` in cast.json reaches
 * RoomStage as 0. Only the LEGACY ENV tier keeps the old trap.
 */
function resolveStageKnobs(snapshot, env) {
  const fromFile = cast.resolveStage(snapshot, { env: {} });
  const e = env || {};
  const legacyMaxBodies = Math.max(0, Number(e.DESK_ROOM_MAX_BODIES) || 3);
  const legacyIdleSeconds = Math.max(60, Number(e.DESK_ROOM_IDLE_S) || 600);
  const maxBodies = fromFile.maxBodiesFrom === "stage.maxBodies" ? fromFile.maxBodies : legacyMaxBodies;
  const idleSeconds = fromFile.idleSecondsFrom === "stage.idleSeconds" ? fromFile.idleSeconds : legacyIdleSeconds;
  return {
    maxBodies,
    idleMs: idleSeconds * 1000,
    cooldownMs: fromFile.cooldownSeconds * 1000,
    gapMs: fromFile.gapMs,
    pollMs: fromFile.pollMs,
  };
}

function placeKey(place) {
  return place ? JSON.stringify(place) : null;
}

/** Send ONE place-avatar event for `slotId` and remember it, so the next
 *  identical resolution is a no-op (see `placeCache`'s doc). No-op when
 *  `place` is falsy -- an actor with no authored/hashed place is left where
 *  the renderer already put it. */
function sendPlace(deps, slotId, place) {
  if (!place) return;
  placeCache.set(slotId, placeKey(place));
  deps.sendToRenderer({ type: "place-avatar", slotId, position: place.position, scale: place.scale, yaw: place.yaw });
}

/** Same as sendPlace, but only when the resolved place actually differs from
 *  the last one sent for this slot -- the hot-reload path, where most
 *  on-stage rows resolve to the SAME place on every file save. */
function maybeSendPlace(deps, slotId, place) {
  const key = placeKey(place);
  if (!key || placeCache.get(slotId) === key) return;
  sendPlace(deps, slotId, place);
}

/**
 * reconcileOnStage — cast-config.watch's onChange handler, past
 * `roomStage.setConfig(snapshot)`. For every row already on stage, resolve it
 * fresh against the NEW file and:
 *   - a changed character -> RE-SPAWN via deps.spawnAvatarSlot (never
 *     `applyCharacter`, which reloads the renderer's whole document and is
 *     the measured avatar-switch bug this plan calls out by name). Room-stage
 *     class does not expose the class a slot renders -- see the comment at
 *     the call site below.
 *   - a changed place (or an unchanged character but a first-time/changed
 *     place) -> one place-avatar event.
 * A row whose character AND place both already match the new resolution is
 * left completely alone -- most rows on most saves.
 */
function reconcileOnStage(deps, stage, resolve) {
  if (!stage || typeof stage.status !== "function") return;
  let onStage;
  try {
    onStage = stage.status().onStage;
  } catch {
    return;
  }
  for (const row of Array.isArray(onStage) ? onStage : []) {
    const origin = cast.originOf({ kind: row.actorKind, id: row.actorId });
    const resolution = resolve({ author: row.agent, actorId: row.actorId, actorKind: row.actorKind, origin });
    if (resolution.character && resolution.character !== row.character) {
      const ok = deps.spawnAvatarSlot(row.slotId, resolution.character, row.agent, resolution.place);
      if (!ok) continue;
      // 🚩 room-stage.cjs (U02, peer-held -- not touched by this unit)
      // exposes no public setter for a slot's character once spawned:
      // ensureSlot() short-circuits on `this.slots.has(slotId)` before it
      // ever looks at the resolution again (see that method's doc). `slots`
      // is a plain, undocumented-but-unprefixed Map property, the SAME shape
      // ensureSlot itself writes (`{agent, character, actorId, actorKind}`)
      // -- this is the only way the host can keep that bookkeeping in sync
      // with a hot-reload re-spawn without editing the peer's file.
      stage.slots.set(row.slotId, { agent: row.agent, character: resolution.character, actorId: row.actorId || "", actorKind: row.actorKind || "" });
      sendPlace(deps, row.slotId, resolution.place);
    } else {
      maybeSendPlace(deps, row.slotId, resolution.place);
    }
  }
}

/**
 * startRoomStage — build and start the company room. Idempotent (a second
 * call while one is already running returns the SAME stage, matching
 * main.cjs's former `if (roomStage || !roomPublisher) return;` guard) and
 * returns `null` when there is nothing to start: no `deps.roomPublisher` yet,
 * or `DESK_ROOM_STAGE=0` (the room stays text-only -- unchanged from before
 * cast.json existed; this switch has no file-authored equivalent on purpose,
 * it is a boot-time feature flag, not a per-actor trust decision).
 *
 * @param {object} deps
 * @param {object} deps.roomPublisher   .recentChat(opts) -> Promise<rows>
 * @param {(slotId, character, agent, place) => boolean} deps.spawnAvatarSlot
 * @param {(slotId) => boolean} deps.removeAvatarSlot
 * @param {(text, voice, speed, slotId) => Promise<{ok, durationMs?, reason?}>} deps.speakAloud
 *   main's REAL signature (text, voice, speed, slotId) -- see the io.speak
 *   wrapper below; the OLD wiring always passed `speed=undefined`, which is
 *   why per-actor speed never reached the voice service until now.
 * @param {() => string[]} deps.listCharacters
 * @param {(names: string[]) => string[]} deps.filterCharacters
 * @param {() => string|null} deps.getActiveCharacter
 * @param {(event: object) => void} deps.sendToRenderer   main's emitToRenderer
 * @param {(...args) => void} [deps.log]
 * @param {object} [deps.env]   defaults to process.env
 * @param {string|() => string} [deps.castFile]   test seam, see resolveCastFile
 * @param {new (io, options) => object} [deps.RoomStage]   test seam: override
 *   the RoomStage constructor so a test can assert exactly what `io` and
 *   `options` this function builds without a real fs.watch/timer/Electron
 *   window in play. Production omits it and gets room-stage.cjs's real class.
 * @param {number} [deps.watchDebounceMs]   test seam: cast-config.watch's
 *   debounce, default 250ms in production; tests pass a small value so the
 *   regression arm for reconcileOnStage does not need a multi-second sleep.
 * @returns {object|null} the RoomStage instance, or null if not started.
 */
function startRoomStage(deps = {}) {
  if (activeStage) return activeStage;
  const env = deps.env || process.env;
  if (String(env.DESK_ROOM_STAGE || "1").trim() === "0") return null;
  if (!deps.roomPublisher) return null;

  const castFile = () => resolveCastFile(deps);
  const loaded = cast.load({ file: castFile() });
  liveSnapshot = loaded.snapshot;
  const resolve = buildResolver(deps, castFile, () => liveSnapshot);
  const knobs = resolveStageKnobs(liveSnapshot, env);
  const log = typeof deps.log === "function" ? deps.log : () => {};

  const RoomStageCtor = deps.RoomStage || require("./room-stage.cjs").RoomStage;
  const stage = new RoomStageCtor(
    {
      recentChat: (opts) => deps.roomPublisher.recentChat(opts),
      resolve,
      onEvict: (slotId) => placeCache.delete(slotId),
      spawn: (slotId, character, agent, place) => deps.spawnAvatarSlot(slotId, character, agent, place),
      remove: (slotId) => deps.removeAvatarSlot(slotId),
      // io.speak's own call shape is (text, voice, slotId, speed) -- see
      // room-stage.cjs's drain(); deps.speakAloud's is main's REAL
      // (text, voice, speed, slotId). Reordering here (not renaming main's
      // signature, which is peer-held) is what lets resolution.speed reach
      // the voice service at all -- the prior wiring hardcoded `undefined`.
      speak: (text, voice, slotId, speed) => deps.speakAloud(text, voice, speed, slotId),
    },
    {
      idleMs: knobs.idleMs,
      pollMs: knobs.pollMs,
      gapMs: knobs.gapMs,
      cooldownMs: knobs.cooldownMs,
      maxBodies: knobs.maxBodies,
      config: loaded,
      log,
    },
  );

  activeStage = stage;
  placeCache.clear();

  activeUnwatch = cast.watch(
    (result) => {
      liveSnapshot = result.snapshot;
      stage.setConfig(result);
      reconcileOnStage(deps, stage, resolve);
    },
    { file: castFile(), debounceMs: deps.watchDebounceMs || 250 },
  );

  stage.start();
  return stage;
}

/** Stop the room stage and its watcher, and drop the singleton -- so a later
 *  startRoomStage() call actually starts a fresh one instead of returning
 *  the idempotent no-op. Main.cjs itself never calls this today (the room
 *  runs for the process lifetime); it exists for tests and for whatever a
 *  future settings toggle needs. */
function stopRoomStage() {
  if (activeUnwatch) {
    activeUnwatch();
    activeUnwatch = null;
  }
  if (activeStage && typeof activeStage.stop === "function") activeStage.stop();
  activeStage = null;
  liveSnapshot = null;
  placeCache.clear();
}

/** `roomStage.status()` for whatever main/mcp-server used to read directly
 *  off its own local variable -- null when no stage is running, matching the
 *  `roomStage ? roomStage.status() : null` guard every prior call site used. */
function status() {
  return activeStage && typeof activeStage.status === "function" ? activeStage.status() : null;
}

/**
 * evictSlot — main's removeAvatarSlot hook, in one line. After main removes
 * the VISUAL slot itself, this drops room-stage's own bookkeeping (slots/
 * lastSeen/lastVoiced, via RoomStage.evict) for the same slotId, so a
 * manually-removed avatar does not linger as a ghost the idle sweep -- or a
 * later resolve()'s `taken` set -- still believes is on stage. False (not a
 * throw) when no room stage is running or the slot was never on stage;
 * RoomStage.evict() calling io.remove() a second time on an already-gone
 * slot is already a harmless no-op in main's real removeAvatarSlot.
 */
function evictSlot(slotId) {
  if (!activeStage || typeof activeStage.evict !== "function") return false;
  return activeStage.evict(slotId);
}

/**
 * castPaneImpl — the Cast pane's write surface, over cast-config.write, plus
 * `describe()` for its read surface (the live snapshot + every on-stage
 * row's resolution, so the pane can say WHY -- `characterFrom`, `voiceFrom`,
 * ... -- and the seen-but-silent book so an unmuted-nowhere origin is
 * discoverable in one click).
 *
 * Independent of `startRoomStage` (a pane may open before the room starts,
 * or DESK_ROOM_STAGE=0), but reads the SAME module-level `activeStage`
 * singleton for on-stage provenance when one exists.
 *
 * @param {object} deps   the same shape startRoomStage takes; only
 *   listCharacters/filterCharacters/env/castFile are actually read here
 *   (describe()'s roster field, and the resolver).
 */
function castPaneImpl(deps = {}) {
  const castFile = () => resolveCastFile(deps);
  // No `getSnapshot` -- see buildResolver's doc: the pane is opened on
  // demand, so "load fresh every call" is correct, not merely convenient.
  const resolve = buildResolver(deps, castFile, null);

  function write(mutation) {
    return cast.write(mutation, { file: castFile() });
  }

  function describe() {
    const loaded = cast.load({ file: castFile() });
    const onStageRaw = activeStage && typeof activeStage.status === "function" ? activeStage.status().onStage : [];
    const onStage = (Array.isArray(onStageRaw) ? onStageRaw : []).map((row) => {
      const origin = cast.originOf({ kind: row.actorKind, id: row.actorId });
      return {
        ...row,
        origin: origin.key,
        resolution: resolve({ author: row.agent, actorId: row.actorId, actorKind: row.actorKind, origin }),
      };
    });
    let seen;
    try {
      seen = cast.readSeen({ file: cast.SEEN_FILE(castFile()) });
    } catch {
      seen = {};
    }
    // Resolved WITH provenance, so the pane can say "deepseek, from the built-in"
    // or "opus, from env.AWDESK_CLAUDE_PROFILE" instead of showing a blank box.
    let deskResolved;
    try {
      deskResolved = cast.resolveDesk(loaded.snapshot || { version: 1 }, { env: deps.env || process.env });
    } catch {
      deskResolved = null;
    }
    let syncStatus;
    try {
      syncStatus = typeof deps.syncStatus === "function" ? deps.syncStatus() : null;
    } catch {
      syncStatus = null;
    }
    return {
      snapshot: loaded.snapshot,
      problems: loaded.problems,
      error: loaded.error,
      roster: safeRoster(deps),
      onStage,
      seen,
      desk: deskResolved,
      sync: syncStatus,
    };
  }

  /** Merge `patch` into `actors[key]` (creating the record if absent). */
  function setActor({ key, patch } = {}) {
    if (!key) return { ok: false, snapshot: null, problems: [], error: "setActor: key is required" };
    return write((draft) => {
      draft.actors = draft.actors || {};
      draft.actors[key] = { ...(draft.actors[key] || {}), ...(patch || {}) };
      return draft;
    });
  }

  /** Drop `actors[key]` entirely -- the record reverts to whatever the next
   *  tier down (channel/class/author/defaults) already grants. */
  function clearActor({ key } = {}) {
    if (!key) return { ok: false, snapshot: null, problems: [], error: "clearActor: key is required" };
    return write((draft) => {
      if (draft.actors) delete draft.actors[key];
      return draft;
    });
  }

  function setStage(patch = {}) {
    return write((draft) => {
      draft.stage = { ...(draft.stage || {}), ...(patch || {}) };
      return draft;
    });
  }

  function setVoice(patch = {}) {
    return write((draft) => {
      draft.voice = { ...(draft.voice || {}), ...(patch || {}) };
      return draft;
    });
  }

  /** The desk's own behaviour sections. ONE door with a closed list, rather than
   *  a door per section: the list is what stops a renderer from using this to
   *  write `actors` or `channels` around the handlers that exist for them. */
  const DESK_SECTIONS = ["models", "prompts", "vision", "sync"];
  function setSection({ section, patch } = {}) {
    if (!DESK_SECTIONS.includes(section)) {
      return { ok: false, snapshot: null, problems: [], error: `setSection: unknown section ${JSON.stringify(section)}` };
    }
    return write((draft) => {
      draft[section] = { ...(draft[section] || {}), ...(patch || {}) };
      return draft;
    });
  }

  function setChannel({ channel, patch } = {}) {
    if (!channel) return { ok: false, snapshot: null, problems: [], error: "setChannel: channel is required" };
    return write((draft) => {
      draft.channels = draft.channels || {};
      draft.channels[channel] = { ...(draft.channels[channel] || {}), ...(patch || {}) };
      return draft;
    });
  }

  /**
   * captureStage — pin every on-stage actor's CURRENT resolved place
   * (authored or hashed; DEFAULT_PLACE when none resolves at all) into
   * `actors[<origin key>].place`, so the pane's next edit is a nudge from a
   * known-good arrangement instead of an empty slate. A no-op ok:true when
   * nothing is on stage (nothing to capture is not an error).
   */
  function captureStage() {
    const onStageRaw = activeStage && typeof activeStage.status === "function" ? activeStage.status().onStage : [];
    const onStage = Array.isArray(onStageRaw) ? onStageRaw : [];
    if (onStage.length === 0) return { ok: true, snapshot: null, problems: [], error: null, captured: 0 };
    let captured = 0;
    const result = write((draft) => {
      draft.actors = draft.actors || {};
      for (const row of onStage) {
        const origin = cast.originOf({ kind: row.actorKind, id: row.actorId });
        const resolution = resolve({ author: row.agent, actorId: row.actorId, actorKind: row.actorKind, origin });
        draft.actors[origin.key] = { ...(draft.actors[origin.key] || {}), place: resolution.place || DEFAULT_PLACE };
        captured += 1;
      }
      return draft;
    });
    return { ...result, captured: result.ok ? captured : 0 };
  }

  /** Hard mute: `speak:false` beats presence and keeps the body -- "be here,
   *  say nothing" (room-stage.cjs's own enqueue() doc). */
  function muteOrigin({ key } = {}) {
    if (!key) return { ok: false, snapshot: null, problems: [], error: "muteOrigin: key is required" };
    return write((draft) => {
      draft.actors = draft.actors || {};
      draft.actors[key] = { ...(draft.actors[key] || {}), speak: false };
      return draft;
    });
  }

  /** The inverse of muteOrigin AND of a `presence:"off"`/`"quiet"` grant:
   *  clears any mute and sets presence back to "normal" explicitly, so a
   *  once-silenced or never-granted origin (surfaced from `describe().seen`)
   *  is a single click to bring back. */
  function reveal({ key } = {}) {
    if (!key) return { ok: false, snapshot: null, problems: [], error: "reveal: key is required" };
    return write((draft) => {
      draft.actors = draft.actors || {};
      const rec = { ...(draft.actors[key] || {}) };
      delete rec.speak;
      rec.presence = "normal";
      draft.actors[key] = rec;
      return draft;
    });
  }

  return { describe, setActor, clearActor, setStage, setVoice, setSection, setChannel, captureStage, muteOrigin, reveal };
}

module.exports = {
  DEFAULT_PLACE,
  buildResolver,
  castPaneImpl,
  evictSlot,
  reconcileOnStage,
  resolveStageKnobs,
  startRoomStage,
  status,
  stopRoomStage,
};
