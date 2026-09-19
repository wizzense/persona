"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { ACTIONS, FleetControl, buildCommand, classify, parseVerdict, summarize, toDistroPath, ARC_ACTIONS, DESTRUCTIVE } = require("./fleet-control.cjs");

test("toDistroPath maps a Windows path to the distro's /mnt view", () => {
  assert.equal(toDistroPath("C:\\AitherOS-Fresh\\.DEPLOYMENT\\scripts\\x.py"),
    "/mnt/c/AitherOS-Fresh/.DEPLOYMENT/scripts/x.py");
  assert.equal(toDistroPath("D:/desk/a.py"), "/mnt/d/desk/a.py");
  assert.equal(toDistroPath("/already/posix"), "/already/posix");
});

test("buildCommand crosses the WSL hop as ONE sh -c string and knows every action", () => {
  for (const action of Object.keys(ACTIONS)) {
    const cmd = buildCommand(action, { script: "C:\\x\\q.py", arcScript: "C:\\x\\arc.py", distro: "Debian" });
    assert.equal(cmd.file, "wsl.exe");
    assert.deepEqual(cmd.args.slice(0, 6), ["-d", "Debian", "-u", "root", "sh", "-c"]);
    assert.equal(cmd.args.length, 7, "the whole invocation is the single sh -c argument");
    // ARC verbs run the ARC script; everything else the fleet script. One verb,
    // one script -- a desk button and an awsh command execute the same file.
    const expectScript = ARC_ACTIONS.has(action) ? /^python3 '\/mnt\/c\/x\/arc\.py' / : /^python3 '\/mnt\/c\/x\/q\.py' /;
    assert.match(cmd.args[6], expectScript);
    assert.match(cmd.args[6], / --json$/);
  }
  assert.match(buildCommand("arc-now", { arcScript: "C:\\x\\arc.py" }).args[6], / start --now 4 --json$/);
  assert.match(buildCommand("arc-stop", { arcScript: "C:\\x\\arc.py" }).args[6], / stop --json$/);
  assert.ok(DESTRUCTIVE.has("arc-stop"), "stopping the solver is a confirm-first verb");
  assert.ok(!DESTRUCTIVE.has("arc-now"), "running ARC is not destructive");
  assert.match(buildCommand("down", { script: "C:\\x\\q.py" }).args[6], / quiesce --all --json$/);
  assert.match(buildCommand("up", { script: "C:\\x\\q.py" }).args[6], / resume --json$/);
  assert.match(buildCommand("gaming", { script: "C:\\x\\q.py" }).args[6], / quiesce --deep --json$/);
  assert.throws(() => buildCommand("nuke"), /unknown fleet action/);
});

test("parseVerdict: JSON wins, rc 2 is CANNOT_JUDGE never ok, garbage is a refusal", () => {
  const ok = parseVerdict('progress noise\n{"ok": true, "fleet": {"running": 0}}', 0);
  assert.equal(ok.ok, true);
  assert.equal(ok.fleet.running, 0);
  const refused = parseVerdict('{"ok": false, "failed": [{"name": "x"}]}', 1);
  assert.equal(refused.ok, false);
  const cj = parseVerdict('{"error": "podman ps failed", "verdict": "CANNOT_JUDGE"}', 2);
  assert.equal(cj.ok, false);
  assert.equal(cj.cannotJudge, true);
  const dead = parseVerdict("", 2, "wsl: distro not found");
  assert.equal(dead.ok, false);
  assert.equal(dead.cannotJudge, true);
  assert.match(dead.error, /distro not found/);
  const garbage = parseVerdict("not json", 1, "boom");
  assert.equal(garbage.ok, false);
  assert.equal(garbage.cannotJudge, undefined);
  // a JSON doc with no ok field takes the exit code's word
  assert.equal(parseVerdict('{"vram": null}', 0).ok, true);
  assert.equal(parseVerdict('{"vram": null}', 1).ok, false);
});

test("classify derives the pill from reality, not the last button", () => {
  assert.equal(classify(null), "UNKNOWN");
  assert.equal(classify({ cannotJudge: true }), "UNKNOWN");
  assert.equal(classify({ fleet: { running: 0, masked: 207 }, held: true }), "DOWN");
  assert.equal(classify({ fleet: { running: 100, masked: 7 }, held: true }), "GPU QUIET");
  assert.equal(classify({ fleet: { running: 100, masked: 3 }, held: false }), "MIXED");
  assert.equal(classify({ fleet: { running: 112, masked: 0 }, held: false }), "UP");
  assert.equal(classify({ fleet: { running: 0, masked: 0 }, held: false }), "UNKNOWN",
    "0 running with nothing masked is not a fleet we understand");
});

test("summarize is one readable line and names CANNOT JUDGE loudly", () => {
  const line = summarize({
    fleet: { running: 0, masked: 207, units: 207, scope: "all" },
    vram: { used_mib: 1850, total_mib: 32607 },
    held: true,
  });
  assert.match(line, /0 container\(s\) running/);
  assert.match(line, /207\/207 units masked/);
  assert.match(line, /GPU 1\.8\/32 GiB/);
  assert.match(line, /HOLD yes/);
  assert.match(line, /scope=all/);
  assert.match(summarize({ cannotJudge: true, error: "no distro" }), /CANNOT JUDGE — no distro/);
});

function fakeChild({ stdout = "", stderrLines = [], code = 0, delay = 5 } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  setTimeout(() => {
    for (const line of stderrLines) child.stderr.emit("data", Buffer.from(line + "\n"));
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    child.emit("close", code);
  }, delay);
  return child;
}

test("FleetControl serialises actions: a second click while one runs is refused as busy", async () => {
  const spawned = [];
  const fc = new FleetControl({
    script: "C:\\x\\q.py",
    spawnImpl: (file, args) => {
      spawned.push(args[6]);
      return fakeChild({ stdout: '{"ok": true, "fleet_running_after": 0}', stderrLines: ["stopping ..."], delay: 30 });
    },
  });
  const progress = [];
  fc.on("progress", (p) => progress.push(p));
  const first = fc.run("down");
  assert.equal(fc.busy, "down");
  const second = await fc.run("up");
  assert.equal(second.ok, false);
  assert.equal(second.busy, "down");
  assert.match(second.error, /^busy: "down"/);
  const verdict = await first;
  assert.equal(verdict.ok, true);
  assert.equal(fc.busy, null);
  assert.equal(spawned.length, 1, "the refused click never spawned a process");
  assert.ok(progress.some((p) => p.phase === "run" && p.line === "stopping ..."), "stderr streams as progress");
  assert.equal(progress.at(-1).phase, "end");
});

test("FleetControl.status caches a fresh verdict and marks it busy during a long action", async () => {
  let calls = 0;
  const fc = new FleetControl({
    script: "C:\\x\\q.py",
    spawnImpl: (file, args) => {
      calls += 1;
      if (args[6].includes(" status ")) {
        return fakeChild({ stdout: '{"fleet": {"running": 5, "masked": 0}, "held": false}' });
      }
      return fakeChild({ stdout: '{"ok": true}', delay: 40 });
    },
  });
  const s1 = await fc.status();
  assert.equal(s1.fleet.running, 5);
  assert.equal(s1.ok, true);
  const s2 = await fc.status();
  assert.equal(calls, 1, "second status within maxAge is served from cache");
  assert.equal(s2, s1);
  const up = fc.run("up");
  const s3 = await fc.status({ maxAgeMs: 0 });
  assert.equal(s3.busy, "up", "status during an action reports the action, does not spawn a second probe");
  await up;
});

test("FleetControl: two concurrent status probes share one child and both get the verdict", async () => {
  let calls = 0;
  const fc = new FleetControl({
    script: "C:\\x\\q.py",
    spawnImpl: () => { calls += 1; return fakeChild({ stdout: '{"fleet": {"running": 0, "masked": 171}, "held": true}', delay: 30 }); },
  });
  const [a, b] = await Promise.all([fc.status({ maxAgeMs: 0 }), fc.status({ maxAgeMs: 0 })]);
  assert.equal(calls, 1, "the second probe joined the first instead of spawning or refusing");
  assert.equal(a.fleet.masked, 171);
  assert.equal(b, a);
  assert.equal(b.busy, undefined, "a joined status is never reported as busy");
  const c = await fc.run("status");
  assert.equal(calls, 2, "after it finished, a new run really probes again");
  assert.equal(c.ok, true);
});

test("FleetControl: an unknown action and a spawn failure are verdicts, never throws", async () => {
  const fc = new FleetControl({
    script: "C:\\x\\q.py",
    spawnImpl: () => { throw new Error("wsl.exe not found"); },
  });
  const bad = await fc.run("nuke");
  assert.equal(bad.ok, false);
  assert.match(bad.error, /unknown action/);
  const dead = await fc.run("status");
  assert.equal(dead.ok, false);
  assert.equal(dead.cannotJudge, true);
  assert.match(dead.error, /wsl\.exe not found/);
});

test("FleetControl: a status verdict is enriched from the HOST with who holds the VRAM and which doors answer", async () => {
  const fc = new FleetControl({
    script: "C:\\x\\q.py",
    spawnImpl: () => fakeChild({ stdout: '{"fleet": {"running": 0, "masked": 171, "units": 189}, "held": true, "vram": {"used_mib": 10413, "total_mib": 32607}}' }),
    gpuHolders: async () => ({ holders: [{ pid: 21084, name: "python", gib: 7.06, hint: "ComfyUI :8188 (Windows, not the fleet)", cmd: "" },
      { pid: 2876, name: "dwm", gib: 4.46, hint: "Windows desktop compositor", cmd: "" }], error: null }),
    surfaces: async () => [{ id: "pulse", label: "Pulse", up: true, detail: "HELD by owner" }, { id: "mcp", label: "MCP", up: false, detail: "ECONNREFUSED" }],
  });
  const st = await fc.run("status");
  assert.equal(st.gpu_holders.length, 2);
  assert.equal(st.surfaces.length, 2);
  assert.match(summarize(st), /GPU 10\.2\/32 GiB \(ComfyUI 7\.1, dwm 4\.5\)/);
  assert.match(summarize(st), /surfaces 1\/2 up \(down: mcp\)/);
  // A non-status action is never enriched, and a throwing probe never breaks the verdict.
  const fc2 = new FleetControl({
    script: "C:\\x\\q.py",
    spawnImpl: () => fakeChild({ stdout: '{"ok": true, "fleet": {"running": 0}}' }),
    gpuHolders: async () => { throw new Error("counters busy"); },
    surfaces: async () => { throw new Error("no network"); },
  });
  const adopt = await fc2.run("adopt");
  assert.equal("gpu_holders" in adopt, false);
  const st2 = await fc2.run("status");
  assert.deepEqual(st2.gpu_holders, []);
  assert.equal(st2.gpu_holders_error, "counters busy");
  assert.deepEqual(st2.surfaces, []);
  // A fake spawn with nothing injected gets NO host probes (tests never shell to powershell).
  const fc3 = new FleetControl({ script: "C:\\x\\q.py", spawnImpl: () => fakeChild({ stdout: '{"fleet": {"running": 1}}' }) });
  const st3 = await fc3.run("status");
  assert.equal("gpu_holders" in st3, false);
});

test("FleetControl: a CANNOT_JUDGE status retries once, and the retry's verdict wins", async () => {
  // Measured 2026-09-12: a load-54 window held the Fleet pane at "?" while the
  // fleet was UP (91 containers) -- podman ps has a 60 s timeout inside the
  // distro script and the spike passes in seconds, so one retry earns its keep.
  let calls = 0;
  const fc = new FleetControl({
    script: "C:/x/q.py",
    statusRetries: 1,
    retryDelayMs: 10,
    spawnImpl: () => {
      calls += 1;
      if (calls === 1) {
        return fakeChild({ stdout: '{"verdict": "CANNOT_JUDGE", "error": "podman ps timed out after 60 seconds"}', delay: 5 });
      }
      return fakeChild({ stdout: '{"fleet": {"running": 91, "masked": 0}, "held": false}', delay: 5 });
    },
  });
  const lines = [];
  fc.on("progress", (p) => lines.push(p.line));
  const st = await fc.run("status");
  assert.equal(calls, 2);
  assert.equal(st.cannotJudge, undefined, "the retry's good verdict replaced the failure");
  assert.equal(st.fleet.running, 91);
  assert.ok(lines.some((l) => /retrying in/.test(l)), "the retry is visible in the log");
});

test("FleetControl: an exhausted retry carries the last GOOD numbers as stale, cannotJudge stays loud", async () => {
  let calls = 0;
  const fc = new FleetControl({
    script: "C:/x/q.py",
    statusRetries: 1,
    retryDelayMs: 10,
    spawnImpl: () => {
      calls += 1;
      if (calls === 1) {
        return fakeChild({ stdout: '{"fleet": {"running": 91, "masked": 0}, "held": false, "vram": {"used_mib": 1000, "total_mib": 32607}}', delay: 5 });
      }
      return fakeChild({ stdout: '{"verdict": "CANNOT_JUDGE", "error": "podman ps timed out"}', delay: 5 });
    },
  });
  const good = await fc.run("status");
  assert.equal(good.fleet.running, 91);
  const st = await fc.run("status");
  assert.equal(st.cannotJudge, true, "could not look must stay LOUD -- never a healthy-looking verdict");
  assert.equal(st.stale.verdict.fleet.running, 91, "the last good numbers ride along, labeled");
  assert.ok(st.stale.age_ms >= 0);
  assert.match(st.stale.reason, /timed out/);
  assert.equal(calls, 3, "one retry was spent before the stale fallback");
});

test("FleetControl: no retry and no stale without a prior good status", async () => {
  let calls = 0;
  const fc = new FleetControl({
    script: "C:/x/q.py",
    statusRetries: 1,
    retryDelayMs: 10,
    spawnImpl: () => { calls += 1; return fakeChild({ stdout: '{"verdict": "CANNOT_JUDGE", "error": "no distro"}', delay: 5 }); },
  });
  const st = await fc.run("status");
  assert.equal(st.cannotJudge, true);
  assert.equal(st.stale, undefined, "nothing to be stale FROM");
  assert.equal(calls, 2, "the one retry still ran");
  // statusRetries=0 disables the patience entirely.
  let calls0 = 0;
  const fc0 = new FleetControl({
    script: "C:/x/q.py",
    statusRetries: 0,
    spawnImpl: () => { calls0 += 1; return fakeChild({ stdout: '{"verdict": "CANNOT_JUDGE"}', delay: 5 }); },
  });
  const s0 = await fc0.run("status");
  assert.equal(s0.cannotJudge, true);
  assert.equal(calls0, 1, "no patience configured, no retry spent");
});
