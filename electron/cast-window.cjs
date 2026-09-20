"use strict";

/**
 * cast-window.cjs — the Cast pane's window/IPC module (U03), mirroring
 * stage-window.cjs's shape exactly: `ensureCastIpc(impl)` wires the
 * desk:cast-* channels, `createCastWindow()` opens the detached twin, and
 * `closeCastWindow()`/`isCastWindowOpen()` round it out so the pane detaches
 * and reattaches like every other one (console-window.cjs's PANES already
 * lists `cast` as a `kind:"file"` entry -- U04 -- pointed at cast.html).
 *
 * Plan "ULTRACODE" cast slice: the one place the owner configures agents,
 * avatars and voices, replacing the tray submenu click that can only bind
 * whichever character happens to be resident right now (cast-config.cjs's
 * own doc: "the same agent changes body between runs").
 *
 * WHY THE HANDLER MAP IS ITS OWN EXPORT (`castHandlers`), not inlined into
 * `ensureCastIpc`: `require("electron")` outside a running Electron process
 * resolves to the npm package's shim, which returns a STRING (the packaged
 * binary's path), not an API object -- `electron().ipcMain` throws under
 * plain `node --test`. That is measurably why no other *-window.cjs in this
 * tree has a test file (stage-window.cjs, sessions-window.cjs, fleet-window.cjs
 * and command-window.cjs are all untested): `ipcMain.handle` is not reachable
 * without a real Electron process. `castHandlers(getImpl)` is pure -- no
 * electron import, no BrowserWindow -- so cast-window.test.cjs can drive
 * every verb headless by calling the returned functions directly, and
 * `ensureCastIpc` becomes a thin loop handing that SAME map to real
 * `ipcMain.handle` calls.
 *
 * The impl is injected (see castPaneImpl in room-stage-host.cjs, U07) so this
 * file never requires main.cjs -- main.cjs takes the running Desk's single-
 * instance lock, which would make this module unrequirable from a second
 * process, i.e. unrequirable from `node --test`.
 */

const path = require("node:path");

// Same lazy-require rule as the other window modules: loadable under
// `node --test` without Electron ever being imported at module scope.
function electron() {
  return require("electron");
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * A key/channel argument that did not arrive as a non-empty string is refused
 * BEFORE it reaches castPaneImpl. castPaneImpl's own `if (!key)` guard only
 * catches falsy values -- an object, an array or a number is truthy and would
 * sail through to `cast.write`, which would then stringify it into cast.json
 * as an origin key that can never match anything real (cast-config.cjs's
 * ORIGIN KEY GRAMMAR: keys are stamped strings, never a payload's own shape).
 */
function invalidArg(verb, value, label) {
  if (typeof value === "string" && value.trim()) return null;
  return { ok: false, error: `${verb}: ${label} is required` };
}

/**
 * castHandlers(getImpl) — the desk:cast-* channel -> handler map, read from
 * `getImpl()` AT CALL TIME (not at build time), so `ensureCastIpc` can swap
 * `castImpl` on a later call -- the same pattern stage-window.cjs's
 * `stageImpl` reassignment relies on -- without re-wiring ipcMain a second
 * time (`ipcMain.handle` throws on a channel that is already registered).
 *
 * Every handler returns the `{ok, ...}` envelope every desk pane uses: a
 * throwing impl yields `{ok:false, error:"<verb>: <message>"}` SYNCHRONOUSLY,
 * never a rejected promise, because every castPaneImpl function (U07, over
 * cast-config.cjs's synchronous fs.readFileSync/renameSync) reads and writes
 * cast.json synchronously — a pane that goes blank because one verb threw is
 * worse than a pane that says which verb failed (the same rule
 * stage-window.cjs's `call` follows).
 *
 * @param {() => object} getImpl
 */
function castHandlers(getImpl) {
  const impl = () => (typeof getImpl === "function" ? getImpl() : getImpl) || {};

  const call = (verb, fn) => {
    try {
      const result = fn();
      // castPaneImpl's writers already return {ok, snapshot, problems, error,
      // ...} — honour that verdict verbatim. Re-wrapping it here would spread
      // {ok:true, ...} FIRST and the result's own `ok:false` SECOND, which
      // still wins with object-spread order — but describe() carries no `ok`
      // field at all, so it must be wrapped, and the two cases need telling
      // apart rather than trusting spread order to save us either way.
      if (isPlainObject(result) && Object.prototype.hasOwnProperty.call(result, "ok")) {
        return result;
      }
      return { ok: true, ...(isPlainObject(result) ? result : {}) };
    } catch (error) {
      return { ok: false, error: `${verb}: ${String((error && error.message) || error)}` };
    }
  };

  return {
    "desk:cast-describe": () => call("describe", () => impl().describe?.()),

    "desk:cast-set-actor": (_event, key, patch) =>
      invalidArg("setActor", key, "key") ||
      call("setActor", () => impl().setActor?.({ key: String(key), patch: isPlainObject(patch) ? patch : {} })),

    "desk:cast-clear-actor": (_event, key) =>
      invalidArg("clearActor", key, "key") ||
      call("clearActor", () => impl().clearActor?.({ key: String(key) })),

    "desk:cast-set-stage": (_event, patch) =>
      call("setStage", () => impl().setStage?.(isPlainObject(patch) ? patch : {})),

    "desk:cast-set-voice": (_event, patch) =>
      call("setVoice", () => impl().setVoice?.(isPlainObject(patch) ? patch : {})),

    // `defaults` is an ActorConfig every actor inherits from (the tier under
    // authors/actors): the "everyone" knobs -- today the physics faders.
    "desk:cast-set-defaults": (_event, patch) =>
      call("setDefaults", () => impl().setDefaults?.(isPlainObject(patch) ? patch : {})),

    "desk:cast-set-section": (_event, section, patch) =>
      invalidArg("setSection", section, "section") ||
      call("setSection", () => impl().setSection?.({ section: String(section), patch: isPlainObject(patch) ? patch : {} })),

    "desk:cast-set-channel": (_event, channel, patch) =>
      invalidArg("setChannel", channel, "channel") ||
      call("setChannel", () => impl().setChannel?.({
        channel: String(channel),
        patch: isPlainObject(patch) ? patch : {},
      })),

    "desk:cast-capture-stage": () => call("captureStage", () => impl().captureStage?.()),

    "desk:cast-mute-origin": (_event, key) =>
      invalidArg("muteOrigin", key, "key") ||
      call("muteOrigin", () => impl().muteOrigin?.({ key: String(key) })),

    "desk:cast-reveal": (_event, key) =>
      invalidArg("reveal", key, "key") ||
      call("reveal", () => impl().reveal?.({ key: String(key) })),
  };
}

let castImpl = {};
let wired = false;

function ensureCastIpc(impl) {
  if (impl) castImpl = impl;
  if (wired) return;
  wired = true;
  const { ipcMain } = electron();
  const handlers = castHandlers(() => castImpl);
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, handler);
  }
}

let castWindow = null;

function createCastWindow() {
  ensureCastIpc();
  const { BrowserWindow } = electron();
  if (castWindow && !castWindow.isDestroyed()) {
    castWindow.show();
    castWindow.focus();
    return castWindow;
  }
  castWindow = new BrowserWindow({
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
  // The same fence every other desk window carries.
  castWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  castWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  castWindow.once("ready-to-show", () => {
    castWindow.show();
    castWindow.focus();
  });
  castWindow.on("closed", () => {
    castWindow = null;
  });
  void castWindow.loadFile(path.join(__dirname, "cast.html"));
  return castWindow;
}

function closeCastWindow() {
  if (castWindow && !castWindow.isDestroyed()) castWindow.close();
}

function isCastWindowOpen() {
  return Boolean(castWindow && !castWindow.isDestroyed());
}

module.exports = { castHandlers, ensureCastIpc, createCastWindow, closeCastWindow, isCastWindowOpen };
