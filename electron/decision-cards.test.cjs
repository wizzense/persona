"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { signature, listOpen, watch, answerCard, cancelCard } = require("./decision-cards.cjs");

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

test("an unreadable store is 'unreadable', never mistaken for empty-and-fine", () => {
  assert.equal(signature(path.join(os.tmpdir(), "desk-no-such-dir-xyz")), "unreadable");
  assert.deepEqual(listOpen(path.join(os.tmpdir(), "desk-no-such-dir-xyz")), []);
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
