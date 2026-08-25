"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { signature, listOpen, watch } = require("./decision-cards.cjs");

function tmpStore() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "persona-decisions-"));
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
    source: { tab_title: "my-tab", cwd: "C:\work", agent: "claude-code" },
  });
  const [card] = listOpen(dir);
  assert.equal(card.tab, "my-tab");
  assert.equal(card.cwd, "C:\work");
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

test("an unreadable store is 'unreadable', never mistaken for empty-and-fine", () => {
  assert.equal(signature(path.join(os.tmpdir(), "persona-no-such-dir-xyz")), "unreadable");
  assert.deepEqual(listOpen(path.join(os.tmpdir(), "persona-no-such-dir-xyz")), []);
});

test("watch fires at start and on change, not on quiet polls", () => {
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
  assert.deepEqual(seen, [["d-1"]], "the initial poll reports the current queue");

  tick();
  assert.equal(seen.length, 1, "a quiet poll must not re-fire onChange");

  writeCard(dir, "d-2");
  tick();
  assert.equal(seen.length, 2, "a new card fires onChange");
  assert.deepEqual(seen[1].sort(), ["d-1", "d-2"]);

  stop();
  assert.equal(tick, null, "stop clears the interval");
});
