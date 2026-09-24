"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { createPresentation } = require("./presentation.cjs");

/**
 * The ratchet (slice 3 of docs/UX-REIMPLEMENTATION.md, map.presentation_layer):
 * presentation.cjs is to become the ONLY file that constructs a BrowserWindow.
 * Step 12 (P0+P1) moved the deck and chat panels; every construction still
 * outside it is listed here BY FILE with the phase that moves it. When a window
 * moves, delete its entry -- this list may only shrink, never grow.
 */
const STILL_OUTSIDE = {
  "cast-window.cjs": 1, // P2
  "command-window.cjs": 1, // P2
  "fleet-window.cjs": 1, // P2
  "sessions-window.cjs": 1, // P2
  "settings-window.cjs": 1, // P2
  "stage-window.cjs": 1, // P2
  "main.cjs": 1, // P3 / step 13 (avatar-window.cjs): the avatar overlay
  "detached-avatar-window.cjs": 1, // P3: the 'solo:<slot>' windows
  "living-desktop-window.cjs": 2, // P4: the overlay + the desktop app window
  "console-window.cjs": 1, // P5: the console itself
};

function constructionsByFile() {
  const counts = {};
  for (const name of fs.readdirSync(__dirname)) {
    if (!name.endsWith(".cjs") || name.endsWith(".test.cjs")) continue;
    const source = fs.readFileSync(path.join(__dirname, name), "utf8");
    const n = source.split("new BrowserWindow(").length - 1;
    if (n) counts[name] = n;
  }
  return counts;
}

test("window constructions outside presentation.cjs are exactly the ones left for later phases", () => {
  const { "presentation.cjs": inside = 0, ...outside } = constructionsByFile();
  assert.equal(inside, 1, "presentation.cjs builds its panels through ONE constructor");
  assert.deepEqual(
    outside,
    STILL_OUTSIDE,
    "a window constructor appeared outside presentation.cjs, or one moved and its STILL_OUTSIDE entry was not deleted",
  );
  const total = Object.values(outside).reduce((a, b) => a + b, 0);
  assert.equal(total, 11, "the ratchet only goes down: 13 before step 12, 11 after it");
});

test("the deck and chat panels are no longer built in main.cjs", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.doesNotMatch(main, /function createDeckWindow\(|function createChatWindow\(|function openConsole\(/);
  assert.match(main, /require\("\.\/presentation\.cjs"\)\.createPresentation\(/, "main no longer wires the window plane");
});

/** A BrowserWindow stand-in: records construction, show/focus/close and events. */
function fakeElectron() {
  const built = [];
  class FakeWindow {
    constructor(options) {
      this.options = options;
      this.destroyed = false;
      this.handlers = {};
      this.shown = 0;
      this.focused = 0;
      this.loaded = null;
      this.webContents = {
        sent: [],
        setWindowOpenHandler: () => {},
        on: () => {},
        once: () => {},
        isLoading: () => false,
        send: (channel, payload) => this.webContents.sent.push([channel, payload]),
      };
      built.push(this);
    }
    setAlwaysOnTop() {}
    isDestroyed() { return this.destroyed; }
    show() { this.shown += 1; }
    focus() { this.focused += 1; }
    once(event, fn) { this.handlers[event] = fn; }
    on(event, fn) { this.handlers[event] = fn; }
    loadURL(url) { this.loaded = url; return Promise.resolve(); }
    close() { this.destroyed = true; if (this.handlers.closed) this.handlers.closed(); }
  }
  const screen = { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) };
  return { electron: { BrowserWindow: FakeWindow, screen }, built };
}

function build() {
  const { electron, built } = fakeElectron();
  const calls = [];
  const noop = (name, ret) => (...args) => { calls.push([name, ...args]); return ret; };
  const windowModule = (x) => ({
    [`create${x}Window`]: noop(`create${x}Window`, null),
    [`close${x}Window`]: noop(`close${x}Window`),
    [`is${x}WindowOpen`]: noop(`is${x}WindowOpen`, false),
    [`ensure${x}Ipc`]: noop(`ensure${x}Ipc`),
  });
  const presentation = createPresentation({
    electron,
    rendererUrl: () => "http://127.0.0.1:5173/",
    isAllowedRendererNavigation: () => true,
    showConsole: noop("showConsole", "console"),
    focusPane: noop("focusPane", true),
    closeConsole: noop("closeConsole"),
    fleetWindow: { ...windowModule("Fleet"), setCloseFallback: noop("setCloseFallback"), getControl: noop("getControl", {}) },
    commandWindow: { ...windowModule("Command"), setCloseFallback: noop("setCloseFallback") },
    sessionsWindow: windowModule("Sessions"),
    stageWindow: windowModule("Stage"),
    settingsWindow: windowModule("Settings"),
    castWindow: windowModule("Cast"),
    desktop: {
      showDesktopApp: noop("showDesktopApp"),
      closeDesktopApp: noop("closeDesktopApp"),
      isAppOpen: noop("isAppOpen", false),
      desktopAppUrl: "",
      ensureDesktopSession: noop("ensureDesktopSession"),
      portalLoginUrl: "",
    },
    ensureHomeIpc: noop("ensureHomeIpc"),
    stagePaneImpl: noop("stagePaneImpl", {}),
    castPaneImpl: noop("castPaneImpl", {}),
    commandRegistry: { paletteRows: () => [] },
    commandContext: () => ({}),
    runCommand: noop("runCommand"),
  });
  return { presentation, built, calls };
}

test("the deck is single-instance and the cards and characters routes share it", () => {
  const { presentation, built } = build();
  const deck = presentation.open("cards");
  assert.equal(built.length, 1);
  assert.equal(deck.loaded, "http://127.0.0.1:5173/?deck=1");
  assert.equal(deck.options.title, "Desk");
  assert.equal(deck.options.webPreferences.sandbox, true);
  assert.equal(presentation.open("characters"), deck, "characters reuses the deck window");
  assert.equal(built.length, 1);
  assert.equal(presentation.isOpen("characters"), true);
  presentation.close("cards");
  assert.equal(presentation.isOpen("cards"), false);
  assert.equal(presentation.getDeckWindow(), null, "the handle is dropped on 'closed'");
});

test("the chat panel opens on ?chat=1, left of the avatar", () => {
  const { presentation, built } = build();
  const chat = presentation.createChatWindow();
  assert.equal(built.length, 1);
  assert.equal(chat.loaded, "http://127.0.0.1:5173/?chat=1");
  assert.equal(chat.options.title, "Desk chat");
  assert.equal(presentation.getChatWindow(), chat);
  assert.equal(presentation.isOpen("chat"), true);
});

test("openInbox raises a detached deck, else lands on the console's cards pane", () => {
  const { presentation, calls } = build();
  assert.equal(presentation.openInbox("card-7"), true);
  assert.ok(calls.some(([name]) => name === "showConsole"), "no deck: the console opens");
  assert.deepEqual(calls.find(([name]) => name === "focusPane"), ["focusPane", "cards", "card-7"]);
  const deck = presentation.createDeckWindow();
  const before = deck.focused;
  calls.length = 0;
  assert.equal(presentation.openInbox(), true);
  assert.equal(deck.focused, before + 1);
  assert.equal(calls.length, 0, "a live deck is raised without touching the console");
});

test("openModelBrowser scrolls the deck to Models & Market", () => {
  const { presentation } = build();
  const deck = presentation.openModelBrowser();
  assert.deepEqual(deck.webContents.sent, [["desk:event", { type: "scroll-to-section", section: "models" }]]);
});

test("an unknown route throws, and every route carries exactly the three verbs", () => {
  const { presentation } = build();
  assert.throws(() => presentation.open("nope"), /no route nope/);
  for (const [, verbs] of Object.entries(presentation.windowsMap())) {
    assert.deepEqual(Object.keys(verbs), ["open", "close", "isOpen"]);
  }
});
