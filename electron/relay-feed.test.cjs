"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const { fetchHistory, fetchThread, post, postThreadReply, RELAY_URL } = require("./relay-feed.cjs");

function fakeSpawn(handler) {
  return (_cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    queueMicrotask(() => {
      const { code, stdout } = handler(args);
      if (code === 2) {
        child.emit("error", new Error("spawn failed"));
      } else {
        child.stdout.emit("data", stdout || "");
        child.emit("close", code);
      }
    });
    return child;
  };
}

test("fetchHistory parses the relay's REAL envelope into desk-shaped rows", async () => {
  const seen = [];
  const rows = await fetchHistory(
    "#agents",
    12,
    fakeSpawn((args) => {
      // never echo the --token pair back into an assertion message (secret-safety)
      seen.push(args.filter((a, i) => args[i - 1] !== "--token" && a !== "--token"));
      assert.equal(args[0], "--url");
      assert.equal(args[1], RELAY_URL);
      return {
        code: 0,
        stdout: JSON.stringify([
          { channel: "#agents", nick: "owner+abc", content: "answered d-x: ack", timestamp: "2026-08-25T00:00:10.000Z" },
          { channel: "#agents", author: "session-b", text: "found a race", at: 2000 },
          { channel: "#agents", nick: "ghost", content: 42 }, // bad row, skipped
          "not-an-object",
        ]),
      };
    }),
  );
  assert.deepEqual(seen[0], ["--url", RELAY_URL, "--json", "history", "#agents", "--limit", "12"]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].author, "owner+abc");
  assert.equal(rows[0].text, "answered d-x: ack");
  assert.equal(rows[0].at, Math.floor(Date.parse("2026-08-25T00:00:10.000Z") / 1000));
  assert.equal(rows[1].author, "session-b");
  assert.equal(rows[1].at, 2000);
});

test("fetchHistory returns [] when the relay refuses or speaks non-JSON", async () => {
  assert.deepEqual(
    await fetchHistory("#agents", 12, fakeSpawn(() => ({ code: 1, stdout: "" }))),
    [],
    "relay refusal is [] — never a half-truth",
  );
  assert.deepEqual(
    await fetchHistory("#agents", 12, fakeSpawn(() => ({ code: 0, stdout: "no json here" }))),
    [],
  );
  assert.deepEqual(
    await fetchHistory("#agents", 12, fakeSpawn(() => ({ code: 2, stdout: "" }))),
    [],
    "a spawn failure is [] too",
  );
});

test("post sends the text and reports the relay verdict", async () => {
  const seen = [];
  assert.equal(
    await post("#agents", "hello fleet", fakeSpawn((args) => {
      // never echo the --token pair back into an assertion message (secret-safety)
      seen.push(args.filter((a, i) => args[i - 1] !== "--token" && a !== "--token"));
      return { code: 0, stdout: "" };
    })),
    true,
  );
  assert.deepEqual(seen[0], ["--url", RELAY_URL, "send", "#agents", "hello fleet"]);

  assert.equal(
    await post("#agents", "hello", fakeSpawn(() => ({ code: 1, stdout: "" }))),
    false,
    "a relay refusal must be false, not thrown",
  );
  assert.equal(await post("#agents", "   "), false, "blank text never spawns");
});

test("fetchThread shapes thread replies and carries id/threadId/agent", async () => {
  const seen = [];
  const rows = await fetchThread(
    "#agents",
    "451a3460",
    fakeSpawn((args) => {
      // never echo the --token pair back into an assertion message (secret-safety)
      seen.push(args.filter((a, i) => args[i - 1] !== "--token" && a !== "--token"));
      return {
        code: 0,
        stdout: JSON.stringify([
          {
            id: "parent-id",
            channel: "#agents",
            nick: "athena",
            content: "here is the fix",
            timestamp: "2026-08-25T00:00:10.000Z",
            agent: true,
            thread_id: "451a3460",
            reply_count: 2,
          },
        ]),
      };
    }),
  );
  assert.deepEqual(
    seen[0],
    ["--url", RELAY_URL, "--json", "thread", "#agents", "451a3460"],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "parent-id");
  assert.equal(rows[0].threadId, "451a3460");
  assert.equal(rows[0].replyCount, 2);
  assert.equal(rows[0].agent, true);
});

test("fetchThread returns [] on refusal, bad json, or a missing id", async () => {
  assert.deepEqual(
    await fetchThread("#agents", "m", fakeSpawn(() => ({ code: 1, stdout: "" }))),
    [],
  );
  assert.deepEqual(
    await fetchThread("#agents", "m", fakeSpawn(() => ({ code: 0, stdout: "nope" }))),
    [],
  );
  assert.deepEqual(await fetchThread("#agents", ""), [], "an empty id never spawns");
});

test("postThreadReply sends a thread-reply and reports the verdict", async () => {
  const seen = [];
  assert.equal(
    await postThreadReply("#agents", "451a3460", "nice catch", fakeSpawn((args) => {
      // never echo the --token pair back into an assertion message (secret-safety)
      seen.push(args.filter((a, i) => args[i - 1] !== "--token" && a !== "--token"));
      return { code: 0, stdout: "" };
    })),
    true,
  );
  assert.deepEqual(
    seen[0],
    ["--url", RELAY_URL, "thread-reply", "#agents", "451a3460", "nice catch"],
  );
  assert.equal(
    await postThreadReply("#agents", "m", "x", fakeSpawn(() => ({ code: 1, stdout: "" }))),
    false,
    "a relay refusal must be false",
  );
  assert.equal(await postThreadReply("#agents", "", "x"), false, "a missing id never spawns");
  assert.equal(await postThreadReply("#agents", "m", "  "), false, "blank text never spawns");
});
