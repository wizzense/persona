"use strict";

/**
 * Bulk triage over the decision-card plane — "answer with default" and "dismiss"
 * for many cards in one call.
 *
 * Why this exists (owner, 2026-09-23): the Inbox showed "298 waiting" and paged
 * through them one at a time. The deck could answer one card; it could not cancel
 * any (decision-cards.cjs has cancelCard, but no IPC reached it), and answering 298
 * cards by looping the single-answer IPC would post 298 lines to #agents.
 *
 * Doctrine, same as decision-cards.cjs: awask stays the ONE write implementation.
 * This module only PLANS (pure) and then paces calls into the injected
 * answerCard/cancelCard, so the store can never be written two ways.
 *
 * Trust: the renderer sends ids and a verb, never a choice. For "answer-default"
 * the choice is re-derived HERE from main's own open-card list, so a stale or
 * forged renderer cannot answer a card with an option it does not have.
 *
 * Wiring (main.cjs / preload.cjs, owned elsewhere):
 *   main:    ipcMain.handle("desk:deck-bulk", (_e, payload) => decisionsBulk.handleBulk(payload, {...}))
 *   preload: bulk: (verb, ids, note) => ipcRenderer.invoke("desk:deck-bulk", { verb, ids, note }),
 */

const BULK_VERBS = Object.freeze(["answer-default", "cancel"]);
/** A single call never spawns more than this many awask processes. */
const MAX_BULK = 500;
/** Gap between spawns. awask is a detached python process per card; 300 at once
 *  is a fork storm on the owner's desktop, 300 x 60 ms is 18 s of background work. */
const DEFAULT_PAUSE_MS = 60;
/** awask writes awaited at once. Each is a short python process; pacing starts
 *  them, this bounds how many can be alive together if awask is slow. */
const MAX_IN_FLIGHT = 8;
/** The raiser picks both the default AND the urgency, so "answer with default"
 *  over a select-all must not record an urgent card's default as the owner's
 *  answer unseen (bulk review #8): those cards are answered one at a time. */
const ONE_BY_ONE_URGENCY = Object.freeze(["high", "critical"]);
const ONE_BY_ONE_KINDS = Object.freeze(["credential", "blocked"]);

/** Why a card cannot take a bulk default, or "" when it can. */
function oneByOneReason(card) {
  const urgency = String((card && card.urgency) || "").toLowerCase();
  if (ONE_BY_ONE_URGENCY.includes(urgency)) return `${urgency}-urgency card needs a one-by-one answer`;
  const kind = String((card && card.kind) || "").toLowerCase();
  if (ONE_BY_ONE_KINDS.includes(kind)) return `${kind} card needs a one-by-one answer`;
  return "";
}

/** The raiser's declared default, only when it names one of the card's OWN options. */
function defaultOptionKey(card) {
  if (!card || typeof card !== "object") return "";
  const key = typeof card.defaultKey === "string" ? card.defaultKey : "";
  if (!key) return "";
  const options = Array.isArray(card.options) ? card.options : [];
  return options.some((o) => o && o.key === key) ? key : "";
}

/**
 * Turn a renderer request into a list of concrete writes. Pure.
 *
 * @param {{verb?: string, ids?: unknown}} request
 * @param {Array<object>} openCards  main's current open-card list (decision-cards listOpen shape)
 * @returns {{ok: boolean, verb: string, actions: Array<{id: string, choice?: string}>,
 *            skipped: Array<{id: string, reason: string}>, error?: string}}
 */
function planBulk(request, openCards) {
  const verb = request && typeof request.verb === "string" ? request.verb : "";
  if (!BULK_VERBS.includes(verb)) {
    return { ok: false, verb, actions: [], skipped: [], error: `unknown bulk verb "${verb}"` };
  }
  const rawIds = request && Array.isArray(request.ids) ? request.ids : null;
  if (!rawIds) return { ok: false, verb, actions: [], skipped: [], error: "ids must be an array" };

  const byId = new Map();
  for (const card of Array.isArray(openCards) ? openCards : []) {
    if (card && typeof card.id === "string") byId.set(card.id, card);
  }
  const seen = new Set();
  const actions = [];
  const skipped = [];
  for (const raw of rawIds) {
    if (typeof raw !== "string" || raw.length === 0) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    if (actions.length >= MAX_BULK) {
      skipped.push({ id: raw, reason: `over the ${MAX_BULK}-card cap for one call` });
      continue;
    }
    const card = byId.get(raw);
    if (!card) {
      skipped.push({ id: raw, reason: "no longer open" });
      continue;
    }
    if (verb === "answer-default") {
      const guarded = oneByOneReason(card);
      if (guarded) {
        skipped.push({ id: raw, reason: guarded });
        continue;
      }
      const choice = defaultOptionKey(card);
      if (!choice) {
        skipped.push({ id: raw, reason: "card has no default answer" });
        continue;
      }
      actions.push({ id: raw, choice });
    } else {
      actions.push({ id: raw });
    }
  }
  return { ok: true, verb, actions, skipped };
}

/** One line for #agents — the sessions learn about a bulk triage ONCE, not 298 times. */
function summaryLine(result) {
  const done = result.done.length;
  const what = result.verb === "cancel" ? "dismissed" : "answered with their default";
  const tail = [];
  if (result.skipped.length) tail.push(`${result.skipped.length} skipped`);
  if (result.failed.length) tail.push(`${result.failed.length} failed`);
  const ids = result.done.slice(0, 8).join(", ") + (done > 8 ? `, +${done - 8} more` : "");
  return `bulk: ${done} card${done === 1 ? "" : "s"} ${what}${tail.length ? ` (${tail.join(", ")})` : ""} (via desk)${ids ? `: ${ids}` : ""}`;
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A writer's verdict: `true`, or `{ok: true}` from a confirmed (attached) awask
 *  write. A bare truthy Promise is NOT a verdict -- that was "a process started"
 *  reported as "answered" (bulk review #9). */
function accepted(verdict) {
  return verdict === true || Boolean(verdict && typeof verdict === "object" && verdict.ok === true);
}

/**
 * Execute a plan, paced. Every write goes through the injected functions, which
 * may return a verdict or a Promise of one; a card counts as done only on an
 * accepted verdict.
 *
 * @param plan  planBulk() output
 * @param deps  {answerCard(id, choice, note) -> verdict, cancelCard(id, note) -> verdict,
 *               note?: string, pauseMs?: number, sleep?: (ms) => Promise, maxInFlight?: number}
 */
async function runBulk(plan, deps = {}) {
  const result = { ok: Boolean(plan && plan.ok), verb: plan ? plan.verb : "", done: [], failed: [],
    skipped: plan ? [...plan.skipped] : [], error: plan && plan.error ? plan.error : undefined };
  if (!plan || !plan.ok) return { ...result, summary: "" };
  const note = String(deps.note || "bulk triage (via desk)").slice(0, 2000);
  const pauseMs = Number.isFinite(deps.pauseMs) ? Math.max(0, deps.pauseMs) : DEFAULT_PAUSE_MS;
  const sleep = typeof deps.sleep === "function" ? deps.sleep : realSleep;
  const maxInFlight = Number.isFinite(deps.maxInFlight) ? Math.max(1, deps.maxInFlight) : MAX_IN_FLIGHT;
  const verdicts = new Array(plan.actions.length).fill(false);
  const inFlight = new Set();
  for (let i = 0; i < plan.actions.length; i += 1) {
    const action = plan.actions[i];
    let pending;
    try {
      pending = Promise.resolve(plan.verb === "cancel"
        ? deps.cancelCard && deps.cancelCard(action.id, note)
        : deps.answerCard && deps.answerCard(action.id, action.choice, note));
    } catch {
      pending = Promise.resolve(false);
    }
    const settled = pending.then((verdict) => { verdicts[i] = accepted(verdict); }, () => { verdicts[i] = false; })
      .then(() => { inFlight.delete(settled); });
    inFlight.add(settled);
    if (inFlight.size >= maxInFlight) await Promise.race(inFlight);
    if (pauseMs > 0 && i < plan.actions.length - 1) await sleep(pauseMs);
  }
  await Promise.all(inFlight);
  plan.actions.forEach((action, i) => (verdicts[i] ? result.done : result.failed).push(action.id));
  return { ...result, summary: result.done.length ? summaryLine(result) : "" };
}

/** planBulk + runBulk against main's live list. `deps.listOpen()` returns the open cards. */
async function handleBulk(payload, deps = {}) {
  const open = typeof deps.listOpen === "function" ? deps.listOpen() : [];
  const plan = planBulk(payload || {}, open);
  const note = payload && typeof payload.note === "string" && payload.note.trim()
    ? payload.note.trim() : deps.note;
  return runBulk(plan, { ...deps, note });
}

module.exports = {
  BULK_VERBS,
  MAX_BULK,
  DEFAULT_PAUSE_MS,
  MAX_IN_FLIGHT,
  defaultOptionKey,
  oneByOneReason,
  planBulk,
  runBulk,
  handleBulk,
  summaryLine,
};
