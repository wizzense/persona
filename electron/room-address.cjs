"use strict";

/**
 * room-address — "which of these tabs am I talking to?", answered or REFUSED.
 *
 * WHY (owner, 2026-09-18: "how does this work when I have multiple Claude Code
 * terminal sessions running in parallel?"): the room's bodies are not
 * distinguishable by author. Measured in room `main` on this box, EVERY
 * claude_code actor is named "AitherOS-Fresh" — the repo — so an avatar menu or
 * a chat picker keyed on the author name offers the owner three identical
 * entries and picks one of them for him. The ListAgents `[ref]` is no help
 * either: it is neither the session id nor the title, so it cannot be used to
 * address anything.
 *
 * The only label that separates parallel tabs is the daemon's /sessions/unified
 * TITLE, and the only thing that can be addressed is the session ID. So:
 *
 *   labelFor(body)                -> what a human should SEE (title first)
 *   resolveAddress(text, bodies)  -> {to, label, rest, candidates, reason}
 *
 * where `to` is a SESSION ID and `rest` is the message with the salutation
 * removed — the sent text must be the request, not "hey two,".
 *
 * 🚩 The rule this module exists to enforce: it NEVER guesses. Two bodies that
 * both match are a refusal with `candidates`, not a coin flip — addressing the
 * wrong tab means a stranger's work gets steered, which is strictly worse than
 * being told to be more specific. Every refusal names a `reason` so the caller
 * can say WHY rather than going quiet.
 *
 * 🚩 The trap next door, not in this file: routing a body's message through the
 * desk's CommandAgent spawns a fresh `claude -p` at a hardcoded cwd, which
 * answers from an EMPTY context and looks like the addressed session replying
 * with amnesia. This module exists so the chat surface can address a REAL
 * session (U21 -> room-steer -> the steer mailbox) instead.
 *
 * Pure: no I/O, no requires, no clock. Every decision is a function with a test.
 */

//: Positional addressing, because the titles are long and the owner is typing
//: in a chat box. Index is 0-based over the bodies AS GIVEN (stage order).
const ORDINALS = new Map([
  ["one", 0], ["first", 0], ["1", 0], ["1st", 0],
  ["two", 1], ["second", 1], ["2", 1], ["2nd", 1],
  ["three", 2], ["third", 2], ["3", 2], ["3rd", 2],
  ["four", 3], ["fourth", 3], ["4", 3], ["4th", 3],
  ["five", 4], ["fifth", 4], ["5", 4], ["5th", 4],
  ["six", 5], ["sixth", 5], ["6", 5], ["6th", 5],
]);

//: Salutations that introduce an address. `@` is handled separately because it
//: takes exactly one token and needs no word list.
const GREETING = /^\s*(?:hey|hi|hello|yo)\b[\s,]*/i;
const AT = /^\s*@([^\s,:]+)[\s,:]*/;
//: How many words a greeting may consume while looking for a title substring:
//: "hey dark matters, status?" must reach "dark matters", but a whole sentence
//: must not be treated as a name.
const MAX_ADDRESS_WORDS = 4;

/** Comparison form: case-folded, punctuation flattened to single spaces. Lets
 *  "@dark-matters" and "Dark Matters — plan 40" meet in the middle. */
function norm(value) {
  return String(value == null ? "" : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** The 4 characters room-stage's slotFor() also uses, so a label and a slot id
 *  disambiguate the same way the stage does. */
function shortId(actorId) {
  return norm(actorId).replace(/ /g, "").slice(0, 4);
}

function normaliseBody(body, index) {
  const b = body || {};
  return {
    index,
    slotId: String(b.slotId || ""),
    agent: String(b.agent || ""),
    actorId: String(b.actorId || ""),
    actorKind: String(b.actorKind || ""),
    title: String(b.title || "").trim(),
  };
}

/** What a human should SEE for a body. The /sessions/unified title wins over
 *  the author name because the author name is the repo and is shared by every
 *  parallel tab; the id4 suffix is the last resort that keeps two untitled
 *  same-named bodies from rendering as one entry. */
function labelFor(body) {
  const b = normaliseBody(body, -1);
  if (b.title) return b.title;
  const id4 = shortId(b.actorId);
  if (b.agent && id4) return `${b.agent} (${id4})`;
  return b.agent || b.slotId || "unknown";
}

/** Labels for a whole list, guaranteed DISTINCT: a picker that shows the same
 *  string twice is the bug this module was written for, and two sessions can
 *  legitimately carry the same title (same repo, same task name). */
function labelledBodies(bodies) {
  const list = (Array.isArray(bodies) ? bodies : []).map(normaliseBody);
  const seen = new Map();
  for (const b of list) {
    const base = labelFor(b);
    seen.set(base, (seen.get(base) || 0) + 1);
  }
  const used = new Set();
  return list.map((b) => {
    const base = labelFor(b);
    let label = base;
    if (seen.get(base) > 1 || used.has(label)) {
      const id4 = shortId(b.actorId) || b.slotId || String(b.index + 1);
      label = `${base} (${id4})`;
    }
    // Still colliding (two bodies, same title, same id4 prefix): fall to the
    // slot id, which room-stage guarantees is unique on stage.
    if (used.has(label)) label = `${base} (${b.slotId || b.index + 1})`;
    used.add(label);
    return { ...b, label, to: b.actorId || null };
  });
}

function card(body) {
  return { to: body.actorId || null, label: labelFor(body), slotId: body.slotId, agent: body.agent };
}

/** The leading phrases of `text`, longest first, each with the remainder after
 *  it. A phrase never runs past a clause boundary (a word ending in , : ; ? !)
 *  because "hey two, rebase this" addresses `two`, not `two, rebase this`. */
function leadingPhrases(text, maxWords) {
  const raw = String(text || "");
  const words = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    words.push({ text: m[0], start: m.index, end: m.index + m[0].length });
    if (/[,:;?!]$/.test(m[0])) break; // boundary word included, nothing after it
    if (words.length >= maxWords) break;
  }
  const out = [];
  for (let k = words.length; k >= 1; k -= 1) {
    const phrase = words.slice(0, k).map((w) => w.text).join(" ").replace(/[,:;?!.]+$/, "");
    if (!phrase) continue;
    out.push({ token: phrase, rest: stripLead(raw.slice(words[k - 1].end)) });
  }
  return out;
}

/** Drop the punctuation that joined the salutation to the message. Only `,`,
 *  `:` and whitespace — a dash or an ellipsis may well be the message. */
function stripLead(text) {
  return String(text || "").replace(/^[\s,:]+/, "");
}

/** Every way `text` could be read as an address, in the order to try them. */
function addressAttempts(text) {
  const raw = String(text == null ? "" : text);
  const attempts = [];
  const at = AT.exec(raw);
  if (at) attempts.push({ token: at[1], rest: stripLead(raw.slice(at[0].length)), explicit: true });
  const hey = GREETING.exec(raw);
  if (hey) {
    for (const a of leadingPhrases(raw.slice(hey[0].length), MAX_ADDRESS_WORDS)) {
      attempts.push({ ...a, explicit: true });
    }
  }
  if (!attempts.length) {
    //: No salutation: accept a BARE leading token, but only as an exact slot id
    //: or session id (see TIERS). Prose cannot collide with those, so this
    //: cannot silently turn the first word of a message into an address.
    for (const a of leadingPhrases(raw, 1)) attempts.push({ ...a, explicit: false });
  }
  return attempts;
}

//: Precedence. First tier with ANY match decides — an exact slot id must beat a
//: loose title substring. `loose` tiers only apply to an explicit address
//: (`@x` / "hey x"), never to a bare leading word.
const TIERS = [
  { name: "slot-id", loose: false, hit: (b, t, n) => b.slotId && norm(b.slotId) === n },
  { name: "session-id", loose: false, hit: (b, t) => b.actorId && b.actorId.toLowerCase() === t.toLowerCase() },
  { name: "session-id-prefix", loose: true, hit: (b, t) => b.actorId && t.length >= 4 && b.actorId.toLowerCase().startsWith(t.toLowerCase()) },
  { name: "ordinal", loose: true, hit: (b, t, n) => ORDINALS.has(n) && ORDINALS.get(n) === b.index },
  { name: "title", loose: false, hit: (b, t, n) => b.title && norm(b.title) === n },
  { name: "agent", loose: true, hit: (b, t, n) => b.agent && norm(b.agent) === n },
  { name: "title-substring", loose: true, hit: (b, t, n) => b.title && n.length >= 2 && norm(b.title).includes(n) },
  { name: "agent-substring", loose: true, hit: (b, t, n) => b.agent && n.length >= 3 && norm(b.agent).includes(n) },
];

function matchBodies(token, list, explicit) {
  const n = norm(token);
  if (!n) return { tier: "", matches: [] };
  for (const tier of TIERS) {
    if (tier.loose && !explicit) continue;
    const matches = list.filter((b) => tier.hit(b, token, n));
    if (matches.length) return { tier: tier.name, matches };
  }
  return { tier: "", matches: [] };
}

/**
 * Address one body and return the message without the salutation.
 *
 * @param {string} text  what the owner typed
 * @param {Array<{slotId,agent,actorId,actorKind,title}>} bodies
 *        RoomStage.status().onStage joined with room-publisher.sessionTitles()
 * @returns {{to:string|null, label:string, rest:string, candidates:Array, reason:string, tier:string, body:object|null}}
 *          `to` is a session id, or null with `candidates` to choose from.
 *          reason: "" resolved · no-bodies · no-address · unknown · ambiguous ·
 *          no-session (a body matched but carries no session id to steer).
 */
function resolveAddress(text, bodies) {
  const raw = String(text == null ? "" : text);
  const list = (Array.isArray(bodies) ? bodies : []).map(normaliseBody);
  if (!list.length) {
    return { to: null, label: "", rest: raw, candidates: [], reason: "no-bodies", tier: "", body: null };
  }
  const attempts = addressAttempts(raw);
  if (!attempts.length) {
    return { to: null, label: "", rest: raw, candidates: list.map(card), reason: "no-address", tier: "", body: null };
  }
  let ambiguous = null;
  for (const attempt of attempts) {
    const { tier, matches } = matchBodies(attempt.token, list, attempt.explicit);
    if (matches.length === 1) {
      const body = matches[0];
      //: A body without a session id cannot be steered (a relay-only actor, or
      //: a row the daemon never saw). Say that instead of sending nowhere.
      if (!body.actorId) {
        return { to: null, label: labelFor(body), rest: attempt.rest, candidates: [card(body)], reason: "no-session", tier, body };
      }
      return { to: body.actorId, label: labelFor(body), rest: attempt.rest, candidates: [], reason: "", tier, body };
    }
    //: Remember the FIRST ambiguity but keep trying shorter phrases: a shorter
    //: phrase that matches exactly one body is a real answer, and no path here
    //: ever picks between two bodies.
    if (matches.length > 1 && !ambiguous) ambiguous = { tier, matches, rest: attempt.rest };
  }
  if (ambiguous) {
    return { to: null, label: "", rest: ambiguous.rest, candidates: ambiguous.matches.map(card), reason: "ambiguous", tier: ambiguous.tier, body: null };
  }
  //: Nothing matched: hand back the message untouched (the "address" was not
  //: one) and every body as a candidate, so the caller can offer the list.
  return { to: null, label: "", rest: raw, candidates: list.map(card), reason: "unknown", tier: "", body: null };
}

module.exports = {
  ORDINALS,
  MAX_ADDRESS_WORDS,
  labelFor,
  labelledBodies,
  resolveAddress,
  norm,
  shortId,
};
