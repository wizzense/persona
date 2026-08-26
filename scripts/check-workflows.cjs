"use strict";

/**
 * check-workflows — the static gate for the TWO workflow defect classes that
 * each cost release runs on 2026-08-25. Both are invisible until a push:
 *
 *   W001  Broken YAML: an edit that drops the `env:` key while leaving its
 *         children behind parses fine to the eye and breaks GitHub's parser —
 *         the workflow gets registered under its FILE PATH and every push
 *         produces a 0-job "failure" zombie run. The fingerprint: a line
 *         indented 2+ deeper than the previous non-blank line, where that
 *         line is NOT a list item, does NOT end in `:` (a key with children)
 *         and does NOT end in `|` (a block scalar). `run: ${{ matrix.command }}`
 *         followed by deeper WIN_CSC_* keys is exactly that.
 *   W002  Signing env defined-from-absent-secrets: `CSC_LINK: ${{ secrets.X
 *         || '' }}` sets '' when the fork has no secret, and electron-builder
 *         26 treats ANY defined CSC_LINK — even empty — as explicit signing,
 *         resolves the empty cert path to the project dir and dies
 *         "⨯ <projectDir> not a file". CSC_IDENTITY_AUTO_DISCOVERY=false does
 *         NOT rescue it. The only correct unsigned path is NO signing env at
 *         all — so any CSC_LINK/CSC_KEY_PASSWORD env key in a workflow is a
 *         failure (certs change the rule when they arrive).
 *
 * Run: node scripts/check-workflows.cjs [--self-test]
 * Exit 0 = clean, 1 = violations, 2 = cannot run (DEAD, not passing).
 */

const fs = require("node:fs");
const path = require("node:path");

const WORKFLOW_DIR = path.join(__dirname, "..", ".github", "workflows");
const WORKFLOW_FILES = fs.existsSync(WORKFLOW_DIR)
  ? fs.readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
  : [];

function validateWorkflow(content, file) {
  const errors = [];
  const lines = content.split(/\r?\n/).map((l) => l.replace(/#.*$/, ""));

  // W001: indent +2 after a non-colon, non-|, non-list-item line.
  let prev = null;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    const indent = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (prev !== null) {
      const jumped = indent - prev.indent >= 2;
      const opener =
        prev.text.endsWith(":") || prev.text.endsWith("|") || prev.text.startsWith("- ");
      if (jumped && !opener) {
        errors.push(
          `${file}:${i + 1}: W001 broken indent (${indent} after ${prev.indent}) — "` +
            `${prev.text.slice(0, 40)}" declares no children; GitHub produces 0-job zombie runs`,
        );
      }
    }
    prev = { indent, text };
  }

  // W002: no signing env at all (comments stripped above).
  const stripped = lines.join("\n");
  if (/\bCSC_LINK\s*:/.test(stripped) || /\bCSC_KEY_PASSWORD\s*:/.test(stripped)) {
    errors.push(
      `${file}: W002 CSC_LINK/CSC_KEY_PASSWORD env — defined-but-empty from an ` +
        `absent secret breaks electron-builder 26 signing ("" resolves to the project dir)`,
    );
  }
  return errors;
}

function check() {
  if (WORKFLOW_FILES.length === 0) {
    console.error("check-workflows: no workflow files found — DEAD, not passing");
    process.exit(2);
  }
  const all = [];
  for (const file of WORKFLOW_FILES) {
    let content;
    try {
      content = fs.readFileSync(path.join(WORKFLOW_DIR, file), "utf8");
    } catch (error) {
      console.error(`check-workflows: cannot read ${file}: ${error.message}`);
      process.exit(2);
    }
    all.push(...validateWorkflow(content, file));
  }
  if (all.length > 0) {
    for (const error of all) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log(`check-workflows: ${WORKFLOW_FILES.length} workflow file(s) clean`);
  process.exit(0);
}

function selfTest() {
  let failed = 0;
  const cases = [
    {
      name: "W001 broken indent (the dropped env: edit)",
      content: [
        "jobs:",
        "  package:",
        "    steps:",
        "      - name: Build native installer",
        "        run: ${{ matrix.command }}",
        "          WIN_CSC_LINK: ${{ secrets.WIN_CSC_LINK }}",
        "",
      ].join("\n"),
      expect: /W001/,
    },
    {
      name: "W002 signing env present",
      content: [
        "jobs:",
        "  package:",
        "    steps:",
        "      - name: Build native installer",
        "        run: x",
        "        env:",
        "          CSC_LINK: ${{ secrets.MAC_CSC_LINK }}",
        "",
      ].join("\n"),
      expect: /W002/,
    },
    {
      name: "W002 not fooled by comment mentions",
      content: [
        "jobs:",
        "  package:",
        "    steps:",
        "      # never set CSC_LINK or CSC_KEY_PASSWORD: empty secrets break signing",
        "      - name: Build native installer",
        "        run: x",
        "",
      ].join("\n"),
      expect: /W002/,
      wantFire: false,
    },
  ];
  for (const c of cases) {
    const errors = validateWorkflow(c.content, "self-test.yml");
    const fired = errors.some((e) => c.expect.test(e));
    if (fired !== (c.wantFire ?? true)) {
      console.error(
        `SELF-TEST FAIL: "${c.name}" ${c.wantFire === false ? "was flagged" : "was not caught"} ` +
          `(${JSON.stringify(errors)})`,
      );
      failed += 1;
    }
  }
  // The healthy case must NOT be flagged — including `- uses:` + `with:`
  // (+2 after a list item) and `run: |` blocks, the two legitimate +2 jumps.
  const clean = [
    "name: Release",
    "on:",
    "  push:",
    "    tags:",
    "      - \"v*.*.*\"",
    "jobs:",
    "  package:",
    "    steps:",
    "      - uses: actions/checkout@v6",
    "        with:",
    "          ref: ${{ github.ref }}",
    "      - name: Build native installer",
    "        run: |",
    "          echo one",
    "          echo two",
    "",
  ].join("\n");
  const falsePos = validateWorkflow(clean, "self-test-clean.yml");
  if (falsePos.length > 0) {
    console.error(`SELF-TEST FAIL: clean workflow flagged: ${JSON.stringify(falsePos)}`);
    failed += 1;
  }
  if (failed > 0) process.exit(1);
  console.log("check-workflows --self-test: all rules fire, false positives guarded");
  process.exit(0);
}

if (process.argv.includes("--self-test")) selfTest();
else check();

module.exports = { validateWorkflow };
