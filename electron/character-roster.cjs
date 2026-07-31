"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { filterCharacters, isHidden } = require("./content-rating.cjs");

const ROOT = path.join(__dirname, "..");
const ROSTER_DIR = path.join(ROOT, "characters");
const ACTIVE_FILE = path.join(ROOT, ".active-character");
const RECENT_FILE = path.join(ROOT, ".recent-characters");
const RECENT_LIMIT = 6;
const ASSET_DIRS = [
  path.join(ROOT, "public", "assets"),
  path.join(ROOT, "dist", "assets"),
];

/** Every character on disk, ratings ignored. Internal — callers that show a
 *  character to a human must use listCharacters() instead. */
function listAllCharacters() {
  let entries = [];
  try {
    entries = fs.readdirSync(ROSTER_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        fs.existsSync(path.join(ROSTER_DIR, entry.name, "model.vrm")),
    )
    .map((entry) => entry.name)
    .sort();
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
  let recent = [];
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
  let recent = [];
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
  const source = path.join(ROSTER_DIR, name);
  const model = path.join(source, "model.vrm");
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
  let candidates = [];
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

module.exports = {
  ROSTER_DIR,
  getRecentCharacters,
  enrollNewestDownload,
  getActiveCharacter,
  installCharacter,
  listAllCharacters,
  listCharacters,
};
