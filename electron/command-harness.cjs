"use strict";

/**
 * command-harness.cjs — the Command window's `harness` backend: the owner's
 * sentence becomes ONE session on the awdk harness daemon (loopback :8362)
 * instead of a `claude -p` spawn, so the pane reaches every sovereign agent and
 * every skill the daemon already serves.
 *
 *   @saga /skill teaser-video make a 20 s teaser for the blog
 *   ^agent      ^skill          ^prompt
 *
 * Opt-in: AWDESK_COMMAND_BACKEND=harness (command-window.cjs installs it on the
 * shared CommandAgent). The default stays `claude` until the parity test is
 * green — owner decision 5 in the daily-driver plan.
 *
 * Failure is RENDERED, never fatal: daemon down -> "daemon unreachable (start
 * it: adk harness serve)"; unknown agent -> the daemon's 400 with the roster;
 * no token -> the token path. The token never leaves the machine.
 */

const { harnessToken, DAEMON } = require("./sessions-client.cjs");

const DEFAULT_HARNESS = () => process.env.AWDESK_COMMAND_HARNESS || "awdk";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 min, the same lane budget as claude -p
const POLL_MS = 300;

/** The daemon-side rule the pane always adds, AROUND whatever cast.json says. */
const BUILTIN_APPEND =
  "You are dispatched from the awdesk Command window by the owner. " +
  "Finish without asking questions unless you raise a decision card via the awdk " +
  "decisions daemon (http://127.0.0.1:8362). End with a 3-line summary of what was done.";

/**
 * "@agent /skill name args… prompt" -> { agent, skill, skillArguments, prompt }.
 * Only a LEADING @agent and /skill are addresses; an @ or / later in the sentence
 * is text. `/skill` takes ONE name; the rest of the line is the prompt, which the
 * daemon also hands to the skill as $ARGUMENTS.
 */
function parseAddress(text) {
  let rest = String(text || "").trim();
  let agent = "";
  let skill = "";
  for (;;) {
    let m = /^@([A-Za-z0-9_-]+)\s*/.exec(rest);
    if (m && !agent) { agent = m[1].toLowerCase(); rest = rest.slice(m[0].length); continue; }
    m = /^\/skill\s+([A-Za-z0-9_.:-]+)\s*/.exec(rest);
    if (m && !skill) { skill = m[1]; rest = rest.slice(m[0].length); continue; }
    break;
  }
  return { agent, skill, skillArguments: skill ? rest : "", prompt: rest };
}

/** The daemon's error text, whatever shape the body took. */
async function detailOf(res) {
  try {
    const body = await res.json();
    return (body && (body.detail || body.error)) || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

function unreachable(error) {
  const msg = (error && error.message) || String(error);
  const cause = error && error.cause && error.cause.code ? ` (${error.cause.code})` : "";
  return `daemon unreachable${cause} — start it: adk harness serve — ${msg}`;
}

/**
 * Run one owner command as a daemon session. `emit(payload)` receives the same
 * `{ text, phase }` progress rows the claude lane emits (the caller adds `id`).
 * Resolves `{ ok, reply, kind: "agent", verdict, session }`; never rejects on a
 * daemon failure — the reply says what happened.
 */
async function runHarnessCommand(text, {
  emit = () => {},
  fetchImpl = globalThis.fetch,
  daemon = process.env.AITHER_HARNESS_URL || DAEMON,
  token = undefined,
  cwd = process.env.AWDESK_COMMAND_CWD || "C:\\AitherOS-Fresh",
  harness = DEFAULT_HARNESS(),
  systemPromptAppend = BUILTIN_APPEND,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = POLL_MS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const bearer = token === undefined ? harnessToken() : token;
  const failed = (reply, extra = {}) => ({
    ok: false, reply, kind: "agent", verdict: { ok: false, error: reply }, session: null, ...extra,
  });
  if (!bearer) {
    return failed("no harness token (~/.aither/harness_token) — the daemon never ran here? start it: adk harness serve");
  }
  const addr = parseAddress(text);
  if (!addr.prompt) return failed("nothing to run — type a sentence after the @agent / skill address");

  const headers = { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" };
  const body = {
    harness,
    cwd,
    title: `desk: ${String(text).slice(0, 60)}`,
    owner: "desk",
    system_prompt_append: systemPromptAppend,
  };
  if (addr.agent) body.agent = addr.agent;
  if (addr.skill) { body.skill = addr.skill; body.skill_arguments = addr.skillArguments; }

  emit({
    text: `[backend] harness ${harness}${addr.agent ? ` @${addr.agent}` : ""}${addr.skill ? ` /skill ${addr.skill}` : ""}`,
    phase: "run",
  });

  let created;
  try {
    const res = await fetchImpl(`${daemon}/sessions`, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) return failed(`daemon refused the session (${res.status}): ${await detailOf(res)}`);
    created = await res.json();
  } catch (error) {
    return failed(unreachable(error));
  }
  const sessionId = created && created.id;
  if (!sessionId) return failed("daemon created no session id");
  emit({ text: `[session] ${harness}/${addr.agent || "default"} ${sessionId}`, phase: "run", session: sessionId });

  try {
    const res = await fetchImpl(`${daemon}/sessions/${sessionId}/submit`, {
      method: "POST", headers, body: JSON.stringify({ text: addr.prompt, submit: true }),
    });
    if (!res.ok) return failed(`daemon refused the turn (${res.status}): ${await detailOf(res)}`, { session: sessionId });
  } catch (error) {
    return failed(unreachable(error), { session: sessionId });
  }

  // Poll the event log (resumable by seq) until the turn completes or the
  // session exits. Text deltas are the reply; tool calls are progress rows.
  let cursor = 0;
  let reply = "";
  const errors = [];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() > deadline) {
      errors.push(`timed out after ${Math.round(timeoutMs / 60000)} min`);
      break;
    }
    let page;
    try {
      const res = await fetchImpl(`${daemon}/sessions/${sessionId}/events?since=${cursor}`, { headers });
      if (!res.ok) { errors.push(`events ${res.status}: ${await detailOf(res)}`); break; }
      page = await res.json();
    } catch (error) {
      errors.push(unreachable(error));
      break;
    }
    let done = false;
    for (const ev of page.events || []) {
      cursor = ev.seq;
      switch (ev.kind) {
        case "text.delta":
          reply += ev.text || "";
          emit({ text: ev.text || "", phase: "run" });
          break;
        case "thinking.delta":
          break;
        case "tool.call":
          emit({ text: `[tool] ${ev.tool || "?"}`, phase: "run" });
          break;
        case "tool.result":
          if (ev.data && ev.data.is_error) emit({ text: `[tool] ${ev.tool || "?"} failed`, phase: "run" });
          break;
        case "error":
          errors.push(ev.text || "error");
          emit({ text: `[error] ${ev.text || "error"}`, phase: "run" });
          break;
        case "turn.completed":
        case "session.exited":
          done = true;
          break;
        default:
          break;
      }
      if (done) break;
    }
    if (done || page.state === "exited" || page.state === "failed") break;
    await sleep(pollMs);
  }

  const ok = errors.length === 0 && reply.trim().length > 0;
  const error = errors.length ? errors.join("; ") : (ok ? null : "the session answered nothing");
  return {
    ok,
    reply: reply.trim() || error,
    kind: "agent",
    verdict: { ok, error },
    session: sessionId,
  };
}

/**
 * Route a CommandAgent's agent lane through the daemon. Installed by
 * command-window.cjs when AWDESK_COMMAND_BACKEND=harness; the fleet lane,
 * queueing, transcript and relay ack stay exactly as they are.
 */
function installHarnessBackend(agent, options = {}) {
  agent._handleAgentCommand = async function handleAgentCommand(id, text) {
    const result = await runHarnessCommand(text, {
      ...options,
      emit: (payload) => this.emit("progress", { id, ...payload }),
    });
    return { id, ...result };
  };
  agent.commandBackend = "harness";
  return agent;
}

module.exports = { parseAddress, runHarnessCommand, installHarnessBackend, BUILTIN_APPEND, DEFAULT_HARNESS };
