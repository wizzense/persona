"use strict";

/**
 * browser-client — living-desktop awareness: aitherbrowser/aitherdesktop
 * over the shared gateway-mcp transport (owner 2026-08-25: "full FULL
 * SYSTEM AWARENESS"). This is the desk's answer to "what is the user
 * looking at right now":
 *
 *   - get_active_window       — the focused window (process + title)
 *   - browser_context         — structured agent-friendly content from the
 *                               active browser tab (the living desktop)
 *   - browser_context_history — what pages the user has visited
 *
 * Fails soft like every desk client: a dead gateway yields ok:true with
 * ERROR notes, never a half-truth (security-review-patterns #5). The
 * raw-content functions are exported for the IPC bridge; desktopSnapshot is
 * the one call the deck section makes.
 */

const { callTool, parseMaybeJson } = require("./gateway-mcp.cjs");

async function activeWindow(call = callTool) {
  const text = await call("get_active_window", {});
  return parseMaybeJson(text) ?? { note: text.slice(0, 300) };
}

async function browserContext(call = callTool) {
  const text = await call("browser_context", {});
  return parseMaybeJson(text) ?? { note: text.slice(0, 300) };
}

async function browserHistory(limit = 10, call = callTool) {
  const text = await call("browser_context_history", { limit });
  return parseMaybeJson(text) ?? { note: text.slice(0, 300) };
}

/** One living-desktop snapshot: the focused window + the active tab. */
async function desktopSnapshot(call = callTool) {
  try {
    const [windowText, contextText] = await Promise.all([
      call("get_active_window", {}).catch((error) => `ERROR: ${error.message}`),
      call("browser_context", {}).catch((error) => `ERROR: ${error.message}`),
    ]);
    return {
      ok: true,
      window: parseMaybeJson(windowText) ?? { note: windowText.slice(0, 300) },
      context: parseMaybeJson(contextText) ?? { note: contextText.slice(0, 300) },
      at: Math.floor(Date.now() / 1000),
    };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error).slice(0, 300) };
  }
}

module.exports = { activeWindow, browserContext, browserHistory, desktopSnapshot };

if (require.main === module) {
  // Self-test: read-only. Exit 0 = desktop context available, 1 = the
  // platform reports it unavailable (available:false envelopes) or the
  // transport is down, 2 = module broken. An unavailable source is a
  // feature-block, never a quiet zero.
  (async () => {
    try {
      const snap = await desktopSnapshot();
      if (!snap.ok) {
        console.error(`DESKTOP UNAVAILABLE: ${snap.reason}`);
        process.exit(1);
      }
      const winBlocked = snap.window?.available === false;
      const ctxBlocked = snap.context?.available === false;
      if (winBlocked || ctxBlocked) {
        const why = (winBlocked && snap.window.message) || (ctxBlocked && snap.context.message)
          || (winBlocked && snap.window.reason) || (ctxBlocked && snap.context.reason)
          || "platform";
        console.error(`DESKTOP UNAVAILABLE: ${why}`);
        process.exit(1);
      }
      const win = typeof snap.window === "object" ? Object.keys(snap.window).length : "?";
      const ctx = typeof snap.context === "object" ? Object.keys(snap.context).length : "?";
      console.log(`DESKTOP OK: ${win} window key(s), ${ctx} context key(s)`);
      process.exit(0);
    } catch (error) {
      console.error(`MODULE BROKEN: ${error && error.stack ? error.stack : error}`);
      process.exit(2);
    }
  })();
}
