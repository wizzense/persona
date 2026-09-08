"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { hintFor, readGpuHolders, shapeHolders, summarizeHolders } = require("./gpu-holders.cjs");

const GIB = 1024 ** 3;

// A captured sample from the owner's host, 2026-09-08 08:53: the fleet had 0
// containers and the Fleet window said 10.2/32 GiB. dwm appears twice (two
// adapters); the python is D:\ComfyUI on :8188, started nine minutes before
// `game down`.
const SAMPLE = [
  { pid: 21084, name: "python.exe", bytes: 7.06 * GIB, cmd: "\"D:\\ComfyUI\\venv\\Scripts\\python.exe\"  main.py --listen 127.0.0.1 --port 8188 --reserve-vram 10" },
  { pid: 2876, name: "dwm.exe", bytes: 4.46 * GIB, cmd: "" },
  { pid: 2876, name: "dwm.exe", bytes: 0.35 * GIB, cmd: "" },
  { pid: 26288, name: "steamwebhelper.exe", bytes: 0.4 * GIB, cmd: "steamwebhelper.exe --type=gpu-process" },
  { pid: 21864, name: "msedge.exe", bytes: 0.24 * GIB, cmd: "msedge.exe" },
  { pid: 19388, name: "PowerToys.exe", bytes: 0.05 * GIB, cmd: "" },
];

test("shapeHolders keeps the MAX per pid, sorts by size, names what the process IS", () => {
  const holders = shapeHolders(SAMPLE, { limit: 3 });
  assert.equal(holders.length, 3);
  assert.deepEqual(holders.map((h) => h.pid), [21084, 2876, 26288]);
  assert.equal(holders[0].name, "python");
  assert.equal(holders[0].gib, 7.06);
  assert.match(holders[0].hint, /ComfyUI :8188/);
  assert.match(holders[0].hint, /not the fleet/);
  assert.equal(holders[1].gib, 4.46, "the dwm dGPU row wins over its 0.35 iGPU row; they are not summed");
  assert.match(holders[1].hint, /compositor/);
  assert.equal(holders[2].hint, "game / launcher");
});

test("shapeHolders drops sub-threshold rows and tolerates a single object or garbage", () => {
  assert.deepEqual(shapeHolders(SAMPLE, { minGib: 1 }).map((h) => h.pid), [21084, 2876]);
  assert.equal(shapeHolders(SAMPLE[0]).length, 1, "ConvertTo-Json emits a bare object for one row");
  assert.deepEqual(shapeHolders(null), []);
  assert.deepEqual(shapeHolders([{ pid: "x", bytes: "y" }, null, 3]), []);
});

test("hintFor knows the fleet distro, model servers, and says nothing when it does not know", () => {
  // The fleet's own VRAM arrives on the host as the Hyper-V worker, never as a
  // container (measured 2026-09-08: vmwp 6.0 GiB with 119 containers up).
  assert.match(hintFor("vmmem", ""), /WSL2/);
  assert.match(hintFor("vmwp", ""), /the fleet distro itself/);
  assert.match(hintFor("ollama.exe", ""), /Ollama/);
  assert.match(hintFor("python.exe", "python server.py"), /python server\.py/);
  // The live shape: a base-interpreter path that never says ComfyUI; the flags do.
  assert.match(
    hintFor("python.exe", '"C:\\Users\\x\\Python312\\python.exe" main.py --listen 127.0.0.1 --port 8188 --reserve-vram 10'),
    /ComfyUI :8188/,
  );
  assert.equal(hintFor("someapp.exe", ""), "");
});

test("summarizeHolders is the parenthesis in the one-line fleet summary", () => {
  assert.equal(summarizeHolders(shapeHolders(SAMPLE)), "ComfyUI 7.1, dwm 4.5");
  assert.equal(summarizeHolders([]), "");
  assert.equal(summarizeHolders(undefined), "");
});

test("readGpuHolders never rejects: exec failure and bad JSON are a reason, not a throw", async () => {
  const failed = await readGpuHolders({ execImpl: (_f, _a, _o, cb) => cb(new Error("powershell missing"), "") });
  assert.deepEqual(failed, { holders: [], error: "powershell missing" });
  const garbage = await readGpuHolders({ execImpl: (_f, _a, _o, cb) => cb(null, "not json") });
  assert.equal(garbage.holders.length, 0);
  assert.match(garbage.error, /unreadable/);
  const thrown = await readGpuHolders({ execImpl: () => { throw new Error("EINVAL"); } });
  assert.equal(thrown.error, "EINVAL");
  const ok = await readGpuHolders({ execImpl: (file, args, _o, cb) => {
    assert.equal(file, "powershell.exe");
    assert.ok(args.includes("-NonInteractive"));
    cb(null, JSON.stringify(SAMPLE));
  } });
  assert.equal(ok.error, null);
  assert.equal(ok.holders[0].pid, 21084);
});
