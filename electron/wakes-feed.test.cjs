"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  WAKE_NAME_RE,
  defaultDaemonBase,
  emptyFeed,
  fetchWakes,
  feedSignature,
  mutate,
  watch,
} = require("./wakes-feed.cjs");

const TOKEN = "test-token-for-testing-only";
const BASE = "http://127.0.0.1:8362";

/** A daemon answer. `json` may throw to exercise the unreadable-body arm. */
function reply(status, body) {
  return {
    status,
    json: async () => {
      if (body instanceof Error) throw body;
      return body;
    },
  };
}

function snapshotBody(overrides = {}) {
  return {
    installed: true,
    home: "C:\\Users\\wzns\\.aither\\awrise",
    schema: 2,
    migration: null,
    count: 2,
    failing: 1,
    disabled: 0,
    running: 1,
    last_tick_at: "2026-09-18T07:41:00+00:00",
    clock_stale: false,
    error: null,
    wakes: [
      {
        name: "nightly-sync",
        enabled: true,
        every: "1h",
        interval_s: 3600,
        run: "python sync.py",
        at: null,
        last_state: "failure",
        last_reason: "exit 1",
        last_started_at: "2026-09-18T07:00:01+00:00",
        last_finished_at: "2026-09-18T07:00:14+00:00",
        last_wake_id: "w-7hk2m9pq",
        consecutive_failures: 3,
        running: false,
        running_since: null,
        next_due_at: "2026-09-18T08:00:01+00:00",
        report: { card_after: 3, card_id: "d-x7k2" },
      },
      {
        name: "hourly-probe",
        enabled: true,
        every: "1h",
        interval_s: 3600,
        run: "probe.sh",
        at: null,
        last_state: "running",
        last_reason: "",
        last_started_at: "2026-09-18T07:40:00+00:00",
        last_finished_at: null,
        last_wake_id: "w-aaa",
        consecutive_failures: 0,
        running: true,
        running_since: "2026-09-18T07:40:00+00:00",
        next_due_at: null,
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The module is a DAEMON client and nothing else. This pin is the whole
// "one reader, one semantics" rule made mechanical: the moment someone adds a
// file fallback here, a second parser of awrise's state exists and the two
// drift (and a file reader cannot compute running / next-due / clock liveness
// at all, so it would render a green list for a dead scheduler).
// ---------------------------------------------------------------------------
test("wakes-feed never reads awrise state files itself", () => {
  const source = fs.readFileSync(path.join(__dirname, "wakes-feed.cjs"), "utf8");
  assert.equal(/require\(\s*["']node:fs["']\s*\)/.test(source), false, "must not require fs");
  assert.equal(/jobs\.json/.test(source), false, "must not name the awrise job file");
  assert.equal(/ledger\.jsonl/.test(source), false, "must not name the awrise ledger file");
  assert.equal(
    /require\(\s*["']node:child_process["']\s*\)/.test(source),
    false,
    "must not spawn the awrise CLI",
  );
});

test("default daemon base honours the harness env, else loopback:8362", () => {
  assert.equal(defaultDaemonBase({}), "http://127.0.0.1:8362");
  assert.equal(
    defaultDaemonBase({ AITHER_HARNESS_HOST: "localhost", AITHER_HARNESS_PORT: "9999" }),
    "http://localhost:9999",
  );
});

test("a 200 snapshot is shaped with the clock fields and the reason on every row", async () => {
  const calls = [];
  const feed = await fetchWakes({
    fetchFn: async (url, init) => {
      calls.push({ url, auth: init.headers.Authorization });
      return reply(200, snapshotBody());
    },
    daemonBase: BASE,
    token: TOKEN,
    nowMs: 1000,
  });
  assert.equal(calls[0].url, `${BASE}/wakes`);
  assert.equal(calls[0].auth, `Bearer ${TOKEN}`);
  assert.equal(feed.source, "daemon");
  assert.equal(feed.installed, true);
  assert.equal(feed.schema, 2);
  assert.equal(feed.failing, 1);
  assert.equal(feed.running, 1);
  assert.equal(feed.last_tick_at, "2026-09-18T07:41:00+00:00");
  assert.equal(feed.clock_stale, false);
  assert.equal(feed.stale_since, null);
  assert.equal(feed.wakes.length, 2);
  assert.equal(feed.wakes[0].lastReason, "exit 1");
  assert.equal(feed.wakes[0].consecutiveFailures, 3);
  assert.equal(feed.wakes[0].cardId, "d-x7k2");
  assert.equal(feed.wakes[1].running, true);
});

test("a v1 job file answers schema 1 with the migration hint intact", async () => {
  const feed = await fetchWakes({
    fetchFn: async () =>
      reply(200, snapshotBody({
        schema: 1,
        migration: "the wake file is v1 (in-memory mapping); run `awrise list` to migrate it on disk",
      })),
    daemonBase: BASE,
    token: TOKEN,
  });
  assert.equal(feed.schema, 1);
  assert.match(feed.migration, /v1/);
});

test("a stale clock rides on the feed even when every job looks fine", async () => {
  const feed = await fetchWakes({
    fetchFn: async () => reply(200, snapshotBody({ failing: 0, clock_stale: true, last_tick_at: null })),
    daemonBase: BASE,
    token: TOKEN,
  });
  assert.equal(feed.clock_stale, true);
  assert.equal(feed.last_tick_at, null);
  assert.equal(feed.wakes.length, 2, "a silent clock must not empty the list");
});

test("awrise absent answers installed:false, not an error", async () => {
  const feed = await fetchWakes({
    fetchFn: async () =>
      reply(200, { installed: false, schema: null, migration: null, wakes: [], count: 0, error: null, clock_stale: false, last_tick_at: null }),
    daemonBase: BASE,
    token: TOKEN,
  });
  assert.equal(feed.installed, false);
  assert.equal(feed.error, null);
  assert.deepEqual(feed.wakes, []);
});

test("no bearer names the credential instead of showing an empty list as truth", async () => {
  let called = false;
  const feed = await fetchWakes({
    fetchFn: async () => {
      called = true;
      return reply(200, snapshotBody());
    },
    daemonBase: BASE,
    token: null,
    nowMs: 7,
  });
  assert.equal(called, false, "no token must not reach the network");
  assert.equal(feed.error, "no harness token");
  assert.equal(feed.installed, null);
  assert.equal(feed.source, "daemon");
});

test("401/403 do NOT degrade to stale and do not keep the old list", async () => {
  const good = await fetchWakes({
    fetchFn: async () => reply(200, snapshotBody()),
    daemonBase: BASE,
    token: TOKEN,
    nowMs: 1,
  });
  for (const status of [401, 403]) {
    const feed = await fetchWakes({
      fetchFn: async () => reply(status, { detail: "invalid token" }),
      daemonBase: BASE,
      token: TOKEN,
      previous: good,
      nowMs: 2,
    });
    assert.equal(feed.source, "daemon", `HTTP ${status} must stay a live answer`);
    assert.equal(feed.error, "token rejected");
    assert.deepEqual(feed.wakes, [], "a rejected token must not show the cached list");
  }
});

test("a daemon without the /wakes window says so rather than looking down", async () => {
  const feed = await fetchWakes({
    fetchFn: async () => reply(404, { detail: "Not Found" }),
    daemonBase: BASE,
    token: TOKEN,
  });
  assert.equal(feed.source, "daemon");
  assert.match(feed.error, /restart the harness daemon/);
});

test("ECONNREFUSED keeps the last good snapshot, tagged stale, with a stable stale_since", async () => {
  const good = await fetchWakes({
    fetchFn: async () => reply(200, snapshotBody()),
    daemonBase: BASE,
    token: TOKEN,
    nowMs: 1000,
  });
  const boom = async () => {
    const error = new Error("connect ECONNREFUSED 127.0.0.1:8362");
    error.code = "ECONNREFUSED";
    throw error;
  };
  const first = await fetchWakes({ fetchFn: boom, daemonBase: BASE, token: TOKEN, previous: good, nowMs: 5000 });
  assert.equal(first.source, "stale");
  assert.equal(first.stale_since, 5000);
  assert.equal(first.error, "daemon unreachable");
  assert.equal(first.wakes.length, 2, "the cached rows are what makes it useful");

  const second = await fetchWakes({ fetchFn: boom, daemonBase: BASE, token: TOKEN, previous: first, nowMs: 900000 });
  assert.equal(second.stale_since, 5000, "the age must count from the FIRST failure");
  assert.equal(second.wakes.length, 2);
});

test("a timeout with nothing cached says 'nothing cached', never an empty job list as fact", async () => {
  const feed = await fetchWakes({
    fetchFn: async () => {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    },
    daemonBase: BASE,
    token: TOKEN,
    previous: null,
    nowMs: 42,
  });
  assert.equal(feed.source, "stale");
  assert.equal(feed.installed, null, "null = unknown, not 'awrise absent'");
  assert.deepEqual(feed.wakes, []);
  assert.equal(feed.stale_since, 42);
  assert.equal(feed.error, "daemon unreachable");
});

test("an unreadable body is an error, not a silent empty list", async () => {
  const feed = await fetchWakes({
    fetchFn: async () => reply(200, new Error("not json")),
    daemonBase: BASE,
    token: TOKEN,
  });
  assert.match(feed.error, /unreadable/);
  assert.deepEqual(feed.wakes, []);
});

// ---------------------------------------------------------------------------
// mutate()
// ---------------------------------------------------------------------------

test("mutate builds the daemon URL, and only `run` asks for a wait window", async () => {
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push({ url, method: init.method, auth: init.headers.Authorization });
    return reply(200, { ok: true, exit_code: 0, stdout_tail: "nightly-sync: disabled" });
  };
  for (const verb of ["enable", "disable", "run"]) {
    await mutate({ fetchFn, daemonBase: BASE, token: TOKEN, name: "nightly-sync", verb });
  }
  assert.equal(seen[0].url, `${BASE}/wakes/nightly-sync/enable`);
  assert.equal(seen[1].url, `${BASE}/wakes/nightly-sync/disable`);
  assert.equal(seen[2].url, `${BASE}/wakes/nightly-sync/run?wait_s=15`);
  assert.deepEqual(new Set(seen.map((s) => s.method)), new Set(["POST"]));
  assert.equal(seen[2].auth, `Bearer ${TOKEN}`);
});

test("mutate refuses a traversal name and an unknown verb WITHOUT a request", async () => {
  let called = false;
  const fetchFn = async () => {
    called = true;
    return reply(200, {});
  };
  for (const bad of ["../x", "a b", "-name", "", "x".repeat(65)]) {
    const result = await mutate({ fetchFn, daemonBase: BASE, token: TOKEN, name: bad, verb: "run" });
    assert.equal(result.ok, false, `${JSON.stringify(bad)} must be refused`);
    assert.equal(result.detail, "invalid wake name");
  }
  assert.equal(called, false, "a bad name must never reach the daemon");
  await assert.rejects(
    () => mutate({ fetchFn, daemonBase: BASE, token: TOKEN, name: "ok", verb: "delete" }),
    /unknown wake verb/,
  );
  assert.equal(called, false);
});

test("mutate without a bearer is refused locally — the desk never posts unauthenticated", async () => {
  let called = false;
  const result = await mutate({
    fetchFn: async () => {
      called = true;
      return reply(200, {});
    },
    daemonBase: BASE,
    token: null,
    name: "nightly-sync",
    verb: "disable",
  });
  assert.equal(called, false);
  assert.equal(result.ok, false);
  assert.equal(result.detail, "no harness token");
});

test("mutate maps 202 to started-with-pid and 409 to already running", async () => {
  const started = await mutate({
    fetchFn: async () => reply(202, { ok: true, running: true, pid: 4242, exit_code: null }),
    daemonBase: BASE,
    token: TOKEN,
    name: "nightly-sync",
    verb: "run",
  });
  assert.equal(started.ok, true);
  assert.equal(started.started, true);
  assert.equal(started.pid, 4242);
  assert.equal(started.exitCode, null);

  const busy = await mutate({
    fetchFn: async () => reply(409, { detail: { error: "already running", pid: 99 } }),
    daemonBase: BASE,
    token: TOKEN,
    name: "nightly-sync",
    verb: "run",
  });
  assert.equal(busy.ok, false);
  assert.equal(busy.detail, "already running");
  assert.equal(busy.pid, 99);
});

test("mutate propagates a non-zero exit and names a missing awrise", async () => {
  const failed = await mutate({
    fetchFn: async () =>
      reply(502, { detail: { error: "awrise run exited 3", exit_code: 3, stderr_tail: "boom" } }),
    daemonBase: BASE,
    token: TOKEN,
    name: "nightly-sync",
    verb: "run",
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.exitCode, 3);
  assert.equal(failed.stderrTail, "boom");
  assert.match(failed.detail, /exited 3/);

  const missing = await mutate({
    fetchFn: async () => reply(503, { detail: "awrise not installed" }),
    daemonBase: BASE,
    token: TOKEN,
    name: "nightly-sync",
    verb: "enable",
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.detail, "awrise not installed");

  const unauth = await mutate({
    fetchFn: async () => reply(401, { detail: "missing bearer token" }),
    daemonBase: BASE,
    token: TOKEN,
    name: "nightly-sync",
    verb: "enable",
  });
  assert.equal(unauth.ok, false);
  assert.equal(unauth.detail, "no harness token");
});

// ---------------------------------------------------------------------------
// watch()
// ---------------------------------------------------------------------------

test("watch pushes on the first poll and only when the feed actually moves", async () => {
  let handler = null;
  const timers = {
    setIntervalFn: (fn) => {
      handler = fn;
      return 1;
    },
    clearIntervalFn: () => {
      handler = null;
    },
  };
  let body = snapshotBody();
  const pushes = [];
  const controller = watch({
    onChange: (feed) => pushes.push(feed),
    fetchFn: async () => reply(200, body),
    daemonBase: BASE,
    token: TOKEN,
    ...timers,
  });
  await controller.firstPoll;
  assert.equal(pushes.length, 1);

  // Same payload -> no push (the signature ignores fetched_at).
  await handler();
  assert.equal(pushes.length, 1);

  // A job flips to failing -> one push.
  body = snapshotBody({ failing: 2 });
  await handler();
  assert.equal(pushes.length, 2);
  assert.equal(pushes[1].failing, 2);

  controller.stop();
  assert.equal(handler, null);
});

test("feedSignature ignores fetched_at but tracks source and staleness", () => {
  const a = emptyFeed({ fetched_at: 1 });
  const b = emptyFeed({ fetched_at: 2 });
  assert.equal(feedSignature(a), feedSignature(b));
  assert.notEqual(feedSignature(a), feedSignature(emptyFeed({ source: "stale", fetched_at: 1 })));
  assert.notEqual(feedSignature(a), feedSignature(emptyFeed({ stale_since: 5, fetched_at: 1 })));
});

test("the name gate accepts real job names and nothing option-shaped", () => {
  assert.equal(WAKE_NAME_RE.test("nightly-sync"), true);
  assert.equal(WAKE_NAME_RE.test("job1"), true);
  assert.equal(WAKE_NAME_RE.test("a.b_c-1"), true);
  assert.equal(WAKE_NAME_RE.test("-force"), false);
  assert.equal(WAKE_NAME_RE.test("../etc"), false);
  assert.equal(WAKE_NAME_RE.test(""), false);
});
