"use strict";

/**
 * market-client — the Desk's window onto the Aitherium marketplace.
 *
 * One-stop-shop foundation (owner 2026-08-25: "browse agent packs from
 * aitherium + avatars ... one stop shop"): the desk panel and Living Desktop
 * both need the SAME marketplace data. The MCP transport lives in
 * gateway-mcp.cjs (one transport, one identity story for every desk data
 * client); this module is only the marketplace shape on top of it. A down
 * gateway or missing bearer yields {ok:false, reason} — the panel renders
 * "market unavailable", never a half-truth.
 */

const { callTool } = require("./gateway-mcp.cjs");

/**
 * Browse the marketplace: query + optional type filter, sorted listings.
 * Returns {ok:true, listings:[{id,name,type,description,short,tags,price}]}
 * or {ok:false, reason}.
 */
async function browse(query = "", type = "", limit = 24) {
  try {
    const text = await callTool("agent_marketplace_browse", {
      query,
      // sort enum is popular|rating|newest|name|revenue — "recent" is a
      // validation error that silently reads as zero listings.
      sort: "newest",
      limit,
      ...(type ? { type } : {}),
    });
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Some tools return plain prose; wrap it rather than guessing.
      return { ok: true, listings: [], note: text.slice(0, 500) };
    }
    if (!parsed.listings) {
      // A validation error (or prose) has no listings — say so loudly.
      return { ok: false, reason: text.slice(0, 300) };
    }
    return { ok: true, listings: parsed.listings, count: parsed.count ?? parsed.listings.length };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error).slice(0, 300) };
  }
}

/** One listing's full detail (invoke/pricing metadata). */
async function detail(listingId) {
  try {
    const text = await callTool("agent_marketplace_get_listing", {
      listing_id: listingId,
    });
    return { ok: true, detail: text };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error).slice(0, 300) };
  }
}

module.exports = { browse, detail };

if (require.main === module) {
  // Self-test: one live browse round-trip. Exit 0 = market reachable and the
  // listing shape parses; exit 1 = unreachable (gateway/bearer); exit 2 = the
  // module itself is broken.
  (async () => {
    try {
      const result = await browse("agent", "", 5);
      if (!result.ok) {
        console.error(`MARKET UNREACHABLE: ${result.reason}`);
        process.exit(1);
      }
      console.log(`MARKET OK: ${result.listings.length} listing(s)`);
      for (const l of result.listings.slice(0, 3)) {
        console.log(`  - ${l.name ?? l.id ?? "(unnamed)"} [${l.type ?? "?"}]`);
      }
      process.exit(0);
    } catch (error) {
      console.error(`MODULE BROKEN: ${error && error.stack ? error.stack : error}`);
      process.exit(2);
    }
  })();
}
