"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { signature, listOpen, actionableCount, watch, answerCard, cancelCard,
  steerCard,
} = require("./decision-cards.cjs");
const cards = require("./decision-cards.cjs");

function tmpStore() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "desk-decisions-"));
}

function writeCard(dir, id, extra = {}) {
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({ id, title: `Card ${id}`, status: "open", created_at: Date.now() / 1000, ...extra }),
  );
}

test("listOpen carries the card's ORIGIN (tab/cwd/agent) so a toast can name it", () => {
  const dir = tmpStore();
  writeCard(dir, "d-src", {
    source: { tab_title: "my-tab", cwd: "C:\\work", agent: "claude-code" },
  });
  const [card] = listOpen(dir);
  assert.equal(card.tab, "my-tab");
  assert.equal(card.cwd, "C:\\work");
  assert.equal(card.agent, "claude-code");
  // absent source stays empty strings, never undefined — toast code concatenates
  writeCard(dir, "d-bare", {});
  const bare = listOpen(dir).find((c) => c.id === "d-bare");
  assert.equal(bare.tab, "");
});

test("listOpen returns open cards oldest-first and skips closed/broken ones", () => {
  const dir = tmpStore();
  writeCard(dir, "d-old", { created_at: 100 });
  writeCard(dir, "d-new", { created_at: 200 });
  writeCard(dir, "d-done", { status: "answered" });
  fs.writeFileSync(path.join(dir, "d-bad.json"), "{not json");
  fs.writeFileSync(path.join(dir, "channels.json"), "{}"); // not a card file

  const cards = listOpen(dir);
  assert.deepEqual(cards.map((c) => c.id), ["d-old", "d-new"]);
});

test("signature moves on create, write and delete — and never on a plain re-read", () => {
  const dir = tmpStore();
  const empty = signature(dir);
  assert.equal(signature(dir), empty, "re-reading an unchanged dir must not report change");

  writeCard(dir, "d-1");
  const one = signature(dir);
  assert.notEqual(one, empty, "a created card must change the signature");

  fs.rmSync(path.join(dir, "d-1.json"));
  assert.notEqual(signature(dir), one, "a removed card must change the signature");
});

test("listOpen carries the card's OWN options and defaultKey, sanitised", () => {
  const dir = tmpStore();
  writeCard(dir, "d-opts", {
    options: [
      { key: "ack", label: "I am looking now", recommended: true },
      { key: "later", label: "Not now" },
      { key: "bad", label: 42 }, // non-string label still keeps its key
      "not-an-object",
    ],
    default_key: "ack",
  });
  const [card] = listOpen(dir);
  assert.deepEqual(
    card.options.map((o) => [o.key, o.label, o.recommended]),
    [
      ["ack", "I am looking now", true],
      ["later", "Not now", false],
      ["bad", "bad", false],
    ],
    "a desk surface must render the raiser's real choices, not its own guess",
  );
  assert.equal(card.defaultKey, "ack");

  writeCard(dir, "d-noopts", {});
  const bare = listOpen(dir).find((c) => c.id === "d-noopts");
  assert.deepEqual(bare.options, []);
  assert.equal(bare.defaultKey, "");
});

test("answerCard spawns awask answer with the card's own choice key", () => {
  const calls = [];
  const fakeSpawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { unref() {} };
  };
  assert.equal(answerCard("d-1", "ack", "", fakeSpawn), true);
  assert.equal(calls.length, 1);
  assert.ok(
    String(calls[0].cmd).toLowerCase().includes("awask"),
    "the binary is awask (resolved to its absolute path so PATH drift cannot fake an answer)",
  );
  assert.deepEqual(calls[0].args, ["answer", "d-1", "ack", "--via", "desk"]);
  assert.equal(calls[0].opts.windowsHide, true, "nothing may flash (gate-1t class)");
  assert.equal(calls[0].opts.detached, true, "desk never holds the answer's lifetime");

  assert.equal(answerCard("d-1", "later", "doing this tomorrow", fakeSpawn), true);
  assert.deepEqual(
    calls[1].args,
    ["answer", "d-1", "later", "--via", "desk", "--note", "doing this tomorrow"],
  );
});

test("answerCard refuses blank ids/choices and survives a failing spawn", () => {
  assert.equal(answerCard("", "ack"), false, "a blank id must refuse, not guess");
  assert.equal(answerCard("d-1", ""), false, "a blank choice must refuse, not guess");
  assert.equal(answerCard("d-1", "ack", "", () => {
    throw new Error("spawn failed");
  }), false, "a failing spawn must report false, never throw");
});

test("cancelCard spawns awask cancel and refuses a blank id", () => {
  const calls = [];
  const fakeSpawn = (cmd, args) => {
    calls.push([cmd, args]);
    return { unref() {} };
  };
  assert.equal(cancelCard("d-1", "not now", fakeSpawn), true);
  assert.ok(String(calls[0][0]).toLowerCase().includes("awask"));
  assert.deepEqual(calls[0][1], ["cancel", "d-1", "--note", "not now"]);
  assert.equal(cancelCard("", "", fakeSpawn), false);
});

test("actionableCount counts cards WAITING on the owner, never info digests", () => {
  const dir = tmpStore();
  writeCard(dir, "d-ask", { options: [{ key: "yes", label: "Yes" }] });
  writeCard(dir, "d-cred", { kind: "credential", options: [] });
  writeCard(dir, "d-blocked", { kind: "blocked", options: [] }); // the notification hook's shape
  writeCard(dir, "d-info1", { kind: "info", options: [] });
  writeCard(dir, "d-info2", { kind: "info", options: [], urgency: "high" });
  writeCard(dir, "d-nokind", {}); // kind absent — sanitised to "decision", no options

  const cards = listOpen(dir);
  assert.equal(
    actionableCount(cards),
    3,
    "one ask + one credential + one blocked count; two high-urgency info digests and a bare card do not — '3 decisions waiting' must not be one ask and two facts, and an optionless blocked session must not go silent",
  );
});

test("an unreadable store is 'unreadable', never mistaken for empty-and-fine", () => {
  assert.equal(signature(path.join(os.tmpdir(), "desk-no-such-dir-xyz")), "unreadable");
  assert.deepEqual(listOpen(path.join(os.tmpdir(), "desk-no-such-dir-xyz")), []);
});

test("watch fires at start and on change, not on quiet polls", async () => {
  const dir = tmpStore();
  writeCard(dir, "d-1");
  const seen = [];
  let tick = null;
  const stop = watch({
    dir,
    onChange: (cards) => seen.push(cards.map((c) => c.id)),
    setIntervalFn: (fn) => {
      tick = fn;
      return 1;
    },
    clearIntervalFn: () => {
      tick = null;
    },
  });
  // The scan is asynchronous now (it must not block the main process): wait for
  // the initial one instead of assuming it finished inside watch().
  for (let i = 0; i < 200 && seen.length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(seen, [["d-1"]], "the initial poll reports the current queue");

  await tick();
  assert.equal(seen.length, 1, "a quiet poll must not re-fire onChange");

  writeCard(dir, "d-2");
  await tick();
  assert.equal(seen.length, 2, "a new card fires onChange");
  assert.deepEqual(seen[1].sort(), ["d-1", "d-2"]);

  stop();
  assert.equal(tick, null, "stop clears the interval");
});

test("scanAsync agrees with the sync signature and list, and re-reads only what changed", async () => {
  const { scanAsync, signature, listOpen } = require("./decision-cards.cjs");
  const fs = require("node:fs");
  const dir = tmpStore();
  writeCard(dir, "d-1");
  writeCard(dir, "d-2");
  const cache = new Map();
  let reads = 0;
  const counting = { ...fs.promises, readFile: async (...a) => { reads += 1; return fs.promises.readFile(...a); } };

  const first = await scanAsync(dir, cache, counting);
  assert.equal(first.signature, signature(dir));
  assert.deepEqual(first.cards.map((c) => c.id).sort(), listOpen(dir).map((c) => c.id).sort());
  assert.equal(reads, 2);

  const quiet = await scanAsync(dir, cache, counting);
  assert.equal(quiet.signature, first.signature);
  assert.equal(reads, 2, "an unchanged store costs stats, not reads");

  writeCard(dir, "d-3");
  const grown = await scanAsync(dir, cache, counting);
  assert.equal(reads, 3, "only the new file is read");
  assert.equal(grown.cards.length, 3);

  fs.unlinkSync(require("node:path").join(dir, "d-1.json"));
  const shrunk = await scanAsync(dir, cache, counting);
  assert.deepEqual(shrunk.cards.map((c) => c.id).sort(), ["d-2", "d-3"]);
  assert.equal(cache.has("d-1.json"), false, "a removed card leaves the cache");
});

test("scanAsync: an unreadable directory is a token no real store produces", async () => {
  const { scanAsync } = require("./decision-cards.cjs");
  const out = await scanAsync(require("node:path").join(tmpStore(), "nope"));
  assert.deepEqual(out, { signature: "unreadable", cards: [] });
});

test("steerCard sends a work order through awask, as ONE argv element, and refuses empties", () => {
  // The verb the deck never had (2026-09-08): a card whose right answer is not
  // one of its options had to be retyped in a terminal. The sentence must stay
  // one argv element -- `awask steer <id> <text...>` is variadic, so a split
  // sentence would have its words re-parsed (a leading "--word" becomes a flag).
  const calls = [];
  const spawnFn = (bin, args) => {
    calls.push(args);
    return { unref() {} };
  };
  assert.equal(steerCard("d-1", "  rebuild the image instead  ", spawnFn), true);
  assert.deepEqual(calls[0], ["steer", "d-1", "rebuild the image instead", "--via", "desk"]);
  assert.equal(steerCard("d-1", "   ", spawnFn), false);
  assert.equal(steerCard("", "do a thing", spawnFn), false);
  assert.equal(calls.length, 1, "an empty steer never reaches awask");
  const long = steerCard("d-2", "x".repeat(5000), spawnFn);
  assert.equal(long, true);
  assert.equal(calls[1][2].length, 2000);
});

test("the card writes report the SPAWN, not delivery -- the deck must not claim more", () => {
  // runAwask is a detached spawn by design (nothing blocks or flashes on the
  // owner's desktop, the gate-1t class), so a true return means "awask started",
  // never "the store took it". Pinned so a future refactor that starts claiming
  // delivery has to change this test and read the reason.
  const started = { unref() {} };
  assert.equal(steerCard("d-1", "do the thing", () => started), true);
  assert.equal(answerCard("d-1", "yes", "", () => started), true);
  // A spawn that THROWS is the only failure these can see.
  assert.equal(steerCard("d-1", "do the thing", () => { throw new Error("ENOENT"); }), false);
  assert.equal(answerCard("d-1", "yes", "", () => { throw new Error("ENOENT"); }), false);
});

// --- The card popup ladder (2026-09-08: "I WANT TO CONSOLIDATE AND DEDUPE") ---
// A decision card had three unrelated homes. These arms pin the routed rungs only:
// the FALLBACK rung deliberately spawns awask's real Tk window, so exercising it in
// a test would open a window on the owner's desktop.

test("a router that takes the card stops the popup from spawning", () => {
  const seen = [];
  cards.setWindowRouter((kind, id) => { seen.push([kind, id]); return true; });
  try {
    assert.equal(cards.openQueueWindow(), true);
    assert.equal(cards.openCardWindow("card-7"), true);
    assert.deepEqual(seen, [["queue", null], ["card", "card-7"]]);
  } finally {
    cards.setWindowRouter(null);
  }
});

test("an empty card id is refused before the router is asked", () => {
  let asked = false;
  cards.setWindowRouter(() => { asked = true; return true; });
  try {
    assert.equal(cards.openCardWindow(""), false);
    assert.equal(cards.openCardWindow(null), false);
    assert.equal(asked, false, "an id-less card must never reach a surface");
  } finally {
    cards.setWindowRouter(null);
  }
});

test("listOpen carries what an answer will DO — consequence, recipe, deadline", () => {
  // A card recipe (awask.card_recipes) turns the answer into an ACTION: picking
  // "Disable this wake" runs `awrise disable --name <job>`. The raiser writes
  // that sentence into the option's `consequence`, and Desk used to drop it —
  // so every desk surface offered a button whose effect was invisible until
  // after it was pressed. `recipe` is how a surface knows the answer ACTS at
  // all, and `deadline` is the card answering itself if nobody does.
  const dir = tmpStore();
  writeCard(dir, "d-rcp", {
    card_recipe: "wake-failed",
    dedupe_key: "awrise:wake-failed:nightly-sync:2026-09-18T05:00:01+00:00",
    deadline: 1790000000,
    default_key: "keep",
    options: [
      { key: "disable", label: "Disable this wake",
        consequence: "awrise disable --name nightly-sync; nothing runs until you re-enable" },
      { key: "keep", label: "Keep it scheduled", consequence: "no change", recommended: true },
    ],
  });
  const [card] = listOpen(dir);
  assert.equal(card.recipe, "wake-failed");
  assert.equal(card.dedupeKey, "awrise:wake-failed:nightly-sync:2026-09-18T05:00:01+00:00");
  assert.equal(card.deadline, 1790000000);
  assert.match(card.options[0].consequence, /awrise disable --name nightly-sync/);
  assert.equal(card.options[1].recommended, true);

  // A hand-raised card has none of it, and must read as "" / 0 rather than
  // undefined: every surface concatenates these straight into text.
  writeCard(dir, "d-plain", { options: [{ key: "ok", label: "OK" }] });
  const plain = listOpen(dir).find((c) => c.id === "d-plain");
  assert.equal(plain.recipe, "");
  assert.equal(plain.dedupeKey, "");
  assert.equal(plain.deadline, 0);
  assert.equal(plain.options[0].consequence, "");

  // Bounded: a desk button is not a place to render an unbounded string.
  writeCard(dir, "d-long", {
    options: [{ key: "ok", label: "OK", consequence: "x".repeat(900) }],
  });
  const long = listOpen(dir).find((c) => c.id === "d-long");
  assert.equal(long.options[0].consequence.length, 200);
});
