"use strict";

/**
 * stage-window.cjs — the Stage pane: every body on the stage, listed, with the
 * arrangements beside them. Plan 40 slice G, the surface half.
 *
 * WHY A PANE AND NOT JUST A MENU (owner, 2026-09-18: "i cant control the actual
 * avatar stage / window / box size anymore", then "the whole UI/UX is starting to
 * just become a stacked mess"): everything about the stage was a GESTURE on a
 * body — drag to move, right-drag to turn, wheel to scale, right-click for the
 * menu. If the body is hidden, tiny, behind another window or simply not where
 * you expect, the stage becomes unmanageable and there is no second path. This
 * pane is that second path: it names each body, says where it stands, and
 * arranges them without the owner having to hit a 3D object with the mouse.
 *
 * The handlers live HERE rather than in console-window.cjs for the same reason
 * Sessions' do: the pane has a standalone twin, and console-window's wireIpc
 * only runs when the console is open.
 *
 * It owns NO state. Bodies come from main (the live slots), arrangements go to
 * the renderer through main's one sender, and the geometry is the renderer's
 * (src/stage/arrangements.ts) — main never holds a second copy of the bounds.
 */

// The window itself is presentation.cjs's route "stage" (slice 3, P2): its size,
// title, preload and single-instance show+focus live in ROUTE_WINDOWS.stage.
// This module keeps the IPC and the injected stageImpl; create/close/isOpen are wrappers.
const { openRouteWindow, closeRouteWindow, routeWindow } = require("./presentation.cjs");

const ROUTE = "stage";

// Same lazy-require rule as the other window modules: loadable under
// `node --test` without Electron.
function electron() {
  return require("electron");
}

let wired = false;
/** Injected by main.cjs: { bodies(), arrange(name, opts), focus(slotId), remove(slotId) }. */
let stageImpl = {};

function ensureStageIpc(impl) {
  if (impl) stageImpl = impl;
  if (wired) return;
  wired = true;
  const { ipcMain } = electron();

  const call = (name, fn) => {
    try {
      return { ok: true, ...(fn() || {}) };
    } catch (error) {
      // A pane that goes blank because one verb threw is worse than a pane that
      // says which verb failed -- the same rule the console's rail follows.
      return { ok: false, error: `${name}: ${String((error && error.message) || error)}` };
    }
  };

  ipcMain.handle("desk:stage-bodies", () => call("bodies", () => ({
    bodies: (stageImpl.bodies && stageImpl.bodies()) || [],
    // Plan 40 slice F: the safety setting is enforced at every door that shows a
    // body, so the pane that lists bodies is where its state belongs. Read-only
    // on purpose -- the desk does not own the flip, it obeys it.
    safety: (stageImpl.safety && stageImpl.safety()) || null,
  })));
  ipcMain.handle("desk:stage-arrange", (_event, name, options) => call("arrange", () => {
    stageImpl.arrange?.(String(name || ""), options || {});
  }));
  ipcMain.handle("desk:stage-focus", (_event, slotId) => call("focus", () => {
    stageImpl.focus?.(slotId ? String(slotId) : null);
  }));
  ipcMain.handle("desk:stage-remove", (_event, slotId) => call("remove", () => {
    stageImpl.remove?.(String(slotId || ""));
  }));
}

function createStageWindow() {
  ensureStageIpc();
  // Deny-open, no-navigate, show+focus on ready and the dropped handle on
  // 'closed' are presentation's openRouteWindow -- the same fence every desk window carries.
  return openRouteWindow(ROUTE, { electron: electron() });
}

function closeStageWindow() {
  closeRouteWindow(ROUTE);
}

function isStageWindowOpen() {
  return Boolean(routeWindow(ROUTE));
}

module.exports = { ensureStageIpc, createStageWindow, closeStageWindow, isStageWindowOpen };
