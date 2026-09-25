"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { buildHomeSummary, ageLabel, HOME_COMMANDS, planHomeSet } = require("./home-summary.cjs");

const NOW = Date.UTC(2026, 8, 23, 20, 0, 0);
const sec = (msAgo) => Math.floor((NOW - msAgo) / 1000);
const DAY = 24 * 60 * 60 * 1000;

function card(id, over = {}) {
  return { id, title: `card ${id}`, summary: "", urgency: "normal", createdAt: sec(60 * 60 * 1000), options: [], ...over };
}

test("counts every card but lists only the top five ACTIONABLE ones, urgent first", () => {
  const cards = [
    ...Array.from({ length: 8 }, (_, i) => card(`d${i}`, { kind: "decision" })),
    card("hot", { urgency: "critical", createdAt: sec(3 * DAY) }),
    card("fyi", { kind: "info" }),
  ];
  const out = buildHomeSummary({ cards, triage: (c) => (c.kind === "info" ? "fyi" : "decision"), now: NOW });
  assert.equal(out.decisions.total, 10);
  assert.equal(out.decisions.waiting, 9, "the info card is counted but not waiting");
  assert.equal(out.decisions.top.length, 5);
  assert.equal(out.decisions.top[0].id, "hot", "critical leads even when older");
  assert.ok(!out.decisions.top.some((c) => c.id === "fyi"));
});

test("today and stale are measured from created_at in SECONDS (awask's unit)", () => {
  const cards = [card("new"), card("week", { createdAt: sec(8 * DAY) }), card("ms", { createdAt: NOW - 9 * DAY })];
  const out = buildHomeSummary({ cards, now: NOW });
  assert.equal(out.decisions.today, 1);
  assert.equal(out.decisions.stale, 2, "a millisecond timestamp is read as one too");
});

test("the recommended option is marked, default key counts as recommended", () => {
  const cards = [card("x", { defaultKey: "b", options: [{ key: "a", label: "A" }, { key: "b", label: "B" }] })];
  const [top] = buildHomeSummary({ cards, now: NOW }).decisions.top;
  assert.deepEqual(top.options.map((o) => o.recommended), [false, true]);
});

test("health is ONE sentence, naming each failing source once", () => {
  const ok = buildHomeSummary({ sessions: { ok: true, sessions: [] }, gateway: { ok: true }, now: NOW });
  assert.equal(ok.health.level, "ok");
  const bad = buildHomeSummary({ sessions: { ok: false, note: "daemon down" }, gateway: { ok: false, note: "HTTP 503" }, now: NOW });
  assert.equal(bad.health.level, "warn");
  assert.equal(bad.health.text, "MCP gateway: HTTP 503 · sessions: daemon down");
});

test("sessions are summarised by status and capped at six", () => {
  const rows = Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, title: `t${i}`, status: i % 2 ? "idle" : "running" }));
  const out = buildHomeSummary({ sessions: { ok: true, sessions: rows }, now: NOW });
  assert.equal(out.sessions.total, 9);
  assert.deepEqual(out.sessions.byStatus, { running: 5, idle: 4 });
  assert.equal(out.sessions.recent.length, 6);
});

test("voice switches pass through as booleans", () => {
  const out = buildHomeSummary({ voice: { voicesMuted: 1, micMuted: 0, talkMode: "open" }, now: NOW });
  assert.deepEqual(out.voice, { voicesMuted: true, micMuted: false, talkMode: "open", doNotDisturb: false });
});

test("planHomeSet runs a toggle only where the live state differs from the asked-for one", () => {
  const live = { voicesMuted: true, micMuted: false, avatarShown: true, doNotDisturb: false };
  // The switch showed voices ON from a stale snapshot; the owner unchecked it to
  // mute. They are ALREADY muted, so nothing may run (a toggle would un-mute).
  assert.deepEqual(planHomeSet({ voicesMuted: true }, live), []);
  assert.deepEqual(planHomeSet({ voicesMuted: false, micMuted: true, avatarShown: false, doNotDisturb: true }, live),
    ["voice.silence", "voice.mute", "avatar.toggle", "attention.dnd"]);
  assert.deepEqual(planHomeSet({ voicesMuted: "yes", quit: true }, live), [], "non-boolean and unknown keys run nothing");
  assert.deepEqual(planHomeSet(null, live), []);
});

test("Home's command allowlist is its own switches, and main enforces it", () => {
  assert.deepEqual([...HOME_COMMANDS].sort(), ["attention.dnd", "avatar.toggle", "voice.mute", "voice.silence"]);
  assert.ok(!HOME_COMMANDS.includes("quit"));
  // The handlers live in home-ipc.cjs (moved out of main.cjs, slice 3); main wires it.
  const homeIpc = fs.readFileSync(path.join(__dirname, "home-ipc.cjs"), "utf8");
  const handler = homeIpc.slice(homeIpc.indexOf('ipcMain.handle("desk:home-run"'));
  assert.match(handler.slice(0, 400), /HOME_COMMANDS\.includes\(id\)/, "desk:home-run runs any registry id");
  assert.match(homeIpc, /ipcMain\.handle\("desk:home-set"/, "no desired-state verb for Home's switches");
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /require\("\.\/home-ipc\.cjs"\)\.createHomeIpc\(/, "main never wires home-ipc.cjs");
});

// ── home.html, run against a minimal DOM ────────────────────────────────────────
function fakeElement(tag) {
  const node = {
    tagName: tag, className: "", textContent: "", title: "", checked: false, disabled: false,
    dataset: {}, children: [], listeners: {},
    append(...kids) { node.children.push(...kids); },
    appendChild(kid) { node.children.push(kid); return kid; },
    replaceChildren() { node.children = []; },
    addEventListener(type, fn) { node.listeners[type] = fn; },
  };
  return node;
}

function loadHome(api) {
  const html = fs.readFileSync(path.join(__dirname, "home.html"), "utf8");
  const script = html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>"));
  const byId = new Map();
  const document = {
    hidden: true,
    getElementById: (id) => { if (!byId.has(id)) byId.set(id, fakeElement("div")); return byId.get(id); },
    createElement: (tag) => fakeElement(tag),
    querySelectorAll: () => [],
  };
  vm.runInNewContext(script, { window: { aitherHome: api }, document, setInterval: () => 0, console });
  return document;
}

const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };
const buttonsOf = (node) => (node.tagName === "button" ? [node] : node.children.flatMap(buttonsOf));
const answerButtons = (list) => buttonsOf(list).filter((b) => b.textContent !== "Open");
// The page lives in another realm: compare plain data, not prototypes.
const plain = (value) => JSON.parse(JSON.stringify(value));

function homeSummary(over = {}) {
  return {
    decisions: { waiting: 1, total: 1, today: 1, stale: 0,
      top: [{ id: "d-1", title: "Ship it?", summary: "", urgency: "normal", age: "1m",
        options: [{ key: "yes", label: "Yes", recommended: true }] }] },
    sessions: { ok: true, total: 0, byStatus: {}, recent: [] },
    voice: { voicesMuted: false, micMuted: false, talkMode: "toggle", doNotDisturb: false },
    avatars: { shown: true, bodies: 1, character: "" },
    health: { level: "ok", text: "fine" },
    at: Date.now(),
    ...over,
  };
}

test("home.html: a switch sends the state it SHOWS, never a blind toggle", async () => {
  const calls = [];
  const api = {
    summary: async () => homeSummary(),
    set: async (patch) => { calls.push(["set", patch]); return { ok: true }; },
    run: async (id) => { calls.push(["run", id]); return { ok: true }; },
  };
  const doc = loadHome(api);
  await flush();
  const voices = doc.getElementById("v-voices");
  assert.equal(voices.checked, true, "voices drawn ON");
  voices.checked = false; // the owner unchecks it to mute
  await voices.listeners.change();
  assert.deepEqual(plain(calls[0]), ["set", { voicesMuted: true }]);
  const dnd = doc.getElementById("v-dnd");
  dnd.checked = true;
  await dnd.listeners.change();
  assert.deepEqual(plain(calls[1]), ["set", { doNotDisturb: true }]);
  assert.ok(!calls.some(([verb]) => verb === "run"));
});

test("home.html: an answered card is not redrawn live, and a failure stays readable", async () => {
  let summaries = 0;
  let verdict = { ok: false, error: "d-1 is not open" };
  const api = {
    summary: async () => { summaries += 1; return homeSummary(); }, // the stale list keeps d-1
    answer: async () => verdict,
    set: async () => ({ ok: true }),
  };
  const doc = loadHome(api);
  await flush();
  const list = doc.getElementById("d-list");
  let [yes] = answerButtons(list);
  await yes.listeners.click();
  await flush();
  assert.match(doc.getElementById("d-error").textContent, /d-1 is not open/);
  assert.equal(yes.disabled, false, "a refused answer can be retried");
  const before = summaries;
  verdict = { ok: true };
  [yes] = answerButtons(list);
  await yes.listeners.click();
  await flush();
  assert.ok(summaries > before, "a good answer refreshes");
  assert.equal(answerButtons(list).length, 0, "the answered card came back with live buttons");
  assert.equal(doc.getElementById("d-error").textContent, "");
});

// ── the console preload hands a frame the Home bridge by EXACT file only ─────
function preloadExposes(href) {
  const exposed = [];
  const fake = {
    contextBridge: { exposeInMainWorld: (name) => exposed.push(name) },
    ipcRenderer: { invoke: () => Promise.resolve(null), on() {}, off() {}, send() {} },
  };
  const electronPath = require.resolve("electron");
  const saved = { electron: require.cache[electronPath], location: globalThis.location, document: globalThis.document };
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: fake };
  for (const name of ["./console-preload.cjs", "./home-preload.cjs"]) delete require.cache[require.resolve(name)];
  globalThis.location = { href };
  globalThis.document = { readyState: "complete", documentElement: null, addEventListener() {} };
  try {
    require("./console-preload.cjs");
  } finally {
    if (saved.electron) require.cache[electronPath] = saved.electron; else delete require.cache[electronPath];
    globalThis.location = saved.location;
    globalThis.document = saved.document;
  }
  return exposed;
}

test("console-preload: only the real file: home.html gets aitherHome, and only the file: SHELL gets aitherConsole", () => {
  // A pane never sees the shell's bridge: it carries runCommand (review #10).
  assert.deepEqual(preloadExposes("file:///D:/desk/electron/home.html"), ["aitherHome"]);
  assert.deepEqual(preloadExposes("http://localhost:5173/console.html?next=home.html"), [],
    "a localhost page named console.html is not the shell");
  assert.deepEqual(preloadExposes("file:///D:/desk/electron/console.html"), ["aitherConsole"]);
  assert.deepEqual(preloadExposes("file:///D:/desk/electron/nothome.html.bak/console.html"), ["aitherConsole"]);
});

test("ageLabel reads like the inbox", () => {
  assert.equal(ageLabel(30 * 1000), "1m");
  assert.equal(ageLabel(5 * 60 * 60 * 1000), "5h");
  assert.equal(ageLabel(13 * DAY), "13d");
  assert.equal(ageLabel(Infinity), "");
});
