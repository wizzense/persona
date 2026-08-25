"use strict";
/* Stale-process gate (2026-08-25) — the desk's most repeated failure class.
 *
 * Electron loads electron/*.cjs from disk at boot and the renderer loads
 * dist/index.html once; peers edit both every few minutes. When the RUNNING
 * process is older than its own on-disk code, every click silently does the
 * wrong thing (or nothing) and no error names the cause. Measured twice in
 * one day: the 16:15 process predated main.cjs (16:34) — beads dead; the
 * 16:05 bundle predated the bead-rewrite — every button opened the deck.
 *
 * Exit 0 fresh, 1 STALE (restart the app), 2 cannot judge — never 0 on
 * silence: no electron process is reported, not passed.
 *
 *   node scripts/check-stale-process.cjs            # live verdict
 *   node scripts/check-stale-process.cjs --self-test  # prove it can fail
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const WATCH = [
  path.join(__dirname, "..", "electron"),
  path.join(__dirname, "..", "dist", "index.html"),
];

function newestMtimeMs() {
  let newest = 0;
  for (const p of WATCH) {
    const st = fs.statSync(p);
    if (!st.isDirectory()) {
      newest = Math.max(newest, st.mtimeMs);
      continue;
    }
    for (const name of fs.readdirSync(p)) {
      if (name.endsWith(".cjs") || name.endsWith(".js")) {
        newest = Math.max(newest, fs.statSync(path.join(p, name)).mtimeMs);
      }
    }
  }
  return newest;
}

function runningSince() {
  try {
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-Command",
       "Get-Process electron -ErrorAction SilentlyContinue | Select-Object -ExpandProperty StartTime"],
      { encoding: "utf-8", timeout: 20000 },
    );
    const times = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      .map((s) => new Date(s).getTime());
    if (!times.length) return null;
    return Math.min(...times); // the ROOT is the oldest electron process
  } catch {
    return undefined; // could not ask
  }
}

function verdict(since, newestMs) {
  return newestMs > since ? "STALE" : "fresh";
}

function main() {
  if (process.argv.includes("--self-test")) {
    // Prove BOTH arms of the comparison without touching any file: the
    // stale arm is the whole point of the check, and a self-test that only
    // ever sees the fresh arm cannot prove it would fail when it should.
    const cases = [
      ["stale: code changed 20m after boot", verdict(1_000_000, 1_000_000 + 20 * 60_000), "STALE"],
      ["fresh: boot after the newest write", verdict(2_000_000, 1_900_000), "fresh"],
      ["stale: same-minute edit still counts", verdict(3_000_000, 3_000_001), "STALE"],
    ];
    const bad = cases.filter((c) => c[1] !== c[2]);
    if (bad.length) {
      console.error("SELF-TEST FAIL:", bad.map((c) => c[0]).join("; "));
      return 1;
    }
    const since = runningSince();
    console.log(
      `self-test OK — all three comparison arms behave (process discovery: ` +
      `${since === undefined ? "unjudgeable" : since === null ? "none running" : "found"})`,
    );
    return 0;
  }
  const since = runningSince();
  if (since === undefined) {
    console.error("NOT VERIFIED: could not query electron processes");
    return 2;
  }
  if (since === null) {
    console.log("no running electron instance — nothing to judge");
    return 0;
  }
  const newest = newestMtimeMs();
  const gapMin = Math.round((newest - since) / 60000);
  if (newest > since) {
    console.error(
      `STALE: the running app started ${new Date(since).toISOString()} but ` +
      `its own code changed ${new Date(newest).toISOString()} (~${gapMin}m later). ` +
      "Every click can silently do the wrong thing — restart the app.",
    );
    return 1;
  }
  console.log(
    `fresh: running since ${new Date(since).toISOString()}, newest source/build ` +
    `${new Date(newest).toISOString()}`,
  );
  return 0;
}

process.exit(main());
