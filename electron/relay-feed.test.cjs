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

function fakeRequest(handler) {
  return (method, urlPath, body) => Promise.resolve(handler(method, urlPath, body));
}

test("post joins the relay identity, sends over HTTP, and reports the verdict", async () => {
  const calls = [];
  const req = fakeRequest((_method, urlPath, body) => {
    calls.push({ urlPath, body });
    if (urlPath === "/v1/agent/join") return { status: 200, body: '{"is_agent":true,"nick":"david"}' };
    if (urlPath.includes("/messages")) return { status: 200, body: '{"success":true}' };
    return { status: 500, body: "" };
  });
  assert.equal(await post("#agents", "hello fleet", req), true);
  const send = calls.find((c) => c.urlPath.includes("/v1/channels/%23agents/messages"));
  assert.ok(send, "the message POST happened");
  assert.equal(send.body.channel, "#agents");
  assert.equal(send.body.nick, "david");
  assert.equal(send.body.content, "hello fleet");

  // a 403 refusal is false, not thrown
  const refuse = fakeRequest((_m, urlPath) => {
    if (urlPath === "/v1/agent/join") return { status: 200, body: '{"is_agent":true}' };
    return { status: 403, body: "agent-only channel" };
  });
  assert.equal(await post("#agents", "hello", refuse), false);
  assert.equal(await post("#agents", "   "), false, "blank text never sends");
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

test("postThreadReply replies over HTTP and reports the verdict", async () => {
  const calls = [];
  const req = fakeRequest((_method, urlPath, body) => {
    calls.push({ urlPath, body });
    if (urlPath === "/v1/agent/join") return { status: 200, body: '{"is_agent":true}' };
    if (urlPath.includes("/thread")) return { status: 200, body: '{"success":true,"reply":{}}' };
    return { status: 500, body: "" };
  });
  assert.equal(await postThreadReply("#agents", "451a3460", "nice catch", req), true);
  const reply = calls.find((c) => c.urlPath.includes("/thread"));
  assert.ok(reply, "the thread POST happened");
  assert.ok(reply.urlPath.includes("451a3460"), "the parent id is in the URL");
  assert.equal(reply.body.nick, "david");
  assert.equal(reply.body.content, "nice catch");

  const refuse = fakeRequest((_m, urlPath) => {
    if (urlPath === "/v1/agent/join") return { status: 200, body: '{"is_agent":true}' };
    return { status: 403, body: "" };
  });
  assert.equal(await postThreadReply("#agents", "m", "x", refuse), false, "a refusal must be false");
  assert.equal(await postThreadReply("#agents", "", "x"), false, "a missing id never sends");
  assert.equal(await postThreadReply("#agents", "m", "  "), false, "blank text never sends");
});
