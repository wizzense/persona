"use strict";

/**
 * The adult-content gate for the character roster.
 *
 * These assert the property that matters: an R18 character must be ABSENT from
 * every list a human sees, and unswitchable, while the gate is closed. Before
 * this existed, listCharacters() was a plain readdir over characters/ and the
 * tray quick-switch menu showed an R18 slug by NAME long before any model
 * rendered.
 *
 * Each case carries a mutation guard — it also asserts the opposite verdict
 * with the gate open — so a filter that accidentally hides everything, or one
 * that hides nothing, both fail rather than passing vacuously.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");

// A per-process mirror. node --test runs each test file in its own PARALLEL
// child process, and pack-roster.test.cjs flips the same real mirror — the two
// racing on ~/.aither/adult_content.json made both flaky (measured 2026-08-25,
// different processes, so no amount of within-file ordering fixes it). The env
// var must be set BEFORE requiring content-rating: the module resolves the
// path once at require time.
const MIRROR = path.join(os.tmpdir(), `desk-adult-gate-${process.pid}.json`);
process.env.DESK_ADULT_CONTENT_MIRROR = MIRROR;
// Fixtures also go to a per-process temp roster: pack-roster.test.cjs
// snapshots the REAL characters/ dir from a parallel process, and a fixture
// that lives between its two snapshots breaks the superset check (measured
// 2026-08-25: "open roster lost a PG character: zz-gate-fixture-plain").
const ROSTER = path.join(os.tmpdir(), `desk-roster-${process.pid}`);
// The gate AUDIT, same per-process rule: the env var must be set before the
// module resolves its paths at require time.
const AUDIT = path.join(os.tmpdir(), `desk-adult-audit-${process.pid}.log`);
process.env.DESK_ADULT_CONTENT_LOG = AUDIT;
process.env.DESK_ROSTER_DIR = ROSTER;
fs.mkdirSync(ROSTER, { recursive: true });
after(() => {
  fs.rmSync(AUDIT, { force: true });
  fs.rmSync(`${AUDIT}.state`, { force: true });
  fs.rmSync(MIRROR, { force: true });
  fs.rmSync(ROSTER, { recursive: true, force: true });
});

const rating = require("./content-rating.cjs");
const roster = require("./character-roster.cjs");

/** Run `fn` with the gate forced to `visible`, then restore the mirror. */
function withGate(visible, fn) {
  const had = fs.existsSync(MIRROR);
  const previous = had ? fs.readFileSync(MIRROR) : null;
  fs.mkdirSync(path.dirname(MIRROR), { recursive: true });
  fs.writeFileSync(MIRROR, JSON.stringify({ visible }));
  rating.invalidateGate();
  try {
    return fn();
  } finally {
    if (had) fs.writeFileSync(MIRROR, previous);
    else fs.rmSync(MIRROR, { force: true });
    rating.invalidateGate();
  }
}

/** A throwaway character directory with the given rating. */
function withCharacter(name, ratingValue, fn) {
  const dir = path.join(ROSTER, name);
  assert.equal(fs.existsSync(dir), false, `fixture ${name} already exists`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "model.vrm"), "not-a-real-vrm");
  if (ratingValue) {
    fs.writeFileSync(
      path.join(dir, "character.json"),
      JSON.stringify({ rating: ratingValue, source: "test" }),
    );
  }
  try {
    return fn();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a missing mirror means LOCKED, not open", () => {
  const had = fs.existsSync(MIRROR);
  const previous = had ? fs.readFileSync(MIRROR) : null;
  fs.rmSync(MIRROR, { force: true });
  rating.invalidateGate();
  try {
    assert.equal(rating.isAdultContentVisible(), false);
  } finally {
    if (had) fs.writeFileSync(MIRROR, previous);
    rating.invalidateGate();
  }
});

test("a malformed mirror means LOCKED", () => {
  const had = fs.existsSync(MIRROR);
  const previous = had ? fs.readFileSync(MIRROR) : null;
  fs.mkdirSync(path.dirname(MIRROR), { recursive: true });
  fs.writeFileSync(MIRROR, "{ this is not json");
  rating.invalidateGate();
  try {
    assert.equal(rating.isAdultContentVisible(), false);
  } finally {
    if (had) fs.writeFileSync(MIRROR, previous);
    else fs.rmSync(MIRROR, { force: true });
    rating.invalidateGate();
  }
});

test("an r18 character is absent from the roster while locked, present when open", () => {
  withCharacter("zz-gate-fixture-r18", "r18", () => {
    withGate(false, () => {
      assert.equal(roster.listCharacters().includes("zz-gate-fixture-r18"), false);
      // Mutation guard: the underlying directory really is there, so this is a
      // filter result and not a missing fixture.
      assert.equal(roster.listAllCharacters().includes("zz-gate-fixture-r18"), true);
    });
    withGate(true, () => {
      assert.equal(roster.listCharacters().includes("zz-gate-fixture-r18"), true);
    });
  });
});

test("an unrated character is HIDDEN while the gate is closed, listed once it opens (owner, 2026-09-20)", () => {
  // Browsing an unjudged roster is how a lewd model gets found: no file, or the
  // rater's "default" stamp (nothing matched the name, nobody looked), both
  // read as unrated and sit in the hidden set beside r15/r18.
  withCharacter("zz-gate-fixture-plain", null, () => {
    withGate(false, () => {
      assert.equal(rating.getRating("zz-gate-fixture-plain"), "unrated");
      assert.equal(roster.listCharacters().includes("zz-gate-fixture-plain"), false);
      const why = rating.refusalFor("zz-gate-fixture-plain");
      assert.equal(why && why.code, "rating-hidden");
      assert.match(why.reason, /not been rated/);
    });
    withGate(true, () => {
      assert.equal(roster.listCharacters().includes("zz-gate-fixture-plain"), true);
      assert.equal(rating.refusalFor("zz-gate-fixture-plain"), null);
    });
  });
  // The rater's step-5 stamp is not a verdict.
  withCharacter("zz-gate-fixture-default", "general", () => {
    rating.setRating("zz-gate-fixture-default", "general", "default");
    withGate(false, () => {
      assert.equal(rating.getRating("zz-gate-fixture-default"), "unrated");
      assert.equal(roster.listCharacters().includes("zz-gate-fixture-default"), false);
    });
    // A real verdict -- any source that is not "default" -- is.
    rating.setRating("zz-gate-fixture-default", "general", "vision-thumb");
    withGate(false, () => {
      assert.equal(rating.getRating("zz-gate-fixture-default"), "general");
      assert.equal(roster.listCharacters().includes("zz-gate-fixture-default"), true);
    });
  });
});

test("installCharacter refuses a hidden character — menus alone are cosmetic", () => {
  withCharacter("zz-gate-fixture-install", "r18", () => {
    withGate(false, () => {
      // MCP set_character, switch-character.ps1 and the model browser all pass a
      // name straight through, so the refusal has to live here.
      assert.equal(roster.installCharacter("zz-gate-fixture-install"), false);
    });
  });
});

test("r15 is treated as adult too", () => {
  withCharacter("zz-gate-fixture-r15", "r15", () => {
    withGate(false, () => {
      assert.equal(roster.listCharacters().includes("zz-gate-fixture-r15"), false);
    });
  });
});

test("a refusal names the REAL cause: hidden by rating, not 'not installed'", () => {
  // The bug this closes: every door refused an R18 character correctly and then
  // said "No character named X is installed" -- so the owner went looking for a
  // model that was sitting in the roster all along.
  withCharacter("zz-refusal-r18", "r18", () => {
    withGate(false, () => {
      const refusal = rating.refusalFor("zz-refusal-r18");
      assert.ok(refusal, "a hidden character must explain itself");
      assert.equal(refusal.code, "rating-hidden");
      assert.equal(refusal.rating, "r18");
      assert.match(refusal.reason, /rated r18/);
      assert.doesNotMatch(refusal.reason, /not installed/i);
      // and the door itself still refuses -- the reason is not a way in
      assert.equal(roster.installCharacter("zz-refusal-r18"), false);
    });
    // Mutation guard: with the gate OPEN there is nothing to explain.
    withGate(true, () => {
      assert.equal(rating.refusalFor("zz-refusal-r18"), null);
    });
  });
});

test("a character that really is missing gets no rating excuse", () => {
  withGate(false, () => {
    assert.equal(rating.refusalFor("zz-no-such-character"), null,
      "an absent character must fall through to the caller's own message");
  });
});

test("a PG character is never refused, gate open or closed", () => {
  withCharacter("zz-refusal-plain", "pg", () => {
    withGate(false, () => assert.equal(rating.refusalFor("zz-refusal-plain"), null));
    withGate(true, () => assert.equal(rating.refusalFor("zz-refusal-plain"), null));
  });
});

test("the desk records WHEN it saw the gate move, once per transition", () => {
  fs.rmSync(AUDIT, { force: true });
  fs.rmSync(`${AUDIT}.state`, { force: true });
  withGate(false, () => assert.equal(rating.noteGateState().changed, true));
  withGate(false, () => assert.equal(rating.noteGateState().changed, false,
    "a steady gate must not append a line per tray rebuild"));
  withGate(true, () => {
    const moved = rating.noteGateState();
    assert.equal(moved.changed, true);
    assert.equal(moved.visible, true);
  });
  const lines = fs.readFileSync(AUDIT, "utf8").trim().split(String.fromCharCode(10));
  assert.equal(lines.length, 2, lines.join(" | "));
  assert.match(lines[0], /mature=hidden by=/);
  assert.match(lines[1], /mature=allowed by=/);
  // The desk cannot authenticate the flip -- it reads a mirror -- so what it
  // attests is what it OBSERVED. Saying more than that would be a lie.
  assert.match(lines[1], /^\d{4}-\d{2}-\d{2}T/);
});

test("the MCP refusal text is the rating one, not the missing-file one", () => {
  const source = fs.readFileSync(path.join(__dirname, "mcp-server.cjs"), "utf8");
  assert.match(source, /refusalText\(/, "set_character/spawn_avatar must consult the gate");
  assert.match(source, /require\("\.\/content-rating\.cjs"\)/);
});

// ─── the three limits (owner, 2026-09-20) ──────────────────────────────────

test("the desk's ceiling hides above itself even with the gate OPEN, and can only tighten", () => {
  withCharacter("zz-ceiling-r15", "r15", () => {
    withCharacter("zz-ceiling-general", "general", () => {
      const castFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cast-ceiling-")), "cast.json");
      const priorCast = process.env.DESK_CAST_FILE;
      process.env.DESK_CAST_FILE = castFile;
      try {
        // Gate open, ceiling general: the r15 body is hidden by the CEILING,
        // which is the limit the platform gate cannot express.
        fs.writeFileSync(castFile, JSON.stringify({ version: 1, content: { maxRating: "general" } }));
        withGate(true, () => {
          assert.equal(rating.hiddenReason("zz-ceiling-r15"), "ceiling");
          assert.equal(rating.hiddenReason("zz-ceiling-general"), null);
          assert.match(rating.refusalFor("zz-ceiling-r15").reason, /ceiling/);
        });
        // Raising the ceiling never OPENS the gate: closed is closed.
        fs.writeFileSync(castFile, JSON.stringify({ version: 1, content: { maxRating: "r18" } }));
        withGate(false, () => {
          assert.equal(rating.hiddenReason("zz-ceiling-r15"), "gate");
          assert.equal(rating.hiddenReason("zz-ceiling-general"), null);
        });
        withGate(true, () => assert.equal(rating.hiddenReason("zz-ceiling-r15"), null));
      } finally {
        if (priorCast === undefined) delete process.env.DESK_CAST_FILE;
        else process.env.DESK_CAST_FILE = priorCast;
      }
    });
  });
});

test("the live safety plane can only TIGHTEN: false closes an open gate, null and true change nothing", () => {
  withCharacter("zz-safety-r18", "r18", () => {
    try {
      withGate(true, () => {
        rating.setSafetyExplicitAllowed(null);
        assert.equal(rating.hiddenReason("zz-safety-r18"), null, "no answer must not hide the roster");
        rating.setSafetyExplicitAllowed(true);
        assert.equal(rating.hiddenReason("zz-safety-r18"), null);
        rating.setSafetyExplicitAllowed(false);
        assert.equal(rating.hiddenReason("zz-safety-r18"), "gate", "a plane forbidding explicit closes the gate");
      });
      // And it can never OPEN one: true against a closed gate is still closed.
      withGate(false, () => {
        rating.setSafetyExplicitAllowed(true);
        assert.equal(rating.hiddenReason("zz-safety-r18"), "gate");
      });
    } finally {
      rating.setSafetyExplicitAllowed(null);
    }
  });
});
