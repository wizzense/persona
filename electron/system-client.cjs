"use strict";

/**
 * system-client — full system awareness for the desk (owner 2026-08-25:
 * "FULL SYSTEM AWARENESS INCLUDING ACTIVE TERMINAL SESSIONS AND AGENT
 * SESSIONS"). One snapshot call over the shared gateway-mcp transport:
 *
 *   - get_system_status   — services, GPU state, platform health
 *   - active_agents       — FluxContextState's live agent activities
 *   - flux_context        — the real-time system context ("aspect":"agents")
 *
 * Every source fails soft: a down gateway yields {ok:false, reason} and the
 * deck renders "system data unavailable" — never a half-truth
 * (security-review-patterns #5). No tool result is echoed verbatim; the
 * caller (deck section) renders the compact summary.
 */

const { callTool, parseMaybeJson } = require("./gateway-mcp.cjs");

/** One awareness snapshot: system status + active agents. `call` is the
 *  gateway-mcp callTool (injectable so tests need no live gateway). */
async function systemSnapshot(call = callTool) {
  try {
    const [systemText, agentsText, fluxText] = await Promise.all([
      call("get_system_status", {}).catch((error) => `ERROR: ${error.message}`),
      call("active_agents", {}).catch((error) => `ERROR: ${error.message}`),
      call("flux_context", { aspect: "agents" }).catch((error) => `ERROR: ${error.message}`),
    ]);
    return {
      ok: true,
      system: parseMaybeJson(systemText) ?? { note: systemText.slice(0, 300) },
      agents: parseMaybeJson(agentsText) ?? { note: agentsText.slice(0, 300) },
      flux: parseMaybeJson(fluxText) ?? { note: fluxText.slice(0, 300) },
      at: Math.floor(Date.now() / 1000),
    };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error).slice(0, 300) };
  }
}

module.exports = { systemSnapshot };

if (require.main === module) {
  // Self-test: one live snapshot. Exit 0 = aware; exit 1 = unreachable
  // (gateway/bearer); exit 2 = the module itself is broken.
  (async () => {
    try {
      const snap = await systemSnapshot();
      if (!snap.ok) {
        console.error(`SYSTEM UNAVAILABLE: ${snap.reason}`);
        process.exit(1);
      }
      const sys = snap.system;
      const agents = snap.agents;
      const names =
        Array.isArray(agents?.activities) ? agents.activities.length
          : Array.isArray(agents) ? agents.length
            : typeof agents === "object" ? Object.keys(agents).length : "?";
      const serviceCount =
        Array.isArray(sys?.services) ? sys.services.length
          : typeof sys === "object" ? Object.keys(sys).length : "?";
      console.log(`SYSTEM OK: ${serviceCount} system key(s), ${names} agent activity key(s)`);
      process.exit(0);
    } catch (error) {
      console.error(`MODULE BROKEN: ${error && error.stack ? error.stack : error}`);
      process.exit(2);
    }
  })();
}
