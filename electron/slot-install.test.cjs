"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { copyIfChanged, queueInstall } = require("./character-roster.cjs");

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "desk-slot-install-"));
}

test("copies a missing destination and creates its directory", async () => {
  const dir = scratch();
  const from = path.join(dir, "model.vrm");
  fs.writeFileSync(from, "vrm-bytes");
  const to = path.join(dir, "assets", "animations", "model-a.vrm");
  assert.deepEqual(await copyIfChanged([{ from, to }]), { copied: 1, skipped: 0 });
  assert.equal(fs.readFileSync(to, "utf8"), "vrm-bytes");
});

test("skips a destination that already holds the same bytes", async () => {
  const dir = scratch();
  const from = path.join(dir, "model.vrm");
  const to = path.join(dir, "model-a.vrm");
  fs.writeFileSync(from, "vrm-bytes");
  await copyIfChanged([{ from, to }]);
  let copies = 0;
  const counting = { ...fs.promises, stat: fs.promises.stat, mkdir: fs.promises.mkdir, copyFile: async (...a) => { copies += 1; return fs.promises.copyFile(...a); } };
  assert.deepEqual(await copyIfChanged([{ from, to }], counting), { copied: 0, skipped: 1 });
  assert.equal(copies, 0);
});

test("re-copies when the size differs or the source is newer", async () => {
  const dir = scratch();
  const from = path.join(dir, "model.vrm");
  const to = path.join(dir, "model-a.vrm");
  fs.writeFileSync(from, "one");
  await copyIfChanged([{ from, to }]);
  fs.writeFileSync(from, "another character");
  assert.deepEqual(await copyIfChanged([{ from, to }]), { copied: 1, skipped: 0 });
  assert.equal(fs.readFileSync(to, "utf8"), "another character");

  fs.writeFileSync(from, "SAME-SIZE-a");
  await copyIfChanged([{ from, to }]);
  fs.writeFileSync(from, "SAME-SIZE-b");
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(from, future, future);
  assert.deepEqual(await copyIfChanged([{ from, to }]), { copied: 1, skipped: 0 });
  assert.equal(fs.readFileSync(to, "utf8"), "SAME-SIZE-b");
});

test("a missing source rejects instead of reporting a spawn", async () => {
  const dir = scratch();
  await assert.rejects(copyIfChanged([{ from: path.join(dir, "nope.vrm"), to: path.join(dir, "x.vrm") }]));
});

test("queued installs never overlap, and a failure does not poison the queue", async () => {
  const dir = scratch();
  const from = path.join(dir, "clip.vrma");
  const to = path.join(dir, "assets", "clip.vrma");
  fs.writeFileSync(from, "clip");
  let running = 0;
  let peak = 0;
  const slow = {
    ...fs.promises,
    copyFile: async (...a) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 20));
      await fs.promises.copyFile(...a);
      running -= 1;
    },
  };
  const bad = queueInstall([{ from: path.join(dir, "missing.vrma"), to }], slow);
  const a = queueInstall([{ from, to }], slow);
  const b = queueInstall([{ from, to: path.join(dir, "assets", "clip-b.vrma") }], slow);
  await assert.rejects(bad);
  assert.deepEqual(await a, { copied: 1, skipped: 0 });
  assert.deepEqual(await b, { copied: 1, skipped: 0 });
  assert.equal(peak, 1);
});
