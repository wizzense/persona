"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildHomeSummary, ageLabel } = require("./home-summary.cjs");

const NOW = Date.UTC(2026, 8, 23, 20, 0, 0);
const sec = (msAgo) => Math.floor((NOW - msAgo) / 1000);
const DAY = 24 * 60 * 60 * 1000;

function card(id, over = {}) {
  return { id, title: `card ${id}`, summary: "", urgency: "normal", createdAt: sec(60 * 60 * 1000), options: [], ...over };
}

test("counts every card but lists only the top five ACTIONABLE ones, urgent first", () => {
  const cards = [
    ...Array.from({ length: 8 }, (_, i) => card(`d${i}`, { kind: "decision" })),
    card("hot", { urgency: "critical", createdAt: sec(3 * DAY) }),
    card("fyi", { kind: "info" }),
  ];
  const out = buildHomeSummary({ cards, triage: (c) => (c.kind === "info" ? "fyi" : "decision"), now: NOW });
  assert.equal(out.decisions.total, 10);
  assert.equal(out.decisions.waiting, 9, "the info card is counted but not waiting");
  assert.equal(out.decisions.top.length, 5);
  assert.equal(out.decisions.top[0].id, "hot", "critical leads even when older");
  assert.ok(!out.decisions.top.some((c) => c.id === "fyi"));
});

test("today and stale are measured from created_at in SECONDS (awask's unit)", () => {
  const cards = [card("new"), card("week", { createdAt: sec(8 * DAY) }), card("ms", { createdAt: NOW - 9 * DAY })];
  const out = buildHomeSummary({ cards, now: NOW });
  assert.equal(out.decisions.today, 1);
  assert.equal(out.decisions.stale, 2, "a millisecond timestamp is read as one too");
});

test("the recommended option is marked, default key counts as recommended", () => {
  const cards = [card("x", { defaultKey: "b", options: [{ key: "a", label: "A" }, { key: "b", label: "B" }] })];
  const [top] = buildHomeSummary({ cards, now: NOW }).decisions.top;
  assert.deepEqual(top.options.map((o) => o.recommended), [false, true]);
});

test("health is ONE sentence, naming each failing source once", () => {
  const ok = buildHomeSummary({ sessions: { ok: true, sessions: [] }, gateway: { ok: true }, now: NOW });
  assert.equal(ok.health.level, "ok");
  const bad = buildHomeSummary({ sessions: { ok: false, note: "daemon down" }, gateway: { ok: false, note: "HTTP 503" }, now: NOW });
  assert.equal(bad.health.level, "warn");
  assert.equal(bad.health.text, "MCP gateway: HTTP 503 · sessions: daemon down");
});

test("sessions are summarised by status and capped at six", () => {
  const rows = Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, title: `t${i}`, status: i % 2 ? "idle" : "running" }));
  const out = buildHomeSummary({ sessions: { ok: true, sessions: rows }, now: NOW });
  assert.equal(out.sessions.total, 9);
  assert.deepEqual(out.sessions.byStatus, { running: 5, idle: 4 });
  assert.equal(out.sessions.recent.length, 6);
});

test("voice switches pass through as booleans", () => {
  const out = buildHomeSummary({ voice: { voicesMuted: 1, micMuted: 0, talkMode: "open" }, now: NOW });
  assert.deepEqual(out.voice, { voicesMuted: true, micMuted: false, talkMode: "open" });
});

test("ageLabel reads like the inbox", () => {
  assert.equal(ageLabel(30 * 1000), "1m");
  assert.equal(ageLabel(5 * 60 * 60 * 1000), "5h");
  assert.equal(ageLabel(13 * DAY), "13d");
  assert.equal(ageLabel(Infinity), "");
});
