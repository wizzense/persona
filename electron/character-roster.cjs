"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { filterCharacters, isHidden } = require("./content-rating.cjs");
const {
  packProvides,
  packContentDir,
} = require("./content-rating-loader.cjs");

const ROOT = path.join(__dirname, "..");
// Test seam: content-rating.test.cjs points this at a per-process temp dir so
// its fixtures never appear in the REAL roster that pack-roster.test.cjs
// snapshots — the two test files run as parallel child processes and raced
// on this directory (measured 2026-08-25: "open roster lost a PG character:
// zz-gate-fixture-plain"). Production never sets the var.
const ROSTER_DIR =
  process.env.DESK_ROSTER_DIR || path.join(ROOT, "characters");
const ACTIVE_FILE = path.join(ROOT, ".active-character");
const RECENT_FILE = path.join(ROOT, ".recent-characters");
const RECENT_LIMIT = 6;
const ASSET_DIRS = [
  path.join(ROOT, "public", "assets"),
  path.join(ROOT, "dist", "assets"),
];

/**
 * Get pack characters if the desk:characters-mature capability is available.
 * Returns a list of character names from the pack, or [] if unavailable.
 */
function getPackCharacters() {
  if (!packProvides("persona:characters-mature")) {
    return [];
  }
  const packDir = packContentDir("persona:characters-mature", "persona");
  if (!packDir) {
    return [];
  }
  try {
    const charDir = path.join(packDir, "characters");
    if (!fs.existsSync(charDir)) {
      return [];
    }
    const entries = fs.readdirSync(charDir, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          fs.existsSync(path.join(charDir, entry.name, "model.vrm")),
      )
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Every character on disk (dev tree + pack), ratings ignored. Internal — callers that show a
 *  character to a human must use listCharacters() instead. */
function listAllCharacters() {
  let devCharacters;
  try {
    const entries = fs.readdirSync(ROSTER_DIR, { withFileTypes: true });
    devCharacters = entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          fs.existsSync(path.join(ROSTER_DIR, entry.name, "model.vrm")),
      )
      .map((entry) => entry.name);
  } catch {
    devCharacters = [];
  }

  const packCharacters = getPackCharacters();
  const combined = [...devCharacters, ...packCharacters];
  return Array.from(new Set(combined)).sort();
}

/** The roster as a human may see it: R18/R15 characters are dropped entirely
 *  while the adult-content gate is closed. This is the ONE list the tray menu,
 *  the avatar right-click menu, the MCP `list_characters` tool and the renderer
 *  IPC all read, so filtering here covers every quick-switch surface at once. */
function listCharacters() {
  return filterCharacters(listAllCharacters());
}

/** Most-recently-switched-to characters, newest first (menu shows these, not all 60+). */
function getRecentCharacters(limit = RECENT_LIMIT) {
  let recent;
  try {
    recent = JSON.parse(fs.readFileSync(RECENT_FILE, "utf8"));
  } catch {
    recent = [];
  }
  const installed = new Set(listCharacters());
  const active = getActiveCharacter();
  const ordered = [active, ...recent].filter(
    (name, index, all) => name && installed.has(name) && all.indexOf(name) === index,
  );
  return ordered.slice(0, limit);
}

function rememberCharacter(name) {
  let recent;
  try {
    recent = JSON.parse(fs.readFileSync(RECENT_FILE, "utf8"));
  } catch {
    recent = [];
  }
  recent = [name, ...recent.filter((entry) => entry !== name)].slice(0, RECENT_LIMIT * 2);
  try {
    fs.writeFileSync(RECENT_FILE, JSON.stringify(recent));
  } catch {
    /* a missing recents file only costs menu ordering */
  }
}

function getActiveCharacter() {
  try {
    return fs.readFileSync(ACTIVE_FILE, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** Copy the character's model (and optional animation overrides) into both asset
 *  trees. Returns true when the character existed and was installed.
 *
 *  Refuses a hidden character. Filtering the menus alone would be cosmetic —
 *  `set_character` over MCP, switch-character.ps1 and the model browser all take
 *  a name directly, so the gate has to hold at the point of INSTALL as well as
 *  at the point of display. */
function installCharacter(name) {
  if (isHidden(name)) return false;

  // Try dev tree first, then pack
  let source = path.join(ROSTER_DIR, name);
  let model = path.join(source, "model.vrm");

  if (!fs.existsSync(model)) {
    // Try loading from pack
    const packDir = packContentDir("persona:characters-mature", "persona");
    if (packDir) {
      source = path.join(packDir, "characters", name);
      model = path.join(source, "model.vrm");
    }
  }

  if (!fs.existsSync(model)) return false;

  for (const assetDir of ASSET_DIRS) {
    fs.mkdirSync(path.join(assetDir, "animations"), { recursive: true });
    fs.copyFileSync(model, path.join(assetDir, "model.vrm"));
    const animations = path.join(source, "animations");
    if (fs.existsSync(animations)) {
      for (const file of fs.readdirSync(animations)) {
        if (file.endsWith(".vrma")) {
          fs.copyFileSync(
            path.join(animations, file),
            path.join(assetDir, "animations", file),
          );
        }
      }
    }
  }
  fs.writeFileSync(ACTIVE_FILE, `${name}\n`);
  rememberCharacter(name);
  return true;
}

/** Enroll the newest .vrm from Downloads into the roster; returns its roster name. */
function enrollNewestDownload(preferredName = null) {
  const downloads = path.join(os.homedir(), "Downloads");
  let candidates;
  try {
    candidates = fs
      .readdirSync(downloads)
      .filter((file) => file.toLowerCase().endsWith(".vrm"))
      .map((file) => {
        const full = path.join(downloads, file);
        return { file, full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return null;
  }
  const newest = candidates[0];
  if (!newest) return null;
  const base =
    preferredName ||
    path
      .basename(newest.file, path.extname(newest.file))
      .replace(/[^\w-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() ||
    "character";
  const dir = path.join(ROSTER_DIR, base);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(newest.full, path.join(dir, "model.vrm"));
  return base;
}

/** Where a spawned slot's model comes from and where it must land -- decided
 *  synchronously and CHEAPLY (existence checks only), so the caller can refuse a
 *  bad spawn at once. The bytes move in `copyIfChanged`, off the event loop.
 *
 *  Measured 2026-09-18 (`/health.stage.mainLag`): the old synchronous
 *  `copyFileSync` of an 18-66 MB model into two asset trees blocked the main
 *  process for 516 ms and 949 ms on consecutive spawns -- IPC and every window's
 *  input stall with it.
 *
 *  Does NOT write ACTIVE_FILE or call rememberCharacter() (slot-0 concepts).
 *  Refuses a hidden character (same gate as installCharacter). Returns
 *  `{ url, copies: [{ from, to }] }` or null. */
function planSlotInstall(name, slotId) {
  if (isHidden(name)) return null;

  // Try dev tree first, then pack
  let source = path.join(ROSTER_DIR, name);
  let model = path.join(source, "model.vrm");

  if (!fs.existsSync(model)) {
    const packDir = packContentDir("persona:characters-mature", "persona");
    if (packDir) {
      source = path.join(packDir, "characters", name);
      model = path.join(source, "model.vrm");
    }
  }

  if (!fs.existsSync(model)) return null;

  const modelFilename = `model-${slotId}.vrm`;
  const animations = path.join(source, "animations");
  const clips = fs.existsSync(animations) ? fs.readdirSync(animations).filter((file) => file.endsWith(".vrma")) : [];
  const copies = [];
  for (const assetDir of ASSET_DIRS) {
    copies.push({ from: model, to: path.join(assetDir, modelFilename) });
    for (const file of clips) copies.push({ from: path.join(animations, file), to: path.join(assetDir, "animations", file) });
  }
  return { url: `./assets/${modelFilename}`, copies };
}

/** Copy each pair without blocking the event loop, skipping a destination that
 *  already holds the same bytes (same size, not older than the source) -- the
 *  same character re-spawned, or a clip shared by every character, costs a stat.
 *  Resolves `{ copied, skipped }`; rejects on the first real failure. */
async function copyIfChanged(copies, fsp = fs.promises) {
  let copied = 0;
  let skipped = 0;
  for (const { from, to } of copies) {
    const src = await fsp.stat(from);
    const dst = await fsp.stat(to).catch(() => null);
    if (dst && dst.size === src.size && dst.mtimeMs >= src.mtimeMs) {
      skipped += 1;
      continue;
    }
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.copyFile(from, to);
    copied += 1;
  }
  return { copied, skipped };
}

/** One install at a time. Every character shares the clip files under
 *  `animations/`, so two spawns copying concurrently write the SAME destination
 *  and Windows answers EBUSY -- measured 2026-09-18: three quick spawns, the
 *  second body never appeared. A failed install does not poison the queue. */
let installChain = Promise.resolve();
function queueInstall(copies, fsp = fs.promises) {
  const run = installChain.then(() => copyIfChanged(copies, fsp));
  installChain = run.catch(() => {});
  return run;
}

module.exports = {
  ROSTER_DIR,
  getRecentCharacters,
  enrollNewestDownload,
  getActiveCharacter,
  installCharacter,
  copyIfChanged,
  planSlotInstall,
  queueInstall,
  listAllCharacters,
  listCharacters,
};
