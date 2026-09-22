"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter, PassThrough } = require("node:stream");

const {
  createGameStageSubscriber,
  createSseParser,
  parseStageEvent,
  ratingAllowed,
  deskRatingOf,
  GAME_ORIGIN,
} = require("./game-stage-subscriber.cjs");

function frame(ev, id) {
  return `id: ${id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
}

/** A fake node request: the handler gets a PassThrough it can write SSE into. */
function fakeRequest(script) {
  const calls = [];
  const request = (options, onResponse) => {
    const res = new PassThrough();
    res.statusCode = script.status === undefined ? 200 : script.status;
    res.setEncoding = () => {};
    const req = new EventEmitter();
    req.end = () => {
      calls.push({ options, res });
      setImmediate(() => { onResponse(res); if (script.onOpen) script.onOpen(res, options); });
    };
    req.destroy = () => { res.end(); };
    return req;
  };
  return { request, calls };
}

const tick = () => new Promise((r) => setImmediate(r));

test("rating map mirrors AWDESK_RATING and fails closed on anything unknown", () => {
  assert.equal(deskRatingOf("pg"), "general");
  assert.equal(deskRatingOf("suggestive"), "r15");
  assert.equal(deskRatingOf("explicit"), "r18");
  assert.equal(deskRatingOf("brutal"), "r18");
  assert.equal(deskRatingOf("r18"), null);
  assert.equal(deskRatingOf(undefined), null);
  assert.equal(ratingAllowed("pg", "general"), true);
  assert.equal(ratingAllowed("suggestive", "general"), false);
  assert.equal(ratingAllowed("suggestive", "r15"), true);
  assert.equal(ratingAllowed("explicit", "r15"), false, "an r18 event never plays on an r15 desk");
  assert.equal(ratingAllowed("brutal", "r18"), true);
  assert.equal(ratingAllowed("pg", "junk"), false, "unknown ceiling = closed");
  assert.equal(ratingAllowed(undefined, "r18"), false, "no rating = closed");
});

test("SSE parser: split chunks, CRLF, comments, multi-line data, ids", () => {
  const p = createSseParser();
  let out = p.feed(": hello\r\nretry: 3000\r\n\r\nid: 7\nevent: speak\nda");
  assert.deepEqual(out, []);
  out = p.feed("ta: {\"a\":1,\ndata: \"b\":2}\n\nid: 8\nevent: tf\ndata: {}\n");
  assert.deepEqual(out, [{ id: "7", event: "speak", data: "{\"a\":1,\n\"b\":2}" }]);
  out = p.feed("\n");
  assert.deepEqual(out, [{ id: "8", event: "tf", data: "{}" }]);
  assert.deepEqual(p.feed("data: no id inherits last\n\n"), [{ id: "8", event: "message", data: "no id inherits last" }]);
});

test("parseStageEvent refuses junk, non-stage types and bad persona ids", () => {
  assert.equal(parseStageEvent("{not json"), null);
  assert.equal(parseStageEvent("[1]"), null);
  assert.equal(parseStageEvent(JSON.stringify({ type: "art", persona_id: "a" })), null);
  assert.equal(parseStageEvent(JSON.stringify({ type: "speak", persona_id: "../x" })), null);
  assert.deepEqual(parseStageEvent(JSON.stringify({ type: "speak", persona_id: "guide", text: "hi", rating: "pg" })), { type: "speak", persona_id: "guide", text: "hi", rating: "pg" });
});

test("handleEvent: the desk ceiling drops r18 speech on an r15 desk, delivers pg speech to speakAloud with the stamped origin", () => {
  const spoken = [];
  const sub = createGameStageSubscriber({
    ceiling: () => ({ maxRating: "r15" }),
    speak: (ev) => spoken.push(ev),
    animate: () => { throw new Error("not called"); },
  });
  assert.equal(sub.handleEvent({ type: "speak", persona_id: "guide", text: "  Hello there ", rating: "pg" }), true);
  assert.equal(sub.handleEvent({ type: "speak", persona_id: "guide", text: "lewd", rating: "explicit" }), false, "r18 dropped at r15");
  assert.equal(sub.handleEvent({ type: "speak", persona_id: "guide", text: "no rating" }), false, "no rating dropped");
  assert.equal(sub.handleEvent({ type: "speak", persona_id: "guide", text: "", rating: "pg" }), false, "empty text is undeliverable");
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].text, "Hello there");
  assert.equal(spoken[0].origin, GAME_ORIGIN);
  assert.equal(spoken[0].persona_id, "guide");
  const s = sub.state();
  assert.equal(s.delivered.speak, 1);
  assert.equal(s.dropped.rating, 2);
  assert.equal(s.dropped.undeliverable, 1);
});

test("handleEvent: animation and tf go to their own deps; a throwing dep is counted, never propagated", () => {
  const anims = [];
  const tfs = [];
  const sub = createGameStageSubscriber({
    ceiling: () => ({ maxRating: "r18" }),
    speak: () => { throw new Error("voice down"); },
    animate: (ev) => anims.push(ev),
    transform: (ev) => tfs.push(ev),
  });
  assert.equal(sub.handleEvent({ type: "animation", persona_id: "follower.1", animation: "wave", rating: "suggestive" }), true);
  assert.equal(sub.handleEvent({ type: "tf", persona_id: "follower.1", tf: { schema_version: 1 }, rating: "brutal" }), true);
  assert.equal(sub.handleEvent({ type: "speak", persona_id: "guide", text: "x", rating: "pg" }), false, "a throwing speak is a counted drop");
  assert.equal(anims[0].animation, "wave");
  assert.equal(tfs[0].tf.schema_version, 1);
  assert.match(sub.state().lastError, /voice down/);
  assert.equal(sub.state().dropped.undeliverable, 1);
});

test("no animate/transform dep = undeliverable, counted, no throw", () => {
  const sub = createGameStageSubscriber({ ceiling: () => ({ maxRating: "r18" }) });
  assert.equal(sub.handleEvent({ type: "animation", persona_id: "a", animation: "wave", rating: "pg" }), false);
  assert.equal(sub.handleEvent({ type: "tf", persona_id: "a", tf: {}, rating: "pg" }), false);
  assert.equal(sub.state().dropped.undeliverable, 2);
});

test("start(): connects with the bearer + Accept, delivers streamed frames, remembers Last-Event-ID for the reconnect", async () => {
  const spoken = [];
  const fake = fakeRequest({
    onOpen(res) {
      if (fake.calls.length === 1) {
        res.write(frame({ type: "speak", persona_id: "guide", text: "one", rating: "pg" }, 41));
        res.write(frame({ type: "speak", persona_id: "guide", text: "adult", rating: "explicit" }, 42));
        res.end();
      }
    },
  });
  const timers = { setTimeout: (fn) => { setImmediate(fn); return 1; }, clearTimeout: () => {} };
  const sub = createGameStageSubscriber({
    url: "http://127.0.0.1:1/dark-matters/api/party-stage/events",
    bearer: () => "tok-123",
    ceiling: () => ({ maxRating: "r15" }),
    speak: (ev) => spoken.push(ev),
    request: fake.request,
    timers,
  });
  sub.start();
  for (let i = 0; i < 12 && fake.calls.length < 2; i++) await tick();
  sub.stop();
  assert.ok(fake.calls.length >= 2, `reconnected (${fake.calls.length} calls)`);
  const first = fake.calls[0].options;
  assert.equal(first.headers.Authorization, "Bearer tok-123");
  assert.equal(first.headers.Accept, "text/event-stream");
  assert.equal(first.path, "/dark-matters/api/party-stage/events");
  assert.equal(first.headers["Last-Event-ID"], undefined, "first connect has no cursor");
  assert.equal(fake.calls[1].options.headers["Last-Event-ID"], "42", "the reconnect resumes after the last frame (even a dropped one)");
  assert.deepEqual(spoken.map((s) => s.text), ["one"], "pg delivered, explicit dropped at r15");
  assert.equal(sub.state().dropped.rating, 1);
});

test("no bearer: never dials, retries later; a non-200 answer is not a stream", async () => {
  const fake = fakeRequest({ status: 401 });
  const scheduled = [];
  const timers = { setTimeout: (fn, ms) => { scheduled.push(ms); return 1; }, clearTimeout: () => {} };
  const sub = createGameStageSubscriber({ bearer: () => "", request: fake.request, timers, ceiling: () => ({ maxRating: "r18" }) });
  sub.start();
  assert.equal(fake.calls.length, 0, "no bearer, no request");
  assert.match(sub.state().lastError, /no session bearer/);
  assert.equal(scheduled.length, 1, "a retry was scheduled");
  sub.stop();

  const sub2 = createGameStageSubscriber({ bearer: () => "t", request: fake.request, timers, ceiling: () => ({ maxRating: "r18" }) });
  sub2.start();
  await tick(); await tick();
  assert.equal(fake.calls.length, 1);
  assert.match(sub2.state().lastError, /answered 401/);
  assert.equal(sub2.state().connected, false);
  sub2.stop();
});

test("stop() cancels the pending reconnect and closes the request", async () => {
  let cleared = 0;
  const fake = fakeRequest({ onOpen(res) { res.end(); } });
  const timers = { setTimeout: () => 7, clearTimeout: () => { cleared += 1; } };
  const sub = createGameStageSubscriber({ bearer: () => "t", request: fake.request, timers, ceiling: () => ({ maxRating: "r18" }) });
  sub.start();
  await tick(); await tick();
  sub.stop();
  assert.equal(cleared, 1, "the scheduled reconnect was cleared");
  assert.equal(sub.state().stopped, true);
});
