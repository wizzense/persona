"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createVoiceAsk } = require("./voice-ask.cjs");

function harness({ speak, listen } = {}) {
  const log = [];
  const timers = [];
  const ask = createVoiceAsk({
    speak: speak || (async (q) => { log.push(`speak:${q}`); return { ok: true, durationMs: 1500 }; }),
    listen: listen || (() => { log.push("listen"); return { ok: true }; }),
    delay: async (ms) => { log.push(`wait:${ms}`); },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
  });
  return { ask, log, timers };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("speaks, waits for the question to finish, then listens; the next transcript is the answer", async () => {
  const h = harness();
  const pending = h.ask.ask("Ship it now?");
  await tick();
  assert.deepEqual(h.log, ["speak:Ship it now?", "wait:1900", "listen"]);
  assert.equal(h.ask.waiting, "Ship it now?");
  assert.equal(h.ask.offer("yes, ship it"), true);
  assert.deepEqual(await pending, { question: "Ship it now?", ok: true, answer: "yes, ship it" });
  assert.equal(h.ask.waiting, null);
});

test("with no ask waiting, a transcript is NOT consumed (it stays a command)", () => {
  const h = harness();
  assert.equal(h.ask.offer("open the fleet panel"), false);
});

test("a second ask while one waits is refused, never queued behind a guess", async () => {
  const h = harness();
  const first = h.ask.ask("A?");
  const second = await h.ask.ask("B?");
  assert.equal(second.ok, false);
  assert.match(second.error, /already waiting/);
  await tick();
  h.ask.offer("a");
  assert.equal((await first).answer, "a");
});

test("a muted mic fails the ask at once with the reason", async () => {
  const h = harness({ listen: () => ({ ok: false, error: "microphone is muted" }) });
  const res = await h.ask.ask("Q?");
  assert.deepEqual(res, { question: "Q?", ok: false, error: "microphone is muted" });
});

test("no answer in time is an error naming the limit", async () => {
  const h = harness();
  const pending = h.ask.ask("Q?", { timeoutMs: 20000 });
  await tick();
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, 20000);
  h.timers[0].fn();
  assert.deepEqual(await pending, { question: "Q?", ok: false, error: "no answer within 20s" });
});

test("a dead voice service still asks (caption) and listens without waiting on audio", async () => {
  const h = harness({ speak: async () => ({ ok: false, reason: "voice service unavailable" }) });
  const pending = h.ask.ask("Q?");
  await tick();
  assert.ok(h.log.includes("wait:400"));
  assert.ok(h.log.includes("listen"));
  h.ask.fail("nothing was heard");
  assert.equal((await pending).error, "nothing was heard");
});

test("an empty question is refused without speaking", async () => {
  const h = harness();
  assert.equal((await h.ask.ask("   ")).ok, false);
  assert.deepEqual(h.log, []);
});
