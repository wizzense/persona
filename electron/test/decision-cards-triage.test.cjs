/**
 * Test decision card triage on the desk side (JS).
 * Verifies that the desk triage matches daemon-side Python logic.
 */

const test = require("node:test");
const assert = require("node:assert");
const {
  triageCard,
  actionableCount,
} = require("../decision-cards.cjs");

// Mock patterns matching daemon-side triage.py
const PATTERNS = {
  decision_kinds: ["credential", "blocked"],
  context_phrases: [
    "\\b(?:is|are)\\s+(?:both\\s+|still\\s+|currently\\s+)?running",
    "\\b(?:everything|the system)\\s+is\\s+(?:still\\s+)?(?:working|running|proceeding)",
    "\\bthe only open items?\\b",
    "\\beverything else is\\b",
    "\\bevery other item\\b",
    "\\b(?:is|are)\\s+(?:an?\\s+)?in[- ]progress\\b",
    "\\bwaiting (?:on|for) (?:it|them|that|the run|completion|input)\\b",
    "\\b(?:watched\\s+)?background run\\b",
  ],
};

test("desk-side triage matches daemon-side", async (t) => {
  await t.test("hourly digest is context", () => {
    const card = {
      id: "d-test",
      title: "Hourly digest",
      kind: "info",
      options: [],
      deadline: null,
    };
    assert.strictEqual(triageCard(card, PATTERNS), "context");
  });

  await t.test("two-option card is decision", () => {
    const card = {
      id: "d-test",
      title: "Choose plan",
      kind: "decision",
      options: [
        { key: "a", label: "Plan A" },
        { key: "b", label: "Plan B" },
      ],
      deadline: null,
    };
    assert.strictEqual(triageCard(card, PATTERNS), "decision");
  });

  await t.test("future deadline is decision", () => {
    const future = Date.now() / 1000 + 3600;
    const card = {
      id: "d-test",
      title: "Approve by 5pm",
      kind: "decision",
      options: [],
      deadline: future,
    };
    assert.strictEqual(triageCard(card, PATTERNS), "decision");
  });

  await t.test("past deadline is context", () => {
    const past = Date.now() / 1000 - 3600;
    const card = {
      id: "d-test",
      title: "Window closed",
      kind: "decision",
      options: [],
      deadline: past,
    };
    assert.strictEqual(triageCard(card, PATTERNS), "context");
  });

  await t.test("credential card is decision", () => {
    const card = {
      id: "d-test",
      title: "Enter API key",
      kind: "credential",
      options: [],
      deadline: null,
    };
    assert.strictEqual(triageCard(card, PATTERNS), "decision");
  });

  await t.test("blocked card is decision", () => {
    const card = {
      id: "d-test",
      title: "Permission denied",
      kind: "blocked",
      options: [],
      deadline: null,
    };
    assert.strictEqual(triageCard(card, PATTERNS), "decision");
  });

  await t.test("status-only options are context", () => {
    const card = {
      id: "d-test",
      title: "Status update",
      kind: "info",
      options: [
        { key: "ack", label: "Everything is running fine" },
        { key: "wait", label: "The system is waiting for input" },
      ],
      deadline: null,
    };
    assert.strictEqual(triageCard(card, PATTERNS), "context");
  });

  await t.test("actionableCount counts decisions only", () => {
    const cards = [
      {
        id: "d-1",
        title: "Hourly digest",
        kind: "info",
        options: [],
        deadline: null,
      },
      {
        id: "d-2",
        title: "Choose plan",
        kind: "decision",
        options: [{ key: "a", label: "Plan A" }],
        deadline: null,
      },
      {
        id: "d-3",
        title: "Permission denied",
        kind: "blocked",
        options: [],
        deadline: null,
      },
    ];
    assert.strictEqual(actionableCount(cards, PATTERNS), 2);
  });

  await t.test("fallback when patterns unavailable", () => {
    const card = {
      id: "d-test",
      title: "Hourly digest",
      kind: "info",
      options: [],
      deadline: null,
    };
    // Without patterns, defaults to "decision" (safe fallback).
    assert.strictEqual(triageCard(card, null), "decision");
  });
});
