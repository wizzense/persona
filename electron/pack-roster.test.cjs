/**
 * The pack roster must be a GATE, not a deletion.
 *
 * The adult characters were moved out of characters/ into the content pack. That
 * makes the closed state correct by construction -- and it also makes it trivial
 * to ship a "gate" that is really a deletion, because every denial test still
 * passes when the feature is simply gone.
 *
 * Measured 2026-07-31: exactly that happened. content-rating-loader.cjs pointed
 * PACKS_ROOT at ~/.aither/packs (the per-pack runtime DATA directory for the
 * AitherOS code packs) instead of ~/.aither/content-packs, so opening the gate
 * returned 66 characters and 0 adult -- identical to the closed state. Nothing
 * failed, nothing logged; the roster was just permanently short 10 characters.
 *
 * So this asserts BOTH verdicts, and the OPEN one is the one that matters.
 *
 * Run: node electron/pack-roster.test.cjs
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// A per-process mirror (see content-rating.test.cjs): node --test runs test
// files as parallel child processes, and content-rating.test.cjs flips the
// same real mirror — the two racing made both flaky (measured 2026-08-25).
// Set BEFORE freshRoster() re-requires the modules: content-rating resolves
// the path once at require time.
const MIRROR = path.join(os.tmpdir(), `desk-adult-gate-${process.pid}.json`);
process.env.DESK_ADULT_CONTENT_MIRROR = MIRROR;
const ADULT_RE = /cumdump|milf|r-18|dilf|ロリ/i;

function freshRoster() {
  // Drop the module cache so the gate and pack list are re-read.
  for (const key of Object.keys(require.cache)) {
    if (/character-roster|content-rating/.test(key)) delete require.cache[key];
  }
  return require("./character-roster.cjs");
}

function withGate(visible, fn) {
  const had = fs.existsSync(MIRROR);
  const backup = had ? fs.readFileSync(MIRROR, "utf8") : null;
  try {
    fs.mkdirSync(path.dirname(MIRROR), { recursive: true });
    fs.writeFileSync(MIRROR, JSON.stringify({ visible }), "utf8");
    return fn();
  } finally {
    // Restore the pre-test mirror state -- leaving it open would flip the
    // gate on this box (or leak an open gate into a parallel test process).
    if (had) fs.writeFileSync(MIRROR, backup, "utf8");
    else if (fs.existsSync(MIRROR)) fs.unlinkSync(MIRROR);
  }
}

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}: ${err.message}`);
  }
}

console.log("pack roster gate:");

const closed = withGate(false, () => freshRoster().listCharacters());
const open = withGate(true, () => freshRoster().listCharacters());

check("closed: no adult character is listed", () => {
  const adult = closed.filter((n) => ADULT_RE.test(n));
  assert.strictEqual(adult.length, 0, `leaked: ${adult.join(", ")}`);
});

check("open: adult characters COME BACK from the pack", () => {
  const adult = open.filter((n) => ADULT_RE.test(n));
  assert.ok(
    adult.length > 0,
    "gate opened but no pack characters appeared — this is a DELETION, not a " +
      "gate. Check PACKS_ROOT in content-rating-loader.cjs points at " +
      "~/.aither/content-packs (not ~/.aither/packs)."
  );
});

check("open strictly supersets closed", () => {
  assert.ok(
    open.length > closed.length,
    `open (${open.length}) must exceed closed (${closed.length})`
  );
  for (const name of closed) {
    assert.ok(open.includes(name), `open roster lost a PG character: ${name}`);
  }
});

check("closed roster is not empty", () => {
  // An empty roster would satisfy every denial assertion above trivially.
  assert.ok(closed.length > 0, "closed roster is empty — the app has no characters");
});

check("mirror was restored", () => {
  // Restored means the pre-test state: absent, or present-and-closed. Never
  // open — a gate left open enables adult content on this box.
  if (fs.existsSync(MIRROR)) {
    const raw = fs.readFileSync(MIRROR, "utf8");
    assert.strictEqual(JSON.parse(raw).visible, false, "gate left OPEN after tests");
  }
});

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
