"use strict";

/**
 * voice-card -- answer a decision card OUT LOUD (owner, 2026-09-22: "IT JUST
 * SPEAKS UPDATES ... NOT GETTING A CHANCE TO RESPOND OR ANSWER ANY KIND OF CARD").
 *
 * The desk already SAID a card arrived ("A decision needs you: <title>") and
 * then gave the owner nothing to say back to: the options were never read, and
 * the next sentence went to Command as a brand-new task. This turns the card
 * into a spoken question (cardPrompt) and the owner's reply into an answer
 * (matchReply): a number or an option's words picks that option, "yes" picks
 * the recommended one, and anything else is a STEER -- sent to the raising
 * session as a work order, the same as typing it into the card.
 *
 * Pure: no Electron, no awask. main.cjs wires it to voice-ask and
 * decision-cards.
 */

const NUMBER_WORDS = [
  ["one", "first", "1"],
  ["two", "second", "2"],
  ["three", "third", "3"],
  ["four", "fourth", "4"],
  ["five", "fifth", "5"],
  ["six", "sixth", "6"],
];
const SPOKEN = ["one", "two", "three", "four", "five", "six"];
const AFFIRM = /^(yes|yeah|yep|sure|ok(ay)?|do it|go( ahead)?|approve[d]?|sounds good|the recommended( one)?)\b/;
const MAX_OPTIONS = SPOKEN.length;

function norm(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The sentence the avatar asks. Options are numbered so "two" is an answer. */
function cardPrompt(card) {
  const title = String((card && card.title) || "a decision").slice(0, 160);
  const options = (card && Array.isArray(card.options) ? card.options : []).slice(0, MAX_OPTIONS);
  if (!options.length) return `A decision needs you: ${title}. Tell me what to do.`;
  const listed = options
    .map((o, i) => `${SPOKEN[i]}, ${String(o.label || o.key).slice(0, 80)}${o.recommended ? ", recommended" : ""}`)
    .join("; ");
  return `A decision needs you: ${title}. Options: ${listed}. Say a number, or tell me what to do instead.`;
}

/**
 * What the owner's reply means for this card:
 *   { kind: "answer", key, label } | { kind: "steer", text } | { kind: "none" }
 */
function matchReply(card, transcript) {
  const said = norm(transcript);
  if (!said) return { kind: "none" };
  const options = (card && Array.isArray(card.options) ? card.options : []).slice(0, MAX_OPTIONS);
  const pick = (o) => ({ kind: "answer", key: o.key, label: String(o.label || o.key) });
  if (options.length) {
    const words = said.split(" ");
    // "two" / "option two" / "the second one" -- a short reply naming a number.
    if (words.length <= 4) {
      const hits = [];
      for (let i = 0; i < options.length; i += 1) {
        if (NUMBER_WORDS[i].some((w) => words.includes(w))) hits.push(i);
      }
      // "the second one": the ordinal is the answer, "one" is a pronoun.
      const named = hits.length > 1 ? hits.filter((i) => i !== 0 || !words.includes("one") || words.includes("first") || words.includes("1")) : hits;
      if (named.length === 1) return pick(options[named[0]]);
    }
    // The option's own words: the longest label fully contained in the reply wins,
    // so "restart the service" beats "restart" when both are options. Only in a
    // SHORT reply -- a sentence that merely mentions an option's word is a steer.
    let best = null;
    for (const o of options) {
      for (const candidate of [norm(o.label), norm(o.key)]) {
        const fits = candidate && words.length <= candidate.split(" ").length + 3;
        if (fits && (` ${said} `).includes(` ${candidate} `)) {
          if (!best || candidate.length > best.len) best = { o, len: candidate.length };
        }
      }
    }
    if (best) return pick(best.o);
    // A bare yes means the raiser's recommendation -- or the only option.
    if (AFFIRM.test(said) && words.length <= 5) {
      const rec = options.find((o) => o.recommended)
        || options.find((o) => o.key === card.defaultKey)
        || (options.length === 1 ? options[0] : null);
      if (rec) return pick(rec);
    }
  }
  return { kind: "steer", text: String(transcript).trim() };
}

module.exports = { cardPrompt, matchReply, norm };
