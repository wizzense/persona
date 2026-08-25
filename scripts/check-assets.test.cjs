"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  EXPECTED_ASSET_ROLES,
  EXPECTED_ASSETS,
  validateAssets,
} = require("./check-assets.cjs");

function createFixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desk-assets-"));
  const assetRoot = path.join(root, "assets");
  fs.mkdirSync(assetRoot, { recursive: true });
  const manifestPath = path.join(assetRoot, "manifest.json");
  fs.copyFileSync(
    path.join(__dirname, "..", "public", "assets", "manifest.json"),
    manifestPath,
  );
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { assetRoot, manifestPath };
}

test("development accepts the complete local set or no media", (context) => {
  assert.deepEqual(validateAssets(), []);
  const fixture = createFixture(context);
  assert.deepEqual(validateAssets(fixture), []);
});

test("manifest assigns every stable asset its intended semantic role", () => {
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "public", "assets", "manifest.json"),
      "utf8",
    ),
  );
  assert.deepEqual(
    Object.fromEntries(manifest.assets.map((asset) => [asset.path, asset.role])),
    EXPECTED_ASSET_ROLES,
  );
});

test("development rejects a partial local media set", (context) => {
  const fixture = createFixture(context);
  const partial = path.join(fixture.assetRoot, EXPECTED_ASSETS[0]);
  fs.mkdirSync(path.dirname(partial), { recursive: true });
  fs.writeFileSync(partial, "local test media");
  assert.ok(
    validateAssets(fixture).some((error) =>
      error.includes("Runtime asset files do not match"),
    ),
  );
});

test("test-only assets are rejected by the release gate", () => {
  const errors = validateAssets({ release: true });
  assert.ok(errors.some((error) => error.includes("distribution is disabled")));
  assert.ok(errors.some((error) => error.includes("Incomplete release license metadata")));
});
