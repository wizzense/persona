"use strict";

/**
 * presentation.cjs -- the desk's window plane: the route registry every console
 * pane detaches through, the deck and chat panels, the standalone file-page
 * windows (ROUTE_WINDOWS: the Command, Fleet, Sessions, Stage and Settings windows so far), openConsole, and the three
 * doors that land on those surfaces: openInbox, openTalkWindow and openModelBrowser.
 *
 * Moved out of main.cjs in slice 3 of docs/UX-REIMPLEMENTATION.md (step 12, plan
 * phases P0+P1). Pure move: every URL, window option, channel and ordering is what
 * main.cjs had. What is NEW is structure only -- the console's `windows` map is
 * DERIVED from the registry (windowsMap()), so a pane can no longer be offered
 * without all three verbs, and the deck and chat panels share one constructor.
 *
 * The ratchet (presentation.test.cjs) counts window constructions outside this
 * file: the remaining *-window.cjs modules move here in later phases, and that
 * count may only go down. Electron itself arrives as a dep, so the module loads in
 * a plain `node`.
 */

const path = require("node:path");

// U28 lands LAST and this plan's units build concurrently -- cast-window.cjs may
// still be in flight on a box as this lands. Guarded (not a top-level destructure)
// so a peer unit's module landing AFTER this file does not crash the whole desk at
// require() time; the Cast pane is wired ONLY when present, and starts working with
// no further edit once its module exists (moved from main.cjs with openConsole,
// its only consumer).
let castModule = {};
try {
  // U03: the Cast pane's window/IPC module -- names follow every OTHER
  // *-window.cjs (create<X>Window/close<X>Window/is<X>WindowOpen beside
  // ensure<X>Ipc: stage-window.cjs, command-window.cjs, sessions-window.cjs,
  // fleet-window.cjs all share this shape).
  castModule = require("./cast-window.cjs");
} catch (error) {
  console.warn("[desk] cast-window.cjs not present yet (U03) -- Cast pane unavailable:", error?.message || error);
}

// The deck opens beside the avatar on its RIGHT; if the avatar sits against the
// right edge, it opens to its LEFT instead of off-screen.
function placeRightOfAvatar(workArea, base, width, height) {
  let x = base ? base.x + base.width + 10 : workArea.x + workArea.width - width - 40;
  let y = base ? base.y : workArea.y + 80;
  if (x + width > workArea.x + workArea.width) {
    x = Math.max(workArea.x + 8, base ? base.x - width - 10 : x);
  }
  y = Math.max(workArea.y + 8, Math.min(y, workArea.y + workArea.height - height - 8));
  return { x, y };
}

// The chat panel opens on the avatar's LEFT, flipping right when that is off-screen.
function placeLeftOfAvatar(workArea, base, width, height) {
  let x = base ? base.x - width - 10 : workArea.x + 60;
  let y = base ? base.y : workArea.y + 80;
  if (x < workArea.x) {
    x = Math.min(workArea.x + workArea.width - width - 8,
      base ? base.x + base.width + 10 : x);
  }
  y = Math.max(workArea.y + 8, Math.min(y, workArea.y + workArea.height - height - 8));
  return { x, y };
}

/** The two floating panels. Same bundle as the avatar scene, same preload, so they
 *  share the bridge and every awdesk rename moves them along for free. */
const PANELS = {
  // The Desk panel -- frameless, always on top, beside the avatar (`?deck=1`).
  deck: {
    query: "deck=1",
    place: placeRightOfAvatar,
    // Renderer warnings and a crashed renderer reach the debug log (the deck's
    // own diagnostics; the chat panel never had them).
    logLabel: "deck",
    window: {
      width: 460,
      height: 700,
      minWidth: 360,
      minHeight: 480,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: true,
      autoHideMenuBar: true,
      alwaysOnTop: true,
      // In the taskbar on purpose: an always-on-top frameless panel the owner
      // cannot find again once it loses focus is a trap, not a feature.
      skipTaskbar: false,
      title: "Desk",
    },
  },
  // The chat bead window (2026-08-25): the company-room relay + direct threads in
  // a DEDICATED chat surface -- not the deck, not a terminal (`?chat=1`).
  chat: {
    query: "chat=1",
    place: placeLeftOfAvatar,
    logLabel: null,
    window: {
      width: 420,
      height: 640,
      minWidth: 340,
      minHeight: 420,
      show: false,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: false,
      title: "Desk chat",
    },
  },
};

/**
 * The ONE constructor. Every window this module builds goes through here, so the
 * baseline webPreferences (isolated, no node, sandboxed, the named preload) cannot
 * drift between routes. The console's sandbox:false exception is NOT a caller of
 * this -- it is still built in console-window.cjs (P5) and will arrive as a named
 * exception in its spec, not as a flag any route can set.
 */
function constructWindow(BrowserWindow, options, preload) {
  return new BrowserWindow({
    ...options,
    webPreferences: {
      preload: path.join(__dirname, preload),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
}

/**
 * Standalone windows that load a local page (`page: {kind:'file'}`) and are owned
 * by a *-window.cjs module that keeps its IPC. The module's create/close/isOpen are
 * thin wrappers over openRouteWindow/closeRouteWindow/routeWindow below, so every
 * caller (the console's windows map, protocol routing, the command verbs) keeps
 * the module's API while the construction lives here.
 *
 * A file page never navigates: will-navigate is refused outright (not merely
 * checked against the renderer's origin, as the panels are).
 */
const ROUTE_WINDOWS = {
  // The Command window (P2, moved from command-window.cjs): a REAL window --
  // framed, in the taskbar, its own title.
  command: {
    file: "command.html",
    preload: "command-preload.cjs",
    window: {
      width: 640,
      height: 720,
      minWidth: 480,
      minHeight: 560,
      show: false,
      title: "Aither Command",
      backgroundColor: "#0f1218",
      autoHideMenuBar: true,
    },
  },
  // The Fleet control window (P2, moved from fleet-window.cjs): framed, in the
  // taskbar, over the four-verb fleet preload. The module keeps FleetControl + IPC.
  fleet: {
    file: "fleet-control.html",
    preload: "fleet-preload.cjs",
    window: {
      width: 640,
      height: 720,
      minWidth: 480,
      minHeight: 560,
      show: false,
      title: "Aither Fleet",
      backgroundColor: "#0f1218",
      autoHideMenuBar: true,
    },
  },
  // The Sessions window (P2, moved from sessions-window.cjs): the Sessions pane's
  // standalone twin, read-only list + tail. The module keeps its two IPC handlers.
  sessions: {
    file: "sessions.html",
    preload: "sessions-preload.cjs",
    window: {
      width: 980,
      height: 720,
      minWidth: 640,
      minHeight: 460,
      show: false,
      title: "Aither Sessions",
      backgroundColor: "#0f1218",
      autoHideMenuBar: true,
    },
  },
  // The Stage window (P2, moved from stage-window.cjs): every body on the stage,
  // listed, with the arrangements beside them. The module keeps its four IPC
  // handlers and the injected stageImpl.
  stage: {
    file: "stage.html",
    preload: "stage-preload.cjs",
    window: {
      width: 780,
      height: 620,
      minWidth: 520,
      minHeight: 420,
      show: false,
      title: "Aither Stage",
      backgroundColor: "#0f1218",
      autoHideMenuBar: true,
    },
  },
  // The Settings window (P2, moved from settings-window.cjs): the Settings pane's
  // detach target. No IPC of its own -- settings.html talks to main through
  // settings-preload.cjs's settingsBridge.
  settings: {
    file: "settings.html",
    preload: "settings-preload.cjs",
    window: {
      width: 640,
      height: 560,
      minWidth: 460,
      minHeight: 380,
      show: false,
      title: "Aither Settings",
      backgroundColor: "#0f1218",
      autoHideMenuBar: true,
    },
  },
};

// One live handle per standalone route; nulled on 'closed'. Module scope because
// the owning *-window.cjs modules are required before createPresentation runs and
// reach their window (progress sends, close) without a presentation instance.
const routeWindows = {};

/** The live window for a standalone route, or null when absent/destroyed. */
function routeWindow(id) {
  const win = routeWindows[id];
  return win && !win.isDestroyed() ? win : null;
}

/** Single-instance: show + focus the route's window if it lives, else build it. */
function openRouteWindow(id, { electron }) {
  const existing = routeWindow(id);
  if (existing) {
    existing.show();
    existing.focus();
    return existing;
  }
  const spec = ROUTE_WINDOWS[id];
  if (!spec) throw new Error(`no window route ${id}`);
  const win = constructWindow(electron.BrowserWindow, spec.window, spec.preload);
  routeWindows[id] = win;
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.once("ready-to-show", () => {
    win.show();
    win.focus();
  });
  win.on("closed", () => {
    routeWindows[id] = null;
  });
  void win.loadFile(path.join(__dirname, spec.file));
  return win;
}

/** Close the route's window. No-op when absent. */
function closeRouteWindow(id) {
  const win = routeWindow(id);
  if (win) win.close();
}

function createPresentation({
  electron,
  rendererUrl,
  isAllowedRendererNavigation,
  getAvatarWindow = () => null,
  showConsole,
  focusPane,
  closeConsole,
  fleetWindow,
  commandWindow,
  sessionsWindow,
  stageWindow,
  settingsWindow,
  // Defaults to the guarded require above; a test passes a stub (the real module
  // registers ipcMain handlers, which a plain `node` does not have).
  castWindow = castModule,
  desktop,
  ensureHomeIpc,
  stagePaneImpl,
  castPaneImpl,
  commandRegistry,
  commandContext,
  runCommand,
  debugLog = () => {},
} = {}) {
  const {
    createFleetWindow,
    ensureFleetIpc,
    setCloseFallback: setFleetCloseFallback,
    closeFleetWindow,
    isFleetWindowOpen,
    getControl: getFleetControl,
  } = fleetWindow;
  const {
    createCommandWindow,
    ensureCommandIpc,
    setCloseFallback: setCommandCloseFallback,
    closeCommandWindow,
    isCommandWindowOpen,
  } = commandWindow;
  const { ensureSessionsIpc, createSessionsWindow, closeSessionsWindow, isSessionsWindowOpen } = sessionsWindow;
  const { ensureStageIpc, createStageWindow, closeStageWindow, isStageWindowOpen } = stageWindow;
  const { createSettingsWindow, closeSettingsWindow, isSettingsWindowOpen } = settingsWindow;
  // Any of these may be absent (cast-window.cjs not landed): each use is guarded.
  const { ensureCastIpc, createCastWindow, closeCastWindow, isCastWindowOpen } = castWindow || {};

  // One live handle per panel; nulled on 'closed', replaced on the next open.
  const panels = { deck: null, chat: null };
  const livePanel = (id) => {
    const win = panels[id];
    return win && !win.isDestroyed() ? win : null;
  };

  /** Single-instance: show + focus the panel if it exists, else build it. */
  function openPanel(id) {
    const existing = livePanel(id);
    if (existing) {
      existing.show();
      existing.focus();
      return existing;
    }
    const spec = PANELS[id];
    const { BrowserWindow, screen } = electron;
    const workArea = screen.getPrimaryDisplay().workArea;
    const avatar = getAvatarWindow();
    const base = avatar && !avatar.isDestroyed() ? avatar.getBounds() : null;
    const { x, y } = spec.place(workArea, base, spec.window.width, spec.window.height);
    const win = constructWindow(BrowserWindow, { x, y, ...spec.window }, "preload.cjs");
    panels[id] = win;
    win.setAlwaysOnTop(true, "floating");
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const url = rendererUrl() + (rendererUrl().includes("?") ? "&" : "?") + spec.query;
    win.webContents.on("will-navigate", (event, targetUrl) => {
      if (!isAllowedRendererNavigation(targetUrl, url)) event.preventDefault();
    });
    if (spec.logLabel) {
      win.webContents.on("console-message", (event) => {
        if (event.level >= 2) {
          debugLog(`[${spec.logLabel} console] ${event.sourceId}:${event.lineNumber} — ${event.message}`);
        }
      });
      win.webContents.on("render-process-gone", (_event, details) => {
        debugLog(`${spec.logLabel.toUpperCase()} RENDERER PROCESS GONE`, details.reason, details.exitCode);
      });
    }
    win.once("ready-to-show", () => {
      win.show();
      win.focus();
    });
    win.on("closed", () => {
      panels[id] = null;
    });
    void win.loadURL(url);
    return win;
  }

  function closePanel(id) {
    const win = livePanel(id);
    if (win) win.close();
  }

  const createDeckWindow = () => openPanel("deck");
  const createChatWindow = () => openPanel("chat");

  // ── the route registry ────────────────────────────────────────────────────
  // Every console pane id -> its detach verbs. showConsole's `windows` map is
  // built FROM this, so a pane cannot be offered with a missing close (a detach
  // button with no way back -- the failure the console exists to remove).
  // Insertion order is the order main.cjs's hand-written map had.
  const routeTable = new Map();
  function register(id, { open, close, isOpen }) {
    for (const [verb, fn] of Object.entries({ open, close, isOpen })) {
      if (typeof fn !== "function") throw new TypeError(`route ${id} has no ${verb}`);
    }
    routeTable.set(id, { open, close, isOpen });
  }
  const panelRoute = (id) => ({
    open: () => openPanel(id),
    close: () => closePanel(id),
    isOpen: () => Boolean(livePanel(id)),
  });

  // Home has no window of its own (detachable:false) -- a pane, never a detach.
  register("home", { open: () => null, close: () => {}, isOpen: () => false });
  register("command", {
    open: () => createCommandWindow(getFleetControl(), { createFleetWindow }),
    close: closeCommandWindow,
    isOpen: isCommandWindowOpen,
  });
  register("fleet", { open: () => createFleetWindow(), close: closeFleetWindow, isOpen: isFleetWindowOpen });
  register("sessions", { open: () => createSessionsWindow(), close: closeSessionsWindow, isOpen: isSessionsWindowOpen });
  register("cards", panelRoute("deck"));
  register("stage", { open: () => createStageWindow(), close: closeStageWindow, isOpen: isStageWindowOpen });
  // U03 guarded (see the require up top): no detach target exists on a box where
  // cast-window.cjs has not landed yet -- open/close are then no-ops and isOpen
  // stays false, matching sessions' own "no detach wiring yet" shape.
  register("cast", {
    open: () => (createCastWindow ? createCastWindow() : null),
    close: () => { if (closeCastWindow) closeCastWindow(); },
    isOpen: () => (isCastWindowOpen ? isCastWindowOpen() : false),
  });
  register("settings", {
    open: () => createSettingsWindow(),
    close: () => closeSettingsWindow(),
    isOpen: () => isSettingsWindowOpen(),
  });
  register("chat", panelRoute("chat"));
  // The Characters pane (owner, 2026-09-20): the inbox stopped carrying bodies, so the
  // spawn chips and the Models & Market grid live here. It is the SAME renderer and the
  // same deck window as the inbox -- one component with a view prop -- so detaching it
  // reuses the deck panel rather than opening a second subscription to the same bridge.
  register("characters", panelRoute("deck"));
  // The AitherDesktop shell -- the SAME aitherium.com desktop the standalone app
  // window shows, hosted on its own session partition so the two are one login. The
  // OVERLAY is deliberately not a pane: it is a transparent, click-through surface
  // over the whole Windows desktop. It stays a tray/protocol launcher.
  register("desktop", {
    open: () => desktop.showDesktopApp(),
    close: () => desktop.closeDesktopApp(),
    isOpen: () => desktop.isAppOpen(),
  });

  const routeOf = (id) => {
    const route = routeTable.get(id);
    if (!route) throw new Error(`no route ${id}`);
    return route;
  };
  const open = (id) => routeOf(id).open();
  const close = (id) => routeOf(id).close();
  const isOpen = (id) => routeOf(id).isOpen();
  const routes = () => [...routeTable.keys()];

  /** The {id: {open, close, isOpen}} object showConsole takes, derived from the
   *  registry. A fresh object per call, as main's literal was. */
  function windowsMap() {
    const out = {};
    for (const [id, { open: o, close: c, isOpen: i }] of routeTable) {
      out[id] = { open: o, close: c, isOpen: i };
    }
    return out;
  }

  /**
   * The unified console: Command | Fleet | Cards | Chat in ONE window.
   *
   * Owner, 2026-09-08: "i would like a unified window with option to detach these
   * including the decision cards -- cant seem to get a wrangle on all of these pop
   * ups". The console does not replace the windows -- it hands each pane BACK to its
   * own window on demand, and takes it back on reattach, which is why every route
   * carries all three of open/close/isOpen.
   */
  function openConsole() {
    // 🚩 Wire the pane handlers FIRST. Both pages talk to main the moment they load
    // -- fleet-control.html probes on load, command.html sends on the first Enter --
    // and their handlers used to be installed only as a side effect of creating the
    // standalone window. Opening the console without ever having opened those
    // windows produced a Fleet pane of em-dashes (identical to a fleet that is down)
    // and a Command pane that failed with "No handler registered for
    // 'desk:command-send'". Both surfaces LOOK finished while answering nothing.
    ensureFleetIpc();
    ensureCommandIpc(getFleetControl(), { createFleetWindow });
    ensureSessionsIpc();
    ensureHomeIpc();
    ensureStageIpc(stagePaneImpl());
    // The Cast pane (U03/U07): who appears, and how they sound. Guarded -- the
    // console still opens with every OTHER pane when cast-window.cjs is absent.
    if (ensureCastIpc) ensureCastIpc(castPaneImpl());
    // And "close" inside a pane now closes the console, rather than looking for a
    // standalone window that does not exist and silently doing nothing.
    setFleetCloseFallback(closeConsole);
    setCommandCloseFallback(closeConsole);
    return showConsole({
      rendererUrl,
      // The palette reads the SAME registry the tray and the avatar menu render
      // from, with labels resolved against live counts, so it can never offer a
      // stale set -- and no capability is gesture-only again.
      commands: {
        // commandContext() -- the same facts the tray and a body's menu resolve
        // against, so the palette knows whether the overlay is open and which
        // shortcuts are really bound.
        list: () => commandRegistry.paletteRows(commandContext()),
        // The palette awaits: a `prompt` record's typed argument rides along and
        // an async verdict (blog verbs) comes back as {ok, message} to show.
        run: (id, arg) => runCommand(id, arg, { surface: "palette" }),
      },
      windows: windowsMap(),
      urls: { desktop: desktop.desktopAppUrl },
      // The pane shares the overlay's partition; sign it in the way the overlay does
      // BEFORE it loads, or it renders the apex signed-out -- the landing page.
      prepare: { desktop: desktop.ensureDesktopSession },
      signIn: { desktop: desktop.portalLoginUrl },
    });
  }

  /** Open the model browser -- the deck panel's Models & Market section. */
  function openModelBrowser() {
    // Owner-overruled 2026-08-25: the standalone python page (model-browser.py
    // on :47836) was "still fucking lame" and its marketplace tab never
    // existed -- the deck panel's Models & Market section IS the browser now
    // (search + roster characters + the live Aitherium marketplace feed).
    const win = createDeckWindow();
    // The deck opens at the TOP (quick actions first -- the 2026-08-25 ordering
    // fix), but Models & market sits below notifications and system awareness,
    // so "Browse models" that only opens the deck read as a dead button
    // (owner, 2026-08-27: "still unable to open model/avatar browser").
    // Scroll the section into view; the renderer handles scroll-to-section.
    const scrollToModels = () => {
      if (win && !win.isDestroyed()) {
        win.webContents.send("desk:event", {
          type: "scroll-to-section",
          section: "models",
        });
      }
    };
    if (win.webContents.isLoading()) {
      win.webContents.once("did-finish-load", scrollToModels);
    } else {
      scrollToModels();
    }
    return win;
  }

  /** Open the talk surface. One chat surface, in the app, no terminal (the old
   *  Windows Terminal tab running the `aither` CLI was owner-overruled 2026-08-25:
   *  "STILL just opens a terminal tab instead of a chat window right there"). */
  function openTalkWindow() {
    // "Talk to Aither" used to open the deck panel -- a list of buttons, not a
    // conversation. The conversation is the console's Chat pane.
    openConsole();
    focusPane("chat");
  }

  /** The ONE way to the inbox (decision cards + agent messages): the detached
   *  Inbox window if the owner pulled it out, else the console on its Inbox pane.
   *  Every bell, badge and menu item lands here, so there is exactly one place a
   *  notification can be found (owner, 2026-09-13: "no proper notification area").
   *  A card id focuses that card. Quiet mode is gated at the callers
   *  (quiet-mode.test pins those doors), never here. */
  function openInbox(cardId = null) {
    const deck = livePanel("deck");
    if (deck) {
      deck.show();
      deck.focus();
      return true;
    }
    openConsole();
    return focusPane("cards", cardId);
  }

  return {
    open,
    close,
    isOpen,
    routes,
    windowsMap,
    openConsole,
    openInbox,
    openTalkWindow,
    openModelBrowser,
    createDeckWindow,
    createChatWindow,
    getDeckWindow: () => panels.deck,
    getChatWindow: () => panels.chat,
  };
}

module.exports = {
  createPresentation,
  PANELS,
  ROUTE_WINDOWS,
  openRouteWindow,
  closeRouteWindow,
  routeWindow,
};
