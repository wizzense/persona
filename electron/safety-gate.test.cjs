"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const gate = require("./safety-gate.cjs");

function tmpStatus(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `desk-safety-${label}-`));
  return path.join(dir, "desk-safety-gate.json");
}

/** A fake safety plane. `answer` is the parsed /safety/filter body. */
function planeThat(answer, { status = 200, calls = [] } = {}) {
  return async (method, urlPath, body, opts) => {
    calls.push({ method, urlPath, body, opts });
    if (urlPath === gate.LEVEL_PATH) return { status: 200, json: { level: answer.level || "unrestricted" } };
    return { status, json: answer };
  };
}

test("safety-gate: clean speech passes through unchanged and records passed", async () => {
  const statusFile = tmpStatus("pass");
  const calls = [];
  const verdict = await gate.consultSpeech("hello there", {
    requestFn: planeThat({ original: "hello there", filtered: "hello there", changed: false, level: "unrestricted" }, { calls }),
    statusFile,
  });
  assert.equal(verdict.allow, true);
  assert.equal(verdict.content, "hello there");
  assert.equal(verdict.changed, false);
  assert.equal(verdict.reachable, true);
  assert.equal(verdict.level, "unrestricted");
  // It asked the route that actually answers in compound mode, with `content` not `text`.
  assert.equal(calls[0].urlPath, "/safety/filter");
  assert.deepEqual(Object.keys(calls[0].body), ["content"]);
  const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
  assert.equal(status.last.verdict, "passed");
  assert.equal(status.counts["speech:passed"], 1);
});

test("safety-gate: speech the plane rewrites is SPOKEN FILTERED, not refused", async () => {
  const statusFile = tmpStatus("filtered");
  const verdict = await gate.consultSpeech("raw words", {
    requestFn: planeThat({ original: "raw words", filtered: "raw [redacted]", changed: true, level: "professional" }),
    statusFile,
  });
  assert.equal(verdict.allow, true, "muting on a rewrite is how this gate gets switched off");
  assert.equal(verdict.content, "raw [redacted]");
  assert.equal(verdict.changed, true);
  assert.equal(JSON.parse(fs.readFileSync(statusFile, "utf8")).last.verdict, "filtered");
});

test("safety-gate: an install the plane rewrites is REFUSED (the name is a join key)", async () => {
  const statusFile = tmpStatus("refused");
  const verdict = await gate.consultInstall("some-character", {
    requestFn: planeThat({ original: "some-character", filtered: "some-[redacted]", changed: true, level: "strict" }),
    statusFile,
  });
  assert.equal(verdict.allow, false);
  assert.equal(verdict.content, "some-character", "the caller must not silently install a renamed folder");
  assert.match(verdict.reason, /rewrote/);
  assert.equal(JSON.parse(fs.readFileSync(statusFile, "utf8")).last.verdict, "refused");
});

test("safety-gate: an unreachable plane FAILS OPEN and says so", async () => {
  const statusFile = tmpStatus("down");
  for (const arm of [
    { requestFn: async () => ({ status: 0, json: null, error: "ECONNREFUSED" }), why: /unreachable/ },
    { requestFn: async () => ({ status: 503, json: null }), why: /HTTP 503/ },
    { requestFn: async () => { throw new Error("boom"); }, why: null },
  ]) {
    let verdict;
    try {
      verdict = await gate.consultSpeech("hello", { requestFn: arm.requestFn, statusFile });
    } catch (error) {
      assert.fail(`consult must never throw at the caller: ${error.message}`);
    }
    assert.equal(verdict.allow, true);
    assert.equal(verdict.content, "hello");
    assert.equal(verdict.reachable, false);
    if (arm.why) assert.match(verdict.reason, arm.why);
  }
  assert.equal(JSON.parse(fs.readFileSync(statusFile, "utf8")).last.verdict, "degraded");
});

test("safety-gate: an install proceeds when the plane is down, degraded and recorded", async () => {
  const statusFile = tmpStatus("down-install");
  const verdict = await gate.consultInstall("atlas", {
    requestFn: async () => ({ status: 0, json: null, error: "ECONNREFUSED" }),
    statusFile,
  });
  assert.equal(verdict.allow, true, "a restarting container must not become an invented outage");
  assert.equal(verdict.reachable, false);
  assert.equal(JSON.parse(fs.readFileSync(statusFile, "utf8")).counts["install:degraded"], 1);
});

test("safety-gate: empty content asks nobody", async () => {
  let asked = 0;
  const verdict = await gate.consultSpeech("   ", {
    requestFn: async () => {
      asked += 1;
      return { status: 200, json: { filtered: "", changed: false } };
    },
    statusFile: tmpStatus("empty"),
  });
  assert.equal(asked, 0);
  assert.equal(verdict.allow, true);
});

test("safety-gate: the level is cached for the TTL", async () => {
  gate.resetLevelCache();
  let asked = 0;
  const requestFn = async () => {
    asked += 1;
    return { status: 200, json: { level: "unrestricted" } };
  };
  const a = await gate.safetyLevel({ requestFn });
  const b = await gate.safetyLevel({ requestFn });
  assert.equal(a, "unrestricted");
  assert.equal(b, "unrestricted");
  assert.equal(asked, 1, "a per-utterance level fetch would put a network hop in front of every word");
  gate.resetLevelCache();
  await gate.safetyLevel({ requestFn });
  assert.equal(asked, 2);
});

test("safety-gate: a plane that answers 200 with garbage is treated as DOWN, not as a pass", async () => {
  const statusFile = tmpStatus("garbage");
  const verdict = await gate.consultSpeech("hello", {
    requestFn: async () => ({ status: 200, json: { not: "a verdict" } }),
    statusFile,
  });
  assert.equal(verdict.reachable, false, "no `filtered` field means no verdict was given");
  assert.equal(verdict.allow, true);
});

// --- the roster half of the funnel -------------------------------------------------
const roster = require("./character-roster.cjs");

test("roster: a refused name enrolls NOTHING", async () => {
  const asked = [];
  let copied = 0;
  const plan = { base: "would-be-name", from: "/nowhere/model.vrm" };
  const result = await roster.enrollNewestDownloadChecked(null, {
    plan,
    perform: () => {
      copied += 1;
      return plan.base;
    },
    consultInstall: async (name) => {
      asked.push(name);
      return { allow: false, reason: `the safety plane rewrote "${name}"`, changed: true, reachable: true };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.name, null);
  assert.match(result.reason, /rewrote/);
  assert.deepEqual(asked, ["would-be-name"], "the verdict is asked about the NAME");
  assert.equal(copied, 0, "a refusal must happen BEFORE any byte is copied");
});

test("roster: an allowed name enrolls, and a degraded verdict still enrolls", async () => {
  const plan = { base: "atlas", from: "/nowhere/model.vrm" };
  for (const verdict of [
    { allow: true, changed: false, reachable: true },
    { allow: true, changed: false, reachable: false, reason: "safety plane unreachable" },
  ]) {
    let copied = 0;
    const result = await roster.enrollNewestDownloadChecked(null, {
      plan,
      perform: () => {
        copied += 1;
        return plan.base;
      },
      consultInstall: async () => verdict,
    });
    assert.equal(result.ok, true);
    assert.equal(result.name, "atlas");
    assert.equal(copied, 1);
    assert.equal(result.verdict.reachable, verdict.reachable);
  }
});

test("roster: a BROKEN safety gate does not take enrollment down", async () => {
  const plan = { base: "atlas", from: "/nowhere/model.vrm" };
  let copied = 0;
  const result = await roster.enrollNewestDownloadChecked(null, {
    plan,
    perform: () => { copied += 1; return plan.base; },
    consultInstall: async () => { throw new Error("gate exploded"); },
  });
  assert.equal(result.ok, true, "a funnel bug must not make enrolling a model impossible");
  assert.equal(copied, 1);
  assert.equal(result.verdict.reachable, false);
  assert.match(result.verdict.reason, /gate exploded/);
});

test("roster: planEnrollment writes nothing", () => {
  const plan = roster.planEnrollment("probe-name");
  if (plan) {
    assert.equal(plan.base, "probe-name");
    assert.ok(typeof plan.from === "string" && plan.from.length > 0);
    const fsx = require("node:fs");
    const pathx = require("node:path");
    assert.equal(
      fsx.existsSync(pathx.join(roster.ROSTER_DIR, "probe-name", "model.vrm")),
      false,
      "planning must not have copied a model",
    );
  }
});
