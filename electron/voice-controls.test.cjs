"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createVoiceControls } = require("./voice-controls.cjs");

/** Point cast-config at a private file for the duration of `fn` (sync or async). */
async function withCast(initial, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-voice-controls-"));
  const file = path.join(dir, "cast.json");
  if (initial) fs.writeFileSync(file, JSON.stringify(initial));
  const before = process.env.DESK_CAST_FILE;
  process.env.DESK_CAST_FILE = file;
  try {
    return await fn(file);
  } finally {
    if (before === undefined) delete process.env.DESK_CAST_FILE;
    else process.env.DESK_CAST_FILE = before;
  }
}

function harness(extra = {}) {
  const sent = [];
  const spoken = [];
  const win = { isDestroyed: () => false, webContents: { send: (ch, msg) => sent.push([ch, msg]) } };
  const controls = createVoiceControls({
    BrowserWindow: { getAllWindows: () => [win] },
    speakAloud: async (...args) => { spoken.push(args); return { ok: true }; },
    refreshTrayMenu: () => {},
    castPane: () => ({ describe: () => ({ onStage: [], snapshot: {} }) }),
    ...extra,
  });
  return { controls, sent, spoken };
}

test("Mute all voices flips voice.muted, hushes what is playing, and flips back", async () => {
  await withCast({ version: 1 }, (file) => {
    const { controls, sent, spoken } = harness();
    assert.equal(controls.voicesMuted(), false);
    controls.toggleVoiceSilence();
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).voice.muted, true);
    assert.equal(controls.voicesMuted(), true);
    assert.deepEqual(sent, [["desk:event", { type: "hush" }]], "muting cuts off the current line");
    controls.toggleVoiceSilence();
    assert.equal(controls.voicesMuted(), false);
    assert.equal(spoken.length, 1, "unmuting says so out loud, once");
  });
});

test("the Voice picker names the body's current voice and writes only that actor", async () => {
  await withCast({ version: 1, actors: { "claude_code:abc": { voice: "onyx" } } }, (file) => {
    const pane = {
      describe: () => ({
        onStage: [{ slotId: "slot3", origin: "claude_code:abc", resolution: { voice: "onyx" } }],
        snapshot: JSON.parse(fs.readFileSync(file, "utf8")),
      }),
    };
    const { controls } = harness({ castPane: () => pane });
    const menu = controls.buildVoiceMenu("slot3");
    const checked = menu.filter((row) => row.type === "radio" && row.checked).map((row) => row.label);
    assert.deepEqual(checked, ["Onyx — US man, deep"]);
    menu.find((row) => row.label === "Ryan — British man").click();
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).actors["claude_code:abc"].voice, "fable");
    controls.buildVoiceMenu("slot3").find((row) => row.label === "Back to the default voice").click();
    assert.equal("voice" in JSON.parse(fs.readFileSync(file, "utf8")).actors["claude_code:abc"], false,
      "reset REMOVES the field rather than writing an invalid null");
  });
});

test("a presence-quiet body reads silenced, and 'Let this one speak' lifts it through the cast pane", async () => {
  await withCast({ version: 1, actors: { "claude_code:q": { presence: "quiet" }, "claude_code:c": { presence: "chatty", speak: false } } }, (file) => {
    const real = require("./room-stage-host.cjs").castPaneImpl({ castFile: file, env: {}, listCharacters: () => [] });
    const snapshot = () => JSON.parse(fs.readFileSync(file, "utf8"));
    const pane = {
      describe: () => ({
        onStage: [
          { slotId: "slot2", origin: "claude_code:q", resolution: { voice: "nova", presence: "quiet", speak: true, voiced: false } },
          { slotId: "slot3", origin: "claude_code:c", resolution: { voice: "nova", presence: "chatty", speak: false, voiced: false } },
        ],
        snapshot: snapshot(),
      }),
      unsilence: real.unsilence,
    };
    const { controls } = harness({ castPane: () => pane });
    const labels = (slot) => controls.buildVoiceMenu(slot).map((row) => row.label);
    assert.ok(labels("slot2").includes("Let this one speak"), "quiet is a silence the menu can lift");
    assert.equal(labels("slot2").includes("Silence this one"), false);

    controls.buildVoiceMenu("slot2").find((row) => row.label === "Let this one speak").click();
    controls.buildVoiceMenu("slot3").find((row) => row.label === "Let this one speak").click();
    assert.equal(snapshot().actors["claude_code:q"].presence, "normal");
    assert.deepEqual(snapshot().actors["claude_code:c"], { presence: "chatty" }, "speak:false lifted, chatty kept");
  });
});

test("a body the stage does not know gets one honest disabled row, not an empty menu", () => {
  const { controls } = harness();
  const menu = controls.buildVoiceMenu("slot9");
  assert.equal(menu.length, 1);
  assert.equal(menu[0].enabled, false);
});
