"use strict";

/**
 * fleet-control.cjs — the Fleet window's backend: ONE implementation of
 * "shut AitherOS down / bring it back", shared with `game down|up` and the Desk
 * MCP `fleet_control` tool.
 *
 * Born 2026-09-07 (owner: "shut aitheros down ... i need a better way to do
 * this ... something tied to awdesk, a real program I can launch and interact
 * with to control this"). Until then the only way to take the fleet down and
 * keep it down was a Claude Code session hand-writing `systemctl mask` loops
 * across the WSL hop, and the only way back was `systemctl unmask --runtime`
 * by hand — 207 units, nothing recorded, nothing the owner could click.
 *
 * Everything here delegates to the IN-DISTRO script
 * `.DEPLOYMENT/scripts/llm-quiesce-distro.py` (root in the Debian WSL distro),
 * which is the only thing that actually HOLDS on the podman-quadlet fleet:
 * HOLD sentinel + `systemctl stop` + runtime masks, sockets before services,
 * verified from `podman ps`, not from exit codes. This file only crosses the
 * WSL hop — one command string through `sh -c`, never re-parsed — and turns
 * the JSON verdict into what the window renders.
 *
 * Every action serialises: a second click while one runs is refused with
 * `busy`, because two concurrent mask/unmask passes on the same 207 units is
 * how a fleet ends up half-up with no record of which half.
 */

const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { readGpuHolders, summarizeHolders } = require("./gpu-holders.cjs");
const { probeSurfaces, summarizeSurfaces } = require("./surfaces.cjs");

const DEFAULT_SCRIPT = "C:\\AitherOS-Fresh\\.DEPLOYMENT\\scripts\\llm-quiesce-distro.py";
const DEFAULT_DISTRO = "Debian";

/** action -> argv for the distro script. `down`/`up` are the owner-facing names
 *  (`game down|up`); the distro script speaks quiesce/resume. */
const ACTIONS = Object.freeze({
  status: ["status"],
  gaming: ["quiesce", "--deep"],
  quiesce: ["quiesce"],
  down: ["quiesce", "--all"],
  resume: ["resume"],
  up: ["resume"],
  adopt: ["adopt"],
});
const ACTION_NAMES = Object.freeze(Object.keys(ACTIONS));

/** Actions that take the fleet (or part of it) DOWN — the window double-confirms these. */
const DESTRUCTIVE = new Set(["down", "gaming", "quiesce"]);

/** How long an action may run before the child is killed. `up` after `down`
 *  reloads a 26 GB model through gpu-boot (measured 2026-09-07: 590 s was not
 *  enough for vllm-fp16 alone), so the ceiling is generous on purpose. */
const TIMEOUT_MS = Object.freeze({
  status: 120_000,
  adopt: 120_000,
  gaming: 600_000,
  quiesce: 600_000,
  down: 900_000,
  resume: 1_800_000,
  up: 1_800_000,
});

/** `C:\a\b.py` -> `/mnt/c/a/b.py` (the distro's view of a Windows file). */
function toDistroPath(windowsPath) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(String(windowsPath ?? ""));
  if (!m) return String(windowsPath ?? "").replace(/\\/g, "/");
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}

function scriptPath() {
  return process.env.AWDESK_FLEET_SCRIPT || DEFAULT_SCRIPT;
}

function distroName() {
  return process.env.AWDESK_FLEET_DISTRO || DEFAULT_DISTRO;
}

/** The exact process to spawn for an action. The whole distro invocation is
 *  ONE string through `sh -c` (the WSL-hop rule: argv is never re-parsed, and
 *  a `$var` or backtick that survives the hop is a different command). */
function buildCommand(action, { script = scriptPath(), distro = distroName() } = {}) {
  const argv = ACTIONS[action];
  if (!argv) throw new Error(`unknown fleet action "${action}" (one of ${ACTION_NAMES.join(", ")})`);
  const inner = `python3 '${toDistroPath(script)}' ${argv.join(" ")} --json`;
  return { file: "wsl.exe", args: ["-d", distro, "-u", "root", "sh", "-c", inner] };
}

/** The distro script prints ONE JSON document on stdout (progress goes to
 *  stderr). rc 2 = CANNOT_JUDGE (no distro / no podman / no python3) and must
 *  never read as a healthy fleet — a window that says "UP" because the probe
 *  could not run is the exact silence this surface exists to end. */
function parseVerdict(stdout, code, stderrTail = "") {
  const text = String(stdout ?? "");
  const start = text.indexOf("{");
  if (start >= 0) {
    try {
      const doc = JSON.parse(text.slice(start));
      if (doc && typeof doc === "object") {
        if (doc.verdict === "CANNOT_JUDGE") return { ok: false, cannotJudge: true, ...doc };
        if (typeof doc.ok !== "boolean") doc.ok = code === 0;
        return doc;
      }
    } catch {
      /* fall through to the rc-based verdict */
    }
  }
  if (code === 2 || code === 127) {
    return {
      ok: false,
      cannotJudge: true,
      error: stderrTail.trim() || "the Debian distro, python3 or podman did not answer",
    };
  }
  return {
    ok: code === 0,
    error: code === 0 ? null : (stderrTail.trim() || `exit ${code}`),
  };
}

/** One-line human summary of a `status` verdict, for the tray tooltip / MCP. */
function summarize(status) {
  if (!status || status.cannotJudge) {
    return `Fleet: CANNOT JUDGE — ${status?.error || "no verdict"}`;
  }
  const fl = status.fleet || {};
  const v = status.vram;
  const gpu = v ? `GPU ${(v.used_mib / 1024).toFixed(1)}/${(v.total_mib / 1024).toFixed(0)} GiB` : "GPU ?";
  const running = fl.running == null ? "?" : fl.running;
  const masked = fl.masked == null ? "?" : `${fl.masked}/${fl.units ?? "?"}`;
  // "GPU 10.2/32 GiB (ComfyUI 7.1, dwm 4.5)": the number AND who holds it —
  // with 0 containers running the number alone was a riddle (2026-09-08).
  const holders = summarizeHolders(status.gpu_holders);
  const surfaces = summarizeSurfaces(status.surfaces);
  return `Fleet: ${running} container(s) running, ${masked} units masked, ${gpu}${holders ? ` (${holders})` : ""}, HOLD ${status.held ? "yes" : "no"}` +
    (fl.scope ? `, scope=${fl.scope}` : "") + (surfaces ? `, ${surfaces}` : "");
}

/** The single word the window's big pill shows. Derived from reality (the
 *  running count + masks), never from the last button pressed. */
function classify(status) {
  if (!status || status.cannotJudge) return "UNKNOWN";
  const fl = status.fleet || {};
  if (fl.running === 0 && (fl.masked ?? 0) > 0) return "DOWN";
  if (status.held) return "GPU QUIET";
  if ((fl.masked ?? 0) > 0) return "MIXED";
  if ((fl.running ?? 0) > 0) return "UP";
  return "UNKNOWN";
}

class FleetControl extends EventEmitter {
  constructor({ spawnImpl = spawn, script, distro, gpuHolders = null, surfaces = null,
    statusRetries = 1, retryDelayMs = 8000 } = {}) {
    super();
    this.spawnImpl = spawnImpl;
    this.script = script;
    this.distro = distro;
    // Patience for the STATUS probe only (actions are long and deliberate by
    // design; retrying those would be retrying the owner's click). The probe is
    // load-sensitive -- podman ps has a 60 s timeout INSIDE the distro script,
    // and on 2026-09-12 a load-54 window held the Fleet pane at "?" while the
    // fleet was up with 91 containers. A spike usually passes within seconds.
    this.statusRetries = Math.max(0, Number(statusRetries) || 0);
    this.retryDelayMs = Math.max(0, Number(retryDelayMs) || 0);
    // Host-side enrichment of a `status` verdict: who holds the VRAM (Windows
    // counters — invisible from inside the distro) and whether the control-plane
    // doors answer. Injectable; a fake spawn gets no host probes unless asked.
    this.gpuHolders = gpuHolders !== null ? gpuHolders : (spawnImpl === spawn ? () => readGpuHolders() : null);
    this.surfaces = surfaces !== null ? surfaces : (spawnImpl === spawn ? () => probeSurfaces() : null);
    this.current = null; // { action, startedAt }
    this.inflight = null; // the promise of the running action (a second status() joins it)
    this.lastStatus = null;
    this.lastStatusAt = 0;
  }

  get busy() {
    return this.current?.action ?? null;
  }

  /** Run one action; resolves with the verdict object (never rejects on a
   *  fleet refusal — `ok:false` carries it — only on a programming error). */
  run(action) {
    if (!ACTIONS[action]) {
      return Promise.resolve({ ok: false, error: `unknown action "${action}"` });
    }
    if (this.current) {
      // Two status probes at once (the window's refresh + a bridge/MCP read)
      // share ONE child: refusing the second as busy left the panel stuck on
      // "RUNNING: STATUS" (measured 2026-09-07, first screenshot).
      if (action === "status" && this.current.action === "status" && this.inflight) {
        return this.inflight;
      }
      return Promise.resolve({
        ok: false,
        busy: this.current.action,
        error: `busy: "${this.current.action}" has been running ${Math.round((Date.now() - this.current.startedAt) / 1000)} s`,
      });
    }
    const cmd = buildCommand(action, { script: this.script, distro: this.distro });
    this.current = { action, startedAt: Date.now() };
    this.emit("progress", { action, line: `> ${action}`, phase: "start" });
    this.inflight = new Promise((resolve) => {
      const finish = (verdict) => {
        this.current = null;
        this.inflight = null;
        if (action === "status" && !verdict.cannotJudge) {
          this.lastStatus = verdict;
          this.lastStatusAt = Date.now();
        }
        if (action === "status" && verdict.cannotJudge && this.lastStatus) {
          // NEVER a number without its age. The counts ride along from the last
          // GOOD probe, labeled with how old they are and why the fresh one
          // failed; `cannotJudge` STAYS TRUE so every consumer (tray, MCP, awsh)
          // still reads "could not judge" loudly. "Could not look" must not
          // read as "healthy" -- that rule is why this class exists.
          verdict.stale = {
            age_ms: Date.now() - this.lastStatusAt,
            at: this.lastStatusAt,
            reason: verdict.error || null,
            verdict: this.lastStatus,
          };
        }
        this.emit("progress", {
          action,
          line: verdict.ok ? `< ${action}: ok` : `< ${action}: ${verdict.error || "refused"}`,
          phase: "end",
          verdict,
        });
        resolve(verdict);
      };
      const attempt = (retriesLeft) => {
        let child;
        try {
          child = this.spawnImpl(cmd.file, cmd.args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        } catch (error) {
          finish({ ok: false, cannotJudge: true, error: error?.message || String(error) });
          return;
        }
        let stdout = "";
        let stderrTail = "";
        let stderrBuf = "";
        const timer = setTimeout(() => {
          try { child.kill(); } catch { /* already gone */ }
          stderrTail += `\n[timeout after ${TIMEOUT_MS[action] / 1000} s]`;
        }, TIMEOUT_MS[action] ?? 600_000);
        timer.unref?.();
        child.stdout?.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
        child.stderr?.on("data", (chunk) => {
          stderrBuf += chunk.toString("utf8");
          const lines = stderrBuf.split(/\r?\n/);
          stderrBuf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            stderrTail = (stderrTail + "\n" + line).slice(-2000);
            this.emit("progress", { action, line, phase: "run" });
          }
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          finish({ ok: false, cannotJudge: true, error: error?.message || String(error) });
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (stderrBuf.trim()) {
            stderrTail = (stderrTail + "\n" + stderrBuf).slice(-2000);
            this.emit("progress", { action, line: stderrBuf.trim(), phase: "run" });
          }
          const verdict = parseVerdict(stdout, code ?? 1, stderrTail);
          if (action === "status" && verdict.cannotJudge && retriesLeft > 0) {
            this.emit("progress", {
              action,
              line: `status: cannot judge (${verdict.error || "no verdict"}) — retrying in ${Math.round(this.retryDelayMs / 1000)} s`,
              phase: "run",
            });
            setTimeout(() => attempt(retriesLeft - 1), this.retryDelayMs).unref?.();
            return;
          }
          if (action !== "status") {
            finish(verdict);
            return;
          }
          // Enrich a status verdict from the HOST before it lands anywhere: the
          // window, the bridge, awsh, adk and the MCP tool all read this one
          // object, so the holders and the doors show up everywhere at once.
          this._enrichStatus(verdict).then(finish, () => finish(verdict));
        });
      };
      attempt(action === "status" ? this.statusRetries : 0);
    });
    return this.inflight;
  }

  /** Attach `gpu_holders` and `surfaces`; each probe fails to [] with a reason, never throws. */
  async _enrichStatus(verdict) {
    const [holders, surfaces] = await Promise.all([
      this.gpuHolders ? Promise.resolve().then(this.gpuHolders).catch((e) => ({ holders: [], error: e?.message || String(e) })) : null,
      this.surfaces ? Promise.resolve().then(this.surfaces).catch(() => []) : null,
    ]);
    if (holders) {
      verdict.gpu_holders = Array.isArray(holders) ? holders : holders.holders || [];
      if (holders.error) verdict.gpu_holders_error = holders.error;
    }
    if (surfaces) verdict.surfaces = Array.isArray(surfaces) ? surfaces : [];
    return verdict;
  }

  /** Cached status if fresh enough, else a live probe. */
  async status({ maxAgeMs = 15_000 } = {}) {
    if (this.current?.action === "status" && this.inflight) return this.inflight;
    if (this.lastStatus && Date.now() - this.lastStatusAt < maxAgeMs) return this.lastStatus;
    if (this.current && this.current.action !== "status" && this.lastStatus) {
      return { ...this.lastStatus, busy: this.current.action };
    }
    return this.run("status");
  }
}

module.exports = {
  ACTIONS,
  ACTION_NAMES,
  DESTRUCTIVE,
  TIMEOUT_MS,
  FleetControl,
  buildCommand,
  classify,
  parseVerdict,
  summarize,
  toDistroPath,
};
