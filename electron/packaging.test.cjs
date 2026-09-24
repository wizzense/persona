"use strict";

// electron-builder ships ONLY what package.json build.files matches. A page or
// stylesheet the app loads at runtime but the globs miss works from a checkout
// and comes up blank (ERR_FILE_NOT_FOUND) in an installed build -- nothing else
// in `npm run check` looks at the files list, so this test is the gate.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { PANES } = require("./console-window.cjs");

const HERE = __dirname;
const ROOT = path.join(HERE, "..");
const FILES = require("../package.json").build.files;

/** A glob -> RegExp for the subset electron-builder patterns here use
 *  (`**`, `*`, `?`). No minimatch: it is only a transitive dependency. */
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } else { re += ".*"; i += 1; }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Last matching pattern wins; a leading `!` excludes. */
function isPackaged(rel, patterns = FILES) {
  const posix = rel.split(path.sep).join("/");
  let shipped = false;
  for (const raw of patterns) {
    const negate = raw.startsWith("!");
    if (globToRegExp(negate ? raw.slice(1) : raw).test(posix)) shipped = !negate;
  }
  return shipped;
}

const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join("/");
const runtimeModules = () => fs.readdirSync(HERE)
  .filter((f) => f.endsWith(".cjs") && !f.endsWith(".test.cjs"));

/** Every electron/ page the app loads: PANES kind:"file" plus each window's
 *  loadFile(path.join(__dirname, "x.html")). */
function loadedPages() {
  const pages = new Set(PANES.filter((p) => p.kind === "file").map((p) => p.file));
  for (const mod of runtimeModules()) {
    const src = fs.readFileSync(path.join(HERE, mod), "utf8");
    for (const m of src.matchAll(/path\.join\(__dirname,\s*"([^"]+\.html)"\)/g)) pages.add(m[1]);
  }
  return [...pages];
}

/** The require("./x.cjs") closure starting at main.cjs -- lazy requires too. */
function requireClosure(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = fs.readFileSync(path.join(HERE, file), "utf8");
    for (const m of src.matchAll(/require\(\s*["']\.\/([^"']+\.cjs)["']\s*\)/g)) {
      if (fs.existsSync(path.join(HERE, m[1]))) queue.push(m[1]);
    }
  }
  return [...seen];
}

test("the glob matcher honours ** and the !*.test.cjs exclusion", () => {
  assert.equal(isPackaged("electron/main.cjs"), true);
  assert.equal(isPackaged("electron/main.test.cjs"), false);
  assert.equal(isPackaged("electron/test/x.test.cjs"), false);
  assert.equal(isPackaged("src/App.tsx"), false);
  // The pre-fix list (4e60eea..): pages and stylesheets were left out.
  const old = ["dist/**/*", "electron/**/*.cjs", "!electron/**/*.test.cjs"];
  assert.equal(isPackaged("electron/home.html", old), false);
  assert.equal(isPackaged("electron/home-summary.cjs", old), true);
});

test("every page the app loads is in build.files", () => {
  const pages = loadedPages();
  assert.ok(pages.includes("home.html") && pages.includes("console.html"),
    `page discovery found too little: ${pages.join(", ")}`);
  for (const page of pages) {
    const abs = path.join(HERE, page);
    assert.ok(fs.existsSync(abs), `${page} is loaded but does not exist`);
    assert.ok(isPackaged(rel(abs)), `${rel(abs)} is loaded at runtime but build.files leaves it out`);
  }
});

test("every stylesheet and script those pages link is in build.files", () => {
  let linked = 0;
  for (const page of loadedPages()) {
    const html = fs.readFileSync(path.join(HERE, page), "utf8");
    const refs = [
      ...[...html.matchAll(/<link\b[^>]*rel=["']?stylesheet[^>]*>/gi)]
        .map((m) => /href=["']([^"']+)["']/i.exec(m[0])?.[1]),
      ...[...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map((m) => m[1]),
    ].filter((href) => href && !/^[a-z]+:/i.test(href));
    for (const href of refs) {
      linked += 1;
      const abs = path.join(HERE, href.split(/[?#]/)[0]);
      assert.ok(fs.existsSync(abs), `${page} links ${href}, which does not exist`);
      assert.ok(isPackaged(rel(abs)), `${page} links ${rel(abs)} but build.files leaves it out`);
    }
  }
  assert.ok(linked > 0, "no stylesheet links found -- the page scan is broken");
});

test("every module main.cjs requires (transitively) is in build.files", () => {
  const mods = requireClosure("main.cjs");
  assert.ok(mods.length > 20, `require scan found only ${mods.length} modules`);
  for (const mod of mods) {
    assert.ok(isPackaged(`electron/${mod}`), `electron/${mod} is required but build.files leaves it out`);
  }
});

test("every same-dir data file a module reads via __dirname is in build.files", () => {
  // aither-themes.json, agent-roster.generated.json: read at runtime, not required.
  for (const mod of runtimeModules()) {
    const src = fs.readFileSync(path.join(HERE, mod), "utf8");
    for (const m of src.matchAll(/path\.join\(__dirname,\s*"([^"/]+\.(?:json|css|png|svg))"\)/g)) {
      const abs = path.join(HERE, m[1]);
      if (!fs.existsSync(abs)) continue;
      assert.ok(isPackaged(rel(abs)), `${mod} reads ${rel(abs)} but build.files leaves it out`);
    }
  }
});
