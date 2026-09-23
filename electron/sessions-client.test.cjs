"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { listSessions, tailTranscript } = require("./sessions-client.cjs");

function fakeFetch({ status = 200, body = { sessions: [] }, throws = null } = {}) {
  return async (_url, opts) => {
    if (throws) throw throws;
    fakeFetch.lastOpts = opts;
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
    };
  };
}

test("listSessions: happy path passes the bearer and returns the rows", async () => {
  process.env.AITHER_HARNESS_TOKEN = "test-token";
  try {
    const fetchImpl = fakeFetch({ body: { sessions: [{ id: "s1", title: "tab", status: "working" }] } });
    const result = await listSessions({ fetchImpl });
    assert.equal(result.ok, true);
    assert.equal(result.sessions.length, 1);
    assert.equal(fakeFetch.lastOpts.headers.Authorization, "Bearer test-token");
  } finally {
    delete process.env.AITHER_HARNESS_TOKEN;
  }
});

test("listSessions: a refused token and an unreachable daemon are DIFFERENT notes", async () => {
  process.env.AITHER_HARNESS_TOKEN = "stale";
  try {
    const refused = await listSessions({ fetchImpl: fakeFetch({ status: 401 }) });
    assert.equal(refused.ok, false);
    assert.match(refused.note, /refused the token/);

    const down = await listSessions({ fetchImpl: fakeFetch({ throws: new Error("ECONNREFUSED") }) });
    assert.equal(down.ok, false);
    assert.match(down.note, /unreachable/);
    assert.deepEqual(down.sessions, []);
  } finally {
    delete process.env.AITHER_HARNESS_TOKEN;
  }
});

test("listSessions: no token anywhere is its own state, never an empty-but-fine list", async () => {
  const savedEnv = process.env.AITHER_HARNESS_TOKEN;
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  delete process.env.AITHER_HARNESS_TOKEN;
  // os.homedir() on win32 reads USERPROFILE, NOT HOME -- overriding only HOME
  // left this test reading the REAL token file and passing for the wrong reason.
  const fakeHome = path.join(os.tmpdir(), "no-such-home-" + Date.now());
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    const result = await listSessions({ fetchImpl: fakeFetch({}) });
    assert.equal(result.ok, false);
    assert.match(result.note, /no harness token/);
  } finally {
    if (savedEnv !== undefined) process.env.AITHER_HARNESS_TOKEN = savedEnv;
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
  }
});

test("tailTranscript: returns the LAST lines, and a byte window keeps whole lines", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-tail-test-"));
  const file = path.join(dir, "t.jsonl");
  try {
    const rows = [];
    for (let i = 1; i <= 200; i += 1) rows.push(JSON.stringify({ type: "user", n: i }));
    fs.writeFileSync(file, rows.join("\n") + "\n", "utf8");

    const full = tailTranscript(file, { maxLines: 10 });
    assert.equal(full.ok, true);
    assert.equal(full.lines.length, 10);
    assert.match(full.lines[9], /\{"type":"user","n":200\}/);

    // A byte window that starts mid-file must open on a line boundary -- a
    // half-line would render as a JSON parse failure on every poll.
    const windowed = tailTranscript(file, { maxLines: 50, maxBytes: 300 });
    assert.equal(windowed.ok, true);
    assert.equal(windowed.truncated, true);
    for (const line of windowed.lines) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tailTranscript: a missing path or file is a note, never a throw", () => {
  assert.equal(tailTranscript("").ok, false);
  const missing = tailTranscript(path.join(os.tmpdir(), "does-not-exist-" + Date.now() + ".jsonl"));
  assert.equal(missing.ok, false);
  assert.match(missing.note, /cannot read transcript/);
});

test("sessionsBrief: working first, capped, and 'could not look' is never an empty list", () => {
  const { sessionsBrief } = require("./sessions-client.cjs");
  const brief = sessionsBrief({
    ok: true,
    sessions: [
      { id: "idle-one-000000", status: "idle", harness: "awdk", title: "local loop" },
      { id: "work-one-000000", status: "working", harness: "claude", title: "fixing the fleet", last_activity_summary: "ran the gates" },
      { id: "wait-one-000000", status: "waiting-input", harness: "claude", title: "needs you" },
    ],
  }, { max: 2 });
  const lines = brief.split("\n");
  assert.match(lines[1], /^- \[working\] claude work-one-000: fixing the fleet -- ran the gates$/);
  assert.match(lines[2], /^- \[waiting-input\]/);
  assert.ok(brief.includes("(+1 more)"));
  assert.ok(brief.includes("awsh_send"));
  assert.match(sessionsBrief({ ok: false, sessions: [], note: "daemon unreachable" }), /unknown right now \(daemon unreachable\)/);
  assert.equal(sessionsBrief({ ok: true, sessions: [] }), "The owner has no active agent sessions right now.");
});
