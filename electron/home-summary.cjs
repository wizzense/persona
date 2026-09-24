"use strict";

/**
 * home-summary.cjs -- the Home page's one read: "does anything need me, and is it
 * all running". Pure: main hands in what it already holds (open cards, the session
 * list, voice switches) and this shapes it, so every rule here is testable without
 * Electron and the page renders data, never decides.
 *
 * Owner, 2026-09-23: the console opened on a pager of 298 cards and five identical
 * 503 rows. Home leads with the few things that are actually a decision, counts the
 * rest instead of listing them, and says ONE sentence about health.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** created_at arrives as epoch seconds from awask; tolerate milliseconds too. */
function ageMs(card, now) {
  const t = Number(card && card.createdAt) || 0;
  if (!t) return Infinity;
  return now - (t < 1e12 ? t * 1000 : t);
}

/** "3m", "5h", "13d" -- how the inbox already writes an age. */
function ageLabel(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const URGENCY_RANK = { critical: 0, high: 1, normal: 2, low: 3 };

/**
 * @param {object} input
 * @param {Array}  input.cards        open decision cards (decision-cards.cardFromRaw shape)
 * @param {(card) => string} [input.triage]  decision-cards.triageCard; "decision" = actionable
 * @param {object} [input.sessions]   sessions-client.listSessions() result {ok, sessions, note}
 * @param {object} [input.voice]      { voicesMuted, micMuted, talkMode }
 * @param {object} [input.avatars]    { shown, bodies, character }
 * @param {object} [input.gateway]    { ok, note } -- the MCP gateway health probe
 * @param {number} [input.now]
 */
function buildHomeSummary({ cards = [], triage, sessions, voice = {}, avatars = {}, gateway, now = Date.now() } = {}) {
  const all = Array.isArray(cards) ? cards : [];
  const isDecision = (card) => (typeof triage === "function" ? triage(card) === "decision" : true);
  const actionable = all.filter(isDecision);
  const stale = all.filter((card) => ageMs(card, now) > 7 * DAY_MS).length;
  const today = all.filter((card) => ageMs(card, now) <= DAY_MS).length;

  const top = [...actionable]
    .sort((a, b) => (URGENCY_RANK[a.urgency] ?? 2) - (URGENCY_RANK[b.urgency] ?? 2)
      || ageMs(a, now) - ageMs(b, now))
    .slice(0, 5)
    .map((card) => ({
      id: card.id,
      title: card.title,
      summary: String(card.summary || "").slice(0, 180),
      urgency: card.urgency || "normal",
      age: ageLabel(ageMs(card, now)),
      options: (card.options || []).slice(0, 3).map((o) => ({
        key: o.key, label: o.label, recommended: Boolean(o.recommended) || o.key === card.defaultKey,
      })),
    }));

  let sessionBlock;
  if (sessions && sessions.ok && Array.isArray(sessions.sessions)) {
    const byStatus = {};
    for (const row of sessions.sessions) byStatus[row.status || "unknown"] = (byStatus[row.status || "unknown"] || 0) + 1;
    sessionBlock = {
      ok: true,
      total: sessions.sessions.length,
      byStatus,
      recent: sessions.sessions.slice(0, 6).map((row) => ({
        id: String(row.id || ""),
        title: String(row.title || row.id || "session").slice(0, 90),
        status: row.status || "unknown",
        harness: row.harness || "",
        activity: String(row.last_activity_summary || "").slice(0, 120),
      })),
    };
  } else {
    sessionBlock = { ok: false, total: 0, byStatus: {}, recent: [], note: (sessions && sessions.note) || "session daemon did not answer" };
  }

  // Health is ONE sentence. A list of every door that failed the same way is how
  // the old inbox ended up with five identical 503 rows.
  const problems = [];
  if (gateway && gateway.ok === false) problems.push(`MCP gateway: ${gateway.note || "down"}`);
  if (!sessionBlock.ok) problems.push(`sessions: ${sessionBlock.note}`);
  const health = problems.length
    ? { level: "warn", text: problems.join(" · ") }
    : { level: "ok", text: "Gateway and session daemon answering." };

  return {
    decisions: { waiting: actionable.length, total: all.length, today, stale, top },
    sessions: sessionBlock,
    voice: {
      voicesMuted: Boolean(voice.voicesMuted),
      micMuted: Boolean(voice.micMuted),
      talkMode: voice.talkMode || "toggle",
    },
    avatars: {
      shown: Boolean(avatars.shown),
      bodies: Number(avatars.bodies) || 0,
      character: avatars.character || "",
    },
    health,
    at: now,
  };
}

module.exports = { buildHomeSummary, ageLabel };
