"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PROJECT_ROOT = path.join(__dirname, "..");
const ASSET_ROOT = path.join(PROJECT_ROOT, "public", "assets");
const MANIFEST_PATH = path.join(ASSET_ROOT, "manifest.json");
const EXPECTED_ASSETS = [
  "model.vrm",
  "animations/idle.vrma",
  "animations/talk1.vrma",
  "animations/talk2.vrma",
  "animations/talk3.vrma",
  "animations/greeting.vrma",
  "animations/happy.vrma",
  "animations/finger-gun.vrma",
  "animations/dance.vrma",
];
const EXPECTED_ASSET_ROLES = {
  "model.vrm": "model",
  "animations/idle.vrma": "idle",
  "animations/talk1.vrma": "talk",
  "animations/talk2.vrma": "talk",
  "animations/talk3.vrma": "talk",
  "animations/greeting.vrma": "greeting",
  "animations/happy.vrma": "happy",
  "animations/finger-gun.vrma": "finger-gun",
  "animations/dance.vrma": "dance",
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
  const actual = listRuntimeAssets(assetRoot);
  const mediaAbsent = actual.length === 0;
  if (JSON.stringify(manifestPaths) !== JSON.stringify(expected)) {
    errors.push("Asset manifest paths do not match Desk's stable asset contract.");
  }
  for (const asset of manifest.assets ?? []) {
    if (EXPECTED_ASSET_ROLES[asset.path] !== asset.role) {
      errors.push(`Incorrect asset role for ${asset.path ?? "unknown asset"}.`);
    }
  }
  if ((!mediaAbsent || release) && JSON.stringify(actual) !== JSON.stringify(expected)) {
    errors.push("Runtime asset files do not match Desk's stable asset contract.");
  }

  if (!mediaAbsent || release) {
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
        "Asset distribution is disabled. Replace the test-only files and set distributionAllowed to true.",
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
