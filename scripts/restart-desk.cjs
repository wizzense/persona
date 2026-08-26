"use strict";

/**
 * restart-desk — the ONE way to bounce the running desk app.
 *
 * The procedure was done by hand three times in one session (2026-08-25):
 * find the main electron process, kill its tree, relaunch `npm start`, and
 * verify a fresh main exists — because every code change to electron/*.cjs
 * needs a full restart, and a stale STARTUP instance (--background) holds
 * the single-instance lock so a plain `npm start` exits while the OLD code
 * keeps serving. Traps this script absorbs:
 *
 *   - an electron.exe with `electron.exe .` in its command line is the MAIN
 *     process; everything else (--type=gpu/utility/renderer) dies with the
 *     tree kill. Other electron apps (different paths) are never touched.
 *   - a --background instance is the login-startup copy running YESTERDAY's
 *     code — it must die too or the lock bounces the fresh launch.
 *   - the npm wrapper exits 1 after electron detaches (measured repeatedly);
 *     process-list verification is the only signal, never the exit code.
 *
 * Idempotent: safe to run with no instance up (the kill is a no-op).
 */

const { execFileSync, spawn } = require("node:child_process");
const path = require("node:path");

const DESK_ROOT = path.join(__dirname, "..");
const DESK_ELECTRON = path.join(DESK_ROOT, "node_modules", "electron", "dist", "electron.exe");

function findMainElectron() {
  // PowerShell CIM gives us the command line; filter to THIS app's main
  // process (bare `electron.exe .` — no --type= children).
  const script = [
    "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\"",
    "| Where-Object { $_.CommandLine -match [regex]::Escape('" + DESK_ELECTRON + "') -and $_.CommandLine -notmatch '--type=' }",
    "| Select-Object -ExpandProperty ProcessId",
  ].join(" ");
  try {
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-Command", script],
      { encoding: "utf8", timeout: 20000 },
    );
    return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function killTree(pid) {
  try {
    execFileSync("taskkill", ["/PID", pid, "/T", "/F"], {
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false; // already gone — idempotent
  }
}

function launch() {
  // Spawn the electron binary DIRECTLY — `npm start` is exactly this, but
  // spawning npm.cmd without a shell is EINVAL on Windows (measured on the
  // first proof run of this script, which left the desk DOWN).
  const child = spawn(DESK_ELECTRON, ["."], {
    cwd: DESK_ROOT,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function main() {
  const mains = findMainElectron();
  console.log(`restart-desk: ${mains.length} main instance(s) running`);
  for (const pid of mains) {
    const killed = killTree(pid);
    console.log(`  kill ${pid}: ${killed ? "ok" : "already gone"}`);
  }
  launch();
  // Re-assert: a fresh main (or a startup --background instance, which is
  // NOT our launch) must be up. This script's job is OUR build live, so the
  // verdict is: a main process exists for this app path. The npm wrapper
  // exit code is deliberately NOT consulted (it exits 1 on detach).
  const deadline = Date.now() + 15000;
  let fresh = null;
  while (Date.now() < deadline) {
    const now = findMainElectron();
    if (now.length > 0) { fresh = now; break; }
    // Sync pause (Atomics.wait is not allowed on Node's main thread).
    try {
      execFileSync(
        "powershell",
        ["-NoProfile", "-Command", "Start-Sleep -Milliseconds 500"],
        { timeout: 3000, windowsHide: true },
      );
    } catch {
      /* best-effort pause */
    }
  }
  if (!fresh) {
    console.error("restart-desk: NO main process after relaunch — desk is DOWN");
    process.exit(1);
  }
  console.log(`restart-desk: desk up (main ${fresh.join(", ")})`);
  process.exit(0);
}

if (require.main === module) main();

module.exports = { findMainElectron, killTree, launch, main };
