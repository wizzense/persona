"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const {
  fetchHistory,
  fetchThread,
  post,
  postThreadReply,
  setHumanityAttestationSource,
  _resetJoinForTests,
  _resetDoorForTests,
  _setBearerSourceForTests,
  RELAY_URL,
  DOOR_KNOCK_URL,
  DOOR_PRESENT_URL,
  DOOR_HEADER,
} = require("./relay-feed.cjs");
const { sharedBridge, _resetSharedForTests } = require("./relay-room-bridge.cjs");

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
  const sent = await post("#agents", "hello fleet", req);
  // 🚩 the verdict now CARRIES the relay's record (id, body) alongside ok/detail
  // (see storedMessageId in relay-feed.cjs) — a plain {ok,detail} deepEqual
  // here would fail on those extra, correct keys, so check the two fields the
  // relay-room-bridge and main.cjs actually branch on.
  assert.equal(sent.ok, true);
  assert.equal(sent.detail, "");
  const send = calls.find((c) => c.urlPath.includes("/v1/channels/%23agents/messages"));
  assert.ok(send, "the message POST happened");
  assert.equal(send.body.channel, "#agents");
  assert.equal(send.body.nick, "david");
  assert.equal(send.body.content, "hello fleet");

  // a 403 refusal is an honest {ok:false} carrying the relay's OWN reason
  const refuse = fakeRequest((_m, urlPath) => {
    if (urlPath === "/v1/agent/join") return { status: 200, body: '{"is_agent":true}' };
    return { status: 403, body: "agent-only channel" };
  });
  const refused = await post("#agents", "hello", refuse);
  assert.equal(refused.ok, false);
  assert.match(refused.detail, /403/);
  assert.match(refused.detail, /agent-only channel/);
  assert.deepEqual(await post("#agents", "   "), { ok: false, detail: "empty message" },
    "blank text never sends");
});

test("post retries ONE transient transport blip, and a join refusal names the relay's reason", async () => {
  _resetJoinForTests();
  // First attempt: the relay answers nothing (status 0 — a restart window or
  // a TLS blip). The retry lands and the message goes through exactly once.
  const flaky = fakeRequest((_m, urlPath, body) => {
    if (urlPath === "/v1/agent/join") return { status: 200, body: '{"is_agent":true}' };
    flaky.attempts = (flaky.attempts || 0) + 1;
    if (flaky.attempts === 1) return { status: 0, body: "" };
    return { status: 200, body: '{"success":true,"content":"' + body.content + '"}' };
  });
  const afterBlip = await post("#agents", "after the blip", flaky);
  assert.equal(afterBlip.ok, true);
  assert.equal(afterBlip.detail, "");
  assert.equal(flaky.attempts, 2, "one retry, not a loop");

  // A join REFUSED by the relay surfaces the relay's own detail, not "refused".
  _resetJoinForTests();
  const joinRefused = fakeRequest(() => ({
    status: 403,
    body: '{"detail":"Requested nick does not match authenticated identity"}',
  }));
  const jr = await post("#agents", "hello", joinRefused);
  assert.equal(jr.ok, false);
  assert.match(jr.detail, /nick does not match/);
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
  const replied = await postThreadReply("#agents", "451a3460", "nice catch", req);
  assert.equal(replied.ok, true);
  assert.equal(replied.detail, "");
  const reply = calls.find((c) => c.urlPath.includes("/thread"));
  assert.ok(reply, "the thread POST happened");
  assert.ok(reply.urlPath.includes("451a3460"), "the parent id is in the URL");
  assert.equal(reply.body.nick, "david");
  assert.equal(reply.body.content, "nice catch");

  const refuse = fakeRequest((_m, urlPath) => {
    if (urlPath === "/v1/agent/join") return { status: 200, body: '{"is_agent":true}' };
    return { status: 403, body: '{"detail":"thread closed"}' };
  });
  const refused = await postThreadReply("#agents", "m", "x", refuse);
  assert.equal(refused.ok, false, "a refusal must be {ok:false}");
  assert.match(refused.detail, /thread closed/);
  assert.deepEqual(await postThreadReply("#agents", "", "x"),
    { ok: false, detail: "missing message id" }, "a missing id never sends");
  assert.deepEqual(await postThreadReply("#agents", "m", "  "),
    { ok: false, detail: "empty reply" }, "blank text never sends");
});

// ---------------------------------------------------------------------------
// The relay's own id, and loop protection that actually fires (U08).
//
// 🚩 Before this unit doorGatedWrite discarded the relay's response body, so
// noteOursToRoom's `result.id || result.message_id || result.body.id` read
// undefined every time and a message this desk posted came back on the next
// poll as somebody else's words — measured 2026-09-19 in AitherRelay.py: a
// message POST answers {"success":true,"message":{...}} and a thread reply
// answers {"success":true,"reply":{...}}, neither carrying `id` at the top
// level. storedMessageId() in relay-feed.cjs is what reads INTO those shapes.
// ---------------------------------------------------------------------------

test("post surfaces the relay's id from message.id and hands it to noteOurs", async () => {
  _resetJoinForTests();
  _resetSharedForTests();
  const req = fakeRequest((_m, urlPath) => {
    if (urlPath === "/v1/agent/join") return { status: 200, body: '{"is_agent":true}' };
    return { status: 200, body: '{"success":true,"message":{"id":"msg-abc"}}' };
  });
  const result = await post("#agents", "hello", req);
  assert.equal(result.ok, true);
  assert.equal(result.id, "msg-abc", "storedMessageId reads message.id");
  // noteOursToRoom is fire-and-forget inside post() — it runs synchronously
  // in this module (no await between the relay answer and the require), so
  // the shared bridge already has it by the time post() resolves.
  assert.ok(sharedBridge().ours.has("msg-abc"),
    "a row THIS desk posted must be recognisable as ours on the next mirror poll");
});

test("post surfaces the relay's id from a bare id or message_id, never from a body with neither", async () => {
  _resetJoinForTests();
  _resetSharedForTests();
  const bareId = fakeRequest((_m, urlPath) => {
    if (urlPath === "/v1/agent/join") return { status: 200, body: '{"is_agent":true}' };
    return { status: 200, body: '{"id":"bare-1"}' };
  });
  assert.equal((await post("#agents", "a", bareId)).id, "bare-1");

  _resetJoinForTests();
  const viaMessageId = fakeRequest((_m, urlPath) => {
    if (urlPath === "/v1/agent/join") return { status: 200, body: '{"is_agent":true}' };
    return { status: 200, body: '{"success":true,"message_id":"mid-2"}' };
  });
  assert.equal((await post("#agents", "b", viaMessageId)).id, "mid-2");

  _resetJoinForTests();
  const noId = fakeRequest((_m, urlPath) => {
    if (urlPath === "/v1/agent/join") return { status: 200, body: '{"is_agent":true}' };
    return { status: 200, body: '{"success":true}' };
  });
  assert.equal((await post("#agents", "c", noId)).id, null,
    "an unparseable id is null, never a guess");
});

test("postThreadReply surfaces the relay's id from reply.id", async () => {
  _resetJoinForTests();
  _resetSharedForTests();
  const req = fakeRequest((_m, urlPath) => {
    if (urlPath === "/v1/agent/join") return { status: 200, body: '{"is_agent":true}' };
    return { status: 200, body: '{"success":true,"reply":{"id":"reply-9"},"thread_info":{}}' };
  });
  const result = await postThreadReply("#agents", "451a3460", "nice catch", req);
  assert.equal(result.id, "reply-9");
  assert.ok(sharedBridge().ours.has("reply-9"));
});

// ---------------------------------------------------------------------------
// The door protocol on the write path (module header, DOORS).
// ---------------------------------------------------------------------------

const DOOR_403 = {
  status: 403,
  body: JSON.stringify({
    detail: "#agents is behind the channel:#agents door. Knock at /doors/knock, "
      + "present your evidence at /doors/present, then send with X-Door-Attestation. "
      + "No attestation presented.",
  }),
};

/** A request fake that ALSO passes the {headers} option through. */
function fakeRequest4(handler) {
  return (method, urlPath, body, opts) => Promise.resolve(handler(method, urlPath, body, opts || {}));
}

/**
 * A scripted relay + gateway. `relay(headers)` decides the write verdict from
 * the attestation header; `present` mints attestations in sequence. Every
 * call is logged so a test can count knocks, presents and writes.
 */
function doorWorld({ relay, present, knock, humanity = "humanity-evidence" } = {}) {
  _resetJoinForTests();
  _resetDoorForTests();
  setHumanityAttestationSource(() => humanity);
  const log = [];
  const world = {
    log,
    presents: 0,
    req: fakeRequest4((_m, urlPath, body, opts) => {
      const headers = opts.headers || {};
      if (urlPath === "/v1/agent/join") {
        log.push({ kind: "join" });
        return { status: 200, body: '{"is_agent":true,"nick":"david"}' };
      }
      if (urlPath === DOOR_KNOCK_URL) {
        log.push({ kind: "knock", door: body.door });
        return knock ? knock(body) : { status: 200, body: '{"door":"channel:#agents","requires":"humanity"}' };
      }
      if (urlPath === DOOR_PRESENT_URL) {
        world.presents += 1;
        log.push({ kind: "present", door: body.door, evidence: body.attestation });
        return present
          ? present(body, world.presents)
          : { status: 200, body: JSON.stringify({ admitted: true, attestation: `att-${world.presents}`, expires_at: "2099-01-01T00:00:00Z" }) };
      }
      if (urlPath.startsWith("/v1/channels/")) {
        log.push({ kind: "write", urlPath, attestation: headers[DOOR_HEADER] || "" });
        return relay ? relay(headers[DOOR_HEADER] || "", body) : (
          headers[DOOR_HEADER] ? { status: 200, body: '{"success":true}' } : DOOR_403
        );
      }
      return { status: 500, body: "" };
    }),
  };
  return world;
}

test("door: the attestation is minted once and reused across two posts", async () => {
  const w = doorWorld();
  const first = await post("#agents", "first", w.req);
  assert.equal(first.ok, true);
  assert.equal(first.detail, "");
  const second = await post("#agents", "second", w.req);
  assert.equal(second.ok, true);
  assert.equal(second.detail, "");
  assert.equal(w.presents, 1, "one present for two posts");
  assert.equal(w.log.filter((e) => e.kind === "knock").length, 1, "one knock too");
  const writes = w.log.filter((e) => e.kind === "write");
  // first post: plain write -> 403-door -> present -> retry; second: header up front
  assert.deepEqual(writes.map((e) => e.attestation), ["", "att-1", "att-1"]);
  assert.equal(w.log.find((e) => e.kind === "knock").door, "channel:#agents");
  assert.equal(w.log.find((e) => e.kind === "present").evidence, "humanity-evidence",
    "the humanity attestation is what gets presented");
  _resetDoorForTests();
});

test("door: the relay write carries X-Door-Attestation (post and thread reply)", async () => {
  const w = doorWorld();
  assert.equal((await post("#agents", "hi", w.req)).ok, true);
  assert.equal((await postThreadReply("#agents", "451a3460", "reply", w.req)).ok, true);
  const last = w.log.filter((e) => e.kind === "write").at(-1);
  assert.ok(last.urlPath.includes("/451a3460/thread"), "the thread write happened");
  assert.equal(last.attestation, "att-1", "the header is on the thread write");
  assert.equal(w.presents, 1, "post and reply share the door attestation");
  _resetDoorForTests();
});

test("door: a 403-door with a cached attestation re-presents once and retries once", async () => {
  // the relay honours att-1 for the first write, then revokes it: att-2 needed
  let honoured = "att-1";
  const w = doorWorld({
    relay: (att) => (att && att === honoured ? { status: 200, body: "{}" } : DOOR_403),
  });
  assert.equal((await post("#agents", "one", w.req)).ok, true);
  honoured = "att-2";
  const two = await post("#agents", "two", w.req);
  assert.equal(two.ok, true);
  assert.equal(two.detail, "");
  assert.equal(w.presents, 2, "re-presented exactly once");
  const writes = w.log.filter((e) => e.kind === "write").map((e) => e.attestation);
  assert.deepEqual(writes, ["", "att-1", "att-1", "att-2"]);

  // and when the retry is STILL 403-door, report it honestly — no third present
  honoured = "never";
  const r = await post("#agents", "three", w.req);
  assert.equal(r.ok, false);
  assert.match(r.detail, /relay HTTP 403/);
  assert.match(r.detail, /behind the channel:#agents door/);
  assert.equal(w.presents, 3, "one re-present per write, never a loop");
  _resetDoorForTests();
});

test("door: present 403 yields an actionable 'door refused' detail with the server's reason", async () => {
  const w = doorWorld({
    present: () => ({ status: 403, body: '{"detail":"humanity attestation expired"}' }),
  });
  const r = await post("#agents", "hi", w.req);
  assert.deepEqual(r, { ok: false, detail: "door refused: humanity attestation expired" });
  assert.equal(w.log.filter((e) => e.kind === "write").length, 1, "no retry without an attestation");

  // an admitted:false 2xx is a refusal too
  const w2 = doorWorld({
    present: () => ({ status: 200, body: '{"admitted":false,"detail":"evidence rejected"}' }),
  });
  assert.deepEqual(await post("#agents", "hi", w2.req), { ok: false, detail: "door refused: evidence rejected" });
  _resetDoorForTests();
});

test("door: gateway 404 names the passthrough rung exactly", async () => {
  const w = doorWorld({ knock: () => ({ status: 404, body: "Not Found" }) });
  assert.deepEqual(await post("#agents", "hi", w.req),
    { ok: false, detail: "doors passthrough not live on the gateway (HTTP 404)" });
  assert.equal(w.presents, 0, "nothing to present against a dead passthrough");

  const w2 = doorWorld({ present: () => ({ status: 404, body: "Not Found" }) });
  assert.deepEqual(await post("#agents", "hi", w2.req),
    { ok: false, detail: "doors passthrough not live on the gateway (HTTP 404)" });
  _resetDoorForTests();
});

test("door: no humanity attestation on this machine is named, after the knock succeeds", async () => {
  const w = doorWorld({ humanity: "" });
  const r = await post("#agents", "hi", w.req);
  assert.equal(r.ok, false);
  assert.equal(r.detail,
    "no humanity attestation on this machine -- take the humanity check once "
    + "(Identity /auth/me/verify-humanity) and save it to ~/.aither/humanity-attestation");
  assert.equal(w.presents, 0, "nothing was presented");
  assert.equal(w.log.filter((e) => e.kind === "knock").length, 1, "the knock came first");
  _resetDoorForTests();
});

test("door: a bearer rotation discards the attestation and re-presents", async () => {
  const w = doorWorld();
  let token = "bearer-A";
  _setBearerSourceForTests(() => token);
  assert.equal((await post("#agents", "one", w.req)).ok, true);
  assert.equal(w.presents, 1);
  token = "bearer-B";
  assert.equal((await post("#agents", "two", w.req)).ok, true);
  assert.equal(w.presents, 2, "a new bearer is a new identity at the door");
  assert.equal(w.log.filter((e) => e.kind === "join").length, 2, "…and re-joins the relay");
  const writes = w.log.filter((e) => e.kind === "write").map((e) => e.attestation);
  assert.deepEqual(writes, ["", "att-1", "att-2"], "the second write presented BEFORE writing");
  _resetDoorForTests();
});

test("door: a lapsed expires_at re-presents before the write", async () => {
  const w = doorWorld({
    present: (_b, n) => ({
      status: 200,
      body: JSON.stringify({
        admitted: true,
        attestation: `att-${n}`,
        expires_at: n === 1 ? Math.floor(Date.now() / 1000) + 2 : "2099-01-01T00:00:00Z",
      }),
    }),
  });
  assert.equal((await post("#agents", "one", w.req)).ok, true);
  assert.equal((await post("#agents", "two", w.req)).ok, true);
  assert.equal(w.presents, 2, "an attestation inside the skew window is not reused");
  _resetDoorForTests();
});

test("door: a plain 403 (no door in the reason) never knocks", async () => {
  const w = doorWorld({ relay: () => ({ status: 403, body: '{"detail":"agent-only channel"}' }) });
  const r = await post("#agents", "hi", w.req);
  assert.equal(r.ok, false);
  assert.match(r.detail, /agent-only channel/);
  assert.equal(w.log.filter((e) => e.kind === "knock").length, 0);
  _resetDoorForTests();
});
