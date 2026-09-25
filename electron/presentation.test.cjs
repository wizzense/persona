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
  "avatar-window.cjs": 1, // P3: the avatar overlay (left main.cjs in step 13)
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
  assert.equal(total, 2, "the ratchet only goes down: 13 before step 12, 11 after it, 10 once command moved, 9 once fleet moved, 8 once sessions moved, 7 once stage moved, 6 once settings moved, 5 once cast moved, 3 once the living-desktop overlay and app window moved, 2 once the detached-avatar solo windows moved");
});

test("detached-avatar-window.cjs never builds its own window again (P3: solo windows)", () => {
  // Read as text: in a plain `node`, require("electron") is a path string, so the
  // module's context menu cannot be driven here; the build it hands over is below.
  const source = fs.readFileSync(path.join(__dirname, "detached-avatar-window.cjs"), "utf8");
  assert.doesNotMatch(source, /\bBrowserWindow\b/, "detached-avatar-window.cjs names BrowserWindow again");
  assert.match(source, /buildSoloWindow\(slotId, \{ electron, title \}\)/, "openDetachedAvatar no longer builds through presentation");
  // What stays with the module: the floating level, every workspace, the solo URL's
  // navigation fence and the right-click way out.
  assert.match(source, /win\.setAlwaysOnTop\(true, "floating"\)/);
  assert.match(source, /win\.setVisibleOnAllWorkspaces\(true, \{ visibleOnFullScreen: true \}\)/);
  assert.match(source, /isAllowedRendererNavigation\(targetUrl, rendererUrl\)/);
  assert.match(source, /label: "Return to main scene"/);
  const mod = require("./detached-avatar-window.cjs");
  for (const name of ["openDetachedAvatar", "closeDetachedAvatar", "isOpen", "listDetached"]) {
    assert.equal(typeof mod[name], "function", `${name} is kept for main.cjs`);
  }
  assert.equal(mod.isOpen("slot-x"), false);
  assert.deepEqual(mod.listDetached(), []);
  mod.closeDetachedAvatar("slot-x"); // no-op when absent
});

test("the solo windows keep the detached avatar's exact options, one per slot", () => {
  const { SOLO_WINDOW, buildSoloWindow, routeWindow } = require("./presentation.cjs");
  const built = [];
  class FakeWindow {
    constructor(options) {
      this.options = options;
      this.destroyed = false;
      this.handlers = {};
      built.push(this);
    }
    isDestroyed() { return this.destroyed; }
    on(event, fn) { this.handlers[event] = fn; }
    close() { this.destroyed = true; if (this.handlers.closed) this.handlers.closed(); }
  }
  const electron = { BrowserWindow: FakeWindow };
  const options = (title) => ({
    width: 420,
    height: 620,
    minWidth: 260,
    minHeight: 360,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    roundedCorners: false,
    autoHideMenuBar: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    title,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  assert.equal(SOLO_WINDOW.preload, "preload.cjs");
  assert.equal(routeWindow("solo:a"), null);
  const a = buildSoloWindow("a", { electron, title: "Aria" });
  assert.deepEqual(a.options, options("Aria"));
  assert.equal("partition" in a.options.webPreferences, false, "a solo avatar shares the default session");
  const b = buildSoloWindow("b", { electron });
  assert.deepEqual(b.options, options("Desk"), "no title falls back to the desk's name");
  assert.deepEqual(buildSoloWindow("c", { electron, title: "" }).options, options("Desk"));
  assert.equal(routeWindow("solo:a"), a, "multi-instance: one handle per slot");
  assert.equal(routeWindow("solo:b"), b);
  a.close();
  assert.equal(routeWindow("solo:a"), null, "the handle is dropped on 'closed'");
  assert.equal(routeWindow("solo:b"), b, "closing one slot leaves the others");
  b.close();
  built[2].close();
  assert.equal(built.length, 3);
});

test("living-desktop-window.cjs never builds its own window again (P4: hosted 'overlay' + 'desktop')", () => {
  // Read as text: the module requires electron and wires ipcMain at load.
  const source = fs.readFileSync(path.join(__dirname, "living-desktop-window.cjs"), "utf8");
  assert.doesNotMatch(source, /\bBrowserWindow\b/, "living-desktop-window.cjs names BrowserWindow again");
  assert.match(source, /buildHostedWindow\("overlay", \{ electron, partition: PARTITION \}\)/, "the overlay no longer builds through presentation");
  assert.match(source, /buildHostedWindow\("desktop", \{ electron, partition: PARTITION \}\)/, "the app window no longer builds through presentation");
  // The module keeps the session: the partition it signs in is the one it hands over.
  assert.match(source, /const PARTITION = "persist:living-desktop";/);
  assert.match(source, /syncPortalSessionCookie\(\)/, "the vault-token injection left the module");
});

test("the hosted routes keep the overlay's and the app window's exact options, on their partition", () => {
  const { HOSTED_WINDOWS, buildHostedWindow, routeWindow } = require("./presentation.cjs");
  const built = [];
  class FakeWindow {
    constructor(options) {
      this.options = options;
      this.destroyed = false;
      this.handlers = {};
      built.push(this);
    }
    isDestroyed() { return this.destroyed; }
    on(event, fn) { this.handlers[event] = fn; }
    close() { this.destroyed = true; if (this.handlers.closed) this.handlers.closed(); }
  }
  const workArea = { x: 10, y: 20, width: 1900, height: 1040 };
  const electron = { BrowserWindow: FakeWindow, screen: { getPrimaryDisplay: () => ({ workArea }) } };
  const partition = "persist:living-desktop";
  const webPreferences = {
    partition,
    preload: path.join(__dirname, "living-desktop-preload.cjs"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  };

  assert.equal(routeWindow("overlay"), null);
  const overlay = buildHostedWindow("overlay", { electron, partition });
  assert.deepEqual(overlay.options, {
    x: 10,
    y: 20,
    width: 1900,
    height: 1040,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    roundedCorners: false,
    skipTaskbar: false,
    title: "AitherOS Aitheros Online",
    webPreferences,
  });
  assert.equal("alwaysOnTop" in overlay.options, false, "the avatars must float ABOVE the overlay");
  assert.equal(routeWindow("overlay"), overlay);

  const app = buildHostedWindow("desktop", { electron, partition });
  assert.deepEqual(app.options, {
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    frame: true,
    autoHideMenuBar: true,
    backgroundColor: "#0b0d12",
    title: "AitherDesktop",
    webPreferences,
  });
  // A small work area shrinks the app window by the same 80 px margin it always had.
  assert.deepEqual(HOSTED_WINDOWS.desktop.place({ x: 0, y: 0, width: 1280, height: 720 }), { width: 1200, height: 640 });
  assert.equal(routeWindow("desktop"), app);
  assert.equal(built.length, 2);

  overlay.close();
  assert.equal(routeWindow("overlay"), null, "the handle is dropped on 'closed'");
  assert.equal(routeWindow("desktop"), app, "closing the overlay leaves the app window");
  app.close();
  assert.equal(routeWindow("desktop"), null);

  assert.throws(() => buildHostedWindow("overlay", { electron }), /needs its session partition/);
  assert.throws(() => buildHostedWindow("nope", { electron, partition }), /no hosted window nope/);
  assert.equal(built.length, 2, "a refused build constructs nothing");
});

test("cast-window.cjs never builds its own window again (P2: route 'cast')", () => {
  const source = fs.readFileSync(path.join(__dirname, "cast-window.cjs"), "utf8");
  assert.doesNotMatch(source, /\bBrowserWindow\b/, "cast-window.cjs names BrowserWindow again");
  assert.match(source, /openRouteWindow\(ROUTE, \{ electron: electron\(\) \}\)/, "createCastWindow no longer opens through presentation");
  // presentation.cjs requires cast-window.cjs at its top level, so a module-scope
  // require back into presentation would read its half-built (empty) exports.
  assert.doesNotMatch(source, /^const .*require\("\.\/presentation\.cjs"\)/m, "cast-window.cjs requires presentation at module scope (a cycle)");
  const { ensureCastIpc, createCastWindow, closeCastWindow, isCastWindowOpen } = require("./cast-window.cjs");
  for (const fn of [ensureCastIpc, createCastWindow, closeCastWindow, isCastWindowOpen]) {
    assert.equal(typeof fn, "function", "the module's exported API is kept for main/console/command callers");
  }
  assert.equal(isCastWindowOpen(), false, "the wrapper reaches presentation's route handle");
  closeCastWindow(); // no-op when absent
});

test("the cast route keeps the Cast window's exact options, single instance, and no navigation", () => {
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
  assert.equal(routeWindow("cast"), null);
  const win = openRouteWindow("cast", { electron });
  assert.deepEqual(win.options, {
    width: 860,
    height: 680,
    minWidth: 560,
    minHeight: 460,
    show: false,
    title: "Aither Cast",
    backgroundColor: "#0f1218",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "cast-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  assert.equal(ROUTE_WINDOWS.cast.file, "cast.html");
  assert.equal(win.file, path.join(__dirname, "cast.html"));
  assert.deepEqual(win.webContents.openHandler(), { action: "deny" });
  let prevented = false;
  win.navHandlers[0]({ preventDefault: () => { prevented = true; } }, "https://example.com/");
  assert.equal(prevented, true, "a file page never navigates");
  win.handlers["ready-to-show"]();
  assert.equal(win.shown, 1);
  assert.equal(win.focused, 1);
  assert.equal(openRouteWindow("cast", { electron }), win, "single instance while it lives");
  assert.equal(built.length, 1);
  assert.equal(win.shown, 2);
  assert.equal(win.focused, 2);
  assert.equal(routeWindow("cast"), win);
  assert.equal(routeWindow("settings"), null, "the cast window is not the settings route's handle");
  const { isCastWindowOpen } = require("./cast-window.cjs");
  assert.equal(isCastWindowOpen(), true, "the module's isOpen reads the route's handle");
  closeRouteWindow("cast");
  assert.equal(routeWindow("cast"), null, "the handle is dropped on 'closed'");
  assert.equal(isCastWindowOpen(), false);
  closeRouteWindow("cast"); // no-op when absent
});

test("settings-window.cjs never builds its own window again (P2: route 'settings')", () => {
  const source = fs.readFileSync(path.join(__dirname, "settings-window.cjs"), "utf8");
  assert.doesNotMatch(source, /\bBrowserWindow\b/, "settings-window.cjs names BrowserWindow again");
  assert.match(source, /openRouteWindow\(ROUTE, \{ electron: electron\(\) \}\)/, "createSettingsWindow no longer opens through presentation");
  const { createSettingsWindow, closeSettingsWindow, isSettingsWindowOpen } = require("./settings-window.cjs");
  for (const fn of [createSettingsWindow, closeSettingsWindow, isSettingsWindowOpen]) {
    assert.equal(typeof fn, "function", "the module's exported API is kept for main/console/command callers");
  }
});

test("the settings route keeps the Settings window's exact options, single instance, and no navigation", () => {
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
  assert.equal(routeWindow("settings"), null);
  const win = openRouteWindow("settings", { electron });
  assert.deepEqual(win.options, {
    width: 640,
    height: 560,
    minWidth: 460,
    minHeight: 380,
    show: false,
    title: "Aither Settings",
    backgroundColor: "#0f1218",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "settings-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  assert.equal(ROUTE_WINDOWS.settings.file, "settings.html");
  assert.equal(win.file, path.join(__dirname, "settings.html"));
  assert.deepEqual(win.webContents.openHandler(), { action: "deny" });
  let prevented = false;
  win.navHandlers[0]({ preventDefault: () => { prevented = true; } }, "https://example.com/");
  assert.equal(prevented, true, "a file page never navigates");
  win.handlers["ready-to-show"]();
  assert.equal(win.shown, 1);
  assert.equal(win.focused, 1);
  assert.equal(openRouteWindow("settings", { electron }), win, "single instance while it lives");
  assert.equal(built.length, 1);
  assert.equal(win.shown, 2);
  assert.equal(win.focused, 2);
  assert.equal(routeWindow("settings"), win);
  assert.equal(routeWindow("stage"), null, "the settings window is not the stage route's handle");
  closeRouteWindow("settings");
  assert.equal(routeWindow("settings"), null, "the handle is dropped on 'closed'");
  closeRouteWindow("settings"); // no-op when absent
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
