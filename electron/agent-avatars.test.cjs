"use strict";

/**
 * agent-avatars tests — proving the U05 shim: getAgentAvatar / setAgentAvatar /
 * clearAgentAvatar / loadMap read and write through cast-config's
 * authors[*].character, keep their exact string-in/string-out signatures, and
 * never touch the repo-root .agent-avatars.json dotfile after migration.
 *
 * Every test points DESK_CAST_FILE (and DESK_AGENT_AVATARS_FILE, so migration
 * never folds THIS machine's real dotfile into a test fixture) at a per-test
 * tmpdir — the same env-seam cast-config.test.cjs's own CAST_FILE test uses,
 * because agent-avatars.cjs's public functions take no {file} param (that is
 * the whole point of "keeps its exact signature").
 *
 *   node --test electron/agent-avatars.test.cjs
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const cast = require("./cast-config.cjs");
const avatars = require("./agent-avatars.cjs");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "desk-agent-avatars-"));
}

/**
 * Runs fn with DESK_CAST_FILE and DESK_AGENT_AVATARS_FILE pointed at fresh,
 * isolated paths (a NEW tmpdir per call, so two arms never share a cast
 * file). DESK_AGENT_AVATARS_FILE defaults to a sibling path that does not
 * exist, so migrateLegacy() finds nothing to fold in and the arm sees only
 * what it wrote itself — never this machine's real .agent-avatars.json.
 */
function withIsolatedCast(fn, { legacyContent } = {}) {
  const dir = tmpDir();
  const castFile = path.join(dir, "cast.json");
  const legacyFile = path.join(dir, "legacy-avatars.json");
  if (legacyContent !== undefined) {
    fs.writeFileSync(legacyFile, JSON.stringify(legacyContent, null, 2), "utf8");
  }
  const hadCast = process.env.DESK_CAST_FILE;
  const hadLegacy = process.env.DESK_AGENT_AVATARS_FILE;
  process.env.DESK_CAST_FILE = castFile;
  process.env.DESK_AGENT_AVATARS_FILE = legacyFile;
  try {
    return fn({ dir, castFile, legacyFile });
  } finally {
    if (hadCast === undefined) delete process.env.DESK_CAST_FILE;
    else process.env.DESK_CAST_FILE = hadCast;
    if (hadLegacy === undefined) delete process.env.DESK_AGENT_AVATARS_FILE;
    else process.env.DESK_AGENT_AVATARS_FILE = hadLegacy;
  }
}

function readRaw(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// ─── back-compat read: legacy string OR the new record ───────────────────────

test("getAgentAvatar: a legacy-shaped string row and a {character,voice} record both return the bare string", () => {
  withIsolatedCast(({ castFile }) => {
    fs.writeFileSync(
      castFile,
      JSON.stringify(
        {
          version: 1,
          migratedLegacyAt: "2026-01-01T00:00:00.000Z", // marker set: no migration noise for this arm
          authors: {
            legacyagent: "legacy-character",
            newagent: { character: "new-character", voice: "nova" },
            novoice: { voice: "echo" }, // a record with no character at all
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    assert.equal(avatars.getAgentAvatar("legacyagent"), "legacy-character");
    assert.equal(avatars.getAgentAvatar("newagent"), "new-character");
    assert.equal(avatars.getAgentAvatar("NovoiCE"), null, "a record with no character reads as unassigned, not as [object Object]");
    // normaliseAuthor lowercases — case must not matter for the lookup key.
    assert.equal(avatars.getAgentAvatar("LEGACYAGENT"), "legacy-character");
    assert.equal(avatars.getAgentAvatar("unknown-agent-xyz"), null);
  });
});

// ─── round-trip: cast file only, never the dotfile ────────────────────────────

test("setAgentAvatar then getAgentAvatar round-trips through the cast file and NEVER writes the repo-root dotfile", () => {
  withIsolatedCast(
    ({ castFile, legacyFile }) => {
      const before = fs.readFileSync(legacyFile, "utf8");
      const statBefore = fs.statSync(legacyFile);

      const ok = avatars.setAgentAvatar("testbot", "nova-vrm");
      assert.equal(ok, true);
      assert.equal(avatars.getAgentAvatar("testbot"), "nova-vrm");

      // Persisted at authors[testbot].character in the CAST file...
      const raw = readRaw(castFile);
      assert.equal(raw.authors.testbot.character, "nova-vrm");

      // ...and the legacy dotfile is untouched — byte-for-byte and mtime.
      assert.equal(fs.readFileSync(legacyFile, "utf8"), before);
      assert.equal(fs.statSync(legacyFile).mtimeMs, statBefore.mtimeMs);

      // Overwrite round-trips too.
      avatars.setAgentAvatar("testbot", "second-vrm");
      assert.equal(avatars.getAgentAvatar("testbot"), "second-vrm");
    },
    { legacyContent: { testbot: "should-never-be-read-back" } },
  );
});

// ─── clearAgentAvatar leaves the voice alone ──────────────────────────────────

test("clearAgentAvatar removes only that agent's character and leaves its voice", () => {
  withIsolatedCast(({ castFile }) => {
    const seeded = cast.write(
      (draft) => {
        draft.authors = { voicedagent: { character: "vrm-x", voice: "echo", speed: 1.1 } };
        return draft;
      },
      { file: castFile },
    );
    assert.ok(seeded.ok, seeded.error);
    assert.equal(avatars.getAgentAvatar("voicedagent"), "vrm-x");

    const ok = avatars.clearAgentAvatar("voicedagent");
    assert.equal(ok, true);
    assert.equal(avatars.getAgentAvatar("voicedagent"), null, "character is gone");

    const raw = readRaw(castFile);
    assert.equal(raw.authors.voicedagent.character, undefined, "character key removed");
    assert.equal(raw.authors.voicedagent.voice, "echo", "voice survives the clear");
    assert.equal(raw.authors.voicedagent.speed, 1.1, "other fields survive the clear too");
  });
});

// ─── fail-soft: missing/unreadable cast file ──────────────────────────────────

test("a missing cast file yields null from getAgentAvatar and {} from loadMap, never a throw", () => {
  withIsolatedCast(() => {
    // castFile deliberately never created.
    assert.doesNotThrow(() => avatars.getAgentAvatar("anyone"));
    assert.equal(avatars.getAgentAvatar("anyone"), null);
    assert.doesNotThrow(() => avatars.loadMap());
    assert.deepEqual(avatars.loadMap(), {});
  });
});

test("an unreadable (corrupt-JSON) cast file yields null / {}, never a throw", () => {
  withIsolatedCast(({ castFile }) => {
    fs.writeFileSync(castFile, "{ not: valid json ,,,", "utf8");
    assert.doesNotThrow(() => avatars.getAgentAvatar("anyone"));
    assert.equal(avatars.getAgentAvatar("anyone"), null);
    assert.doesNotThrow(() => avatars.loadMap());
    assert.deepEqual(avatars.loadMap(), {});
    // setAgentAvatar must fail soft too (cast-config.write refuses on fatal
    // JSON.parse — the mutation still runs from an empty draft) rather than throw.
    assert.doesNotThrow(() => avatars.setAgentAvatar("anyone", "x"));
  });
});

// ─── listAgents is unaffected by the shim ─────────────────────────────────────

test("listAgents is unchanged by any of it: the known-agent scan union assigned characters", () => {
  withIsolatedCast(({ castFile }) => {
    fs.writeFileSync(
      castFile,
      JSON.stringify(
        {
          version: 1,
          migratedLegacyAt: "2026-01-01T00:00:00.000Z",
          authors: { "brand-new-agent-not-in-any-roster": { character: "vrm-y" } },
        },
        null,
        2,
      ),
      "utf8",
    );

    const listed = avatars.listAgents();
    assert.ok(Array.isArray(listed));
    // Every KNOWN_AGENTS entry (the live pack/roster scan) is present...
    for (const known of avatars.KNOWN_AGENTS) {
      assert.ok(listed.includes(known), `expected KNOWN_AGENTS entry ${known} in listAgents()`);
    }
    // ...and an assigned-but-unknown agent from the cast file is present too.
    assert.ok(listed.includes("brand-new-agent-not-in-any-roster"));
    // Sorted, de-duplicated.
    assert.deepEqual(listed, [...new Set(listed)].sort());
  });
});

// ─── migration: the one hand-off from the legacy dotfile ─────────────────────

test("migration: a legacy .agent-avatars.json row is folded into the cast file once, then read through it", () => {
  withIsolatedCast(
    ({ castFile, legacyFile }) => {
      assert.ok(!fs.existsSync(castFile), "cast file must not exist yet — migration creates it");

      assert.equal(avatars.getAgentAvatar("migrateme"), "folded-in-vrm");

      const raw = readRaw(castFile);
      assert.equal(raw.authors.migrateme.character, "folded-in-vrm");
      assert.ok(typeof raw.migratedLegacyAt === "string" && raw.migratedLegacyAt);

      // The dotfile is COPIED, never renamed or deleted.
      assert.ok(fs.existsSync(legacyFile));
      assert.deepEqual(readRaw(legacyFile), { migrateme: "folded-in-vrm" });

      // A value the owner later authors directly through the shim survives
      // and is not re-clobbered by a second migration attempt.
      avatars.setAgentAvatar("migrateme", "owner-chosen-vrm");
      assert.equal(avatars.getAgentAvatar("migrateme"), "owner-chosen-vrm");
    },
    { legacyContent: { migrateme: "folded-in-vrm" } },
  );
});
