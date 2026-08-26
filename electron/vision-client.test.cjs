"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { visionSnapshot, askImage, compareImages } = require("./vision-client.cjs");

test("visionSnapshot reports the hosted service status", async () => {
  const calls = [];
  const snap = await visionSnapshot(async (name, args) => {
    calls.push({ name, args });
    return JSON.stringify({ model: "gemma4", loaded: true });
  });
  assert.equal(snap.ok, true);
  assert.equal(snap.status.model, "gemma4");
  assert.ok(snap.at > 0);
  assert.deepEqual(calls.map((c) => c.name), ["get_vision_status"]);
});

test("a dead transport degrades to an ERROR note, never a throw", async () => {
  const snap = await visionSnapshot(async () => {
    throw new Error("gateway down");
  });
  assert.equal(snap.ok, true);
  assert.match(snap.status.note, /gateway down/);
});

test("askImage forwards the path and question", async () => {
  const calls = [];
  const result = await askImage("C:\\shots\\x.png", "what is this?", async (name, args) => {
    calls.push({ name, args });
    return JSON.stringify({ answer: "a screenshot" });
  });
  assert.equal(result.answer, "a screenshot");
  assert.deepEqual(calls[0], {
    name: "ask_about_image",
    args: { image_path: "C:\\shots\\x.png", question: "what is this?" },
  });
});

test("compareImages forwards both paths", async () => {
  const calls = [];
  const result = await compareImages("a.png", "b.png", async (name, args) => {
    calls.push({ name, args });
    return JSON.stringify({ same: false });
  });
  assert.equal(result.same, false);
  assert.deepEqual(calls[0].args, { image_path1: "a.png", image_path2: "b.png" });
});
