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

test("answer-default leaves urgent, credential and blocked cards for a one-by-one answer", () => {
  const open = [
    card("crit", { urgency: "critical", options: [{ key: "delete" }, { key: "keep" }], defaultKey: "delete" }),
    card("high", { urgency: "High" }),
    card("cred", { kind: "credential" }),
    card("blk", { kind: "blocked" }),
    card("ok", { urgency: "normal" }),
  ];
  const plan = bulk.planBulk({ verb: "answer-default", ids: open.map((c) => c.id) }, open);
  assert.deepEqual(plan.actions, [{ id: "ok", choice: "yes" }]);
  assert.deepEqual(plan.skipped.map((s) => s.id), ["crit", "high", "cred", "blk"]);
  assert.match(plan.skipped[0].reason, /one-by-one/);
  // Dismissing is not choosing FOR the owner: cancel still takes them all.
  assert.equal(bulk.planBulk({ verb: "cancel", ids: open.map((c) => c.id) }, open).actions.length, 5);
});

test("a card counts as done only when awask ACCEPTED it, not when a process started", async () => {
  const plan = bulk.planBulk({ verb: "cancel", ids: ["a", "b", "c"] }, [card("a"), card("b"), card("c")]);
  const result = await bulk.runBulk(plan, {
    cancelCard: (id) => Promise.resolve(id === "b" ? { ok: false, error: "already answered" } : { ok: true }),
    sleep: noSleep,
  });
  assert.deepEqual(result.done, ["a", "c"]);
  assert.deepEqual(result.failed, ["b"]);
  assert.match(result.summary, /^bulk: 2 cards dismissed \(1 failed\) \(via desk\): a, c$/);
});

test("confirmed writes stay paced and bounded in flight", async () => {
  const ids = Array.from({ length: 6 }, (_, i) => `c${i}`);
  const sleeps = [];
  let live = 0;
  let peak = 0;
  const result = await bulk.runBulk(bulk.planBulk({ verb: "cancel", ids }, ids.map((id) => card(id))), {
    cancelCard: () => {
      live += 1;
      peak = Math.max(peak, live);
      return new Promise((resolve) => setImmediate(() => { live -= 1; resolve({ ok: true }); }));
    },
    sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
    pauseMs: 60,
    maxInFlight: 2,
  });
  assert.equal(result.done.length, 6);
  assert.deepEqual(sleeps, [60, 60, 60, 60, 60]);
  assert.ok(peak <= 2, `peak in flight ${peak}`);
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
