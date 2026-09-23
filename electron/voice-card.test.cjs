"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { cardPrompt, matchReply } = require("./voice-card.cjs");

const card = {
  id: "c1",
  title: "Restart the scheduler?",
  defaultKey: "later",
  options: [
    { key: "restart", label: "Restart now", recommended: true },
    { key: "later", label: "Later tonight" },
    { key: "restart-hard", label: "Restart now and clear the queue" },
  ],
};

test("the prompt reads the title and numbers every option, marking the recommended one", () => {
  assert.equal(
    cardPrompt(card),
    "A decision needs you: Restart the scheduler?. Options: one, Restart now, recommended; "
      + "two, Later tonight; three, Restart now and clear the queue. Say a number, or tell me what to do instead.",
  );
  assert.match(cardPrompt({ title: "Free text", options: [] }), /Tell me what to do\.$/);
});

test("a number picks that option however it is said", () => {
  for (const said of ["two", "Option two.", "the second one", "2"]) {
    assert.deepEqual(matchReply(card, said), { kind: "answer", key: "later", label: "Later tonight" }, said);
  }
});

test("the option's own words pick it, the longest match winning", () => {
  assert.equal(matchReply(card, "later tonight please").key, "later");
  assert.equal(matchReply(card, "restart now and clear the queue").key, "restart-hard");
  assert.equal(matchReply(card, "restart now").key, "restart");
});

test("a bare yes means the recommended option", () => {
  assert.equal(matchReply(card, "Yes, do it").key, "restart");
  const noRec = { ...card, options: card.options.map((o) => ({ ...o, recommended: false })) };
  assert.equal(matchReply(noRec, "yes").key, "later", "falls back to the card's default");
});

test("anything else is a steer to the session, never a guessed option", () => {
  assert.deepEqual(matchReply(card, "No -- wait until the ARC run finishes, then restart"), {
    kind: "steer",
    text: "No -- wait until the ARC run finishes, then restart",
  });
  // A long sentence that merely CONTAINS a number is not a pick.
  assert.equal(matchReply(card, "I think one of them is fine but check the logs first").kind, "steer");
});

test("silence is nothing, and a card without options only steers", () => {
  assert.deepEqual(matchReply(card, "   "), { kind: "none" });
  assert.equal(matchReply({ title: "t", options: [] }, "yes").kind, "steer");
});
