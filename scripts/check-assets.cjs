"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PROJECT_ROOT = path.join(__dirname, "..");
const ASSET_ROOT = path.join(PROJECT_ROOT, "public", "assets");
const MANIFEST_PATH = path.join(ASSET_ROOT, "manifest.json");

/**
 * The stable asset contract is the ONE file Desk redistributes and licenses
 * in its installer: the default character model. Everything else under
 * assets/ is per-user runtime media, never shipped:
 *
 *   - animations/*.vrma — VRoid Hub "personality motions", downloaded through
 *     the user's own Hub license at character-enroll time (vroid-sync.py).
 *     Their redistribution terms are NOT ours to grant, so they are never
 *     committed and the packaged app ships without them; the animation
 *     loader tolerates their absence (useVrmAnimation.play catches and
 *     completes the once-callback).
 *   - model-slot<N>.vrm — per-slot runtime copies written by
 *     installCharacterToSlot() for spawned avatar slots.
 *
 * So validation is PRESENCE of the required asset (all-or-nothing in dev,
 * mandatory in release), never an equality against the whole directory —
 * the old equality check counted two stale slot models as undeclared assets
 * and broke `npm test` (measured 2026-08-25).
 */
const EXPECTED_ASSETS = ["model.vrm"];
const EXPECTED_ASSET_ROLES = {
  "model.vrm": "model",
};

function listRuntimeAssets(directory = ASSET_ROOT, prefix = "") {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const relative = path.posix.join(prefix, entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) return listRuntimeAssets(absolute, relative);
      return /\.(?:vrm|vrma)$/i.test(entry.name) ? [relative] : [];
    })
    .sort();
}

function validateAssets({
  release = false,
  assetRoot = ASSET_ROOT,
  manifestPath = MANIFEST_PATH,
} = {}) {
  const errors = [];
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return [`Cannot read assets/manifest.json: ${error.message}`];
  }

  const manifestPaths = (manifest.assets ?? []).map((asset) => asset.path).sort();
  const expected = [...EXPECTED_ASSETS].sort();
  if (JSON.stringify(manifestPaths) !== JSON.stringify(expected)) {
    errors.push("Asset manifest paths do not match Desk's stable asset contract.");
  }
  for (const asset of manifest.assets ?? []) {
    if (EXPECTED_ASSET_ROLES[asset.path] !== asset.role) {
      errors.push(`Incorrect asset role for ${asset.path ?? "unknown asset"}.`);
    }
  }

  // Dev accepts EITHER no media at all (a fresh checkout — the user enrolls a
  // character at runtime) OR every required asset present AND non-empty. A
  // present-but-empty file is media and must not pass.
  const anyMedia = EXPECTED_ASSETS.some((relative) =>
    fs.existsSync(path.join(assetRoot, relative)),
  );
  if (anyMedia || release) {
    for (const relative of EXPECTED_ASSETS) {
      const absolute = path.join(assetRoot, relative);
      if (!fs.existsSync(absolute) || fs.statSync(absolute).size === 0) {
        errors.push(`Missing or empty asset: ${relative}`);
      }
    }
  }

  if (release) {
    if (manifest.distributionAllowed !== true) {
      errors.push(
        "Asset distribution is disabled. Complete the license metadata and set distributionAllowed to true.",
      );
    }
    for (const asset of manifest.assets ?? []) {
      if (
        typeof asset.license !== "string" ||
        asset.license.trim() === "" ||
        typeof asset.source !== "string" ||
        asset.source.trim() === "" ||
        asset.source === "local-test-only"
      ) {
        errors.push(`Incomplete release license metadata: ${asset.path ?? "unknown asset"}`);
      }
    }
  }
  return errors;
}

if (require.main === module) {
  const release = process.argv.includes("--release");
  const errors = validateAssets({ release });
  if (errors.length > 0) {
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log(
      release
        ? "Desk assets are complete and marked for distribution."
        : "Desk asset contract is valid (local character media may be absent).",
    );
  }
}

module.exports = {
  ASSET_ROOT,
  EXPECTED_ASSET_ROLES,
  EXPECTED_ASSETS,
  listRuntimeAssets,
  validateAssets,
};
