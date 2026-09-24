/**
 * The Decisions page's pure model: filtering, facet counts, grouping, paging,
 * keyboard targets and the awareness collapse. No React, no bridge — vitest
 * drives exactly this (model.test.ts), the components only render it.
 *
 * Why a LIST (owner, 2026-09-23): the inbox read "298 waiting · 1 of 302" and
 * paged through cards one at a time. Nobody triages 298 decisions that way; a
 * list with search, age/kind facets and bulk actions is the only honest shape
 * for a queue that size.
 */

import { otherChoices, primaryChoice, type DeckDecision } from '../../deck/deck-types';

/** main's card carries more than DeckDecision declares (decision-cards.cjs
 *  cardFromRaw): kind, deadline, recipe and each option's consequence. All
 *  optional here — an older main does not send them. */
export interface DecisionCard extends DeckDecision {
  kind?: string;
  deadline?: number;
  recipe?: string;
  dedupeKey?: string;
  options: Array<{ key: string; label: string; recommended: boolean; consequence?: string }>;
}

export type AgeBucket = 'today' | 'week' | 'older';
export type GroupBy = 'none' | 'project' | 'age';

export interface DecisionFilters {
  query: string;
  /** null = every age. */
  age: AgeBucket | null;
  /** null = every kind. */
  kind: string | null;
}

export const EMPTY_FILTERS: DecisionFilters = { query: '', age: null, kind: null };
export const PAGE_SIZE = 50;

export const AGE_LABELS: Record<AgeBucket, string> = {
  today: 'Today',
  week: 'This week',
  older: 'Older than 7 days',
};

const DAY_MS = 86_400_000;

/** Local midnight of the day `nowMs` falls in. */
function startOfDay(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Today = since local midnight; This week = the last 7 days before that;
 *  Older = more than 7 days old. A card with no timestamp is "older" — it has
 *  certainly been waiting longer than we can prove. */
export function ageBucket(createdAtSec: number, nowMs: number): AgeBucket {
  if (!createdAtSec) return 'older';
  const at = createdAtSec * 1000;
  if (at >= startOfDay(nowMs)) return 'today';
  if (at >= nowMs - 7 * DAY_MS) return 'week';
  return 'older';
}

/** The card's kind, lower-case; cards from an older main are "decision". */
export function kindOf(card: DecisionCard): string {
  return (card.kind || 'decision').toLowerCase();
}

/** The last segment of a path, for either separator. */
function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** The project chip: the cwd's folder, else the tab title, else the agent. */
export function projectOf(card: DecisionCard): string {
  if (card.cwd) return basename(card.cwd);
  return card.tab || card.agent || 'unknown';
}

/** Newest first — the list reads top-down as "what just arrived". */
export function sortNewestFirst<T extends DecisionCard>(cards: T[]): T[] {
  return [...cards].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || a.id.localeCompare(b.id));
}

function matchesQuery(card: DecisionCard, needle: string): boolean {
  if (!needle) return true;
  const hay = [card.title, card.summary, card.id, card.cwd, card.tab, card.agent, card.kind ?? '',
    ...card.options.map((o) => o.label)].join('\n').toLowerCase();
  return needle.split(/\s+/).every((word) => hay.includes(word));
}

/** Apply the triage bar. Search matches every whitespace-separated word. */
export function filterCards<T extends DecisionCard>(cards: T[], filters: DecisionFilters, nowMs: number): T[] {
  const needle = filters.query.trim().toLowerCase();
  return cards.filter((card) =>
    (filters.age === null || ageBucket(card.createdAt, nowMs) === filters.age)
    && (filters.kind === null || kindOf(card) === filters.kind)
    && matchesQuery(card, needle));
}

export interface FacetCounts {
  age: Record<AgeBucket, number>;
  /** kind -> count, most frequent first. */
  kinds: Array<{ kind: string; count: number }>;
}

/**
 * The number on each chip: what you would see if you clicked it, given the
 * OTHER active filters (age counts ignore the age filter, kind counts ignore
 * the kind filter) — the usual faceted-search contract.
 */
export function facetCounts(cards: DecisionCard[], filters: DecisionFilters, nowMs: number): FacetCounts {
  const age: Record<AgeBucket, number> = { today: 0, week: 0, older: 0 };
  for (const card of filterCards(cards, { ...filters, age: null }, nowMs)) {
    age[ageBucket(card.createdAt, nowMs)] += 1;
  }
  const kindMap = new Map<string, number>();
  for (const card of filterCards(cards, { ...filters, kind: null }, nowMs)) {
    const kind = kindOf(card);
    kindMap.set(kind, (kindMap.get(kind) ?? 0) + 1);
  }
  const kinds = [...kindMap.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
  return { age, kinds };
}

/** The kind chips to render: the top `limit` kinds, plus the ACTIVE kind even
 *  when a query pushed it out of the top or to zero — otherwise the list stays
 *  filtered with no chip showing the filter or turning it off. */
export function kindChips(
  kinds: FacetCounts['kinds'],
  activeKind: string | null,
  limit: number,
): FacetCounts['kinds'] {
  const top = kinds.slice(0, limit);
  if (!activeKind || top.some((k) => k.kind === activeKind)) return top;
  const count = kinds.find((k) => k.kind === activeKind)?.count ?? 0;
  return [...top, { kind: activeKind, count }];
}

export interface CardGroup<T extends DecisionCard = DecisionCard> {
  key: string;
  label: string;
  cards: T[];
}

/** Group an already-sorted list. Groups keep the list's order; project groups
 *  are ordered by size (the noisiest project first), age groups by age. */
export function groupCards<T extends DecisionCard>(cards: T[], groupBy: GroupBy, nowMs: number): CardGroup<T>[] {
  if (groupBy === 'none') return [{ key: 'all', label: '', cards }];
  const map = new Map<string, T[]>();
  for (const card of cards) {
    const key = groupBy === 'age' ? ageBucket(card.createdAt, nowMs) : projectOf(card);
    const list = map.get(key);
    if (list) list.push(card);
    else map.set(key, [card]);
  }
  const groups = [...map.entries()].map(([key, list]) => ({
    key,
    label: groupBy === 'age' ? AGE_LABELS[key as AgeBucket] : key,
    cards: list,
  }));
  if (groupBy === 'age') {
    const order: AgeBucket[] = ['today', 'week', 'older'];
    return groups.sort((a, b) => order.indexOf(a.key as AgeBucket) - order.indexOf(b.key as AgeBucket));
  }
  return groups.sort((a, b) => b.cards.length - a.cards.length || a.key.localeCompare(b.key));
}

/** True when the raiser declared a default that is one of the card's own options —
 *  the only cards "Answer with default" may touch (mirrors decisions-bulk.cjs). */
export function hasDefault(card: DecisionCard): boolean {
  return Boolean(card.defaultKey) && card.options.some((o) => o.key === card.defaultKey);
}

/** The label of the default option, for the bulk bar's confirmation text. */
export function defaultLabel(card: DecisionCard): string {
  return card.options.find((o) => o.key === card.defaultKey)?.label ?? '';
}

/** "Keep owner-only ×8, Defer ×4": what a bulk answer-with-default will SEND, so the
 *  confirm step shows the answers, not just a count (review #8). */
export function defaultsSummary(cards: DecisionCard[], limit = 3): string {
  const counts = new Map<string, number>();
  for (const card of cards) {
    const label = defaultLabel(card);
    if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const shown = rows.slice(0, limit).map(([label, n]) => `${label} ×${n}`);
  if (rows.length > limit) shown.push(`+${rows.length - limit} more`);
  return shown.join(', ');
}

/** Every option in button order: the primary one first, then the rest — the
 *  order the 1-9 keys pick in, so the digit on screen is the digit you press. */
export function orderedChoices(card: DecisionCard): Array<{ key: string; label: string; primary: boolean }> {
  const primary = primaryChoice(card);
  if (!primary) return [];
  return [{ ...primary, primary: true }, ...otherChoices(card).map((o) => ({ ...o, primary: false }))];
}

/** The option a digit key picks (1-based), or null. */
export function choiceForDigit(card: DecisionCard, digit: number): string | null {
  if (!Number.isInteger(digit) || digit < 1 || digit > 9) return null;
  return orderedChoices(card)[digit - 1]?.key ?? null;
}

/** j/k movement clamped to the visible list; -1 when the list is empty. */
export function moveCursor(index: number, delta: number, length: number): number {
  if (length <= 0) return -1;
  if (index < 0) return delta > 0 ? 0 : length - 1;
  return Math.min(length - 1, Math.max(0, index + delta));
}

const ENTER_ACTIVATES_TAGS = new Set(['BUTTON', 'A', 'SUMMARY']);
const ENTER_ACTIVATES_ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'option']);

/** Whether the list's Enter shortcut may toggle the cursor card. Enter on a
 *  focused button IS its click; preventDefault on that keydown swallowed the
 *  click, so Tab-to-"Approve"-then-Enter collapsed the card and sent nothing. */
export function enterTogglesCursor(target: EventTarget | null, cursorId: string | null): boolean {
  if (!cursorId) return false;
  const el = target as {
    tagName?: unknown;
    getAttribute?: (name: string) => string | null;
    classList?: { contains: (name: string) => boolean };
  } | null;
  if (!el || typeof el.tagName !== 'string') return true;
  // A row's OWN header button keeps focus after a click while j/k move only the
  // cursor, so Enter there means "open the cursor row", not "re-click row A".
  if (el.classList && typeof el.classList.contains === 'function' && el.classList.contains('dx-row-main')) return true;
  if (ENTER_ACTIVATES_TAGS.has(el.tagName.toUpperCase())) return false;
  const role = typeof el.getAttribute === 'function' ? el.getAttribute('role') : null;
  return !(role && ENTER_ACTIVATES_ROLES.has(role.toLowerCase()));
}

/** How many rows must be shown for `id` to be on screen (paging), or null. */
export function pagesToReveal(ids: string[], id: string, pageSize = PAGE_SIZE): number | null {
  const at = ids.indexOf(id);
  if (at < 0) return null;
  return Math.ceil((at + 1) / pageSize) * pageSize;
}

/** Urgency as a class suffix; unknown urgencies read as normal. */
export function urgencyClass(urgency: string): 'critical' | 'high' | 'normal' | 'low' {
  const u = (urgency || '').toLowerCase();
  return u === 'critical' || u === 'high' || u === 'low' ? u : 'normal';
}

/** "due in 3h" / "default applies — overdue 2h" / '' — the deadline is the card's
 *  own answer (an unanswered recipe card applies its default when it passes). */
export function deadlineLabel(card: DecisionCard, nowMs: number): string {
  if (!card.deadline) return '';
  const secs = Math.round(card.deadline - nowMs / 1000);
  const span = (n: number) => (n < 5400 ? `${Math.max(1, Math.round(n / 60))}m`
    : n < 129600 ? `${Math.round(n / 3600)}h` : `${Math.round(n / 86400)}d`);
  return secs >= 0 ? `due in ${span(secs)}` : `past due ${span(-secs)}`;
}

/** One awareness source, already in words. */
export interface AwarenessRow {
  label: string;
  text: string;
  /** false when the text is a healthy reading ("up", a window title). */
  failing: boolean;
}

export interface AwarenessLine {
  labels: string[];
  text: string;
  failing: boolean;
  /** true when this line stands for more than one source. */
  shared: boolean;
}

/**
 * Collapse sources that say the SAME thing into one line naming all of them.
 *
 * Five rows of "HTTP 503: Authorization backend unreachable" (owner screenshot,
 * 2026-09-23) is one fact printed five times. sharedCause() only recognised
 * transport errors; this groups ANY identical failure, keeps healthy rows
 * separate, and keeps first-seen order so the panel does not jump around.
 */
export function collapseAwareness(rows: AwarenessRow[]): AwarenessLine[] {
  const out: AwarenessLine[] = [];
  const failingByText = new Map<string, AwarenessLine>();
  for (const row of rows) {
    const text = row.text.trim() || 'no answer';
    if (row.failing) {
      const existing = failingByText.get(text);
      if (existing) {
        existing.labels.push(row.label);
        existing.shared = true;
        continue;
      }
      const line: AwarenessLine = { labels: [row.label], text, failing: true, shared: false };
      failingByText.set(text, line);
      out.push(line);
    } else {
      out.push({ labels: [row.label], text, failing: false, shared: false });
    }
  }
  return out;
}
