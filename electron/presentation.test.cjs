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
  "settings-window.cjs": 1, // P2
  "avatar-window.cjs": 1, // P3: the avatar overlay (left main.cjs in step 13)
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
  assert.equal(total, 7, "the ratchet only goes down: 13 before step 12, 11 after it, 10 once command moved, 9 once fleet moved, 8 once sessions moved, 7 once stage moved");
});

test("stage-window.cjs never builds its own window again (P2: route 'stage')", () => {
  const source = fs.readFileSync(path.join(__dirname, "stage-window.cjs"), "utf8");
  assert.doesNotMatch(source, /\bBrowserWindow\b/, "stage-window.cjs names BrowserWindow again");
  assert.match(source, /openRouteWindow\(ROUTE, \{ electron: electron\(\) \}\)/, "createStageWindow no longer opens through presentation");
  const { ensureStageIpc, createStageWindow, closeStageWindow, isStageWindowOpen } = require("./stage-window.cjs");
  for (const fn of [ensureStageIpc, createStageWindow, closeStageWindow, isStageWindowOpen]) {
    assert.equal(typeof fn, "function", "the module's exported API is kept for main/console/command callers");
  }
});

test("the stage route keeps the Stage window's exact options, single instance, and no navigation", () => {
  const { ROUTE_WINDOWS, openRouteWindow, closeRouteWindow, routeWindow } = require("./presentation.cjs");
  const built = [];
  class FakeWindow {
    constructor(options) {
      this.options = options;
      this.destroyed = false;
      this.handlers = {};
      this.shown = 0;
      this.focused = 0;
      this.navHandlers = [];
      this.webContents = {
        openHandler: null,
        setWindowOpenHandler: (fn) => { this.webContents.openHandler = fn; },
        on: (event, fn) => { if (event === "will-navigate") this.navHandlers.push(fn); },
      };
      built.push(this);
    }
    isDestroyed() { return this.destroyed; }
    show() { this.shown += 1; }
    focus() { this.focused += 1; }
    once(event, fn) { this.handlers[event] = fn; }
    on(event, fn) { this.handlers[event] = fn; }
    loadFile(file) { this.file = file; return Promise.resolve(); }
    close() { this.destroyed = true; if (this.handlers.closed) this.handlers.closed(); }
  }
  const electron = { BrowserWindow: FakeWindow };
  assert.equal(routeWindow("stage"), null);
  const win = openRouteWindow("stage", { electron });
  assert.deepEqual(win.options, {
    width: 780,
    height: 620,
    minWidth: 520,
    minHeight: 420,
    show: false,
    title: "Aither Stage",
    backgroundColor: "#0f1218",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "stage-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  assert.equal(ROUTE_WINDOWS.stage.file, "stage.html");
  assert.equal(win.file, path.join(__dirname, "stage.html"));
  assert.deepEqual(win.webContents.openHandler(), { action: "deny" });
  let prevented = false;
  win.navHandlers[0]({ preventDefault: () => { prevented = true; } }, "https://example.com/");
  assert.equal(prevented, true, "a file page never navigates");
  win.handlers["ready-to-show"]();
  assert.equal(win.shown, 1);
  assert.equal(win.focused, 1);
  assert.equal(openRouteWindow("stage", { electron }), win, "single instance while it lives");
  assert.equal(built.length, 1);
  assert.equal(win.shown, 2);
  assert.equal(win.focused, 2);
  assert.equal(routeWindow("stage"), win);
  assert.equal(routeWindow("sessions"), null, "the stage window is not the sessions route's handle");
  closeRouteWindow("stage");
  assert.equal(routeWindow("stage"), null, "the handle is dropped on 'closed'");
  closeRouteWindow("stage"); // no-op when absent
});

test("sessions-window.cjs never builds its own window again (P2: route 'sessions')", () => {
  const source = fs.readFileSync(path.join(__dirname, "sessions-window.cjs"), "utf8");
  assert.doesNotMatch(source, /\bBrowserWindow\b/, "sessions-window.cjs names BrowserWindow again");
  assert.match(source, /openRouteWindow\(ROUTE, \{ electron: electron\(\) \}\)/, "createSessionsWindow no longer opens through presentation");
  const { ensureSessionsIpc, createSessionsWindow, closeSessionsWindow, isSessionsWindowOpen } = require("./sessions-window.cjs");
  for (const fn of [ensureSessionsIpc, createSessionsWindow, closeSessionsWindow, isSessionsWindowOpen]) {
    assert.equal(typeof fn, "function", "the module's exported API is kept for main/console/command callers");
  }
});

test("the sessions route keeps the Sessions window's exact options, single instance, and no navigation", () => {
  const { ROUTE_WINDOWS, openRouteWindow, closeRouteWindow, routeWindow } = require("./presentation.cjs");
  const built = [];
  class FakeWindow {
    constructor(options) {
      this.options = options;
      this.destroyed = false;
      this.handlers = {};
      this.shown = 0;
      this.focused = 0;
      this.navHandlers = [];
      this.webContents = {
        openHandler: null,
        setWindowOpenHandler: (fn) => { this.webContents.openHandler = fn; },
        on: (event, fn) => { if (event === "will-navigate") this.navHandlers.push(fn); },
      };
      built.push(this);
    }
    isDestroyed() { return this.destroyed; }
    show() { this.shown += 1; }
    focus() { this.focused += 1; }
    once(event, fn) { this.handlers[event] = fn; }
    on(event, fn) { this.handlers[event] = fn; }
    loadFile(file) { this.file = file; return Promise.resolve(); }
    close() { this.destroyed = true; if (this.handlers.closed) this.handlers.closed(); }
  }
  const electron = { BrowserWindow: FakeWindow };
  assert.equal(routeWindow("sessions"), null);
  const win = openRouteWindow("sessions", { electron });
  assert.deepEqual(win.options, {
    width: 980,
    height: 720,
    minWidth: 640,
    minHeight: 460,
    show: false,
    title: "Aither Sessions",
    backgroundColor: "#0f1218",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "sessions-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  assert.equal(ROUTE_WINDOWS.sessions.file, "sessions.html");
  assert.equal(win.file, path.join(__dirname, "sessions.html"));
  assert.deepEqual(win.webContents.openHandler(), { action: "deny" });
  let prevented = false;
  win.navHandlers[0]({ preventDefault: () => { prevented = true; } }, "https://example.com/");
  assert.equal(prevented, true, "a file page never navigates");
  win.handlers["ready-to-show"]();
  assert.equal(win.shown, 1);
  assert.equal(win.focused, 1);
  assert.equal(openRouteWindow("sessions", { electron }), win, "single instance while it lives");
  assert.equal(built.length, 1);
  assert.equal(win.shown, 2);
  assert.equal(win.focused, 2);
  assert.equal(routeWindow("sessions"), win);
  assert.equal(routeWindow("fleet"), null, "the sessions window is not the fleet route's handle");
  closeRouteWindow("sessions");
  assert.equal(routeWindow("sessions"), null, "the handle is dropped on 'closed'");
  closeRouteWindow("sessions"); // no-op when absent
});

test("fleet-window.cjs never builds its own window again (P2: route 'fleet')", () => {
  const source = fs.readFileSync(path.join(__dirname, "fleet-window.cjs"), "utf8");
  assert.doesNotMatch(source, /\bBrowserWindow\b/, "fleet-window.cjs names BrowserWindow again");
  assert.match(source, /openRouteWindow\(ROUTE, \{ electron \}\)/, "createFleetWindow no longer opens through presentation");
});

test("the fleet route keeps the Fleet window's exact options, single instance, and no navigation", () => {
  const { ROUTE_WINDOWS, openRouteWindow, closeRouteWindow, routeWindow } = require("./presentation.cjs");
  const built = [];
  class FakeWindow {
    constructor(options) {
      this.options = options;
      this.destroyed = false;
      this.handlers = {};
      this.shown = 0;
      this.focused = 0;
      this.navHandlers = [];
      this.webContents = {
        openHandler: null,
        setWindowOpenHandler: (fn) => { this.webContents.openHandler = fn; },
        on: (event, fn) => { if (event === "will-navigate") this.navHandlers.push(fn); },
      };
      built.push(this);
    }
    isDestroyed() { return this.destroyed; }
    show() { this.shown += 1; }
    focus() { this.focused += 1; }
    once(event, fn) { this.handlers[event] = fn; }
    on(event, fn) { this.handlers[event] = fn; }
    loadFile(file) { this.file = file; return Promise.resolve(); }
    close() { this.destroyed = true; if (this.handlers.closed) this.handlers.closed(); }
  }
  const electron = { BrowserWindow: FakeWindow };
  assert.equal(routeWindow("fleet"), null);
  const win = openRouteWindow("fleet", { electron });
  assert.deepEqual(win.options, {
    width: 640,
    height: 720,
    minWidth: 480,
    minHeight: 560,
    show: false,
    title: "Aither Fleet",
    backgroundColor: "#0f1218",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "fleet-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  assert.equal(ROUTE_WINDOWS.fleet.file, "fleet-control.html");
  assert.equal(win.file, path.join(__dirname, "fleet-control.html"));
  assert.deepEqual(win.webContents.openHandler(), { action: "deny" });
  let prevented = false;
  win.navHandlers[0]({ preventDefault: () => { prevented = true; } }, "https://example.com/");
  assert.equal(prevented, true, "a file page never navigates");
  win.handlers["ready-to-show"]();
  assert.equal(win.shown, 1);
  assert.equal(win.focused, 1);
  assert.equal(openRouteWindow("fleet", { electron }), win, "single instance while it lives");
  assert.equal(built.length, 1);
  assert.equal(win.shown, 2);
  assert.equal(win.focused, 2);
  assert.equal(routeWindow("fleet"), win);
  assert.equal(routeWindow("command"), null, "the fleet window is not the command route's handle");
  closeRouteWindow("fleet");
  assert.equal(routeWindow("fleet"), null, "the handle is dropped on 'closed'");
  closeRouteWindow("fleet"); // no-op when absent
});

test("command-window.cjs never builds its own window again (P2: route 'command')", () => {
  const source = fs.readFileSync(path.join(__dirname, "command-window.cjs"), "utf8");
  assert.doesNotMatch(source, /\bBrowserWindow\b/, "command-window.cjs names BrowserWindow again");
  assert.match(source, /openRouteWindow\(ROUTE, \{ electron \}\)/, "createCommandWindow no longer opens through presentation");
});

test("the command route keeps the Command window's exact options, single instance, and no navigation", () => {
  const { ROUTE_WINDOWS, openRouteWindow, closeRouteWindow, routeWindow } = require("./presentation.cjs");
  const built = [];
  class FakeWindow {
    constructor(options) {
      this.options = options;
      this.destroyed = false;
      this.handlers = {};
      this.shown = 0;
      this.focused = 0;
      this.navHandlers = [];
      this.webContents = {
        openHandler: null,
        setWindowOpenHandler: (fn) => { this.webContents.openHandler = fn; },
        on: (event, fn) => { if (event === "will-navigate") this.navHandlers.push(fn); },
      };
      built.push(this);
    }
    isDestroyed() { return this.destroyed; }
    show() { this.shown += 1; }
    focus() { this.focused += 1; }
    once(event, fn) { this.handlers[event] = fn; }
    on(event, fn) { this.handlers[event] = fn; }
    loadFile(file) { this.file = file; return Promise.resolve(); }
    close() { this.destroyed = true; if (this.handlers.closed) this.handlers.closed(); }
  }
  const electron = { BrowserWindow: FakeWindow };
  assert.equal(routeWindow("command"), null);
  const win = openRouteWindow("command", { electron });
  assert.deepEqual(win.options, {
    width: 640,
    height: 720,
    minWidth: 480,
    minHeight: 560,
    show: false,
    title: "Aither Command",
    backgroundColor: "#0f1218",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "command-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  assert.equal(ROUTE_WINDOWS.command.file, "command.html");
  assert.equal(win.file, path.join(__dirname, "command.html"));
  assert.deepEqual(win.webContents.openHandler(), { action: "deny" });
  let prevented = false;
  win.navHandlers[0]({ preventDefault: () => { prevented = true; } }, "https://example.com/");
  assert.equal(prevented, true, "a file page never navigates");
  win.handlers["ready-to-show"]();
  assert.equal(win.shown, 1);
  assert.equal(win.focused, 1);
  assert.equal(openRouteWindow("command", { electron }), win, "single instance while it lives");
  assert.equal(built.length, 1);
  assert.equal(win.shown, 2);
  assert.equal(win.focused, 2);
  assert.equal(routeWindow("command"), win);
  closeRouteWindow("command");
  assert.equal(routeWindow("command"), null, "the handle is dropped on 'closed'");
  closeRouteWindow("command"); // no-op when absent
  assert.throws(() => openRouteWindow("nope", { electron }), /no window route nope/);
});

test("the deck and chat panels are no longer built in main.cjs", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.doesNotMatch(main, /function createDeckWindow\(|function createChatWindow\(|function openConsole\(/);
  assert.match(main, /require\("\.\/presentation\.cjs"\)\.createPresentation\(/, "main no longer wires the window plane");
});

test("main.cjs constructs no window and never holds the avatar window (step 13)", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.equal(main.split("new BrowserWindow(").length - 1, 0, "a window is built in main.cjs again");
  assert.match(main, /require\("\.\/avatar-window\.cjs"\)\.createAvatarWindow\(/, "main no longer wires the avatar window");
  // The overlay is replaced over the desk's life (closed -> null -> rebuilt), so a
  // module-level copy, or a dep that captures one, goes stale. Readers ask the getter.
  assert.doesNotMatch(main, /^(let|var) avatarWindow\b/m, "main keeps its own avatar-window variable again");
  assert.doesNotMatch(main, /getAvatarWindow:\s*\(\)\s*=>\s*avatarWindow/, "a dep captures main's copy, not the getter");
  assert.doesNotMatch(main, /\blatestEvent\b|\bhyprlandConfigur/, "avatar-window state leaked back into main");
});

/** Just enough of Electron for avatar-window.cjs: the overlay's setters, IPC, userData. */
function fakeAvatarElectron() {
  const built = [];
  class FakeWindow {
    constructor(options) {
      this.options = options;
      this.destroyed = false;
      this.visible = false;
      this.handlers = {};
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
    static fromWebContents() { return null; }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setOpacity() {}
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    isVisible() { return this.visible; }
    showInactive() { this.visible = true; }
    show() { this.visible = true; }
    focus() {}
    hide() { this.visible = false; }
    once(event, fn) { this.handlers[event] = fn; }
    on(event, fn) { this.handlers[event] = fn; }
    loadURL(url) { this.loaded = url; return Promise.resolve(); }
    destroy() { this.destroyed = true; if (this.handlers.closed) this.handlers.closed(); }
  }
  const ipcMain = { removeAllListeners: () => {}, on: () => {} };
  const app = { getPath: () => require("node:os").tmpdir() };
  return { electron: { BrowserWindow: FakeWindow, screen: {}, ipcMain }, app, built };
}

test("getAvatarWindow follows the replaced overlay, and the last event survives for the snapshot", () => {
  const { createAvatarWindow } = require("./avatar-window.cjs");
  const { electron, app, built } = fakeAvatarElectron();
  const avatar = createAvatarWindow({
    electron,
    app,
    configureHyprlandWindow: async () => true,
    getHyprlandWindowPlacement: async () => null,
    isAllowedRendererNavigation: () => true,
  });
  assert.equal(avatar.getAvatarWindow(), null, "no window before the first show");
  avatar.emitToRenderer({ type: "state", state: { phase: "idle" } });
  avatar.showOverlay();
  const first = avatar.getAvatarWindow();
  assert.equal(first, built[0]);
  assert.equal(first.visible, true);
  assert.equal(avatar.createWindow(), first, "single instance while it lives");
  first.destroy();
  assert.equal(avatar.getAvatarWindow(), null, "the getter drops a closed window");
  avatar.showOverlay();
  assert.equal(built.length, 2);
  assert.equal(avatar.getAvatarWindow(), built[1], "the getter returns the REPLACEMENT");
  avatar.sendToAvatar("focus-avatar", { slotId: null });
  assert.deepEqual(built[1].webContents.sent, [["desk:event", { type: "focus-avatar", slotId: null }]]);
  assert.deepEqual(avatar.getLatestEvent(), { type: "state", state: { phase: "idle" } });
  avatar.stop();
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
