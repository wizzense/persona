"use strict";

/**
 * connect-client — aitherconnect + portal workspace awareness over the
 * shared gateway-mcp transport (owner 2026-08-25: "INCLUDING ACTIVE
 * TERMINAL SESSIONS AND AGENT SESSIONS AND INTEGRATED TO
 * PORTAL.AITHERIUM.COM FOR WORKSPACE AWARENESS"). Two sources, one
 * snapshot:
 *
 *   - get_active_workspace_profile — which workspace profile the desk is
 *                                    living in (the portal-aware half)
 *   - get_running_processes        — host process table, filtered HERE for
 *                                    terminal-shaped names (the active
 *                                    terminal sessions half; the filter is
 *                                    client-side so the transport stays
 *                                    thin and the set is testable)
 *
 * Fails soft like every desk client: a dead gateway yields ok:true with
 * ERROR notes, never a half-truth (security-review-patterns #5).
 */

const { callTool, parseMaybeJson } = require("./gateway-mcp.cjs");

// Terminal-shaped process names on the box this desk actually runs on
// (Windows-first) plus the WSL/Linux set, since sessions here live in both.
// Best-effort by design: this names sessions a human would call "a
// terminal", not an exhaustive process taxonomy.
const TERMINAL_NAMES = [
  "windowsterminal", "wt", "pwsh", "powershell", "cmd", "conhost",
  "bash", "zsh", "sh", "fish", "tmux", "screen", "wsl", "wslhost",
  "alacritty", "wezterm", "mintty", "gnome-terminal", "konsole", "kitty",
];

/** Normalize one process-table row to a display name, or null. */
function rowName(row) {
  if (typeof row === "string") return row.toLowerCase();
  if (!row || typeof row !== "object") return null;
  const candidate =
    row.name ?? row.process ?? row.ProcessName ?? row.command ?? row.CommandLine ?? row.cmd;
  return typeof candidate === "string" ? candidate.toLowerCase() : null;
}

/** Filter the host process table to terminal-shaped rows. Tolerant of the
 *  tool returning strings, objects, or nothing useful. */
async function terminalSessions(call = callTool) {
  const text = await call("get_running_processes", {});
  const parsed = parseMaybeJson(text);
  // The gateway's desktop-context tools answer with an availability
  // envelope when the backend cannot see this machine — carry its reason
  // forward, never a quiet zero.
  if (parsed && parsed.available === false) {
    return {
      total: 0,
      names: [],
      note: `desktop context unavailable: ${parsed.message || parsed.reason || "platform"}`,
    };
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.processes) ? parsed.processes
      : Array.isArray(parsed?.items) ? parsed.items
        : Array.isArray(parsed?.data) ? parsed.data
          : null;
  if (!list) return { total: 0, names: [], note: "process table unavailable" };
  const terminals = list.filter((row) => {
    const name = rowName(row);
    return name !== null && TERMINAL_NAMES.some((t) => name.includes(t));
  });
  return {
    total: terminals.length,
    names: terminals.slice(0, 12).map((row) => (typeof row === "string" ? row : rowName(row))),
  };
}

async function workspaceProfile(call = callTool) {
  const text = await call("get_active_workspace_profile", {});
  return parseMaybeJson(text) ?? { note: text.slice(0, 300) };
}

/** One connect snapshot: the workspace profile + terminal sessions. */
async function connectSnapshot(call = callTool) {
  try {
    const [workspaceText, terminals] = await Promise.all([
      call("get_active_workspace_profile", {}).catch((error) => `ERROR: ${error.message}`),
      terminalSessions(call).catch((error) => ({
        total: 0, names: [], note: `ERROR: ${error.message}`,
      })),
    ]);
    return {
      ok: true,
      workspace: parseMaybeJson(workspaceText) ?? { note: workspaceText.slice(0, 300) },
      terminals,
      at: Math.floor(Date.now() / 1000),
    };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error).slice(0, 300) };
  }
}

module.exports = { terminalSessions, workspaceProfile, connectSnapshot, TERMINAL_NAMES };

if (require.main === module) {
  // Self-test: read-only. Exit 0 = aware, 1 = unreachable, 2 = module broken.
  (async () => {
    try {
      const snap = await connectSnapshot();
      if (!snap.ok) {
        console.error(`CONNECT UNAVAILABLE: ${snap.reason}`);
        process.exit(1);
      }
      if (snap.workspace?.note?.startsWith("ERROR:")) {
        console.error(`CONNECT UNAVAILABLE: ${snap.workspace.note}`);
        process.exit(1);
      }
      const ws = typeof snap.workspace === "object" ? Object.keys(snap.workspace).length : "?";
      const tt = snap.terminals.total;
      const suffix = snap.terminals.note ? ` — ${snap.terminals.note}` : "";
      console.log(`CONNECT OK: ${ws} workspace key(s), ${tt} terminal session(s)${suffix}`);
      process.exit(0);
    } catch (error) {
      console.error(`MODULE BROKEN: ${error && error.stack ? error.stack : error}`);
      process.exit(2);
    }
  })();
}
