"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { filterCharacters, isHidden } = require("./content-rating.cjs");

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
 * resolveModelFile — the .vrm bytes for a character, following `base`.
 *
 * A forked character (character.json `base` + `customise`) has no model.vrm of
 * its own; the mesh is its base's and the differences are applied at LOAD time
 * by the renderer. Walks the chain with a cycle guard and a depth cap, because
 * a hand-edited character.json can name a loop and a loop here is a hang in
 * front of the avatar window.
 */
function resolveModelFile(name, { depth = 8 } = {}) {
  const seen = new Set();
  let node = name;
  for (let hop = 0; node && hop < depth && !seen.has(node); hop += 1) {
    seen.add(node);
    const own = path.join(ROSTER_DIR, node, "model.vrm");
    if (fs.existsSync(own)) return own;
    node = contentRating().baseOf ? contentRating().baseOf(node) : null;
  }
  return null;
}

/** The customise recipe for a character, MERGED down its base chain (a
 *  variant's own values win). `{}` when nothing is customised. */
function customiseOf(name, { depth = 8 } = {}) {
  const chain = [];
  const seen = new Set();
  let node = name;
  for (let hop = 0; node && hop < depth && !seen.has(node); hop += 1) {
    seen.add(node);
    const record = contentRating().ratingRecord(node);
    if (record && typeof record.customise === "object" && record.customise) chain.push(record.customise);
    node = contentRating().baseOf(node);
  }
  // Furthest base first, so a nearer variant overrides it section by section.
  const out = {};
  for (const layer of chain.reverse()) {
    for (const [section, value] of Object.entries(layer)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        out[section] = { ...(out[section] || {}), ...value };
      } else {
        out[section] = value;
      }
    }
  }
  return out;
}

/**
 * forkCharacter — a new roster entry that is a RECIPE over an existing one.
 *
 * Owner, 2026-09-20: "can we fork and customise all of the characters we've
 * downloaded". This is the cheap half of that: no mesh is copied, so a variant
 * is a few hundred bytes and the original is never touched. The renderer
 * applies `customise` (blendshapes, bone scales, material colours) at load,
 * through the same seam the spring-physics knobs use.
 *
 * Refuses when: the base does not exist, the base is not licensed for
 * modification (the .vrm says so -- see vrm-license), the variant name is not a
 * slug, or the name is taken. The rating is NOT chosen here: content-rating's
 * getRating walks `base`, so a fork can never be tamer than what it forked.
 *
 * @returns {{ok: boolean, name: string|null, reason: string|null}}
 */
function forkCharacter(base, variant, customise = {}, options = {}) {
  const rating = contentRating();
  if (!isValidSlug(base) || !isValidSlug(variant)) {
    return { ok: false, name: null, reason: "base and variant must be slugs" };
  }
  if (!fs.existsSync(path.join(ROSTER_DIR, base))) {
    return { ok: false, name: null, reason: `no character named ${base}` };
  }
  if (!resolveModelFile(base)) {
    return { ok: false, name: null, reason: `${base} resolves to no model.vrm` };
  }
  const name = `${base}-${variant}`;
  const dir = path.join(ROSTER_DIR, name);
  if (fs.existsSync(dir)) return { ok: false, name: null, reason: `${name} already exists` };
  const licence = options.licence || modificationAllowed(base);
  if (licence.allowed === false) {
    // The .vrm's own meta says no. That is the author's term, not our policy.
    return { ok: false, name: null, reason: `${base} is not licensed for modification (${licence.detail})` };
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "character.json"),
      JSON.stringify({
        base,
        customise: customise && typeof customise === "object" ? customise : {},
        // Its OWN rating is deliberately absent: getRating inherits the base's,
        // and writing one here would be the laundering this design refuses.
        source: "fork",
        forkedAt: new Date().toISOString(),
        licence: licence.detail || null,
      }, null, 2),
    );
  } catch (error) {
    return { ok: false, name: null, reason: `could not write the variant: ${error && error.message}` };
  }
  return { ok: true, name, reason: null, rating: rating.getRating(name) };
}

function isValidSlug(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 80
    && !value.includes("/") && !value.includes("\\") && !value.includes("\0")
    && value !== "." && value !== "..";
}

/**
 * modificationAllowed — what the MODEL's own embedded licence says.
 *
 * Measured across this roster on 2026-09-20: every one of the 66 permits it (48
 * VRM 0.x `modification=allow`, 1 `allowModification`, 17
 * `allowModificationRedistribution`), so this gate costs nothing today and is
 * the thing that stops it costing everything the day a model that forbids it
 * arrives. Unreadable meta is NOT a yes: it returns null (unknown), and the
 * caller decides -- forkCharacter proceeds on unknown and records what it saw,
 * because refusing every model whose meta we cannot parse would make the
 * feature useless on VRM 0.x models that simply omit the field.
 */
function modificationAllowed(name) {
  const file = resolveModelFile(name);
  if (!file) return { allowed: null, detail: "no model.vrm to read" };
  let doc;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const header = Buffer.alloc(20);
      fs.readSync(fd, header, 0, 20, 0);
      if (header.toString("utf8", 0, 4) !== "glTF") return { allowed: null, detail: "not a GLB" };
      const chunkLength = header.readUInt32LE(12);
      const body = Buffer.alloc(Math.min(chunkLength, 8 * 1024 * 1024));
      fs.readSync(fd, body, 0, body.length, 20);
      doc = JSON.parse(body.toString("utf8"));
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    return { allowed: null, detail: `unreadable meta: ${error && error.message}` };
  }
  const ext = (doc && doc.extensions) || {};
  if (ext.VRMC_vrm) {
    const mod = String((ext.VRMC_vrm.meta || {}).modification || "");
    if (mod === "prohibited") return { allowed: false, detail: "VRM 1.0 modification=prohibited" };
    if (mod.startsWith("allowModification")) return { allowed: true, detail: `VRM 1.0 ${mod}` };
    return { allowed: null, detail: `VRM 1.0 modification=${mod || "absent"}` };
  }
  if (ext.VRM) {
    const meta = ext.VRM.meta || {};
    const url = String(meta.otherPermissionUrl || meta.otherLicenseUrl || "");
    const hit = /[?&]modification=([^&]+)/.exec(url);
    const lic = String(meta.licenseName || "");
    if (hit) {
      const value = decodeURIComponent(hit[1]);
      if (value === "disallow") return { allowed: false, detail: "VRM 0.x modification=disallow" };
      return { allowed: true, detail: `VRM 0.x modification=${value}` };
    }
    if (/_ND$/.test(lic)) return { allowed: false, detail: `VRM 0.x ${lic} (NoDerivatives)` };
    return { allowed: null, detail: `VRM 0.x licenseName=${lic || "absent"}` };
  }
  return { allowed: null, detail: "no VRM extension" };
}

/** Lazy, so content-rating and this module can require each other. */
function contentRating() {
  return require("./content-rating.cjs");
}

/** Every character on disk, ratings ignored. Internal — callers that show a
 *  character to a human must use listCharacters() instead. */
function listAllCharacters() {
  let devCharacters;
  try {
    const entries = fs.readdirSync(ROSTER_DIR, { withFileTypes: true });
    devCharacters = entries
      .filter((entry) => {
        if (!entry.isDirectory()) return false;
        if (fs.existsSync(path.join(ROSTER_DIR, entry.name, "model.vrm"))) return true;
        // A FORK owns no mesh -- it is a recipe over a base (forkCharacter). It
        // is a real roster entry and must be listed, or it is invisible to the
        // menus, to the rating gate and to the full-body capture that judges it.
        return resolveModelFile(entry.name) !== null;
      })
      .map((entry) => entry.name);
  } catch {
    devCharacters = [];
  }

  return Array.from(new Set(devCharacters)).sort();
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

  // 🚩 The roster dir is the ONLY source (owner, 2026-09-19: "help people connect
  // and find their own avatars"). The mature content pack that used to be the
  // fallback here is gone from the product; the per-character age-rating gate
  // (content-rating.cjs) stays, because VRoid Hub models arrive with r15/r18
  // flags and honouring them is what keeps a downloaded roster safe.
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

/** Decide WHAT would be enrolled, writing nothing: `{ base, from }` or null.
 *
 *  Split out from `enrollNewestDownload` on 2026-09-19 so the safety funnel has a
 *  point to refuse AT. A verdict that arrives after the bytes are copied is not a
 *  gate, it is a log line. */
function planEnrollment(preferredName = null) {
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
  return { base, from: newest.full };
}

/** Do the copy a plan describes; returns the roster name. */
function performEnrollment(plan) {
  if (!plan || !plan.base || !plan.from) return null;
  const dir = path.join(ROSTER_DIR, plan.base);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(plan.from, path.join(dir, "model.vrm"));
  return plan.base;
}

/** Enroll the newest .vrm from Downloads into the roster; returns its roster name.
 *  Unchecked: kept for callers that already hold a verdict. New UI paths use
 *  `enrollNewestDownloadChecked`. */
function enrollNewestDownload(preferredName = null) {
  return performEnrollment(planEnrollment(preferredName));
}

/** The SAFETY-FUNNELLED enrollment path (`.AITHERIUM/CAPABILITY/AVATAR-FORGE-PIPELINE.md`
 *  stage 6: "consulted at the two places output becomes visible").
 *
 *  A downloaded VRM is an outside artifact entering the roster under a name that becomes
 *  the folder, the cast binding and the Dark Matters guide key — so the name is asked
 *  about BEFORE any byte is copied. A refusal writes nothing and says why; an unreachable
 *  safety plane enrolls anyway and records `degraded` (see safety-gate.cjs: refusing every
 *  enrollment while a container restarts would be an outage this funnel invented).
 *
 *  @returns {{ok: boolean, name: string|null, reason: string|null, verdict: object|null}}
 */
async function enrollNewestDownloadChecked(preferredName = null, options = {}) {
  // `plan` and `perform` are TEST SEAMS: production passes neither, so a box with no .vrm in
  // Downloads cannot make the refusal path untestable (it did — the first version of the
  // test passed for the wrong reason, reporting "nothing to enroll" as a refusal).
  const plan = options.plan || planEnrollment(preferredName);
  if (!plan) return { ok: false, name: null, reason: "no .vrm found in Downloads to enroll", verdict: null };

  let verdict = null;
  const consult = options.consultInstall || safetyConsultInstall();
  if (consult) {
    try {
      verdict = await consult(plan.base, options.safety || {});
    } catch (error) {
      // Fails OPEN like the speech half: a bug in the funnel must not make enrolling a
      // model impossible, and an unhandled rejection in a menu click handler is invisible.
      verdict = {
        allow: true,
        changed: false,
        reachable: false,
        reason: `safety gate threw: ${error && error.message ? error.message : error}`,
      };
    }
    if (verdict && verdict.allow === false) {
      return { ok: false, name: null, reason: verdict.reason || "refused by the safety plane", verdict };
    }
  }
  const perform = options.perform || performEnrollment;
  const name = perform(plan);
  if (!name) return { ok: false, name: null, reason: "the copy into the roster failed", verdict };
  // A hand-enrolled model arrives with NO character.json, and since 2026-09-20 an
  // unjudged character is hidden with the adult ones -- so without this the owner
  // drops a .vrm in and it silently never appears. Judge it now. Fire-and-forget:
  // the enroll already succeeded and a rater that cannot run must not undo it.
  const rating = rateOnEnroll(name, options);
  return { ok: true, name, reason: null, verdict, rating };
}

/**
 * rateOnEnroll — judge ONE freshly enrolled character, in the background.
 *
 * Runs `rate-characters.py --only <name> --apply --vision --capture`: the desk
 * renders a full-body frame of the model (bridge POST /roster/capture) and a
 * vision model rates it. Returns what the caller should TELL the owner, never a
 * promise -- the menu click that triggered the enroll has already returned.
 *
 * 🚩 It writes a PENDING marker first. Until the rater answers, the character is
 * `unrated` and therefore hidden, and "hidden" with no explanation is exactly
 * the failure this function exists to avoid: the marker makes the state legible
 * to `rate-characters.py --report` and to the Cast pane's hidden list. If python
 * or the rater is missing the marker stays, and the owner gets the one command
 * that fixes it rather than a model that vanished.
 */
function rateOnEnroll(name, options = {}) {
  const spawn = options.spawn || require("node:child_process").spawn;
  const dir = path.join(ROSTER_DIR, name);
  try {
    const file = path.join(dir, "character.json");
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify({ rating: "unrated", source: "pending" }, null, 2));
    }
  } catch {
    /* the rater below is what decides; a marker we could not write is not fatal */
  }
  const python = options.python || process.env.DESK_PYTHON || "python";
  try {
    const child = spawn(
      python,
      [path.join(ROOT, "rate-characters.py"), "--only", name, "--apply", "--vision", "--capture"],
      { cwd: ROOT, detached: true, stdio: "ignore", windowsHide: true },
    );
    if (child && typeof child.unref === "function") child.unref();
    return { started: true, hint: `rating ${name} now (full-body look); it appears once judged` };
  } catch (error) {
    return {
      started: false,
      hint: `${name} is enrolled but UNJUDGED, so it stays hidden. Rate it: `
        + `python rate-characters.py --only ${name} --apply --vision --capture`,
      error: String((error && error.message) || error),
    };
  }
}

/** Guarded require, the same shape main.cjs uses for voice-resolve: a missing or broken
 *  gate module must not take the enrollment path down with it. */
function safetyConsultInstall() {
  try {
    const gate = require("./safety-gate.cjs");
    return typeof gate.consultInstall === "function" ? gate.consultInstall : null;
  } catch {
    return null;
  }
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

  // 🚩 The roster dir is the ONLY source (owner, 2026-09-19: "help people connect
  // and find their own avatars"). The mature content pack that used to be the
  // fallback here is gone from the product; the per-character age-rating gate
  // (content-rating.cjs) stays, because VRoid Hub models arrive with r15/r18
  // flags and honouring them is what keeps a downloaded roster safe.
  const source = path.join(ROSTER_DIR, name);
  // A VARIANT owns no model.vrm: it is a recipe over a base (see forkCharacter).
  // Resolve the bytes from the base and let the renderer apply the deltas, so a
  // fork costs a few hundred bytes instead of another 60 MB of mesh.
  const model = resolveModelFile(name);

  if (!model || !fs.existsSync(model)) return null;

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
  rateOnEnroll,
  forkCharacter,
  customiseOf,
  modificationAllowed,
  resolveModelFile,
  ROSTER_DIR,
  getRecentCharacters,
  enrollNewestDownload,
  enrollNewestDownloadChecked,
  planEnrollment,
  performEnrollment,
  getActiveCharacter,
  installCharacter,
  copyIfChanged,
  planSlotInstall,
  queueInstall,
  listAllCharacters,
  listCharacters,
};
