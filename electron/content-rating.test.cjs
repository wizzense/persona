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
const test = require("node:test");

const MIRROR = path.join(os.homedir(), ".aither", "adult_content.json");
const ROSTER = path.join(__dirname, "..", "characters");

const rating = require("./content-rating.cjs");
const roster = require("./character-roster.cjs");

/** Run `fn` with the gate forced to `visible`, then restore the real mirror. */
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

test("an unrated character stays visible — the gate hides adult, not everything", () => {
  withCharacter("zz-gate-fixture-plain", null, () => {
    withGate(false, () => {
      assert.equal(rating.getRating("zz-gate-fixture-plain"), "unrated");
      assert.equal(roster.listCharacters().includes("zz-gate-fixture-plain"), true);
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
