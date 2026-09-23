"use strict";

/**
 * command-agent.cjs — the Command window's backend: ONE implementation of
 * "owner types a sentence, an agent does the work" in awdesk, shared with the
 * bridge and MCP desk_command tool.
 *
 * Routing: fleet verbs (fleet down|up, gpu quiet|resume, etc.) go to the shared
 * FleetControl; everything else spawns "claude" headless and streams the result
 * via stream-json, serializing requests (one at a time, queue the rest).
 *
 * History lives in %USERPROFILE%\.aither\desk-command.jsonl (survives fleet down)
 * and is mirrored best-effort to awrelay.
 */

const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { summarize: summarizeFleet, classify: classifyFleet, DESTRUCTIVE: DESTRUCTIVE_FLEET } = require("./fleet-control.cjs");
// One spelling of the mirror channel, shared with the poller that reads it. A
// second literal here is how a rename leaves the desk writing to a channel
// nothing polls. relay-poller requires only node builtins, so this is not a cycle.
const { MIRROR_CHANNEL } = require("./relay-poller.cjs");
const { BackendResolver } = require("./backend-profile.cjs");

const DEFAULT_CLAUDE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
const RELAY_TIMEOUT_MS = 10 * 1000; // 10 s

/** Fleet verbs that can be classified from text. */
const FLEET_VERBS = Object.freeze({
  "fleet down": "down",
  "fleet up": "up",
  "fleet status": "status",
  "fleet quiesce": "quiesce",
  "fleet resume": "resume",
  "shut the fleet down": "down",
  "bring the fleet up": "up",
  "gpu quiet": "gaming",
  "game on": "gaming",
  "gpu resume": "resume",
  "game off": "resume",
  // ARC command and control (owner, 2026-09-19). Longer phrases first: the
  // classifier matches by inclusion, so "arc run now" must be seen before "arc".
  "arc run now": "arc-now",
  "run arc now": "arc-now",
  "arc now": "arc-now",
  "arc status": "arc-status",
  "is arc running": "arc-status",
  "arc stop": "arc-stop",
  "stop arc": "arc-stop",
  "arc start": "arc-start",
  "start arc": "arc-start",
});

/** What the owner reads back. `gaming` is the script's name for "gpu quiet";
 *  a reply headed "Fleet gaming" answered a verb nobody typed (2026-09-21). */
const FLEET_LABELS = Object.freeze({
  status: "Fleet status",
  down: "Fleet down",
  up: "Fleet up",
  quiesce: "Fleet quiesce",
  resume: "GPU resume",
  gaming: "GPU quiet",
  adopt: "Fleet adopt",
  "arc-status": "ARC status",
  "arc-start": "ARC start",
  "arc-now": "ARC run now",
  "arc-stop": "ARC stop",
});

/** What a DESTRUCTIVE verb will do, said before it does it. */
const FLEET_CONSEQUENCE = Object.freeze({
  gaming: "stops every LLM/GPU container and holds them down until GPU resume",
  quiesce: "stops the LLM containers and holds them down until fleet resume",
  down: "stops the WHOLE fleet (every container) and holds it down until fleet up",
  "arc-stop": "stops the ARC solver (the world model stays up)",
});

/** The one word that confirms an ARMED destructive verb. Exact match only —
 *  a sentence containing "yes" is a sentence, not a confirmation. */
const CONFIRM_WORDS = new Set(["confirm", "yes", "y", "do it", "go"]);
const CONFIRM_TTL_MS = 2 * 60 * 1000;

function transcriptPath() {
  return path.join(os.homedir(), ".aither", "desk-command.jsonl");
}

/** Resolve a CLI to an absolute path Electron can spawn WITHOUT a shell.
 *  On Windows `claude` and `awrelay` are npm/pip `.cmd` shims; `spawn("claude")`
 *  answers ENOENT (measured 2026-09-08: every agent command in the first build
 *  died with "spawn claude ENOENT" while `claude` worked in every terminal).
 *  Same recipe as decision-cards.cjs's awaskBin(): `where.exe`, prefer the .cmd,
 *  memoise, env override first. Falls back to the bare name so a later PATH fix
 *  still works. */
const _binCache = new Map();
/** Harness warnings that describe the host's auth/backend setup, not the answer.
 *  Owner screenshots 2026-09-22: every Aither Command reply was preceded by
 *  "[stderr] claude.ai connectors are disabled ..." and
 *  "[claude-code:unrecognized_model] {...}". They print on EVERY non-Anthropic
 *  backend and cannot be prevented from here, only kept out of the chat and out
 *  of the failure text. Anything not matched is still shown as [stderr]. */
const CLI_NOISE = Object.freeze([
  /claude\.ai connectors are disabled/i,
  /\[claude-code:unrecognized_model\]/i,
]);

function isCliNoise(line) {
  return CLI_NOISE.some((re) => re.test(String(line || "")));
}

function resolveBin(name, envVar) {
  const override = envVar && process.env[envVar];
  if (override) return override;
  if (_binCache.has(name)) return _binCache.get(name);
  let found = name;
  try {
    const { execFileSync } = require("node:child_process");
    const out = process.platform === "win32"
      ? execFileSync("where.exe", [name], { encoding: "utf8", windowsHide: true })
      : execFileSync("which", [name], { encoding: "utf8" });
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length) {
      found = process.platform === "win32"
        ? (lines.find((l) => /\.exe$/i.test(l)) || lines.find((l) => /\.cmd$/i.test(l)) || lines[0])
        : lines[0];
    }
    // Node >= 20.12 refuses to spawn a .cmd/.bat without a shell (EINVAL, the
    // BatBadBut fix), and a shell would re-parse the prompt text. npm's shim
    // is one line: "%dp0%\node_modules\...\bin\claude.exe" %* -- follow it to
    // the real executable and spawn THAT.
    if (/\.cmd$/i.test(found)) {
      const target = exeFromCmdShim(found);
      if (target) found = target;
    }
  } catch {
    /* not on PATH from this process: keep the bare name */
  }
  _binCache.set(name, found);
  return found;
}

/** Pure: the .exe an npm .cmd shim launches, or null. Exported for the test. */
function exeFromCmdShim(cmdPath, text = null) {
  try {
    const body = text ?? fs.readFileSync(cmdPath, "utf8");
    const m = /"%dp0%\\([^"]+\.exe)"/i.exec(body) || /"(%~dp0)\\([^"]+\.exe)"/i.exec(body);
    if (!m) return null;
    const rel = m[m.length - 1];
    const candidate = path.join(path.dirname(cmdPath), rel);
    return text != null || fs.existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function ensureTranscriptDir() {
  const dir = path.dirname(transcriptPath());
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Classify a text command into fleet verb or agent.
 * @returns {{ kind: "fleet", action: string } | { kind: "agent" }}
 */
function classifyCommand(text) {
  const normalized = String(text ?? "").toLowerCase().trim().replace(/\s+/g, " ");
  // A bare confirmation word is its own kind: it means something only while a
  // destructive verb is armed, and it must never reach the claude lane (where
  // "yes" would spawn a 30-minute agent to answer a question nobody asked).
  if (CONFIRM_WORDS.has(normalized)) return { kind: "confirm" };
  for (const [key, action] of Object.entries(FLEET_VERBS)) {
    if (normalized === key || normalized.includes(key)) {
      return { kind: "fleet", action };
    }
  }
  return { kind: "agent" };
}

/** The live-sessions brief every agent prompt carries (sessions-client.cjs). */
async function defaultSessionsContext() {
  const { listSessions, sessionsBrief } = require("./sessions-client.cjs");
  return sessionsBrief(await listSessions({ timeoutMs: 3000 }));
}

class CommandAgent extends EventEmitter {
  constructor({ fleetControl = null, spawnImpl = spawn, claudePath = null, relayPath = null,
    transcriptFile = null, backendResolver = undefined, sessionsContext = undefined } = {}) {
    super();
    this._backendResolver = backendResolver;
    // What the owner's other sessions are doing, added to every agent prompt.
    // Only the REAL spawn reads the live daemon by default: a test with a fake
    // spawn must never make a network call it did not ask for.
    this.sessionsContext = sessionsContext !== undefined
      ? sessionsContext
      : (spawnImpl === spawn ? defaultSessionsContext : null);
    this.fleetControl = fleetControl;
    this.spawnImpl = spawnImpl;
    // Injectable: the first test suite wrote to the OWNER's real transcript, so
    // "test / cmd1 / cmd2 / no output" showed up in the Command window's history.
    this.transcriptFile = transcriptFile || transcriptPath();
    // Resolved lazily so tests with a fake spawn never shell out to where.exe.
    this._claudePath = claudePath;
    this._relayPath = relayPath;
    this.queue = [];
    this.current = null; // { id, text, startedAt } -- the claude lane only
    this.children = new Map(); // id -> child process
    // A destructive fleet verb the owner typed, waiting for its one-word
    // confirmation: { action, text, source, at }. Cleared by any other command.
    this.pendingConfirm = null;
  }

  get queueLength() {
    return this.queue.length;
  }

  get claudePath() {
    // A fake spawn (tests) sees the bare name; only the real spawn needs where.exe.
    if (!this._claudePath) {
      this._claudePath = this.spawnImpl === spawn ? resolveBin("claude", "AWDESK_CLAUDE_BIN") : "claude";
    }
    return this._claudePath;
  }

  get relayPath() {
    if (!this._relayPath) {
      this._relayPath = this.spawnImpl === spawn ? resolveBin("awrelay", "AWDESK_AWRELAY_BIN") : "awrelay";
    }
    return this._relayPath;
  }

  get backend() {
    // A fake spawn (tests) gets NO resolver: tests must never shell out to pwsh,
    // and the pre-fix behaviour (inherit the desk's env) is what several of them
    // assert against. Same laziness rule as claudePath/relayPath above.
    if (this._backendResolver === undefined) {
      this._backendResolver = this.spawnImpl === spawn ? new BackendResolver() : null;
    }
    return this._backendResolver;
  }

  /**
   * Run a command (text). Returns { ok, id, reply, kind, verdict? }
   * @param {string} text - the command text
   * @param {{ source: string }} opts - metadata (e.g. { source: "command-window" })
   * @returns {Promise<{ ok: boolean, id: string, reply: string, kind: "fleet"|"agent", verdict?: object }>}
   */
  async run(text, { source = "unknown" } = {}) {
    ensureTranscriptDir();
    const id = randomUUID();
    const request = { id, timestamp: new Date().toISOString(), source, text, kind: null, verdict: null };

    const classify = classifyCommand(text);
    request.kind = classify.kind;

    // Record request immediately.
    this._appendTranscript(request);
    this.emit("request", { id, text, source });

    // Fleet verbs (and the word that confirms one) never wait behind a claude
    // agent: FleetControl serialises itself and answers in seconds, while an
    // agent command can hold the lane for 30 minutes. Measured 2026-09-21:
    // "gpu quiet" sat silently behind a running probe for three minutes and the
    // owner read it as "no response". Different executor, different lane.
    if (classify.kind !== "agent") {
      return this._executeCommand(id, text, classify, source);
    }

    // Queue or run immediately if nothing is running.
    if (this.current) {
      this.queue.push({ id, text, classify, source });
      this.emit("queued", { id, queueLength: this.queue.length });
      // Say so where the owner is looking: a queued command that renders
      // nothing is indistinguishable from a dead window.
      this.emit("progress", {
        id,
        text: `queued behind "${String(this.current.text || "").slice(0, 80)}" — ${this.queue.length} waiting`,
        phase: "queued",
      });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          // If still in queue after 30 min, assume timeout.
          const idx = this.queue.findIndex((q) => q.id === id);
          if (idx >= 0) {
            this.queue.splice(idx, 1);
            reject(new Error(`command timeout (queued for 30 min)`));
          }
        }, DEFAULT_CLAUDE_TIMEOUT_MS);
        this.once(`done:${id}`, (result) => {
          clearTimeout(timer);
          resolve(result);
        });
      });
    }

    return this._executeCommand(id, text, classify, source);
  }

  async _executeCommand(id, text, classify, source) {
    // Only the claude lane owns `current` and the queue (see run()).
    const ownsLane = classify.kind === "agent";
    if (ownsLane) this.current = { id, text, startedAt: Date.now() };
    this.emit("progress", { id, text: `> ${classify.kind === "agent" ? "claude: " : "fleet: "}${text}`, phase: "start" });

    let outcome = null; // what the relay ack reports: the reply and whether it worked
    try {
      let result;
      if (classify.kind === "confirm") {
        result = await this._handleConfirm(id, text, source);
      } else if (classify.kind === "fleet") {
        result = await this._handleFleetCommand(id, text, classify.action, source);
      } else {
        // Anything that is not a confirmation cancels an armed verb.
        this.pendingConfirm = null;
        result = await this._handleAgentCommand(id, text, source);
      }

      // Record reply.
      this._appendTranscript({
        id,
        timestamp: new Date().toISOString(),
        kind: result.kind,
        reply: result.reply,
        verdict: result.verdict ?? null,
      });

      this.emit("progress", { id, text: result.reply, phase: "end", verdict: result.verdict });
      this.emit("complete", { id, ...result });
      outcome = { reply: result.reply, ok: result.ok !== false };

      return result;
    } catch (error) {
      const reply = error?.message || String(error);
      const verdict = { ok: false, error: reply };
      outcome = { reply, ok: false };
      this._appendTranscript({
        id,
        timestamp: new Date().toISOString(),
        kind: classify.kind,
        reply,
        verdict,
      });
      this.emit("progress", { id, text: `ERROR: ${reply}`, phase: "end", verdict });
      // NOT "error": an EventEmitter throws on an unlistened "error" event, which
      // turned this catch block into a crash of the owner's command (measured
      // 2026-09-08 by the ENOENT test). "failed" is observable, never fatal.
      this.emit("failed", { id, error });
      return { ok: false, id, reply, kind: classify.kind, verdict };
    } finally {
      if (ownsLane) this.current = null;
      // Relay best-effort (fire-and-forget): an [ack] with the reply, never the request.
      void this._relayRequest(text, classify.kind, { ...(outcome || { reply: "", ok: false }), source });
      // Process next in queue.
      const next = ownsLane ? this.queue.shift() : null;
      if (next) {
        this.emit("dequeued", { id: next.id, queueLength: this.queue.length });
        const result = await this._executeCommand(next.id, next.text, next.classify, next.source);
        this.emit(`done:${next.id}`, result);
      }
    }
  }

  async _handleFleetCommand(id, text, action, source = "unknown", { confirmed = false } = {}) {
    const label = FLEET_LABELS[action] || `Fleet ${action}`;
    if (!this.fleetControl) {
      return { ok: false, id, reply: `${label}: fleet control is not available in this desk`, kind: "fleet" };
    }

    // A DESTRUCTIVE verb is ARMED by the sentence and fired by a second,
    // exact-match word from the same surface — the chat equivalent of the
    // Fleet window's double-click. classifyCommand() matches by inclusion, so a
    // sentence that merely MENTIONS "fleet down" reads like the command
    // (security finding 2026-09-19); the second word is what makes it deliberate.
    // The relay never confirms: a peer agent's "yes" is not the owner's.
    if (DESTRUCTIVE_FLEET.has(action) && !confirmed) {
      if (/^relay:/.test(String(source || ""))) {
        this.pendingConfirm = null;
        return {
          ok: false, id, kind: "fleet",
          reply: `${label}: refused — a destructive verb cannot be confirmed from the relay; use the Fleet pane or the Command window.`,
          verdict: { ok: false, requiresConfirmation: true, action },
        };
      }
      this.pendingConfirm = { action, text, source, at: Date.now() };
      return {
        ok: true, id, kind: "fleet",
        reply: `${label} is armed — it ${FLEET_CONSEQUENCE[action] || "changes the fleet"}. `
          + `Type "confirm" within 2 minutes to do it; anything else cancels.`,
        verdict: { ok: true, armed: true, action },
      };
    }
    this.pendingConfirm = null;

    // The second argument is honoured by a FleetControl that gates on it and
    // ignored by one that does not.
    const verdict = await this.fleetControl.run(action, { confirm: true });
    // The reply IS the fleet's state, in the same words the Fleet window uses —
    // a bare "ok" answers nothing the owner asked, and a bare exit code
    // ("Fleet gaming: exit 4294967295", 2026-09-21) answers it in the wrong language.
    let reply;
    if (verdict.cannotJudge) {
      reply = `${label}: could not reach the fleet — ${verdict.error || "no verdict"}`;
    } else if (verdict.busy) {
      // A busy refusal has no counts; rendering it as a status read "UNKNOWN —
      // ? container(s)", which is a riddle, not an answer.
      reply = `${label}: the fleet is busy with "${verdict.busy}" — try again in a moment`;
    } else if (action === "status") {
      reply = `${classifyFleet(verdict)} — ${summarizeFleet(verdict)}`;
    } else if (verdict.requiresConfirmation) {
      reply = `${label}: refused — ${verdict.error || "needs confirmation"}`;
    } else if (verdict.ok) {
      const after = verdict.fleet_running_after != null
        ? ` — ${verdict.fleet_running_after} container(s) still running`
        : verdict.fleet_running != null ? ` — ${verdict.fleet_running} container(s) running` : "";
      reply = `${label}: done${after}`;
    } else {
      reply = `${label}: ${verdict.error || "refused"}`;
    }

    return {
      ok: verdict.ok,
      id,
      reply,
      kind: "fleet",
      verdict,
    };
  }

  /** The owner typed the confirmation word: fire the armed verb, or say there is none. */
  async _handleConfirm(id, text, source = "unknown") {
    const pending = this.pendingConfirm;
    this.pendingConfirm = null;
    if (!pending) {
      return { ok: false, id, kind: "fleet", reply: `Nothing is armed — type the verb first (e.g. "gpu quiet"), then "confirm".` };
    }
    const label = FLEET_LABELS[pending.action] || `Fleet ${pending.action}`;
    if (Date.now() - pending.at > CONFIRM_TTL_MS) {
      return { ok: false, id, kind: "fleet", reply: `${label}: the confirmation window (2 minutes) has passed — type "${pending.text}" again.` };
    }
    if (pending.source !== source || /^relay:/.test(String(source || ""))) {
      return { ok: false, id, kind: "fleet", reply: `${label}: refused — confirm from the same window that armed it.` };
    }
    return this._handleFleetCommand(id, pending.text, pending.action, source, { confirmed: true });
  }

  async _handleAgentCommand(id, text) {
    // The backend the owner is paying for, resolved BEFORE the spawn. Without
    // this the pane ran on the default Anthropic login and its whole history
    // answered "You've hit your weekly limit" (measured 2026-09-12). Failure is
    // rendered, never fatal: no resolver / no env -> inherit the desk's env,
    // exactly the pre-fix behaviour, with a visible note saying so.
    let backendEnv = {};
    const resolver = this.backend;
    if (resolver) {
      const resolved = await resolver.resolve();
      backendEnv = (resolved && resolved.env) || {};
      this.emit("progress", {
        id,
        text: backendEnv.ANTHROPIC_BASE_URL
          ? `[backend] ${resolved.profile} — ${backendEnv.ANTHROPIC_MODEL || "default model"}`
          : `[backend] ${(resolved && resolved.profile) || "default"} NOT resolved `
            + `(${(resolved && resolved.note) || "no detail"}) — using the desk's default login`,
        phase: "run",
      });
    }
    let sessionsNote = "";
    if (typeof this.sessionsContext === "function") {
      try {
        sessionsNote = String((await this.sessionsContext()) || "");
      } catch {
        sessionsNote = ""; // context is a help, never a reason to refuse the command
      }
    }
    return new Promise((resolve, reject) => {
      // The built-in is the floor and is never replaceable: cast.json's
      // prompts.commandPersona / commandAppend are added AROUND it (see
      // desk-settings.cjs), so a persona cannot delete the decision-card rule.
      const builtinPrompt =
        `You are dispatched from the awdesk Command window by the owner. ` +
        `You must finish without asking questions unless you raise a decision card via the awdk decisions daemon (http://127.0.0.1:8362). ` +
        `End with a 3-line summary of what was done.`;
      let systemPrompt;
      try {
        systemPrompt = require("./desk-settings.cjs").commandSystemPrompt(builtinPrompt);
      } catch {
        systemPrompt = builtinPrompt;
      }
      if (sessionsNote) systemPrompt = `${systemPrompt}\n\n${sessionsNote}`;

      const args = [
        "-p",
        text,
        "--output-format",
        "stream-json",
        "--verbose",
        "--append-system-prompt",
        systemPrompt,
      ];

      let child;
      try {
        child = this.spawnImpl(this.claudePath, args, {
          // Same override the harness backend honours (command-harness.cjs).
          cwd: process.env.AWDESK_COMMAND_CWD || "C:\\AitherOS-Fresh",
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          // The resolved profile rides the spawn env — never a settings.json
          // write, never a User-scope var: this process's children only.
          env: { ...process.env, ...backendEnv },
        });
      } catch (error) {
        return reject(new Error(`Failed to spawn claude: ${error?.message || String(error)}`));
      }

      this.children.set(id, child);
      let fullReply = "";
      let stderrTail = "";
      let stderrBuf = "";

      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        stderrTail += `\n[timeout after ${DEFAULT_CLAUDE_TIMEOUT_MS / 1000} s]`;
      }, DEFAULT_CLAUDE_TIMEOUT_MS);
      timer.unref?.();

      child.stdout?.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            // Claude Code's stream-json (measured 2026-09-08): whole `assistant`
            // messages carrying content blocks, then ONE `result` line whose
            // `result` is the final text. There are no content_block_delta events
            // at this layer — the first version listened for those and every
            // agent reply came back "no output".
            if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
              for (const block of obj.message.content) {
                if (block.type === "text" && block.text) {
                  this.emit("progress", { id, text: block.text, phase: "run" });
                } else if (block.type === "tool_use") {
                  this.emit("progress", { id, text: `[tool] ${block.name}`, phase: "run" });
                }
              }
            } else if (obj.type === "result") {
              if (typeof obj.result === "string" && obj.result) fullReply = obj.result;
              if (obj.is_error) stderrTail = (stderrTail + "\n" + (obj.result || "error")).slice(-2000);
            } else if (obj.type === "content_block_delta" && obj.delta?.type === "text_delta") {
              fullReply += obj.delta.text;
              this.emit("progress", { id, text: obj.delta.text, phase: "run" });
            }
          } catch {
            // not JSON, log as progress
            this.emit("progress", { id, text: line, phase: "run" });
          }
        }
      });

      child.stderr?.on("data", (chunk) => {
        stderrBuf += chunk.toString("utf8");
        const lines = stderrBuf.split(/\r?\n/);
        stderrBuf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim() || isCliNoise(line)) continue;
          stderrTail = (stderrTail + "\n" + line).slice(-2000);
          this.emit("progress", { id, text: `[stderr] ${line}`, phase: "run" });
        }
      });

      child.on("error", (error) => {
        clearTimeout(timer);
        this.children.delete(id);
        reject(new Error(`claude process error: ${error?.message || String(error)}`));
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        this.children.delete(id);
        if (stderrBuf.trim() && !isCliNoise(stderrBuf)) {
          stderrTail = (stderrTail + "\n" + stderrBuf).slice(-2000);
        }

        const verdict = {
          ok: code === 0,
          code,
          error: code === 0 ? null : (stderrTail.trim() || `exit ${code}`),
        };

        if (code !== 0) {
          // If claude failed, make that clear in the reply.
          if (!fullReply) fullReply = verdict.error || `exit ${code}`;
        }

        resolve({
          ok: code === 0,
          id,
          reply: fullReply || verdict.error || "no output",
          kind: "agent",
          verdict,
        });
      });
    });
  }

  /**
   * Mirror a FINISHED command to #command as an `[ack]` carrying the reply.
   *
   * It used to echo the REQUEST text as a `request`/`finding` envelope, which
   * is exactly what the relay poller (relay-poller.cjs) treats as a work order
   * — the desk would have re-executed its own echo every 20 s. An ack is what
   * the channel wants anyway: the request is already there when it came from
   * the relay, and when it came from the window the ack names it.
   *
   * A command that ARRIVED from the relay is not mirrored here: the poller
   * posts the ack as a thread reply under the message that asked.
   */
  async _relayRequest(text, kind, { reply = "", ok = true, source = "" } = {}) {
    try {
      if (/^relay:/.test(String(source || ""))) return { ok: true, skipped: "from-relay" };
      const head = ok === false ? "[ack] FAILED — " : "[ack] ";
      const body = `${head}${String(reply || (ok === false ? "failed" : "done")).trim()}`.slice(0, 1800)
        + `\n— re: ${String(text || "").slice(0, 200)}`;
      const args = [
        "send",
        MIRROR_CHANNEL,
        body,
        "--kind",
        "ack",
      ];

      return new Promise((resolve) => {
        let child;
        try {
          child = this.spawnImpl(this.relayPath, args, {
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            timeout: RELAY_TIMEOUT_MS,
          });
        } catch (error) {
          // A throwing spawn (ENOENT via a fake, a missing binary) must never
          // become an unhandled rejection on the owner's command.
          this.emit("progress", { text: `relay: unavailable (${error?.message || error})`, phase: "run" });
          resolve({ ok: false, reason: "spawn" });
          return;
        }

        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            /* already gone */
          }
          resolve({ ok: false, reason: "timeout" });
        }, RELAY_TIMEOUT_MS);

        // The mirror must report what the relay actually DID. This handler used to
        // resolve({ ok: true }) on any close code, so every ack "succeeded" —
        // including through the whole period #command did not exist, which is how
        // a channel that was never created read as a working mirror for a day. A
        // best-effort side channel is allowed to fail; it is not allowed to lie
        // about failing.
        let stderr = "";
        try {
          child.stderr?.on("data", (chunk) => {
            if (stderr.length < 2000) stderr += String(chunk);
          });
        } catch {
          /* a fake child with no streams is fine — the exit code is the verdict */
        }

        child.on("close", (code, signal) => {
          clearTimeout(timer);
          // A killed child reports code null WITH a signal — that is a failure,
          // not a pass. A test fake that emits close with no arguments at all
          // reports neither, and stays a pass so fixtures do not have to model
          // an exit status they are not testing.
          if (!signal && (code === 0 || code == null)) {
            resolve({ ok: true });
            return;
          }
          const why = stderr.trim().split("\n").filter(Boolean).slice(-1)[0] || "";
          const what = signal ? `killed by ${signal}` : `exit ${code}`;
          this.emit("progress", {
            text: `relay: ack NOT posted (awrelay ${what}${why ? ` — ${why.slice(0, 160)}` : ""})`,
            phase: "run",
          });
          resolve({ ok: false, reason: signal ? "signal" : "exit", code, signal, stderr: why });
        });

        child.on("error", () => {
          clearTimeout(timer);
          resolve({ ok: false, reason: "error" });
        });
      });
    } catch {
      // Never throw on relay failure — it's best-effort.
    }
  }

  _appendTranscript(record) {
    try {
      fs.mkdirSync(path.dirname(this.transcriptFile), { recursive: true });
      const line = JSON.stringify(record) + "\n";
      fs.appendFileSync(this.transcriptFile, line, "utf8");
    } catch {
      // Silently fail if transcript write fails — never break the main flow.
    }
  }

  /**
   * Read the last `limit` entries from the transcript.
   * @param {number} limit - max entries to return
   * @returns {Array<object>}
   */
  history(limit = 50) {
    try {
      if (!fs.existsSync(this.transcriptFile)) return [];
      const lines = fs
        .readFileSync(this.transcriptFile, "utf8")
        .split("\n")
        .filter((l) => l.trim());
      // The transcript is two rows per command (request, then reply). History is
      // ONE item per command — {id, at, source, text, reply, kind, verdict} — which
      // is the contract awsh /command, adk desk history and the bridge poll on.
      const byId = new Map();
      for (const line of lines) {
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        if (!row || !row.id) continue;
        const item = byId.get(row.id) || { id: row.id, at: null, source: null, text: null, reply: null, kind: null, verdict: null };
        if (row.text != null) {
          item.text = row.text;
          item.at = row.timestamp || item.at;
          item.source = row.source || item.source;
        }
        if (row.reply != null) {
          item.reply = row.reply;
          item.repliedAt = row.timestamp || null;
          item.verdict = row.verdict ?? item.verdict;
        }
        if (row.kind) item.kind = row.kind;
        byId.delete(row.id);
        byId.set(row.id, item); // re-insert: newest activity last
      }
      return Array.from(byId.values()).slice(-limit);
    } catch {
      return [];
    }
  }

  /** Kill all running commands (for shutdown). */
  killAll() {
    for (const child of this.children.values()) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
    this.children.clear();
  }
}

module.exports = {
  classifyCommand,
  isCliNoise,
  CommandAgent,
  FLEET_VERBS,
  resolveBin,
  exeFromCmdShim,
  transcriptPath,
};
