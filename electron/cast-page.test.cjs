"use strict";

/**
 * cast.html's controls, run against a paper DOM.
 *
 * The pane had no page test. It writes cast.json -- who may speak, how loud --
 * so a control wired to the wrong key is not a cosmetic bug: a "Mute everyone"
 * box that patches `mute` instead of `muted` is a switch the owner flips, sees
 * flip, and that silences nothing, because cast-config drops the unknown key
 * into problems[] and carries on. Nothing else in the tree would notice.
 *
 * Same technique as fleet-control-page.test.cjs: lift the script out of the
 * html, run it under `vm` over the smallest document that satisfies it, with a
 * fake `window.aitherCast` that records every write. If the page grows a DOM
 * call this document lacks the test throws at load -- the right failure.
 *
 *   node --test electron/cast-page.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const HTML = fs.readFileSync(path.join(__dirname, "cast.html"), "utf8");
const SCRIPT = HTML.slice(HTML.indexOf("<script>") + 8, HTML.lastIndexOf("</script>"));

class Node {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.listeners = {};
    this.attributes = {};
    this.className = "";
    this.id = "";
    this.title = "";
    this.type = "";
    this.value = "";
    this.checked = false;
    this.open = false;
    this._text = "";
    this.classList = { add() {}, remove() {} };
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v) {
    this._text = String(v);
    this.children = [];
  }
  appendChild(child) { this.children.push(child); return child; }
  append(...kids) { for (const k of kids) this.children.push(k); }
  replaceChildren(...kids) { this.children = [...kids]; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  fire(type) { for (const fn of this.listeners[type] || []) fn({ target: this }); }
  querySelector(sel) { return this.walk().find((n) => n.tagName === sel.toUpperCase()) || null; }
  walk() { return [this, ...this.children.flatMap((c) => (c.walk ? c.walk() : []))]; }
}

function boot(describeResult) {
  const byId = new Map();
  const body = new Node("body");
  const document = {
    body,
    createElement: (tag) => new Node(tag),
    createTextNode: (text) => { const n = new Node("#text"); n._text = String(text); return n; },
    getElementById: (id) => {
      if (!byId.has(id)) { const n = new Node("div"); n.id = id; byId.set(id, n); body.appendChild(n); }
      return byId.get(id);
    },
  };
  const writes = [];
  // JSON round-trip: the patches are built INSIDE the vm context, so their
  // prototype is that realm's Object and a strict deepEqual against a literal
  // from this one fails on identical content. It is also exactly what crosses
  // the real IPC boundary -- structured data, no prototypes.
  const record = (name) => (...args) => {
    writes.push({ name, args: JSON.parse(JSON.stringify(args)) });
    return Promise.resolve({ ok: true });
  };
  const aitherCast = {
    describe: () => Promise.resolve({ ok: true, ...describeResult }),
    setActor: record("setActor"), clearActor: record("clearActor"), setStage: record("setStage"),
    setVoice: record("setVoice"), setSection: record("setSection"), setChannel: record("setChannel"),
    captureStage: record("captureStage"),
    muteOrigin: record("muteOrigin"), reveal: record("reveal"),
  };
  const sandbox = { document, window: { aitherCast }, setInterval: () => 0, console };
  vm.createContext(sandbox);
  vm.runInContext(`${SCRIPT}\n;globalThis.__refresh = refresh;`, sandbox);
  return { body, writes, refresh: () => sandbox.__refresh() };
}

/** The field wrapper whose <label> starts with `labelText`. */
function field(body, labelText) {
  const hit = body.walk().find(
    (n) => n.className === "field" && n.children[0] && n.children[0].tagName === "LABEL" &&
      n.children[0].textContent.startsWith(labelText),
  );
  assert.ok(hit, `no field labelled "${labelText}" -- the control is not on the page`);
  return hit;
}
const inputOf = (node, type) => node.walk().find((n) => n.tagName === "INPUT" && n.type === type);

const SNAPSHOT = { version: 1, voice: { volume: 0.5, muted: false }, stage: {}, actors: {} };
const ACTOR = {
  origin: "claude_code:7f3a", agent: "aither", actorKind: "claude_code", actorId: "7f3a", slotId: "slot1",
  resolution: { volume: 0.6, volumeFrom: "defaults.volume", masterVolume: 0.5, muted: false, bubble: true,
    speak: true, body: true, presence: "normal", speed: 1.35, voice: "nova" },
};

test("cast pane: the master fader writes voice.volume, on RELEASE, as a number", async () => {
  const page = boot({ snapshot: SNAPSHOT, onStage: [], seen: {}, roster: [], problems: [] });
  await page.refresh();
  const slider = inputOf(field(page.body, "Master volume"), "range");
  assert.ok(slider, "Master volume has no range input");
  assert.equal(slider.value, "0.5", "the fader must open at the file's value, not the built-in");
  assert.equal(slider.max, "1");

  slider.value = "0.25";
  slider.fire("input");
  assert.equal(page.writes.length, 0, "dragging must not write -- one write per pixel wakes the watcher per pixel");
  slider.fire("change");
  assert.deepEqual(page.writes, [{ name: "setVoice", args: [{ volume: 0.25 }] }]);
});

test("cast pane: Mute everyone writes voice.muted -- the exact key cast-config reads", async () => {
  const page = boot({ snapshot: SNAPSHOT, onStage: [], seen: {}, roster: [], problems: [] });
  await page.refresh();
  const box = inputOf(field(page.body, "Mute everyone"), "checkbox");
  assert.equal(box.checked, false);
  box.checked = true;
  box.fire("change");
  assert.deepEqual(page.writes, [{ name: "setVoice", args: [{ muted: true }] }]);
});

test("cast pane: Speech bubbles defaults ON when unset and writes stage.bubbles", async () => {
  const page = boot({ snapshot: SNAPSHOT, onStage: [], seen: {}, roster: [], problems: [] });
  await page.refresh();
  const box = inputOf(field(page.body, "Speech bubbles"), "checkbox");
  assert.equal(box.checked, true, "unset must read as ON, matching cast-config's built-in");
  box.checked = false;
  box.fire("change");
  assert.deepEqual(page.writes, [{ name: "setStage", args: [{ bubbles: false }] }]);
});

test("cast pane: an actor's fader goes to 200%, says what will PLAY, and writes that actor's volume", async () => {
  const page = boot({ snapshot: SNAPSHOT, onStage: [ACTOR], seen: {}, roster: [], problems: [] });
  await page.refresh();
  const block = field(page.body, "Volume");
  const slider = inputOf(block, "range");
  assert.equal(slider.max, "2", "a quiet voice must be boostable past 100%");
  assert.equal(slider.value, "0.6");
  // 60% of its own fader x a 50% master = 30%: the label states the product.
  assert.match(block.children[0].textContent, /Volume 60% . plays at 30%/);
  assert.match(block.textContent, /defaults\.volume/, "the fader must say which tier its value came from");

  slider.value = "1.5";
  slider.fire("input");
  assert.match(block.children[0].textContent, /Volume 150% . plays at 75%/);
  slider.fire("change");
  assert.deepEqual(page.writes[0], { name: "setActor", args: ["claude_code:7f3a", { volume: 1.5 }] });
});

test("cast pane: a muted room is stated on the actor's fader instead of a misleading percentage", async () => {
  const muted = { ...ACTOR, resolution: { ...ACTOR.resolution, muted: true } };
  const page = boot({ snapshot: SNAPSHOT, onStage: [muted], seen: {}, roster: [], problems: [] });
  await page.refresh();
  assert.match(field(page.body, "Volume").children[0].textContent, /room muted/);
});

test("cast pane: an actor's bubble switch writes that actor's `bubble`", async () => {
  const page = boot({ snapshot: SNAPSHOT, onStage: [ACTOR], seen: {}, roster: [], problems: [] });
  await page.refresh();
  const label = page.body.walk().find((n) => n.className === "ck" && n.textContent === "bubble");
  assert.ok(label, "no per-actor bubble switch");
  const box = inputOf(label, "checkbox");
  assert.equal(box.checked, true);
  box.checked = false;
  box.fire("change");
  assert.deepEqual(page.writes[0], { name: "setActor", args: ["claude_code:7f3a", { bubble: false }] });
});

test("cast pane: every key it writes for loudness and captions is one cast-config VALIDATES", () => {
  // The loop that would have caught `mute` vs `muted`: what the page sends must
  // be a key the validator knows, or the write lands in problems[] and does nothing.
  const cast = require("./cast-config.cjs");
  const { problems } = cast.validateCast({
    version: 1,
    voice: { volume: 0.25, muted: true },
    stage: { bubbles: false },
    actors: { "claude_code:7f3a": { volume: 1.5, bubble: false } },
  });
  assert.deepEqual(problems, []);
});

// ─── desk behaviour + sync ──────────────────────────────────────────────────

const DESK = {
  models: { commandProfile: "deepseek", commandProfileFrom: "builtin" },
  prompts: {}, vision: { enabled: true, enabledFrom: "builtin" }, sync: {},
};

test("cast pane: the backend field shows the value IN FORCE and where it came from, and writes models.commandProfile", async () => {
  const page = boot({ snapshot: SNAPSHOT, onStage: [], seen: {}, roster: [], problems: [], desk: DESK });
  await page.refresh();
  const block = field(page.body, "Command agent backend");
  assert.match(block.textContent, /in force: deepseek \(builtin\)/);
  const input = inputOf(block, "text");
  assert.equal(input.value, "", "an UNSET field must stay empty -- the built-in is a placeholder, not a value");
  input.value = "opus";
  input.fire("change");
  assert.deepEqual(page.writes, [{ name: "setSection", args: ["models", { commandProfile: "opus" }] }]);
});

test("cast pane: persona, extra instructions, vision and its prompt each write their own section + key", async () => {
  const page = boot({ snapshot: SNAPSHOT, onStage: [], seen: {}, roster: [], problems: [], desk: DESK });
  await page.refresh();
  const area = (label) => field(page.body, label).walk().find((n) => n.tagName === "TEXTAREA");

  const persona = area("Command agent persona");
  persona.value = "  You are Aither.  ";
  persona.fire("change");
  const extra = area("Extra instructions");
  extra.value = "";
  extra.fire("change");
  const vision = inputOf(field(page.body, "Vision"), "checkbox");
  assert.equal(vision.checked, true);
  vision.checked = false;
  vision.fire("change");
  const look = area("What to look for");
  look.value = "Describe only the UI.";
  look.fire("change");

  assert.deepEqual(page.writes, [
    { name: "setSection", args: ["prompts", { commandPersona: "You are Aither." }] },
    { name: "setSection", args: ["prompts", { commandAppend: null }] },   // cleared = unset, not ""
    { name: "setSection", args: ["vision", { enabled: false }] },
    { name: "setSection", args: ["vision", { imagePrompt: "Describe only the UI." }] },
  ]);
});

test("cast pane: sync is shown OFF with its reason, and turning it on writes sync.enabled", async () => {
  const page = boot({
    snapshot: SNAPSHOT, onStage: [], seen: {}, roster: [], problems: [], desk: DESK,
    sync: { enabled: false, reason: "sync.enabled is off", target: null, pull: null, push: null },
  });
  await page.refresh();
  const state = page.body.walk().find((n) => n.id === "syncState");
  assert.match(state.textContent, /off . sync\.enabled is off/);
  const box = inputOf(field(page.body, "Sync"), "checkbox");
  assert.equal(box.checked, false, "sync must read OFF when unset");
  box.checked = true;
  box.fire("change");
  assert.deepEqual(page.writes, [{ name: "setSection", args: ["sync", { enabled: true }] }]);
});

test("cast pane: a failed push is SAID -- 'server kept less' is not shown as 'in step'", async () => {
  const page = boot({
    snapshot: SNAPSHOT, onStage: [], seen: {}, roster: [], problems: [], desk: DESK,
    sync: {
      enabled: true, reason: null, target: "file D:/p.json",
      pull: { verdict: "in step", output: "", at: "t1" },
      push: { verdict: "refused — the server kept less than it was sent", output: "dropped: authors.token-service", at: "t2" },
    },
  });
  await page.refresh();
  const text = page.body.walk().find((n) => n.id === "syncState").textContent;
  assert.match(text, /file D:\/p\.json/);
  assert.match(text, /push: refused/);
  assert.match(text, /authors\.token-service/);
});

test("cast pane: every desk/sync key the page writes is one cast-config VALIDATES", () => {
  const cast = require("./cast-config.cjs");
  const { problems } = cast.validateCast({
    version: 1,
    models: { commandProfile: "opus" },
    prompts: { commandPersona: "You are Aither.", commandAppend: "Be brief." },
    vision: { enabled: false, imagePrompt: "Describe only the UI." },
    sync: { enabled: true, profile: "D:/p.json", url: "https://h.invalid/p", tokenFile: "C:/b", pullOnStart: true, pushOnChange: false },
  });
  assert.deepEqual(problems, []);
});
