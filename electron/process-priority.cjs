"use strict";

/**
 * process-priority — the desk is an interactive overlay on a box that also runs
 * batch work (gates, test suites, renders). Measured 2026-09-18 with the host
 * at 100 % CPU: the desk's timers fired up to 1.1 s late and frames stalled
 * while its own JS was 98 % idle (scripts/main-profile.cjs) -- it was simply
 * not being scheduled. Every desk process (main, GPU, renderers, utilities)
 * therefore runs ABOVE NORMAL: ahead of batch jobs, never ahead of the OS.
 *
 *   DESK_PRIORITY = above (default) | normal
 */

const os = require("node:os");

const LEVELS = { above: os.constants.priority.PRIORITY_ABOVE_NORMAL, normal: os.constants.priority.PRIORITY_NORMAL };

/** Pure: env → the priority to apply, or null to leave the processes alone. */
function wantedPriority(env = process.env) {
  const v = String(env.DESK_PRIORITY || "above").trim().toLowerCase();
  if (v === "normal") return null;
  return LEVELS.above;
}

/** Apply to every pid once; returns { raised, failed }. Children come and go, so callers re-run it. */
function raisePriorities(pids, priority, setPriority = os.setPriority, done = new Set()) {
  let raised = 0;
  let failed = 0;
  for (const pid of pids) {
    if (done.has(pid)) continue;
    try {
      setPriority(pid, priority);
      done.add(pid);
      raised += 1;
    } catch {
      failed += 1; // exited between the listing and the call
    }
  }
  for (const pid of [...done]) if (!pids.includes(pid)) done.delete(pid);
  return { raised, failed };
}

/** Wire it to an Electron app: now, and on a slow timer for windows opened later. */
function keepDeskResponsive(app, { env = process.env, intervalMs = 30000, setIntervalFn = setInterval, setPriority = os.setPriority } = {}) {
  const priority = wantedPriority(env);
  if (priority == null) return { enabled: false };
  const done = new Set();
  const sweep = () => raisePriorities(app.getAppMetrics().map((m) => m.pid), priority, setPriority, done);
  sweep();
  const timer = setIntervalFn(sweep, intervalMs);
  if (timer && typeof timer.unref === "function") timer.unref();
  return { enabled: true, sweep };
}

module.exports = { keepDeskResponsive, raisePriorities, wantedPriority };
