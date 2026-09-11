"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  EXPECTED_ASSET_ROLES,
  EXPECTED_ASSETS,
  listRuntimeAssets,
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

test("the stable contract requires no redistributed assets at all", () => {
  // Owner decision 2026-09-10: Desk ships no character models. This assertion
  // is the contract — if a future change wants a bundled model back, it must
  // fail HERE first, not at a release tag.
  assert.deepEqual(EXPECTED_ASSETS, []);
  assert.deepEqual(EXPECTED_ASSET_ROLES, {});
});

test("development accepts the real tree, with or without local media", (context) => {
  assert.deepEqual(validateAssets(), []);
  const fixture = createFixture(context);
  assert.deepEqual(validateAssets(fixture), []);
});

test("the committed manifest declares no redistributed assets", () => {
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "public", "assets", "manifest.json"),
      "utf8",
    ),
  );
  assert.deepEqual(manifest.assets, []);
});

test("a user's own model and slot copies are dev media, never an error", (context) => {
  // installCharacter()/installCharacterToSlot() write model.vrm and
  // model-slot<N>.vrm into assets/ at runtime; vroid-sync writes animations.
  // All of it is the user's own licensed media, allowed in dev, forbidden in
  // a package.
  const fixture = createFixture(context);
  fs.writeFileSync(path.join(fixture.assetRoot, "model.vrm"), "user model");
  fs.writeFileSync(path.join(fixture.assetRoot, "model-slot1.vrm"), "slot copy");
  fs.mkdirSync(path.join(fixture.assetRoot, "animations"), { recursive: true });
  fs.writeFileSync(
    path.join(fixture.assetRoot, "animations", "talk1.vrma"),
    "user motion",
  );
  assert.deepEqual(validateAssets(fixture), []);
});

test("release passes on the clean real tree", () => {
  assert.deepEqual(validateAssets({ release: true }), []);
});

test("release REFUSES to package a tree containing a character model", (context) => {
  const fixture = createFixture(context);
  fs.writeFileSync(path.join(fixture.assetRoot, "model.vrm"), "stray model");
  const errors = validateAssets({
    release: true,
    assetRoot: fixture.assetRoot,
    manifestPath: fixture.manifestPath,
  });
  assert.ok(errors.some((error) => error.includes("may not contain character media")));
  assert.ok(errors.some((error) => error.includes("model.vrm")));
});

test("release REFUSES a manifest that declares a redistributed asset", (context) => {
  const fixture = createFixture(context);
  const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, "utf8"));
  manifest.assets = [{ path: "model.vrm", role: "model" }];
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
  assert.ok(errors.some((error) => error.includes("declares redistributed assets")));
});

test("listRuntimeAssets finds nested vrm/vrma media only", (context) => {
  const fixture = createFixture(context);
  fs.mkdirSync(path.join(fixture.assetRoot, "animations"), { recursive: true });
  fs.writeFileSync(path.join(fixture.assetRoot, "avatar.png"), "not media");
  fs.writeFileSync(path.join(fixture.assetRoot, "animations", "idle.vrma"), "m");
  assert.deepEqual(listRuntimeAssets(fixture.assetRoot), ["animations/idle.vrma"]);
});
