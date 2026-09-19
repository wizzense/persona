"use strict";

/**
 * Put the Windows voice-output listener in place WITHOUT Visual Studio.
 *
 * Why: the avatar's lip-sync (the original core of Desk) needs
 * native/bin/win32/desk-audio-listener.exe, and `npm run native:build` needs
 * Visual Studio Build Tools to produce it. On a box without them the app boots,
 * draws, answers /health and reports `listener.available: false` — and the
 * character never speaks. MEASURED 2026-09-18 on the owner's own desk: the
 * helper had never existed there. The published installer carries a built
 * copy, so this pulls it out of the latest release instead of compiling.
 *
 * Refuses (exit 1) when the helper source is newer than the release it would
 * copy from — a stale binary that "works" is worse than a missing one.
 *
 *   node scripts/fetch-native-helper.cjs            # latest release
 *   node scripts/fetch-native-helper.cjs v0.1.0-beta.2
 *
 * Needs `gh` (authenticated) and 7-Zip. Both are named in the failure message.
 */

const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = "wizzense/persona";
const PROJECT_ROOT = path.join(__dirname, "..");
const HELPER_SRC = path.join("native", "windows", "DeskAudioListener.cpp");
const TARGET = path.join(PROJECT_ROOT, "native", "bin", "win32", "desk-audio-listener.exe");
const SEVEN_ZIP = [
  "7z",
  path.join(process.env.ProgramFiles || "C:\\Program Files", "7-Zip", "7z.exe"),
];

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", windowsHide: true, ...opts }).trim();
}

function find7z() {
  for (const candidate of SEVEN_ZIP) {
    const probe = spawnSync(candidate, ["i"], { windowsHide: true });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

function main() {
  if (process.platform !== "win32") {
    console.error("fetch-native-helper: only the Windows helper is fetched this way.");
    return 1;
  }
  const sevenZip = find7z();
  if (!sevenZip) {
    console.error("fetch-native-helper: 7-Zip not found (7z on PATH or C:\\Program Files\\7-Zip).");
    return 1;
  }
  // `gh release view` with no tag means "latest" and SKIPS pre-releases, which
  // is every Desk release so far — list the newest instead.
  const tag =
    process.argv[2] ||
    sh("gh", ["release", "list", "-R", REPO, "--limit", "1", "--json", "tagName",
              "-q", ".[0].tagName"]);
  if (!tag) {
    console.error(`fetch-native-helper: ${REPO} has no releases.`);
    return 1;
  }
  const published = sh("gh", [
    "release", "view", tag, "-R", REPO, "--json", "publishedAt", "-q", ".publishedAt",
  ]);
  // The helper source must not be newer than the release: a binary built
  // before the last source change is a silently wrong listener.
  const lastSourceChange = sh("git", ["log", "-1", "--format=%cI", "--", HELPER_SRC], {
    cwd: PROJECT_ROOT,
  });
  if (lastSourceChange && new Date(lastSourceChange) > new Date(published)) {
    console.error(
      `fetch-native-helper: ${HELPER_SRC} changed ${lastSourceChange}, after release ${tag} ` +
        `(${published}) — build it (npm run native:build) or cut a release first.`,
    );
    return 1;
  }
  const asset = sh("gh", [
    "release", "view", tag, "-R", REPO, "--json", "assets",
    "-q", '.assets[] | select(.name | test("windows-x64-setup\\\\.exe$")) | .name',
  ]);
  if (!asset) {
    console.error(`fetch-native-helper: release ${tag} has no windows-x64-setup.exe asset.`);
    return 1;
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "desk-helper-"));
  try {
    console.log(`fetch-native-helper: ${tag} -> ${asset}`);
    sh("gh", ["release", "download", tag, "-R", REPO, "-p", asset, "-D", work, "--clobber"]);
    sh(sevenZip, ["e", "-y", `-o${work}`, path.join(work, asset), "$PLUGINSDIR/app-64.7z"]);
    sh(sevenZip, [
      "e", "-y", `-o${work}`, path.join(work, "app-64.7z"),
      "resources/native/win32/desk-audio-listener.exe",
    ]);
    const extracted = path.join(work, "desk-audio-listener.exe");
    if (!fs.existsSync(extracted)) {
      console.error("fetch-native-helper: the installer did not contain the helper.");
      return 1;
    }
    fs.mkdirSync(path.dirname(TARGET), { recursive: true });
    fs.copyFileSync(extracted, TARGET);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  // Re-assert: the helper must answer as itself, not merely exist.
  const probe = spawnSync(TARGET, [], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  const answered = /--pid/.test(`${probe.stdout}${probe.stderr}`);
  if (!answered) {
    console.error(`fetch-native-helper: ${TARGET} does not answer like the listener.`);
    return 1;
  }
  console.log(`fetch-native-helper: OK ${TARGET} (${fs.statSync(TARGET).size} bytes)`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { TARGET };
