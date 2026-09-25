"use strict";

/**
 * cast.html -- the Voices page -- run against a paper DOM.
 *
 * The page writes cast.json -- who may speak, in which voice, how loud -- so a
 * control wired to the wrong key is not a cosmetic bug: a master switch that
 * patches `mute` instead of `muted` is a switch the owner flips, sees flip, and
 * that silences nothing, because cast-config drops the unknown key into
 * problems[] and carries on. Nothing else in the tree would notice.
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
const STYLE = (HTML.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || "";

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
    this.disabled = false;
    this.hidden = false;
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
  fire(type) { for (const fn of this.listeners[type] || []) fn({ target: this, preventDefault() {} }); }
  querySelector(sel) { return this.walk().find((n) => n.tagName === sel.toUpperCase()) || null; }
  walk() { return [this, ...this.children.flatMap((c) => (c.walk ? c.walk() : []))]; }
}

function boot(describeResult, { previewResult = { ok: true }, overrides = {} } = {}) {
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
  const record = (name, answer = { ok: true }) => (...args) => {
    writes.push({ name, args: JSON.parse(JSON.stringify(args)) });
    return Promise.resolve(answer);
  };
  const aitherCast = {
    describe: () => Promise.resolve({ ok: true, ...describeResult }),
    setActor: record("setActor"), clearActor: record("clearActor"), setStage: record("setStage"),
    setVoice: record("setVoice"), setDefaults: record("setDefaults"), setSection: record("setSection"),
    setChannel: record("setChannel"), captureStage: record("captureStage"),
    muteOrigin: record("muteOrigin"), reveal: record("reveal"), unsilence: record("unsilence"),
    preview: record("preview", previewResult),
    ...overrides,
  };
  const sandbox = { document, window: { aitherCast }, setInterval: () => 0, console };
  vm.createContext(sandbox);
  vm.runInContext(`${SCRIPT}\n;globalThis.__refresh = refresh;`, sandbox);
  return { body, writes, byId: (id) => document.getElementById(id), refresh: () => sandbox.__refresh() };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** The field wrapper whose <label> starts with `labelText`. */
function field(root, labelText) {
  const hit = root.walk().find(
    (n) => n.className === "ui-field" && n.children[0] && n.children[0].tagName === "LABEL" &&
      n.children[0].textContent.startsWith(labelText),
  );
  assert.ok(hit, `no field labelled "${labelText}" -- the control is not on the page`);
  return hit;
}
const inputOf = (node, type) => node.walk().find((n) => n.tagName === "INPUT" && n.type === type);
const selectOf = (node) => node.walk().find((n) => n.tagName === "SELECT");
const buttonOf = (node, text) => node.walk().find((n) => n.tagName === "BUTTON" && n.textContent === text);
/** The "Who speaks" table row for one origin key. */
function speakerRow(page, key) {
  const hit = page.byId("speakers").children.find((tr) => tr.attributes["data-key"] === key);
  assert.ok(hit, `no Who-speaks row for ${key}`);
  return hit;
}
const optionsOf = (select) => select.children.map((o) => ({ value: o.value, label: o.textContent }));

const SNAPSHOT = { version: 1, voice: { volume: 0.5, muted: false }, stage: {}, actors: {} };
const RESIDENT = {
  origin: "service:awdesk", agent: "aither", actorKind: "service", actorId: "awdesk", slotId: "slot0",
  resident: true, character: "Nova",
  resolution: { voice: "shimmer", voiceFrom: "hash", volume: 1, masterVolume: 0.5, muted: false, speak: true,
    presence: "normal", voiced: true, bubble: true },
};
const ACTOR = {
  origin: "claude_code:7f3a", agent: "aither", actorKind: "claude_code", actorId: "7f3a", slotId: "slot1",
  resolution: { volume: 0.6, volumeFrom: "defaults.volume", masterVolume: 0.5, muted: false, bubble: true,
    speak: true, body: true, presence: "normal", speed: 1.35, voice: "nova", voiced: true },
};
const base = (extra = {}) => ({ snapshot: SNAPSHOT, onStage: [], seen: {}, roster: [], problems: [], ...extra });

// ─── page structure ──────────────────────────────────────────────────────────

test("voices page: links the tokens THEN aither-ui.css, and declares no component CSS of its own", () => {
  const tokens = HTML.indexOf('<link rel="stylesheet" href="aither-tokens.css"');
  const ui = HTML.indexOf('<link rel="stylesheet" href="aither-ui.css"');
  assert.ok(tokens > 0 && ui > tokens, "aither-ui.css must be linked, after the tokens");
  assert.match(HTML, /<body class="ui">/);
  // A pane-local .chip/.btn/.row is how seven panes ended up with seven buttons.
  for (const own of [".chip", ".btn", ".row", ".tag", ".banner", "section {", "select,", "input[type"]) {
    assert.ok(!STYLE.includes(own), `cast.html restyles a component: ${own}`);
  }
  assert.deepEqual(STYLE.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|oklch\(/g) || [], [], "no colour literals");
});

test("voices page: 'All voices' is the FIRST card, 'Who speaks' second, everything else collapsed below", () => {
  const all = HTML.indexOf('id="allVoicesCard"');
  const who = HTML.indexOf('id="speakersCard"');
  const firstDetails = HTML.indexOf('<details class="ui-card"');
  assert.ok(all > 0 && all < who && who < firstDetails, "the two main cards must lead, Advanced after");
  // Every advanced section is still on the page, just folded.
  for (const id of ["bodiesCard", "voiceServiceCard", "filterCard", "channelsCard", "stageCard", "contentCard",
    "physicsCard", "deskCard", "syncCard"]) {
    assert.match(HTML, new RegExp(`<details class="ui-card" id="${id}">`), `${id} is not a collapsed card`);
  }
  assert.doesNotMatch(HTML, /<datalist/, "voices are picked from a named list, not typed into a datalist");
});

// ─── All voices ──────────────────────────────────────────────────────────────

test("All voices: the master switch reads ON when unmuted and switching it off writes voice.muted:true", async () => {
  const page = boot(base());
  await page.refresh();
  const box = inputOf(field(page.byId("allVoices"), "Voices"), "checkbox");
  assert.equal(box.checked, true, "unmuted must read as ON");
  box.checked = false;
  box.fire("change");
  assert.deepEqual(page.writes, [{ name: "setVoice", args: [{ muted: true }] }]);
  assert.equal(page.byId("masterBadge").textContent, "On");
});

test("All voices: a muted room reads OFF and switching it on writes voice.muted:false", async () => {
  const page = boot(base({ snapshot: { ...SNAPSHOT, voice: { muted: true } } }));
  await page.refresh();
  const box = inputOf(field(page.byId("allVoices"), "Voices"), "checkbox");
  assert.equal(box.checked, false);
  assert.equal(page.byId("masterBadge").textContent, "Muted");
  box.checked = true;
  box.fire("change");
  assert.deepEqual(page.writes, [{ name: "setVoice", args: [{ muted: false }] }]);
});

test("All voices: the master fader writes voice.volume, on RELEASE, as a number", async () => {
  const page = boot(base());
  await page.refresh();
  const slider = inputOf(field(page.byId("allVoices"), "Master volume"), "range");
  assert.equal(slider.value, "0.5", "the fader must open at the file's value, not the built-in");
  assert.equal(slider.max, "1");
  slider.value = "0.25";
  slider.fire("input");
  assert.equal(page.writes.length, 0, "dragging must not write -- one write per pixel wakes the watcher per pixel");
  slider.fire("change");
  assert.deepEqual(page.writes, [{ name: "setVoice", args: [{ volume: 0.25 }] }]);
});

test("All voices: the default voice is a NAMED dropdown and writes voice.defaultVoice by id", async () => {
  const page = boot(base());
  await page.refresh();
  const select = selectOf(field(page.byId("allVoices"), "Default voice"));
  const opts = optionsOf(select);
  assert.deepEqual(opts[0], { value: "", label: "Built-in (Aria — US woman)" });
  assert.ok(opts.some((o) => o.value === "onyx" && o.label === "Onyx — US man, deep"));
  select.value = "onyx";
  select.fire("change");
  assert.deepEqual(page.writes, [{ name: "setVoice", args: [{ defaultVoice: "onyx" }] }]);
});

// ─── Who speaks ──────────────────────────────────────────────────────────────

test("Who speaks: the resident first, then on-stage bodies, then heard origins -- each once", async () => {
  const seen = {
    "relay:#agents": { kind: "relay", channel: "#agents", count: 3, lastSeen: "2026-09-23T10:00:00Z" },
    "claude_code:7f3a": { kind: "claude_code", count: 9, lastSeen: "2026-09-23T11:00:00Z" },
  };
  const page = boot(base({ onStage: [RESIDENT, ACTOR], seen }));
  await page.refresh();
  const keys = page.byId("speakers").children.map((tr) => tr.attributes["data-key"]);
  assert.deepEqual(keys, ["service:awdesk", "claude_code:7f3a", "relay:#agents"]);
  assert.match(speakerRow(page, "service:awdesk").textContent, /aither \(resident\)/);
});

test("Who speaks: the voice select lists every NAMED voice by label with the id as value", async () => {
  const page = boot(base({ onStage: [ACTOR] }));
  await page.refresh();
  const opts = optionsOf(selectOf(speakerRow(page, "claude_code:7f3a")));
  const named = opts.filter((o) => o.value && o.value !== "__other__");
  assert.deepEqual(named, [
    { value: "nova", label: "Aria — US woman" },
    { value: "shimmer", label: "Jenny — US woman" },
    { value: "en-US-AvaNeural", label: "Ava — US woman" },
    { value: "en-US-EmmaNeural", label: "Emma — US woman" },
    { value: "en-US-AnaNeural", label: "Ana — US girl" },
    { value: "alloy", label: "Alloy — US man" },
    { value: "echo", label: "Echo — US man" },
    { value: "onyx", label: "Onyx — US man, deep" },
    { value: "fable", label: "Ryan — British man" },
    { value: "en-GB-SoniaNeural", label: "Sonia — British woman" },
  ]);
  assert.equal(opts[0].value, "", "an Automatic (unset) choice leads");
  assert.match(opts[0].label, /Automatic \(Aria — US woman\)/, "unset says which voice resolves today");
  assert.equal(opts[opts.length - 1].label, "Other…");
});

test("Who speaks: picking a named voice writes that actor's voice id", async () => {
  const page = boot(base({ onStage: [ACTOR] }));
  await page.refresh();
  const select = selectOf(speakerRow(page, "claude_code:7f3a"));
  select.value = "fable";
  select.fire("change");
  assert.deepEqual(page.writes, [{ name: "setActor", args: ["claude_code:7f3a", { voice: "fable" }] }]);
});

test("Who speaks: a CUSTOM voice already in the file is shown as its own option, selected", async () => {
  const snapshot = { ...SNAPSHOT, actors: { "claude_code:7f3a": { voice: "en-US-MichelleNeural" } } };
  const page = boot(base({ snapshot, onStage: [{ ...ACTOR, resolution: { ...ACTOR.resolution, voice: "en-US-MichelleNeural" } }] }));
  await page.refresh();
  const select = selectOf(speakerRow(page, "claude_code:7f3a"));
  assert.equal(select.value, "en-US-MichelleNeural");
  assert.ok(optionsOf(select).some((o) => o.value === "en-US-MichelleNeural" && /custom/.test(o.label)));
});

test("Who speaks: 'Other…' reveals a text box; only a *Neural id -- any locale -- is written", async () => {
  const page = boot(base({ onStage: [ACTOR] }));
  await page.refresh();
  const row = speakerRow(page, "claude_code:7f3a");
  const select = selectOf(row);
  const custom = inputOf(row, "text");
  assert.equal(custom.hidden, true, "the free-text box is hidden until Other… is picked");
  select.value = "__other__";
  select.fire("change");
  assert.equal(custom.hidden, false);
  assert.equal(page.writes.length, 0, "choosing Other… alone writes nothing");

  custom.value = "robot-voice";
  custom.fire("change");
  assert.equal(page.writes.length, 0, "a non-neural id must not reach cast.json");
  assert.match(page.byId("err").textContent, /not a neural voice id/);

  // Non-English edge-tts ids were writable by hand before the picker; they still are.
  for (const id of ["en-US-GuyNeural", "ja-JP-NanamiNeural", "zh-CN-liaoning-XiaobeiNeural"]) {
    custom.value = id;
    custom.fire("change");
  }
  custom.value = `en-US-${"X".repeat(30)}Neural`;
  custom.fire("change");
  assert.deepEqual(page.writes, [
    { name: "setActor", args: ["claude_code:7f3a", { voice: "en-US-GuyNeural" }] },
    { name: "setActor", args: ["claude_code:7f3a", { voice: "ja-JP-NanamiNeural" }] },
    { name: "setActor", args: ["claude_code:7f3a", { voice: "zh-CN-liaoning-XiaobeiNeural" }] },
  ], "over 40 chars is refused -- cast.json would drop it");
});

test("Who speaks: ▶ previews the voice currently chosen, or the resolved one when unset", async () => {
  const page = boot(base({ onStage: [RESIDENT, ACTOR] }));
  await page.refresh();
  // Unset -> the voice the resident resolves to today.
  buttonOf(speakerRow(page, "service:awdesk"), "▶").fire("click");
  await tick();
  const row = speakerRow(page, "claude_code:7f3a");
  const select = selectOf(row);
  select.value = "en-GB-SoniaNeural";
  buttonOf(row, "▶").fire("click");
  await tick();
  assert.deepEqual(page.writes.filter((w) => w.name === "preview"), [
    { name: "preview", args: ["shimmer"] },
    { name: "preview", args: ["en-GB-SoniaNeural"] },
  ]);
});

test("Who speaks: a refused preview SAYS why instead of looking like it played", async () => {
  const page = boot(base({ onStage: [ACTOR] }), { previewResult: { ok: false, error: "preview: voice.muted (voice)" } });
  await page.refresh();
  buttonOf(speakerRow(page, "claude_code:7f3a"), "▶").fire("click");
  await tick();
  await tick();
  assert.match(page.byId("err").textContent, /voice\.muted/);
});

test("Who speaks: switching a speaker OFF mutes it (speak:false); ON unsilences it (never a blanket reveal)", async () => {
  const silenced = { ...ACTOR, resolution: { ...ACTOR.resolution, speak: false, voiced: false } };
  const page = boot(base({ onStage: [RESIDENT, silenced] }));
  await page.refresh();
  const on = inputOf(speakerRow(page, "service:awdesk"), "checkbox");
  assert.equal(on.checked, true);
  on.checked = false;
  on.fire("change");
  const off = inputOf(speakerRow(page, "claude_code:7f3a"), "checkbox");
  assert.equal(off.checked, false, "speak:false must read as Silenced");
  assert.match(speakerRow(page, "claude_code:7f3a").textContent, /Silenced/);
  off.checked = true;
  off.fire("change");
  assert.deepEqual(page.writes, [
    { name: "muteOrigin", args: ["service:awdesk"] },
    { name: "unsilence", args: ["claude_code:7f3a"] },
  ]);
});

test("Who speaks: Off -> On through the REAL cast pane keeps a chatty presence; a quiet one is lifted", async () => {
  // Wired to room-stage-host's own castPaneImpl over a scratch cast.json: the
  // switch must land the same rule the right-click menu does, not just call a name.
  const os = require("node:os");
  const host = require("./room-stage-host.cjs");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "desk-cast-page-")), "cast.json");
  fs.writeFileSync(file, JSON.stringify({
    version: 1, actors: { "claude_code:7f3a": { presence: "chatty" }, "claude_code:q": { presence: "quiet" } },
  }));
  const pane = host.castPaneImpl({ castFile: file, env: {}, listCharacters: () => [] });
  const live = (fn) => (key) => Promise.resolve(fn({ key }));
  const overrides = { muteOrigin: live(pane.muteOrigin), unsilence: live(pane.unsilence), reveal: live(pane.reveal) };
  const quiet = { ...ACTOR, origin: "claude_code:q", actorId: "q", slotId: "slot2",
    resolution: { ...ACTOR.resolution, presence: "quiet", voiced: false } };
  const page = boot(base({ onStage: [ACTOR, quiet] }), { overrides });
  await page.refresh();
  const chatty = inputOf(speakerRow(page, "claude_code:7f3a"), "checkbox");
  chatty.checked = false;
  chatty.fire("change");
  chatty.checked = true;
  chatty.fire("change");
  const q = inputOf(speakerRow(page, "claude_code:q"), "checkbox");
  assert.equal(q.checked, false, "presence quiet reads Silenced");
  q.checked = true;
  q.fire("change");
  await tick();
  const actors = JSON.parse(fs.readFileSync(file, "utf8")).actors;
  assert.deepEqual(actors["claude_code:7f3a"], { presence: "chatty" }, "Off -> On must not clobber chatty");
  assert.equal(actors["claude_code:q"].presence, "normal", "a quiet silence is lifted");
});

test("Who speaks: a relay origin nobody configured reads Silenced; presence quiet does too", async () => {
  const seen = { "relay:#agents": { kind: "relay", channel: "#agents" } };
  const quiet = { ...ACTOR, resolution: { ...ACTOR.resolution, presence: "quiet" } };
  const page = boot(base({ onStage: [quiet], seen }));
  await page.refresh();
  assert.equal(inputOf(speakerRow(page, "relay:#agents"), "checkbox").checked, false);
  assert.equal(inputOf(speakerRow(page, "claude_code:7f3a"), "checkbox").checked, false);
});

test("Who speaks: Reset drops ONLY the voice override, and is disabled when there is none", async () => {
  const snapshot = { ...SNAPSHOT, actors: { "claude_code:7f3a": { voice: "onyx", volume: 1.5 } } };
  const page = boot(base({ snapshot, onStage: [RESIDENT, ACTOR] }));
  await page.refresh();
  assert.equal(buttonOf(speakerRow(page, "service:awdesk"), "Reset").disabled, true);
  const reset = buttonOf(speakerRow(page, "claude_code:7f3a"), "Reset");
  assert.equal(reset.disabled, false);
  reset.fire("click");
  assert.deepEqual(page.writes, [{ name: "setActor", args: ["claude_code:7f3a", { voice: null }] }]);
});

test("Who speaks: a speaker's fader goes to 200%, says what will PLAY, and writes that actor's volume", async () => {
  const page = boot(base({ onStage: [ACTOR] }));
  await page.refresh();
  const row = speakerRow(page, "claude_code:7f3a");
  const slider = inputOf(row, "range");
  assert.equal(slider.max, "2", "a quiet voice must be boostable past 100%");
  assert.equal(slider.value, "0.6");
  // 60% of its own fader x a 50% master = 30%: the readout states the product.
  assert.match(row.textContent, /60% → 30%/);
  assert.match(row.textContent, /defaults\.volume/, "the fader must say which tier its value came from");
  slider.value = "1.5";
  slider.fire("input");
  assert.match(row.textContent, /150% → 75%/);
  slider.fire("change");
  assert.deepEqual(page.writes, [{ name: "setActor", args: ["claude_code:7f3a", { volume: 1.5 }] }]);
});

test("Who speaks: a muted room is stated on the fader instead of a misleading percentage", async () => {
  const muted = { ...ACTOR, resolution: { ...ACTOR.resolution, muted: true } };
  const page = boot(base({ onStage: [muted] }));
  await page.refresh();
  assert.match(speakerRow(page, "claude_code:7f3a").textContent, /\(muted\)/);
});

test("Who speaks: an empty desk says so instead of rendering a blank table", async () => {
  const page = boot(base());
  await page.refresh();
  assert.match(page.byId("speakers").textContent, /Nobody is on stage/);
});

// ─── Advanced ────────────────────────────────────────────────────────────────

test("Advanced: Speech bubbles defaults ON when unset and writes stage.bubbles", async () => {
  const page = boot(base());
  await page.refresh();
  const box = inputOf(field(page.byId("stageGrid"), "Speech bubbles"), "checkbox");
  assert.equal(box.checked, true, "unset must read as ON, matching cast-config's built-in");
  box.checked = false;
  box.fire("change");
  assert.deepEqual(page.writes, [{ name: "setStage", args: [{ bubbles: false }] }]);
});

test("Advanced: a body's bubble switch, character and Clear override still write that actor", async () => {
  const page = boot(base({ onStage: [ACTOR], roster: ["Nova", "Luna"] }));
  await page.refresh();
  const bodies = page.byId("bodiesList");
  const bubble = inputOf(field(bodies, "Bubble"), "checkbox");
  assert.equal(bubble.checked, true);
  bubble.checked = false;
  bubble.fire("change");
  const character = selectOf(field(bodies, "Character"));
  character.value = "Luna";
  character.fire("change");
  buttonOf(bodies, "Clear override").fire("click");
  assert.deepEqual(page.writes, [
    { name: "setActor", args: ["claude_code:7f3a", { bubble: false }] },
    { name: "setActor", args: ["claude_code:7f3a", { character: "Luna" }] },
    { name: "clearActor", args: ["claude_code:7f3a"] },
  ]);
});

test("Advanced: the resident gets no Character/Presence/Body control -- nothing reads them for it", async () => {
  const page = boot(base({ onStage: [RESIDENT] }));
  await page.refresh();
  const labels = page.byId("bodiesList").walk()
    .filter((n) => n.className === "ui-field").map((n) => n.children[0].textContent);
  assert.ok(labels.includes("Speed") && labels.includes("Bubble") && labels.includes("Physics"));
  for (const hidden of ["Character", "Presence", "Body"]) assert.ok(!labels.includes(hidden), `${hidden} shown for the resident`);
});

test("Advanced: the speech filter carries its WHOLE sub-object on a write", async () => {
  const snapshot = { ...SNAPSHOT, voice: { ...SNAPSHOT.voice, speechFilter: { maxChars: 300 } } };
  const page = boot(base({ snapshot }));
  await page.refresh();
  const box = inputOf(field(page.byId("filterGrid"), "Speech filter allows code"), "checkbox");
  box.checked = true;
  box.fire("change");
  assert.deepEqual(page.writes, [{ name: "setVoice", args: [{ speechFilter: { maxChars: 300, allowCode: true } }] }]);
});

test("Advanced: a heard relay channel is listed and its switch writes channels[ch].voiced", async () => {
  const seen = { "relay:#agents": { kind: "relay", channel: "#agents" } };
  const page = boot(base({ seen }));
  await page.refresh();
  const item = page.byId("channelsList").children.find((n) => n.attributes["data-channel"] === "#agents");
  assert.ok(item, "the heard channel is not listed");
  const box = inputOf(item, "checkbox");
  assert.equal(box.checked, false, "relay channels start silent");
  box.checked = true;
  box.fire("change");
  const presence = selectOf(item);
  presence.value = "quiet";
  presence.fire("change");
  assert.deepEqual(page.writes, [
    { name: "setChannel", args: ["#agents", { voiced: true }] },
    { name: "setChannel", args: ["#agents", { presence: "quiet" }] },
  ]);
});

test("Advanced: the everyone-physics faders write defaults.physics", async () => {
  const page = boot(base());
  await page.refresh();
  const slider = page.byId("physicsGrid").walk().find((n) => n.tagName === "INPUT" && n.type === "range");
  slider.value = "2";
  slider.fire("change");
  assert.deepEqual(page.writes, [{ name: "setDefaults", args: [{ physics: { weight: 2 } }] }]);
});

test("voices page: every key it writes for voices, loudness and captions is one cast-config VALIDATES", () => {
  // The loop that would have caught `mute` vs `muted`: what the page sends must
  // be a key the validator knows, or the write lands in problems[] and does nothing.
  const cast = require("./cast-config.cjs");
  const { problems } = cast.validateCast({
    version: 1,
    voice: { volume: 0.25, muted: true, defaultVoice: "en-GB-SoniaNeural", speechFilter: { maxChars: 300, allowCode: true } },
    stage: { bubbles: false },
    channels: { "#agents": { voiced: true, presence: "quiet" } },
    actors: { "claude_code:7f3a": { volume: 1.5, bubble: false, voice: "en-US-AvaNeural", speak: false } },
  });
  assert.deepEqual(problems, []);
});

// ─── desk behaviour + sync ──────────────────────────────────────────────────

const DESK = {
  models: { commandProfile: "deepseek", commandProfileFrom: "builtin" },
  prompts: {}, vision: { enabled: true, enabledFrom: "builtin" }, sync: {},
};

test("Advanced: the backend field shows the value IN FORCE and where it came from, and writes models.commandProfile", async () => {
  const page = boot(base({ desk: DESK }));
  await page.refresh();
  const block = field(page.byId("deskGrid"), "Command agent backend");
  assert.match(block.textContent, /in force: deepseek \(builtin\)/);
  const input = inputOf(block, "text");
  assert.equal(input.value, "", "an UNSET field must stay empty -- the built-in is a placeholder, not a value");
  input.value = "opus";
  input.fire("change");
  assert.deepEqual(page.writes, [{ name: "setSection", args: ["models", { commandProfile: "opus" }] }]);
});

test("Advanced: persona, extra instructions, vision and its prompt each write their own section + key", async () => {
  const page = boot(base({ desk: DESK }));
  await page.refresh();
  const desk = page.byId("deskGrid");
  const area = (label) => field(desk, label).walk().find((n) => n.tagName === "TEXTAREA");

  const persona = area("Command agent persona");
  persona.value = "  You are Aither.  ";
  persona.fire("change");
  const extra = area("Extra instructions");
  extra.value = "";
  extra.fire("change");
  const vision = inputOf(field(desk, "Vision"), "checkbox");
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

test("Advanced: sync is shown OFF with its reason, and turning it on writes sync.enabled", async () => {
  const page = boot(base({
    desk: DESK, sync: { enabled: false, reason: "sync.enabled is off", target: null, pull: null, push: null },
  }));
  await page.refresh();
  assert.match(page.byId("syncState").textContent, /off . sync\.enabled is off/);
  const box = inputOf(field(page.byId("syncGrid"), "Sync"), "checkbox");
  assert.equal(box.checked, false, "sync must read OFF when unset");
  box.checked = true;
  box.fire("change");
  assert.deepEqual(page.writes, [{ name: "setSection", args: ["sync", { enabled: true }] }]);
});

test("Advanced: a failed push is SAID -- 'server kept less' is not shown as 'in step'", async () => {
  const page = boot(base({
    desk: DESK,
    sync: {
      enabled: true, reason: null, target: "file D:/p.json",
      pull: { verdict: "in step", output: "", at: "t1" },
      push: { verdict: "refused — the server kept less than it was sent", output: "dropped: authors.token-service", at: "t2" },
    },
  }));
  await page.refresh();
  const text = page.byId("syncState").textContent;
  assert.match(text, /file D:\/p\.json/);
  assert.match(text, /push: refused/);
  assert.match(text, /authors\.token-service/);
});

test("voices page: every desk/sync key the page writes is one cast-config VALIDATES", () => {
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
