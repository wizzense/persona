"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { PRESENTATIONS, createSurfaceState } = require("./surface-state.cjs");

const ROUTES = ["cards", "command", "fleet"];

test("every route starts embedded and answers for itself", () => {
  const state = createSurfaceState(ROUTES);
  assert.deepEqual(state.detached(), []);
  for (const id of ROUTES) assert.equal(state.presentationOf(id), "embedded");
  assert.equal(state.presentationOf("nope"), null);
});

test("a change notifies once; a no-op notifies nobody", () => {
  const state = createSurfaceState(ROUTES);
  const seen = [];
  state.subscribe((snap, changed) => seen.push({ snap, changed }));

  state.set("fleet", "detached");
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].changed, ["fleet"]);
  assert.equal(seen[0].snap.fleet, "detached");

  // Setting it again is not news. A rail that re-renders on every tick is how a
  // pane loses its scroll position and a hosted view flickers.
  state.set("fleet", "detached");
  assert.equal(seen.length, 1);
});

test("reconcile folds in what the WINDOWS report, in one emit", () => {
  // The oracle is the windows, not this map: the owner can close a detached
  // window from its own title bar, and an intention-only map would insist the
  // pane is still out there forever.
  const state = createSurfaceState(ROUTES);
  const batches = [];
  state.subscribe((_snap, changed) => batches.push(changed));

  state.reconcile({ cards: true, fleet: true });
  assert.deepEqual(batches, [["cards", "fleet"]], "one emit for the batch");
  assert.deepEqual(state.detached(), ["cards", "fleet"]);

  // The owner closed the cards window directly.
  state.reconcile({ cards: false });
  assert.deepEqual(batches[1], ["cards"]);
  assert.deepEqual(state.detached(), ["fleet"]);
});

test("an unobserved route is LEFT ALONE, never read as embedded", () => {
  const state = createSurfaceState(ROUTES);
  state.set("fleet", "detached");
  state.reconcile({ cards: false });
  assert.equal(state.presentationOf("fleet"), "detached",
    "a partial observation must not reset the routes it said nothing about");
});

test("nonsense is refused, not stored", () => {
  const state = createSurfaceState(ROUTES);
  assert.throws(() => state.set("ghost", "detached"), /unknown route/);
  assert.throws(() => state.set("fleet", "minimised"), /unknown presentation/);
  // reconcile is fed by machines, so it SKIPS what it cannot use rather than
  // throwing in the middle of a batch and leaving half of it applied.
  state.reconcile({ ghost: true, fleet: "minimised", cards: true });
  assert.deepEqual(state.detached(), ["cards"]);
  assert.equal(state.presentationOf("fleet"), "embedded");
});

test("a throwing subscriber does not stop the others, and the state still moved", () => {
  const state = createSurfaceState(ROUTES);
  const seen = [];
  state.subscribe(() => { throw new Error("boom"); });
  state.subscribe((snap) => seen.push(snap.fleet));
  state.set("fleet", "detached");
  assert.deepEqual(seen, ["detached"]);
  assert.equal(state.presentationOf("fleet"), "detached");
});

test("unsubscribe stops delivery", () => {
  const state = createSurfaceState(ROUTES);
  let count = 0;
  const off = state.subscribe(() => { count += 1; });
  state.set("fleet", "detached");
  off();
  state.set("fleet", "embedded");
  assert.equal(count, 1);
});

test("the presentations are the ones the shell knows how to paint", () => {
  assert.deepEqual([...PRESENTATIONS], ["embedded", "detached", "hidden"]);
});
