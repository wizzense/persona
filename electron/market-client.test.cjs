"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

// Regression pins for the 2026-08-27 blank-deck-window crash: browse() must
// return the DECLARED shape on every path — {ok, listings} ALWAYS present.
// The Deck panel reads market.listings.slice(...) unconditionally, and the
// two error paths used to return {ok:false, reason} with no listings key,
// which crashed the whole deck window to blank (decisions list, character
// gallery and settings all read as dead buttons).
function withCallTool(fake, fn) {
  const mcpPath = require.resolve("./gateway-mcp.cjs");
  const mcPath = require.resolve("./market-client.cjs");
  delete require.cache[mcpPath];
  delete require.cache[mcPath];
  const gatewayMcp = require(mcpPath);
  gatewayMcp.callTool = fake;
  return fn(require(mcPath));
}

test("browse: valid listings pass through with the shape intact", async () => {
  await withCallTool(
    async () => JSON.stringify({ listings: [{ id: "p1", name: "pack" }] }),
    async (client) => {
      const r = await client.browse();
      assert.equal(r.ok, true);
      assert.deepEqual(r.listings, [{ id: "p1", name: "pack" }]);
    },
  );
});

test("browse: JSON WITHOUT listings keeps the shape (the crash class)", async () => {
  await withCallTool(
    async () => JSON.stringify({ error: "validation failed" }),
    async (client) => {
      const r = await client.browse();
      assert.equal(r.ok, false);
      assert.ok(Array.isArray(r.listings), "listings must exist on failure");
      assert.equal(r.listings.length, 0);
      assert.match(r.reason, /validation failed/);
    },
  );
});

test("browse: transport failure keeps the shape", async () => {
  await withCallTool(
    async () => {
      throw new Error("gateway down");
    },
    async (client) => {
      const r = await client.browse();
      assert.equal(r.ok, false);
      assert.ok(Array.isArray(r.listings), "listings must exist on failure");
      assert.equal(r.listings.length, 0);
      assert.match(r.reason, /gateway down/);
    },
  );
});

test("browse: plain prose (non-JSON) still carries listings", async () => {
  await withCallTool(
    async () => "here is some prose, no json",
    async (client) => {
      const r = await client.browse();
      assert.equal(r.ok, true);
      assert.deepEqual(r.listings, []);
    },
  );
});
