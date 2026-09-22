"use strict";

/**
 * wakes-feed — Desk's window onto awrise (the routines/scheduler brick).
 *
 * awrise runs the owner's scheduled jobs ("wakes"). A wake that stops firing,
 * or a clock that stops ticking, is exactly the class of failure nobody
 * notices: the job list still looks green while nothing has run for a day.
 * Desk is the surface that is ALWAYS on the owner's screen, so it is the right
 * carrier for "your scheduler is silent".
 *
 * ONE READER. Everything here goes through the awdk harness daemon's /wakes
 * window (:8362) — the same window Discord, AitherDesktop and the MCP tool
 * read. Desk deliberately does NOT parse awrise's own state files and does NOT
 * spawn the awrise CLI:
 *   - a second parser in JS is a rival implementation that drifts (the DCS001
 *     class this tree already learned from decision-cards.cjs);
 *   - the live file on this host is still the v1 shape, which a naive reader
 *     mis-maps (interval/command vs interval_s/run);
 *   - `running`, `next_due_at` and clock liveness are derived from the awrise
 *     LEDGER, not from the job file, so a file reader cannot compute them at
 *     all — it would render a green list for a dead scheduler.
 * When the daemon cannot be reached the desk shows its LAST GOOD snapshot
 * tagged `source: "stale"` with the age, or "nothing cached" — an honest
 * "I cannot see it right now" instead of a fabricated list
 * (security-review-patterns #5: never pretend empty).
 *
 * WRITE side: enable/disable/run POST to the same daemon window, which holds
 * the bearer check, the per-name in-flight slot and the argv control. Desk
 * spawns nothing.
 */

const { readBridgeToken } = require("./bridge-server.cjs");

/** Same gate the daemon applies before any path join or argv build. */
const WAKE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MUTATE_VERBS = new Set(["enable", "disable", "run"]);

/** Read timeout for the list poll, and for a mutation. `run` gets its own. */
const READ_TIMEOUT_MS = 3000;
const MUTATE_TIMEOUT_MS = 8000;
/** `run` asks the daemon to wait this long, then answers 202 with the pid. The
 *  client timeout must OUTLIVE that wait or a healthy run reads as a timeout. */
const RUN_WAIT_S = 15;
const RUN_TIMEOUT_MS = 20000;

/** The harness daemon on loopback — the same address steerback/awsh use. */
function defaultDaemonBase(env = process.env) {
  const host = String(env.AITHER_HARNESS_HOST || "").trim() || "127.0.0.1";
  const port = String(env.AITHER_HARNESS_PORT || "").trim() || "8362";
  return `http://${host}:${port}`;
}

function emptyFeed(extra = {}) {
  return {
    source: "daemon",
    installed: null,
    schema: null,
    migration: null,
    wakes: [],
    count: 0,
    failing: 0,
    disabled: 0,
    running: 0,
    last_tick_at: null,
    clock_stale: false,
    stale_since: null,
    error: null,
    ...extra,
  };
}

/**
 * The last good snapshot, re-tagged. `stale_since` is set ONCE, on the first
 * failure, and carried across every later failure — the chip must say "down
 * for 40 minutes", not "down for 30 seconds" forever.
 */
function staleFeed(previous, nowMs, error) {
  if (previous && Array.isArray(previous.wakes) && previous.source === "daemon") {
    return { ...previous, source: "stale", stale_since: nowMs, error };
  }
  if (previous && Array.isArray(previous.wakes) && previous.source === "stale") {
    return { ...previous, source: "stale", stale_since: previous.stale_since ?? nowMs, error };
  }
  return emptyFeed({ source: "stale", stale_since: nowMs, error });
}

function shapeWake(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = typeof raw.name === "string" ? raw.name : "";
  if (!name) return null;
  return {
    name,
    enabled: raw.enabled !== false,
    every: typeof raw.every === "string" ? raw.every : "",
    intervalS: Number.isFinite(Number(raw.interval_s)) ? Number(raw.interval_s) : null,
    run: typeof raw.run === "string" ? raw.run : "",
    at: typeof raw.at === "string" ? raw.at : null,
    lastState: typeof raw.last_state === "string" ? raw.last_state : "",
    // The REASON is the whole point of a failure row: "failure" alone sends the
    // owner to a terminal, "failure — exit 1" does not.
    lastReason: typeof raw.last_reason === "string" ? raw.last_reason : "",
    lastStartedAt: typeof raw.last_started_at === "string" ? raw.last_started_at : null,
    lastFinishedAt: typeof raw.last_finished_at === "string" ? raw.last_finished_at : null,
    lastWakeId: typeof raw.last_wake_id === "string" ? raw.last_wake_id : null,
    consecutiveFailures: Number(raw.consecutive_failures) || 0,
    running: raw.running === true,
    runningSince: typeof raw.running_since === "string" ? raw.running_since : null,
    nextDueAt: typeof raw.next_due_at === "string" ? raw.next_due_at : null,
    cardId:
      raw.report && typeof raw.report === "object" && typeof raw.report.card_id === "string"
        ? raw.report.card_id
        : "",
    error: typeof raw.error === "string" ? raw.error : "",
  };
}

function shapeSnapshot(payload, nowMs) {
  const wakes = Array.isArray(payload?.wakes)
    ? payload.wakes.map(shapeWake).filter(Boolean)
    : [];
  return {
    source: "daemon",
    installed: typeof payload?.installed === "boolean" ? payload.installed : null,
    schema: Number.isFinite(Number(payload?.schema)) ? Number(payload.schema) : null,
    migration: typeof payload?.migration === "string" ? payload.migration : null,
    wakes,
    count: Number(payload?.count) || wakes.length,
    failing: Number(payload?.failing) || 0,
    disabled: Number(payload?.disabled) || 0,
    running: Number(payload?.running) || 0,
    // Clock liveness rides on EVERY list answer: a green job list with no ticks
    // is the #1 failure awrise names ("enabled routines with no runner"), and a
    // surface that renders rows without it reads as healthy when it is dead.
    last_tick_at: typeof payload?.last_tick_at === "string" ? payload.last_tick_at : null,
    clock_stale: payload?.clock_stale === true,
    stale_since: null,
    error: typeof payload?.error === "string" ? payload.error : null,
    fetched_at: nowMs,
  };
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * GET /wakes from the harness daemon.
 *
 * A token problem is NEVER degraded to "stale": a bad bearer would otherwise
 * show a cached list forever while nothing behind it is true. It answers with
 * an empty list and names the credential, so the cockpit says what to fix.
 */
async function fetchWakes({
  fetchFn = globalThis.fetch,
  daemonBase = defaultDaemonBase(),
  token = readBridgeToken(),
  previous = null,
  nowMs = Date.now(),
  timeoutMs = READ_TIMEOUT_MS,
} = {}) {
  if (!token) {
    return emptyFeed({ installed: null, error: "no harness token", fetched_at: nowMs });
  }
  let response;
  try {
    response = await fetchFn(`${daemonBase}/wakes`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return staleFeed(previous, nowMs, "daemon unreachable");
  }
  const status = Number(response?.status) || 0;
  if (status === 401 || status === 403) {
    return emptyFeed({ error: "token rejected", fetched_at: nowMs });
  }
  if (status === 404) {
    // The daemon is UP but has no /wakes window: an older harness process that
    // has not been restarted onto this code. That is a fact, not an outage —
    // a stale snapshot here would hide the one thing worth saying.
    return emptyFeed({ error: "daemon has no /wakes window (restart the harness daemon)", fetched_at: nowMs });
  }
  if (status < 200 || status >= 300) {
    return emptyFeed({ error: `daemon HTTP ${status}`, fetched_at: nowMs });
  }
  const payload = await readJson(response);
  if (!payload || typeof payload !== "object") {
    return emptyFeed({ error: "daemon answered unreadable JSON", fetched_at: nowMs });
  }
  return shapeSnapshot(payload, nowMs);
}

/**
 * Enable / disable / run one wake THROUGH the daemon. `run` asks the daemon to
 * hold the request 15 s and answers 202 with the pid when the wake outlives
 * that — the child is never killed, and the outcome is read from the list.
 */
async function mutate({
  fetchFn = globalThis.fetch,
  daemonBase = defaultDaemonBase(),
  token = readBridgeToken(),
  name,
  verb,
} = {}) {
  if (!MUTATE_VERBS.has(verb)) throw new TypeError(`unknown wake verb: ${verb}`);
  if (typeof name !== "string" || !WAKE_NAME_RE.test(name)) {
    return { ok: false, status: 400, detail: "invalid wake name", exitCode: null, started: false, pid: null, stderrTail: "" };
  }
  if (!token) {
    return { ok: false, status: 0, detail: "no harness token", exitCode: null, started: false, pid: null, stderrTail: "" };
  }
  const query = verb === "run" ? `?wait_s=${RUN_WAIT_S}` : "";
  const url = `${daemonBase}/wakes/${encodeURIComponent(name)}/${verb}${query}`;
  let response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      // No `origin` claim: the desk is an owner-local surface with no platform
      // identity, so the daemon's bearer + entitlement decide. Sending a
      // platform id here would be a claim the daemon would have to trust.
      body: JSON.stringify({ note: "desk" }),
      signal: AbortSignal.timeout(verb === "run" ? RUN_TIMEOUT_MS : MUTATE_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, status: 0, detail: "daemon unreachable", exitCode: null, started: false, pid: null, stderrTail: "" };
  }
  const status = Number(response?.status) || 0;
  const payload = await readJson(response);
  const detailObj = payload && typeof payload.detail === "object" ? payload.detail : null;
  if (status === 202) {
    return {
      ok: true,
      status,
      started: true,
      pid: Number(payload?.pid) || null,
      exitCode: null,
      stderrTail: "",
      detail: "started — outcome in the list",
    };
  }
  if (status >= 200 && status < 300) {
    return {
      ok: true,
      status,
      started: false,
      pid: Number(payload?.pid) || null,
      exitCode: Number.isFinite(Number(payload?.exit_code)) ? Number(payload.exit_code) : null,
      stderrTail: typeof payload?.stderr_tail === "string" ? payload.stderr_tail : "",
      detail: typeof payload?.stdout_tail === "string" && payload.stdout_tail ? payload.stdout_tail : "ok",
    };
  }
  if (status === 401) {
    return { ok: false, status, detail: "no harness token", exitCode: null, started: false, pid: null, stderrTail: "" };
  }
  if (status === 403) {
    return { ok: false, status, detail: "token rejected", exitCode: null, started: false, pid: null, stderrTail: "" };
  }
  if (status === 409) {
    return {
      ok: false,
      status,
      detail: "already running",
      pid: Number(detailObj?.pid) || null,
      exitCode: null,
      started: false,
      stderrTail: "",
    };
  }
  if (status === 503) {
    return { ok: false, status, detail: "awrise not installed", exitCode: null, started: false, pid: null, stderrTail: "" };
  }
  const detail = detailObj
    ? String(detailObj.error || `daemon HTTP ${status}`)
    : typeof payload?.detail === "string"
      ? payload.detail
      : `daemon HTTP ${status}`;
  return {
    ok: false,
    status,
    detail,
    exitCode: Number.isFinite(Number(detailObj?.exit_code)) ? Number(detailObj.exit_code) : null,
    started: false,
    pid: null,
    stderrTail: typeof detailObj?.stderr_tail === "string" ? detailObj.stderr_tail : "",
  };
}

/**
 * What "changed" means for a push. `fetched_at` is excluded so a stable list
 * does not re-render every 30 s; `source`/`stale_since`/`error` are INCLUDED so
 * the chip flips the moment the daemon goes away or comes back.
 */
function feedSignature(feed) {
  if (!feed) return "none";
  try {
    return JSON.stringify(feed, (key, value) => (key === "fetched_at" ? undefined : value));
  } catch {
    return "unserializable";
  }
}

/**
 * Poll /wakes; call onChange(feed) on start and whenever the signature moves.
 * Injectable fetch + timers. Returns a stop function.
 */
function watch({
  intervalMs = 30000,
  onChange,
  fetchFn = globalThis.fetch,
  daemonBase = defaultDaemonBase(),
  token = null,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  nowFn = Date.now,
} = {}) {
  if (typeof onChange !== "function") throw new TypeError("watch requires onChange");
  let lastSig = null;
  let previous = null;
  let stopped = false;
  const poll = async () => {
    const feed = await fetchWakes({
      fetchFn,
      daemonBase,
      token: token ?? readBridgeToken(),
      previous,
      nowMs: nowFn(),
    });
    if (stopped) return;
    previous = feed;
    const sig = feedSignature(feed);
    if (sig === lastSig) return;
    lastSig = sig;
    try {
      onChange(feed);
    } catch {
      /* a bad consumer must not kill the watcher */
    }
  };
  const started = poll();
  // The interval callback RETURNS the poll promise so a test can await one
  // tick deterministically; the .catch keeps a rejected poll from becoming an
  // unhandled rejection in the app.
  const handle = setIntervalFn(() => poll().catch(() => {}), intervalMs);
  return {
    stop: () => {
      stopped = true;
      clearIntervalFn(handle);
    },
    /** Test hook: the first poll's promise, so an arm can await the first push. */
    firstPoll: started,
  };
}

module.exports = {
  WAKE_NAME_RE,
  MUTATE_VERBS,
  RUN_WAIT_S,
  defaultDaemonBase,
  emptyFeed,
  fetchWakes,
  feedSignature,
  mutate,
  watch,
};
