"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PROJECT_ROOT = path.join(__dirname, "..");
const ASSET_ROOT = path.join(PROJECT_ROOT, "public", "assets");
const MANIFEST_PATH = path.join(ASSET_ROOT, "manifest.json");

/**
 * Desk redistributes NO character media. Owner decision, 2026-09-10: a model
 * shipped by default is a licensing and content-moderation liability the app
 * should never carry — the app directs users to VRoid Hub (or any VRM 1.0
 * file they have the rights to) and loads what they enrolled themselves.
 *
 * So the contract is the INVERSE of the one this file used to enforce:
 *
 *   - `manifest.assets` is EMPTY, and stays empty;
 *   - a RELEASE must have no `.vrm`/`.vrma` anywhere under assets/ — a local
 *     model in a dev tree is normal runtime media (installCharacter* and
 *     vroid-sync write `model.vrm`, `model-slot<N>.vrm` and
 *     `animations/*.vrma` there), but it must not reach a package;
 *   - dev accepts anything, because dev IS the user's own tree.
 *
 * The previous contract required exactly one redistributed asset (`model.vrm`,
 * "Gyigi" by Robotnik) and released only when `distributionAllowed` was true;
 * both the file and the flag are gone with it. Failing closed here means the
 * gate REFUSES to package a tree that contains a model, rather than merely
 * declining to require one — "ships no models" is a property a check has to
 * assert, not a hope.
 */
const EXPECTED_ASSETS = [];
const EXPECTED_ASSET_ROLES = {};

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

  const declared = (manifest.assets ?? []).map((asset) => asset.path).sort();
  if (JSON.stringify(declared) !== JSON.stringify([...EXPECTED_ASSETS].sort())) {
    errors.push(
      "Asset manifest declares redistributed assets — Desk ships no character models " +
        `(found: ${declared.join(", ") || "none"}).`,
    );
  }
  for (const asset of manifest.assets ?? []) {
    if (EXPECTED_ASSET_ROLES[asset.path] !== asset.role) {
      errors.push(`Incorrect asset role for ${asset.path ?? "unknown asset"}.`);
    }
  }

  if (release) {
    // The one thing a package must never contain. Names every offending file,
    // because "a model is present" without the path is a bad afternoon.
    const media = listRuntimeAssets(assetRoot);
    if (media.length > 0) {
      errors.push(
        "A release may not contain character media: " +
          `${media.join(", ")} under public/assets. Desk ships no models — ` +
          "remove them before packaging (they are per-user runtime state).",
      );
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
        ? "Desk release carries no character media and declares none."
        : "Desk asset contract is valid (local character media may be present; none of it is redistributed).",
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
