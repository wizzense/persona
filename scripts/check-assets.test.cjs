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

test("per-slot runtime copies never break the stable contract", (context) => {
  // installCharacterToSlot() writes model-slot<N>.vrm into every asset tree
  // at runtime; those copies are state, not contract assets. A stale pair of
  // them broke `npm test` on 2026-08-25 by being counted as undeclared assets.
  const fixture = createFixture(context);
  fs.writeFileSync(
    path.join(fixture.assetRoot, "model-slot1.vrm"),
    "runtime slot copy",
  );
  fs.writeFileSync(
    path.join(fixture.assetRoot, "model-slot2.vrm"),
    "runtime slot copy",
  );
  assert.deepEqual(validateAssets(fixture), []);
});

test("runtime animations are allowed media, not undeclared assets", (context) => {
  // The packaged app ships WITHOUT .vrma files (they are per-user VRoid Hub
  // downloads); a dev tree with them present must still validate.
  const fixture = createFixture(context);
  fs.mkdirSync(path.join(fixture.assetRoot, "animations"), { recursive: true });
  fs.writeFileSync(
    path.join(fixture.assetRoot, "animations", "talk1.vrma"),
    "local motion media",
  );
  assert.deepEqual(validateAssets(fixture), []);
});

test("development rejects an EMPTY required asset while media is present", (context) => {
  const fixture = createFixture(context);
  fs.writeFileSync(
    path.join(fixture.assetRoot, EXPECTED_ASSETS[0]),
    "",
  );
  assert.ok(
    validateAssets(fixture).some((error) =>
      error.includes(`Missing or empty asset: ${EXPECTED_ASSETS[0]}`),
    ),
  );
});

test("release gate passes on the licensed real tree", () => {
  // The real tree ships a verified-redistributable model (VRM 1.0 meta
  // inspected directly, 2026-08-25) with complete manifest metadata.
  assert.deepEqual(validateAssets({ release: true }), []);
});

test("release gate rejects disabled distribution and incomplete licenses", (context) => {
  const fixture = createFixture(context);
  const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, "utf8"));
  manifest.distributionAllowed = false;
  for (const asset of manifest.assets) asset.license = null;
  fs.writeFileSync(
    fixture.manifestPath,
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
  const errors = validateAssets({
    release: true,
    assetRoot: fixture.assetRoot,
    manifestPath: fixture.manifestPath,
  });
  assert.ok(errors.some((error) => error.includes("distribution is disabled")));
  assert.ok(errors.some((error) => error.includes("Incomplete release license metadata")));
});
