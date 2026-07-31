"use strict";

/**
 * Content pack runtime loader for Persona (Node.js/Electron).
 *
 * Answers: "is capability X available right now?"
 *  = an installed pack provides it AND the adult gate is open
 *
 * Fail-closed on every error.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// CONTENT packs, not ~/.aither/packs -- that path is the per-pack runtime
// DATA directory for the AitherOS code packs (taxdesk, forge-studio,
// themis-legal, vault). Pointing here at the wrong root made every pack
// character unreachable EVEN WITH THE GATE OPEN, which turns the gate into
// a deletion: it passes every denial test while the feature is simply gone.
const PACKS_ROOT = path.join(os.homedir(), ".aither", "content-packs");
const ADULT_GATE = path.join(os.homedir(), ".aither", "adult_content.json");

let packCache = null;
let gateCacheAt = 0;
const CACHE_MS = 5000;

/**
 * Read the adult content gate (~/.aither/adult_content.json).
 *
 * @returns {boolean} True only if visible=true is set. False on any error.
 */
function readAdultGate() {
  const now = Date.now();
  if (packCache && now - gateCacheAt < CACHE_MS) {
    return packCache.gateValue || false;
  }

  let visible = false;
  try {
    visible = JSON.parse(fs.readFileSync(ADULT_GATE, "utf8")).visible === true;
  } catch {
    visible = false;
  }

  gateCacheAt = now;
  if (!packCache) packCache = {};
  packCache.gateValue = visible;

  return visible;
}

/**
 * Load all installed packs.
 *
 * @returns {Array<Object>} List of manifest objects
 */
function loadPacks() {
  const now = Date.now();
  if (packCache && now - packCache.loadedAt < CACHE_MS) {
    return packCache.packs || [];
  }

  let packs = [];
  try {
    if (fs.existsSync(PACKS_ROOT)) {
      const entries = fs.readdirSync(PACKS_ROOT, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          const manifestPath = path.join(
            PACKS_ROOT,
            entry.name,
            "manifest.json",
          );
          if (fs.existsSync(manifestPath)) {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
            packs.push(manifest);
          }
        } catch {
          // Silently skip corrupted manifests
        }
      }
    }
  } catch {
    // Silently return empty list if packs root is unreadable
  }

  if (!packCache) packCache = {};
  packCache.packs = packs;
  packCache.loadedAt = now;

  return packs;
}

/**
 * Check if an installed pack provides a capability.
 *
 * A capability is available only if:
 *   1. An installed pack provides it
 *   2. The adult gate is open (if pack is rated r15+ or provides adult content)
 *
 * @param {string} capability - Capability name (e.g. "persona:characters")
 * @returns {boolean} True if capability is available right now
 */
function packProvides(capability) {
  try {
    const packs = loadPacks();
    for (const pack of packs) {
      if (!pack.provided || !pack.provided.includes(capability)) continue;

      // Check rating - if it's adult content, gate it
      const rating = pack.rating || "general";
      if (["r15", "r18"].includes(rating)) {
        if (!readAdultGate()) return false;
      }
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Get the content directory for a capability in a specific tree.
 *
 * @param {string} capability - Capability name (e.g. "persona:characters")
 * @param {string} tree - Tree name (e.g. "persona", "media-forge")
 * @returns {string|null} Path to content directory if available, null otherwise
 */
function packContentDir(capability, tree) {
  if (!packProvides(capability)) return null;

  try {
    const packs = loadPacks();
    for (const pack of packs) {
      if (!pack.provided || !pack.provided.includes(capability)) continue;

      const packId = pack.id;
      const contentPath = path.join(PACKS_ROOT, packId, "content", tree);
      if (fs.existsSync(contentPath)) {
        return contentPath;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * List all capabilities provided by installed packs.
 *
 * @returns {Array<string>} List of capability names (gated by adult gate if applicable)
 */
function listAvailableCapabilities() {
  try {
    const packs = loadPacks();
    const capabilities = new Set();

    for (const pack of packs) {
      const rating = pack.rating || "general";
      const provided = pack.provided || [];

      // Filter by adult gate if needed
      if (["r15", "r18"].includes(rating)) {
        if (!readAdultGate()) continue;
      }

      for (const cap of provided) {
        capabilities.add(cap);
      }
    }

    return Array.from(capabilities).sort();
  } catch {
    return [];
  }
}

/**
 * Clear the cache (used by tests and when the gate changes).
 */
function invalidateCache() {
  packCache = null;
  gateCacheAt = 0;
}

module.exports = {
  packProvides,
  packContentDir,
  listAvailableCapabilities,
  invalidateCache,
  readAdultGate,
};
