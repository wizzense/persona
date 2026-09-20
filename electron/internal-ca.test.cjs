"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { candidates, internalCaBuffer, internalCaOptions } = require("./internal-ca.cjs");

test("the monorepo layout is tried BEFORE the flattened one, and no literal drive path is in the list", () => {
  const list = candidates({ AITHEROS_ROOT: path.join("X", "root") }, path.join("X", "home"));
  assert.equal(list[0], path.join("X", "root", "AitherOS", "Library", "Data", "tls", "ca-chain.pem"));
  assert.equal(list[1], path.join("X", "root", "Library", "Data", "tls", "ca-chain.pem"));
  assert.ok(list.every((p) => !/^[A-Z]:\\AitherOS-/.test(p)), `operator path leaked: ${list}`);
});

test("DESK_INTERNAL_CA wins, AITHEROS_DATA and ~/.aither follow", () => {
  const list = candidates(
    { DESK_INTERNAL_CA: "explicit.pem", AITHEROS_DATA: path.join("d", "data") },
    path.join("h", "ome"),
  );
  assert.deepEqual(list, [
    "explicit.pem",
    path.join("d", "data", "tls", "ca-chain.pem"),
    path.join("h", "ome", ".aither", "ca-chain.pem"),
  ]);
});

test("the first READABLE candidate is returned; none readable -> undefined / {}", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-ca-"));
  try {
    const chain = path.join(dir, "AitherOS", "Library", "Data", "tls");
    fs.mkdirSync(chain, { recursive: true });
    fs.writeFileSync(path.join(chain, "ca-chain.pem"), "PEM");
    const env = { DESK_INTERNAL_CA: path.join(dir, "missing.pem"), AITHEROS_ROOT: dir };
    assert.equal(internalCaBuffer(env, dir).toString(), "PEM");
    assert.equal(internalCaOptions(env, dir).ca.toString(), "PEM");
    assert.equal(internalCaBuffer({}, dir), undefined);
    assert.deepEqual(internalCaOptions({}, dir), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
