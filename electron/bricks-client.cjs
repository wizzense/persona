"use strict";

/**
 * bricks-client — the desk's door onto `adk bricks` (awdk): which Aither World
 * bricks are installed, which have a newer version on the index, and one-click
 * upgrade / test / rollback. Owner, 2026-09-22: "detect when new versions of
 * awdk/awnix/bricks are updated and make it easy to upgrade and test and
 * rollback".
 *
 * The desk owns none of the logic. adk/bricks.py decides what is outdated,
 * refuses an editable checkout, tests after an upgrade and rolls back on a
 * failed test; this module only runs it and hands the JSON back. A second
 * implementation here would drift from the CLI the owner also uses.
 *
 * Nothing reaches the shell: the verb and brick name are validated, and the
 * binary is spawned directly with an argv (no shell string).
 */

const { execFile } = require("node:child_process");

const VERBS = new Set(["upgrade", "test", "rollback"]);
const NAME = /^[a-z][a-z0-9-]{1,48}$/;

/** `adk` resolved the same way the Command window resolves `claude`. */
function adkBin() {
  if (process.env.AWDESK_ADK_BIN) return process.env.AWDESK_ADK_BIN;
  try {
    return require("./command-agent.cjs").resolveBin("adk", "AWDESK_ADK_BIN");
  } catch {
    return "adk";
  }
}

/**
 * Run `adk bricks <args> --json`. Resolves {ok, data} or {ok:false, error}.
 * An upgrade that failed exits non-zero AND prints its JSON verdict, so stdout
 * is parsed before the exit code is judged.
 */
function runBricks(args, { execFileImpl = execFile, bin = adkBin(), timeoutMs = 900000 } = {}) {
  return new Promise((resolve) => {
    execFileImpl(
      bin,
      ["bricks", ...args, "--json"],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        let data = null;
        try {
          data = JSON.parse(String(stdout || "").trim() || "null");
        } catch {
          /* not JSON: judged below as an error, never an empty list */
        }
        if (data !== null) {
          const ok = Array.isArray(data) ? true : Boolean(data.ok);
          return resolve(ok ? { ok: true, data } : { ok: false, data, error: data.error || "failed" });
        }
        const why = error
          ? (error.code === "ENOENT" ? "adk is not installed or not on PATH" : String(error.message || error))
          : "adk bricks returned no JSON";
        return resolve({ ok: false, error: `${why}${stderr ? `: ${String(stderr).slice(-300)}` : ""}` });
      },
    );
  });
}

function listBricks(opts) {
  return runBricks(["list"], { timeoutMs: 120000, ...opts });
}

/** upgrade | test | rollback one brick. Refused WITHOUT a spawn if either argument is bad. */
function actOnBrick(verb, name, opts) {
  if (!VERBS.has(verb)) return Promise.resolve({ ok: false, error: `unknown verb: ${verb}` });
  if (!NAME.test(String(name || ""))) return Promise.resolve({ ok: false, error: `bad brick name: ${name}` });
  return runBricks([verb, name], opts);
}

module.exports = { runBricks, listBricks, actOnBrick, adkBin, VERBS };
