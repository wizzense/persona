"use strict";

/**
 * quiet-mode.cjs -- "is the owner busy with something full-screen right now?"
 *
 * Owner, 2026-09-23: "annoying that i keep getting awdesk/awask/awdecision cards
 * popping up on my main screen while im playing games". Nothing that raised a card
 * asked. This is the one question every interrupting path asks first:
 *
 *   quiet = doNotDisturb  OR  (quietWhenFullscreen AND the foreground is full-screen)
 *
 * "Full-screen" is two measurements, because games do it two ways:
 *   - SHQueryUserNotificationState -- Windows' own answer: BUSY (a full-screen app),
 *     RUNNING_D3D_FULL_SCREEN (exclusive-mode game), PRESENTATION_MODE, QUIET_TIME
 *     (Focus Assist). Borderless-windowed games usually do NOT trip it, so:
 *   - the foreground window's rect covers its whole monitor and it is not the shell
 *     or one of the desk's own windows (the AitherOS Online overlay IS full-screen).
 *
 * The probe is ONE long-lived hidden PowerShell printing a line every 2 s, not a
 * spawn per check: a probe that starts a process every few seconds is its own
 * frame-time spike in the game it is trying not to disturb.
 */

const { spawn: nodeSpawn } = require("node:child_process");

// QUERY_USER_NOTIFICATION_STATE values that mean "do not interrupt".
const QUNS_QUIET = Object.freeze({ 2: "a full-screen app", 3: "a full-screen game", 4: "presentation mode", 6: "Focus Assist" });

const PROBE = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System; using System.Runtime.InteropServices;
public class QuietProbe {
  [DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int s);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO i);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
}
"@
$parentPid = [int]$env:DESK_QUIET_PARENT
while ($true) {
  # Die with the desk. A killed Electron does not take this child with it, and a
  # write to a closed pipe is swallowed under SilentlyContinue -- five orphaned
  # probes were measured polling forever on 2026-09-23.
  if ($parentPid -gt 0 -and -not (Get-Process -Id $parentPid -ErrorAction SilentlyContinue)) { exit 0 }
  $q = 0; [void][QuietProbe]::SHQueryUserNotificationState([ref]$q)
  $fs = 0; $procId = 0; $name = ''
  $h = [QuietProbe]::GetForegroundWindow()
  if ($h -ne [IntPtr]::Zero -and $h -ne [QuietProbe]::GetShellWindow() -and $h -ne [QuietProbe]::GetDesktopWindow()) {
    $sb = New-Object System.Text.StringBuilder 64; [void][QuietProbe]::GetClassName($h, $sb, 64)
    $cls = $sb.ToString()
    if ($cls -ne 'WorkerW' -and $cls -ne 'Progman' -and $cls -ne 'Shell_TrayWnd') {
      $r = New-Object QuietProbe+RECT; [void][QuietProbe]::GetWindowRect($h, [ref]$r)
      $mi = New-Object QuietProbe+MONITORINFO; $mi.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($mi)
      $m = [QuietProbe]::MonitorFromWindow($h, 2)
      if ([QuietProbe]::GetMonitorInfo($m, [ref]$mi)) {
        $mr = $mi.rcMonitor
        if ($r.L -le $mr.L -and $r.T -le $mr.T -and $r.R -ge $mr.R -and $r.B -ge $mr.B) { $fs = 1 }
      }
      $p = [uint32]0; [void][QuietProbe]::GetWindowThreadProcessId($h, [ref]$p); $procId = $p
      if ($fs -eq 1) { $name = (Get-Process -Id $procId).ProcessName }
    }
  }
  try { [Console]::Out.WriteLine("QUNS=$q FS=$fs PID=$procId NAME=$name"); [Console]::Out.Flush() } catch { exit 0 }
  Start-Sleep -Milliseconds 2000
}
`;

/** Parse one probe line. Pure; exported for the test. */
function parseProbeLine(line) {
  const m = /QUNS=(\d+)\s+FS=(\d)\s+PID=(\d+)\s+NAME=(.*)$/.exec(String(line || "").trim());
  if (!m) return null;
  return { quns: Number(m[1]), fullscreen: m[2] === "1", pid: Number(m[3]), name: m[4].trim() };
}

/**
 * The verdict. Pure; exported for the test.
 * @param {object} prefs  { doNotDisturb, quietWhenFullscreen }
 * @param {object|null} probe  last parseProbeLine() result
 * @param {number[]} ownPids  the desk's own processes -- its full-screen overlay is not a game
 */
function decide(prefs = {}, probe = null, ownPids = []) {
  if (prefs.doNotDisturb) return { quiet: true, reason: "Do not disturb is on" };
  if (prefs.quietWhenFullscreen === false || !probe) return { quiet: false, reason: "" };
  if (QUNS_QUIET[probe.quns]) return { quiet: true, reason: `Windows reports ${QUNS_QUIET[probe.quns]}` };
  if (probe.fullscreen && !ownPids.includes(probe.pid)) {
    return { quiet: true, reason: `${probe.name || "an app"} is full-screen` };
  }
  return { quiet: false, reason: "" };
}

function createQuietMode({
  readPrefs = () => ({}),
  ownPids = () => [process.pid],
  onChange = () => {},
  spawn = nodeSpawn,
  platform = process.platform,
  log = () => {},
} = {}) {
  let probe = null;
  let child = null;
  let last = { quiet: false, reason: "" };
  let buffer = "";
  let restarts = 0;
  let firstLine = null;
  const firstSeen = new Promise((resolve) => { firstLine = resolve; });

  function evaluate() {
    let prefs;
    try { prefs = readPrefs() || {}; } catch { prefs = {}; }
    let pids;
    try { pids = ownPids() || []; } catch { pids = []; }
    const next = decide(prefs, probe, pids);
    if (next.quiet !== last.quiet || next.reason !== last.reason) {
      const was = last;
      last = next;
      try { onChange(next, was); } catch (error) { log("quiet onChange threw", error?.message || error); }
    }
    return last;
  }

  function start() {
    if (child || platform !== "win32") return;
    try {
      child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", PROBE], {
        windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, DESK_QUIET_PARENT: String(process.pid) },
      });
    } catch (error) {
      log("quiet probe did not start", error?.message || error);
      child = null;
      return;
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const parsed = parseProbeLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        if (parsed) { probe = parsed; evaluate(); firstLine(); }
      }
    });
    child.on("exit", () => {
      child = null;
      probe = null;
      evaluate();
      // A probe that dies must not leave the desk believing the game is still up
      // (probe=null reads as "not full-screen"), and it comes back -- bounded.
      if (restarts++ < 5) setTimeout(start, 5000).unref?.();
    });
  }

  function stop() {
    restarts = Infinity;
    if (child) { try { child.kill(); } catch { /* already gone */ } }
    child = null;
  }

  /** Resolves on the probe's first verdict, or after `timeoutMs` (or at once off
   *  Windows). The desk's first decision poll waits on this: the probe needs ~2 s to
   *  compile, and a backlog announced in that gap is the console jumping over a game. */
  function ready(timeoutMs = 6000) {
    if (platform !== "win32") return Promise.resolve();
    return Promise.race([firstSeen, new Promise((resolve) => setTimeout(resolve, timeoutMs).unref?.())]);
  }

  return { start, stop, ready, state: evaluate, isQuiet: () => evaluate().quiet };
}

module.exports = { createQuietMode, decide, parseProbeLine, QUNS_QUIET };
