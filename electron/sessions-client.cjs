"use strict";

/**
 * sessions-client.cjs — the Sessions pane's backend: the awdk harness daemon's
 * unified session directory (loopback :8362), read-only.
 *
 * WHY (2026-09-12, owner: "a proper interactive awsh/aithershell"): the daemon
 * already merges daemon-owned sessions with DISCOVERED interactive Claude Code
 * tabs (pid + start-time, so no cooperation is needed from the tab), and every
 * row carries its honest steer_capability. Slice 1 of COCKPIT-DESIGN.md is
 * read-only — "stop tab-cycling to check on things" — and this pane IS that
 * view: list + live tail, saying what it cannot do instead of pretending.
 *
 * Auth: Bearer from AITHER_HARNESS_TOKEN or ~/.aither/harness_token (the same
 * resolution order harness-client.ts documents). The token never leaves the
 * main process — the pane's frame only ever sees session rows and file tails.
 *
 * Failure is a RENDERED STATE: daemon down / no token -> { ok:false, note }
 * with the reason — never a thrown error, and never a fabricated empty list.
 * "Could not look" and "nothing is running" must not read the same.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DAEMON = process.env.AITHER_HARNESS_URL || "http://127.0.0.1:8362";

function harnessToken() {
  if (process.env.AITHER_HARNESS_TOKEN) return process.env.AITHER_HARNESS_TOKEN.trim();
  try {
    return fs.readFileSync(path.join(os.homedir(), ".aither", "harness_token"), "utf8").trim();
  } catch {
    return "";
  }
}

async function listSessions({ fetchImpl = globalThis.fetch, timeoutMs = 6000 } = {}) {
  const token = harnessToken();
  if (!token) {
    return { ok: false, sessions: [], note: "no harness token (~/.aither/harness_token) — daemon never ran here?" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${DAEMON}/sessions/unified`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, sessions: [], note: `daemon refused the token (${res.status}) — restart it: adk harness serve` };
    }
    if (!res.ok) return { ok: false, sessions: [], note: `daemon answered ${res.status}` };
    const body = await res.json();
    const sessions = Array.isArray(body.sessions) ? body.sessions : [];
    return { ok: true, sessions, note: `${sessions.length} session(s)` };
  } catch (error) {
    const why = error && error.name === "AbortError"
      ? `daemon did not answer within ${Math.round(timeoutMs / 1000)}s`
      : "daemon unreachable (start it: adk harness serve)";
    return { ok: false, sessions: [], note: why };
  } finally {
    clearTimeout(timer);
  }
}

/** The last `maxLines` lines of a transcript, capped by BYTES so a huge JSONL
 *  cannot stall the pane, and read from the END — a tail is all this view
 *  shows, and reading a 200 MB file to print its last page is how a live view
 *  becomes the slowest pane in the window. */
function tailTranscript(transcriptPath, { maxLines = 60, maxBytes = 512 * 1024 } = {}) {
  const p = String(transcriptPath || "");
  if (!p) return { ok: false, lines: [], note: "session has no transcript_path" };
  let fd = null;
  try {
    const size = fs.statSync(p).size;
    const start = Math.max(0, size - maxBytes);
    fd = fs.openSync(p, "r");
    const len = size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    let text = buf.toString("utf8");
    // A byte-window can open mid-multibyte or mid-line; drop the partial first line.
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    const lines = text.split("\n").filter((l) => l.trim());
    return {
      ok: true,
      lines: lines.slice(-maxLines),
      truncated: start > 0 || lines.length > maxLines,
      note: "",
    };
  } catch (error) {
    return { ok: false, lines: [], note: `cannot read transcript: ${(error && error.message) || error}` };
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

const STATUS_ORDER = { working: 0, "waiting-input": 1, idle: 2 };

function clip(text, n) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * A short, prompt-sized brief of the owner's live sessions for the Command
 * agent (owner, 2026-09-22: "have context of all of my active sessions and
 * work"). Working sessions first. "Could not look" is said as such -- never an
 * empty list, which would read as "nothing is running".
 */
function sessionsBrief(result, { max = 15 } = {}) {
  if (!result || !result.ok) {
    return `The owner's active sessions: unknown right now (${(result && result.note) || "no answer"}).`;
  }
  const rows = [...result.sessions].sort(
    (a, b) => (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3),
  );
  if (!rows.length) return "The owner has no active agent sessions right now.";
  const lines = rows.slice(0, max).map((s) => {
    const summary = s.last_activity_summary ? ` -- ${clip(s.last_activity_summary, 90)}` : "";
    return `- [${s.status || "?"}] ${s.harness || "?"} ${String(s.id || "").slice(0, 12)}: ${clip(s.title, 70)}${summary}`;
  });
  const more = rows.length > max ? `\n(+${rows.length - max} more)` : "";
  return (
    `The owner's active agent sessions right now (${rows.length}), from the harness daemon:\n` +
    `${lines.join("\n")}${more}\n` +
    "When the owner asks about ongoing work, answer from these; to message or steer one, " +
    "use the awsh MCP tools (awsh_send / awsh_say) with its id."
  );
}

module.exports = { listSessions, tailTranscript, harnessToken, sessionsBrief, DAEMON };
