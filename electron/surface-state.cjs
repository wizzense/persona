"use strict";

/**
 * Where is each surface RIGHT NOW — one owner, one answer.
 *
 * WHY (slice 2 of docs/UX-REIMPLEMENTATION.md, earned by a bug on 2026-09-18):
 * reattaching the Inbox left the console painting "Inbox is in its own window"
 * over the pane that had come back. Nothing threw. The fact "is this pane
 * detached" had TWO owners -- the shell's DOM and main's window list -- and they
 * were reconciled by hand at three call sites, one of which read main's list
 * before the asynchronous window close had landed.
 *
 * So the fact gets one home. A surface is a ROUTE (a pane id); where it lives is
 * a PRESENTATION. This module holds the map, folds in what the windows actually
 * report, and tells subscribers ONLY when something changed. It is pure: no
 * electron, no windows, no timers -- the caller observes reality and hands it in,
 * which is also what makes every transition testable under `node --test`.
 *
 * 🚩 `reconcile()` exists because the windows are the ORACLE, not this map. The
 * owner can close a detached window from its own title bar; an intention-only
 * state machine would then insist the pane is detached forever, which is the
 * original bug with extra steps.
 */

/** A pane inside the console, in its own window, or not showing at all. */
const PRESENTATIONS = Object.freeze(["embedded", "detached", "hidden"]);

function createSurfaceState(routeIds, { initial = "embedded" } = {}) {
  const routes = Object.freeze([...routeIds].map(String));
  if (!routes.length) throw new Error("surface-state needs at least one route");
  if (!PRESENTATIONS.includes(initial)) throw new Error(`unknown presentation: ${initial}`);

  const where = new Map(routes.map((id) => [id, initial]));
  const listeners = new Set();

  const known = (route) => where.has(String(route));

  function emit(changed) {
    if (!changed.length) return changed;
    const snap = snapshot();
    for (const listener of listeners) {
      try {
        listener(snap, changed);
      } catch (error) {
        // A subscriber that throws must not stop the others, and must not leave
        // the map half-announced: the state has ALREADY moved by this point.
        console.warn(`[surface-state] subscriber failed: ${(error && error.message) || error}`);
      }
    }
    return changed;
  }

  function snapshot() {
    return Object.fromEntries(routes.map((id) => [id, where.get(id)]));
  }

  /** Move one route. Returns the routes that changed (0 or 1 of them). */
  function set(route, presentation) {
    const id = String(route);
    if (!known(id)) throw new Error(`unknown route: ${id}`);
    if (!PRESENTATIONS.includes(presentation)) {
      throw new Error(`unknown presentation: ${presentation}`);
    }
    if (where.get(id) === presentation) return emit([]);
    where.set(id, presentation);
    return emit([id]);
  }

  /**
   * Fold in what the windows actually report.
   *
   * `observed` maps a route to a presentation, or to a boolean meaning "is it in
   * its own window". Routes the caller did not observe are left alone -- a
   * partial observation must never be read as "everything else is embedded".
   * One emit for the whole batch, so a reconcile of five windows does not
   * re-render the rail five times.
   */
  function reconcile(observed) {
    const changed = [];
    for (const [route, value] of Object.entries(observed || {})) {
      const id = String(route);
      if (!known(id)) continue;
      const presentation = typeof value === "boolean"
        ? (value ? "detached" : "embedded")
        : value;
      if (!PRESENTATIONS.includes(presentation)) continue;
      if (where.get(id) === presentation) continue;
      where.set(id, presentation);
      changed.push(id);
    }
    return emit(changed);
  }

  function presentationOf(route) {
    return where.get(String(route)) || null;
  }

  function detached() {
    return routes.filter((id) => where.get(id) === "detached");
  }

  function subscribe(listener) {
    if (typeof listener !== "function") throw new Error("subscribe needs a function");
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { routes, snapshot, set, reconcile, presentationOf, detached, subscribe };
}

module.exports = { PRESENTATIONS, createSurfaceState };
