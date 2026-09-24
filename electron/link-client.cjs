"use strict";

/**
 * link-client — the desk's door onto `adk link` (awdk): is this machine linked
 * to aitherium.com, as whom, in which ROLE — and the one button that links it.
 *
 * Owner, 2026-09-23: "what about awsh + awdesk integration for onboarding?"
 * awdesk had no account link at all. The desk owns none of the logic: adk/link.py
 * runs the device grant, persists the sign-in where awsh and adk read it, and
 * fetches the role-aware bundle (platform owner vs everyone else). A second
 * implementation here would be a fifth sign-in path, which is the problem.
 *
 * Nothing reaches a shell: the device code is validated and adk is spawned with
 * an argv.
 */

const { execFile } = require("node:child_process");

const DEVICE_CODE = /^[A-Za-z0-9_-]{8,256}$/;

function adkBin() {
  if (process.env.AWDESK_ADK_BIN) return process.env.AWDESK_ADK_BIN;
  try {
    return require("./command-agent.cjs").resolveBin("adk", "AWDESK_ADK_BIN");
  } catch {
    return "adk";
  }
}

/** Run `adk link <args> --json`; resolves {ok, data} or {ok:false, error}. */
function runLink(args, { execFileImpl = execFile, bin = adkBin(), timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    execFileImpl(
      bin,
      ["link", ...args, "--json"],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        let data = null;
        try {
          data = JSON.parse(String(stdout || "").trim() || "null");
        } catch {
          /* judged below */
        }
        if (data && typeof data === "object") {
          const ok = data.ok !== false;
          return resolve(ok ? { ok: true, data } : { ok: false, data, error: data.error || "failed" });
        }
        const why = error
          ? (error.code === "ENOENT" ? "adk is not installed or not on PATH" : String(error.message || error))
          : "adk link returned no JSON";
        return resolve({ ok: false, error: `${why}${stderr ? `: ${String(stderr).slice(-300)}` : ""}` });
      },
    );
  });
}

const linkStatus = (opts) => runLink(["status"], opts);
const linkStart = (opts) => runLink(["start"], opts);

/** One poll. Refused WITHOUT a spawn if the device code is not code-shaped. */
function linkPoll(deviceCode, opts) {
  if (!DEVICE_CODE.test(String(deviceCode || ""))) {
    return Promise.resolve({ ok: false, error: "bad device code" });
  }
  return runLink(["poll", String(deviceCode)], opts);
}

module.exports = { runLink, linkStatus, linkStart, linkPoll, adkBin };
