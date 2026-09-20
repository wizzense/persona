"use strict";

/**
 * backend-profile.cjs — resolve the claude-backend launcher's profile env for
 * surfaces that spawn `claude` THEMSELVES (the Command pane, its bridge, MCP).
 *
 * WHY (2026-09-12): the Command pane spawned bare `claude`, which drove the
 * owner's DEFAULT Anthropic login — and the pane's own history shows what every
 * command got back: "You've hit your weekly limit". The launcher
 * (tools/claude-backend/claude-backend.ps1) owns both the profile table and the
 * vault fetch; its `resolve <profile> --to-file <path>` seam writes the env as
 * JSON to a file (the token value is never printed) that this module reads and
 * deletes. One owner of credentials, one owner of profiles, no second copy.
 *
 * Failure is a RENDERED STATE, never a blocker: any error resolves to
 * { ok: false, env: {} } and the caller falls back to inheriting the desk's
 * environment — exactly the pre-existing behaviour — with a visible note.
 * Success is cached for TTL_MS (a vault fetch per command would be wasteful and
 * would make the desk depend on the fleet for EVERY command, where before it
 * depended on it for none); failures retry sooner.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const DEFAULT_TTL_MS = 30 * 60 * 1000; // a resolved env is reused for 30 min
const FAILURE_TTL_MS = 60 * 1000; // a failure is retried after a minute
const HELPER_TIMEOUT_MS = 180 * 1000; // covers the vault path under fleet load

function helperPath() {
  return process.env.AWDESK_BACKEND_HELPER
    || "C:\\AitherOS-Fresh\\tools\\claude-backend\\claude-backend.ps1";
}

/** cast.json `models.commandProfile`, then the legacy AWDESK_CLAUDE_PROFILE, then
 *  "deepseek" -- resolved (and VALIDATED: this string becomes an argument to the
 *  helper script) by cast-config. Read per call, so a change in the Cast pane or
 *  a sync pull moves the very next Command run; the resolved-env cache below is
 *  keyed on the profile, so switching never serves the old backend's env. */
function profileName() {
  try {
    const name = require("./desk-settings.cjs").current().models.commandProfile;
    if (name) return name;
  } catch {
    /* fall through to the pre-existing behaviour */
  }
  return process.env.AWDESK_CLAUDE_PROFILE || "deepseek";
}

class BackendResolver {
  constructor({ spawnImpl = spawn, now = Date.now, ttlMs = DEFAULT_TTL_MS,
    helper = null, pwsh = null } = {}) {
    this.spawnImpl = spawnImpl;
    this.now = now;
    this.ttlMs = ttlMs;
    this.helper = helper || helperPath();
    this.pwsh = pwsh || process.env.AWDESK_PWSH_BIN || "pwsh";
    this._cached = null; // { at, ttl, result }
    this._inflight = null;
  }

  /** @returns {Promise<{ok:boolean, profile:string, env:object, note:string}>} */
  async resolve() {
    if (process.env.AWDESK_BACKEND_RESOLVE === "0") {
      return { ok: false, profile: profileName(), env: {}, note: "disabled by AWDESK_BACKEND_RESOLVE=0" };
    }
    // Keyed on the PROFILE, not just on time. The profile is now a setting the
    // owner changes from the Cast pane; a time-only cache would go on handing out
    // the previous backend's env -- base URL, model AND token -- for up to half an
    // hour after the switch, which reads as "the setting does nothing".
    const wanted = profileName();
    if (this._cached && this._cached.profile === wanted && this.now() - this._cached.at < this._cached.ttl) {
      return this._cached.result;
    }
    if (!this._inflight || this._inflightProfile !== wanted) {
      this._inflightProfile = wanted;
      const flight = this._resolveOnce()
        .then((result) => {
          this._cached = { at: this.now(), ttl: result.ok ? this.ttlMs : FAILURE_TTL_MS, result, profile: wanted };
          return result;
        })
        .finally(() => { if (this._inflight === flight) this._inflight = null; });
      this._inflight = flight;
    }
    return this._inflight;
  }

  _resolveOnce() {
    const profile = profileName();
    const dest = path.join(os.tmpdir(), `awdesk-backend-${randomUUID()}.json`);
    return new Promise((resolveResult) => {
      // The temp file is deleted on EVERY path — the env may hold a token, and a
      // stray one in %TEMP% is exactly the at-rest secret this seam avoids.
      const done = (result) => {
        try { fs.rmSync(dest, { force: true }); } catch { /* best effort */ }
        resolveResult(result);
      };
      let child;
      try {
        child = this.spawnImpl(this.pwsh, ["-NoProfile", "-File", this.helper,
          "resolve", profile, "--to-file", dest],
          { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      } catch (error) {
        return done({ ok: false, profile, env: {}, note: `spawn failed: ${error?.message || error}` });
      }
      let stderr = "";
      const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, HELPER_TIMEOUT_MS);
      timer.unref?.();
      try {
        child.stderr?.on("data", (chunk) => { if (stderr.length < 2000) stderr += String(chunk); });
      } catch { /* a fake child with no streams is fine — the exit code is the verdict */ }
      child.on("error", (error) => {
        clearTimeout(timer);
        done({ ok: false, profile, env: {}, note: `helper error: ${error?.message || error}` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          const why = stderr.trim().split("\n").filter(Boolean).pop() || `exit ${code}`;
          return done({ ok: false, profile, env: {}, note: why.slice(0, 300) });
        }
        try {
          const parsed = JSON.parse(fs.readFileSync(dest, "utf8"));
          const env = {};
          for (const [k, v] of Object.entries(parsed)) {
            if (k === "profile") continue;
            if (typeof v === "string" && v) env[k] = v;
          }
          return done({ ok: true, profile: String(parsed.profile || profile), env, note: "resolved" });
        } catch (error) {
          return done({ ok: false, profile, env: {}, note: `unreadable resolve file: ${error?.message || error}` });
        }
      });
    });
  }
}

module.exports = { BackendResolver, helperPath, profileName };
