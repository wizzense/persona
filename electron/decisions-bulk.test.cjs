"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const bulk = require("./decisions-bulk.cjs");

function card(id, extra = {}) {
  return {
    id,
    title: `Card ${id}`,
    options: [
      { key: "yes", label: "Yes", recommended: true },
      { key: "later", label: "Later", recommended: false },
    ],
    defaultKey: "yes",
    ...extra,
  };
}

const noSleep = () => Promise.resolve();

test("defaultOptionKey only trusts a default that names one of the card's own options", () => {
  assert.equal(bulk.defaultOptionKey(card("a")), "yes");
  assert.equal(bulk.defaultOptionKey(card("b", { defaultKey: "" })), "");
  assert.equal(bulk.defaultOptionKey(card("c", { defaultKey: "ghost" })), "");
  assert.equal(bulk.defaultOptionKey(null), "");
});

test("planBulk refuses an unknown verb and a non-array id list", () => {
  assert.equal(bulk.planBulk({ verb: "delete-everything", ids: ["a"] }, [card("a")]).ok, false);
  assert.equal(bulk.planBulk({ verb: "cancel", ids: "a" }, [card("a")]).ok, false);
});

test("answer-default re-derives the choice from main's list and skips cards without one", () => {
  const open = [card("a"), card("b", { defaultKey: "" }), card("c", { defaultKey: "later" })];
  const plan = bulk.planBulk({ verb: "answer-default", ids: ["a", "b", "c", "gone", "a"] }, open);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.actions, [{ id: "a", choice: "yes" }, { id: "c", choice: "later" }]);
  assert.deepEqual(plan.skipped.map((s) => s.id), ["b", "gone"]);
});

test("cancel plans every open id and caps one call at MAX_BULK", () => {
  const open = Array.from({ length: bulk.MAX_BULK + 3 }, (_, i) => card(`d${i}`));
  const plan = bulk.planBulk({ verb: "cancel", ids: open.map((c) => c.id) }, open);
  assert.equal(plan.actions.length, bulk.MAX_BULK);
  assert.equal(plan.skipped.length, 3);
  assert.match(plan.skipped[0].reason, /cap/);
});

test("runBulk calls the injected writers, records failures, and paces between spawns", async () => {
  const calls = [];
  const sleeps = [];
  const plan = bulk.planBulk({ verb: "answer-default", ids: ["a", "b", "c"] }, [card("a"), card("b"), card("c")]);
  const result = await bulk.runBulk(plan, {
    answerCard: (id, choice, note) => { calls.push([id, choice, note]); if (id === "b") throw new Error("spawn"); return id !== "c"; },
    sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
    pauseMs: 5,
  });
  assert.deepEqual(result.done, ["a"]);
  assert.deepEqual(result.failed, ["b", "c"]);
  assert.equal(calls.length, 3);
  assert.equal(calls[0][1], "yes");
  assert.deepEqual(sleeps, [5, 5]);
  assert.match(result.summary, /^bulk: 1 card answered with their default \(2 failed\)/);
});

test("handleBulk cancels via cancelCard with the caller's note and one summary line", async () => {
  const cancelled = [];
  const result = await bulk.handleBulk(
    { verb: "cancel", ids: ["a", "b"], note: "stale, triaged in bulk" },
    { listOpen: () => [card("a"), card("b")], cancelCard: (id, note) => { cancelled.push([id, note]); return true; }, sleep: noSleep },
  );
  assert.deepEqual(result.done, ["a", "b"]);
  assert.deepEqual(cancelled, [["a", "stale, triaged in bulk"], ["b", "stale, triaged in bulk"]]);
  assert.match(result.summary, /2 cards dismissed \(via desk\): a, b$/);
});

test("a refused plan writes nothing and says why", async () => {
  let wrote = false;
  const result = await bulk.handleBulk({ verb: "nope", ids: ["a"] }, {
    listOpen: () => [card("a")], cancelCard: () => { wrote = true; return true; }, sleep: noSleep,
  });
  assert.equal(result.ok, false);
  assert.equal(wrote, false);
  assert.match(result.error, /unknown bulk verb/);
  assert.equal(result.summary, "");
});
