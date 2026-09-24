import { describe, expect, it } from 'vitest';

import {
  EMPTY_FILTERS,
  PAGE_SIZE,
  ageBucket,
  choiceForDigit,
  collapseAwareness,
  deadlineLabel,
  facetCounts,
  filterCards,
  groupCards,
  enterTogglesCursor,
  defaultsSummary,
  hasDefault,
  kindChips,
  moveCursor,
  orderedChoices,
  pagesToReveal,
  projectOf,
  sortNewestFirst,
  urgencyClass,
  type DecisionCard,
} from './model';
import { awarenessRows } from './awareness';
import { bulkResultNote, deckStateFromPush } from './bridge';
import { EMPTY_DECK_STATE, normalizeWakes, type DeckState } from '../../deck/deck-types';

// Local-time noon, so "today" is TZ-independent.
const NOW = new Date(2026, 8, 23, 12, 0, 0).getTime();
const HOUR = 3600;
const nowSec = Math.floor(NOW / 1000);

function card(id: string, overrides: Partial<DecisionCard> = {}): DecisionCard {
  return {
    id,
    title: `Card ${id}`,
    summary: '',
    urgency: 'normal',
    createdAt: nowSec - HOUR,
    options: [
      { key: 'yes', label: 'Ship it', recommended: true },
      { key: 'no', label: 'Hold', recommended: false },
    ],
    defaultKey: 'yes',
    tab: '',
    cwd: '',
    agent: '',
    ...overrides,
  };
}

describe('ageBucket', () => {
  it('splits today / this week / older at local midnight and 7 days', () => {
    expect(ageBucket(nowSec - 2 * HOUR, NOW)).toBe('today');
    expect(ageBucket(nowSec - 13 * HOUR, NOW)).toBe('week'); // yesterday 23:00
    expect(ageBucket(nowSec - 6 * 24 * HOUR, NOW)).toBe('week');
    expect(ageBucket(nowSec - 8 * 24 * HOUR, NOW)).toBe('older');
    expect(ageBucket(0, NOW)).toBe('older');
  });
});

describe('filtering and facets', () => {
  const cards = [
    card('a', { title: 'Rotate the tunnel key', kind: 'credential', cwd: 'C:\\AitherOS-Fresh' }),
    card('b', { title: 'Merge PR 8553', createdAt: nowSec - 3 * 24 * HOUR, cwd: '/home/x/awdk/' }),
    card('c', { title: 'Old wake streak', createdAt: nowSec - 30 * 24 * HOUR, kind: 'blocked', tab: 'wakes' }),
  ];

  it('search matches every word across title, id and project', () => {
    expect(filterCards(cards, { ...EMPTY_FILTERS, query: 'merge 8553' }, NOW).map((c) => c.id)).toEqual(['b']);
    expect(filterCards(cards, { ...EMPTY_FILTERS, query: 'aitheros' }, NOW).map((c) => c.id)).toEqual(['a']);
  });

  it('age and kind filters combine', () => {
    expect(filterCards(cards, { ...EMPTY_FILTERS, age: 'older' }, NOW).map((c) => c.id)).toEqual(['c']);
    expect(filterCards(cards, { ...EMPTY_FILTERS, kind: 'decision' }, NOW).map((c) => c.id)).toEqual(['b']);
  });

  it('facet counts ignore their own dimension but honour the others', () => {
    const facets = facetCounts(cards, { ...EMPTY_FILTERS, age: 'today' }, NOW);
    expect(facets.age).toEqual({ today: 1, week: 1, older: 1 });
    expect(facets.kinds).toEqual([{ kind: 'credential', count: 1 }]);
  });

  it('the active kind keeps its chip when a query pushes it out of the top', () => {
    // Two 'deploy' decisions outrank the one 'blocked' card once the query is typed.
    const pool = [
      ...cards,
      card('d', { title: 'deploy one' }),
      card('e', { title: 'deploy two' }),
      card('f', { title: 'deploy three', kind: 'blocked' }),
    ];
    const filters = { ...EMPTY_FILTERS, kind: 'blocked', query: 'deploy' };
    expect(filterCards(pool, filters, NOW).map((c) => c.id)).toEqual(['f']);
    const facets = facetCounts(pool, filters, NOW);
    expect(facets.kinds.slice(0, 1).map((k) => k.kind)).toEqual(['decision']);
    expect(kindChips(facets.kinds, 'blocked', 1)).toEqual([
      { kind: 'decision', count: 2 },
      { kind: 'blocked', count: 1 },
    ]);
    // A query that matches none of that kind still leaves a chip to turn it off.
    expect(kindChips([{ kind: 'decision', count: 2 }], 'blocked', 6))
      .toEqual([{ kind: 'decision', count: 2 }, { kind: 'blocked', count: 0 }]);
    // No active kind, or one already in the top: just the top.
    expect(kindChips(facets.kinds, null, 1)).toEqual([{ kind: 'decision', count: 2 }]);
    expect(kindChips(facets.kinds, 'decision', 1)).toEqual([{ kind: 'decision', count: 2 }]);
  });

  it('sorts newest first', () => {
    expect(sortNewestFirst(cards).map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('groups by project (largest first) and by age (in age order)', () => {
    const more = [...cards, card('d', { cwd: '/home/x/awdk' })];
    const byProject = groupCards(sortNewestFirst(more), 'project', NOW);
    expect(byProject[0]).toMatchObject({ key: 'awdk' });
    expect(byProject[0].cards.map((c) => c.id)).toEqual(['d', 'b']);
    expect(groupCards(sortNewestFirst(more), 'age', NOW).map((g) => g.label))
      .toEqual(['Today', 'This week', 'Older than 7 days']);
    expect(groupCards(more, 'none', NOW)).toHaveLength(1);
  });

  it('project chip falls back cwd -> tab -> agent', () => {
    expect(projectOf(card('x', { cwd: 'D:\\desk\\' }))).toBe('desk');
    expect(projectOf(card('x', { tab: 'my tab' }))).toBe('my tab');
    expect(projectOf(card('x', { agent: 'lyra' }))).toBe('lyra');
    expect(projectOf(card('x'))).toBe('unknown');
  });
});

describe('answers and keyboard', () => {
  it('hasDefault only when the default names an option', () => {
    expect(hasDefault(card('a'))).toBe(true);
    expect(hasDefault(card('a', { defaultKey: '' }))).toBe(false);
    expect(hasDefault(card('a', { defaultKey: 'ghost' }))).toBe(false);
  });

  it('digits pick in button order: primary first, then the rest', () => {
    const c = card('a', {
      defaultKey: 'later',
      options: [
        { key: 'now', label: 'Now', recommended: true },
        { key: 'later', label: 'Later', recommended: false },
        { key: 'never', label: 'Never', recommended: false },
      ],
    });
    expect(orderedChoices(c).map((o) => o.key)).toEqual(['later', 'never', 'now']);
    expect(choiceForDigit(c, 1)).toBe('later');
    expect(choiceForDigit(c, 3)).toBe('now');
    expect(choiceForDigit(c, 4)).toBeNull();
    expect(choiceForDigit(c, 0)).toBeNull();
  });

  it('cursor movement clamps and starts from the right end', () => {
    expect(moveCursor(-1, 1, 5)).toBe(0);
    expect(moveCursor(-1, -1, 5)).toBe(4);
    expect(moveCursor(4, 1, 5)).toBe(4);
    expect(moveCursor(0, -1, 5)).toBe(0);
    expect(moveCursor(0, 1, 0)).toBe(-1);
  });

  it('Enter on a focused button is that button, not the cursor toggle', () => {
    const el = (tagName: string, role: string | null = null) =>
      ({ tagName, getAttribute: () => role }) as unknown as EventTarget;
    // The option/Pop out/Dismiss/"Something else…" buttons, links and tabs keep Enter.
    expect(enterTogglesCursor(el('BUTTON'), 'd-1')).toBe(false);
    expect(enterTogglesCursor(el('A'), 'd-1')).toBe(false);
    expect(enterTogglesCursor(el('DIV', 'tab'), 'd-1')).toBe(false);
    // Body (nothing focused) and plain elements still toggle the cursor card.
    expect(enterTogglesCursor(el('BODY'), 'd-1')).toBe(true);
    expect(enterTogglesCursor(el('DIV'), 'd-1')).toBe(true);
    expect(enterTogglesCursor(null, 'd-1')).toBe(true);
    expect(enterTogglesCursor(el('BODY'), null)).toBe(false);
    expect(enterTogglesCursor(el('DIV', 'Button'), 'd-1')).toBe(false); // roles compare case-insensitively
  });

  it('Enter on a row header button still opens the CURSOR row (click A, press j, press Enter)', () => {
    const rowMain = { tagName: 'BUTTON', getAttribute: () => null, classList: { contains: (c: string) => c === 'dx-row-main' } } as unknown as EventTarget;
    expect(enterTogglesCursor(rowMain, 'd-2')).toBe(true);
  });

  it('the bulk confirm names the answers it will send, most common first', () => {
    const card = (id: string, label: string) =>
      ({ id, defaultKey: 'k', options: [{ key: 'k', label }] }) as unknown as Parameters<typeof defaultsSummary>[0][number];
    const cards = [card('a', 'Defer'), card('b', 'Keep owner-only'), card('c', 'Keep owner-only'), card('d', 'Noted'), card('e', 'Retry')];
    expect(defaultsSummary(cards)).toBe('Keep owner-only ×2, Defer ×1, Noted ×1, +1 more');
    expect(defaultsSummary([])).toBe('');
  });

  it('paging grows to reveal a deep-linked card', () => {
    const ids = Array.from({ length: 180 }, (_, i) => `d${i}`);
    expect(pagesToReveal(ids, 'd10')).toBe(PAGE_SIZE);
    expect(pagesToReveal(ids, 'd120')).toBe(3 * PAGE_SIZE);
    expect(pagesToReveal(ids, 'nope')).toBeNull();
  });

  it('urgency and deadline labels', () => {
    expect(urgencyClass('HIGH')).toBe('high');
    expect(urgencyClass('weird')).toBe('normal');
    expect(deadlineLabel(card('a', { deadline: nowSec + 3 * HOUR }), NOW)).toBe('due in 3h');
    expect(deadlineLabel(card('a', { deadline: nowSec - 600 }), NOW)).toBe('past due 10m');
    expect(deadlineLabel(card('a'), NOW)).toBe('');
  });
});

describe('awareness collapse', () => {
  it('five sources failing the same way become ONE line naming all of them', () => {
    const reason = 'HTTP 503: Authorization backend unreachable';
    const rows = awarenessRows({
      system: { ok: false, reason },
      voice: { ok: false, reason },
      vision: { ok: false, reason },
      desktop: { ok: false, reason },
      connect: { ok: false, reason },
    });
    const lines = collapseAwareness(rows);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ shared: true, failing: true, text: reason });
    expect(lines[0].labels).toEqual(['System', 'Voice', 'Vision', 'Desktop', 'Workspace']);
  });

  it('keeps healthy rows and distinct failures apart, in order', () => {
    const lines = collapseAwareness([
      { label: 'Voice', text: 'up', failing: false },
      { label: 'Vision', text: 'the MCP gateway is not answering (:8182)', failing: true },
      { label: 'Desktop', text: 'code.exe', failing: false },
      { label: 'Workspace', text: 'the MCP gateway is not answering (:8182)', failing: true },
      { label: 'System', text: 'HTTP 500', failing: true },
    ]);
    expect(lines.map((l) => l.labels.join('+'))).toEqual(['Voice', 'Vision+Workspace', 'Desktop', 'System']);
  });

  it('a transport error in a note counts as failing without the prefix', () => {
    const rows = awarenessRows({
      voice: { ok: true, status: { note: 'ERROR: connect ECONNREFUSED 127.0.0.1:8182' } },
    });
    const voice = rows.find((r) => r.label === 'Voice');
    expect(voice).toMatchObject({ failing: true, text: 'the MCP gateway is not answering (:8182)' });
  });
});

describe('deckStateFromPush', () => {
  it('keeps every field main pushes, totalCount included', () => {
    const full: DeckState = {
      ...EMPTY_DECK_STATE,
      openCount: 12,
      totalCount: 298,
      deskVisible: true,
      agents: ['lyra'],
      characters: ['aria'],
      characterModels: { aria: 'file:///aria.vrm' },
      activeCharacter: 'aria',
      agentCharacters: { lyra: 'aria' },
      relayChannel: '#ops',
      roomStatus: 'live',
      wakes: normalizeWakes(EMPTY_DECK_STATE.wakes),
    };
    // Every DeckState key must survive the push, or the header differs pull vs push.
    expect(deckStateFromPush({ type: 'deck-state', ...full })).toEqual(full);
    expect(deckStateFromPush({ type: 'deck-state', openCount: 3 }).totalCount).toBeUndefined();
  });
});

describe('bulkResultNote', () => {
  it('says what was handed over, skipped and failed', () => {
    expect(bulkResultNote({
      ok: true, verb: 'cancel', done: ['a', 'b'], failed: ['c'],
      skipped: [{ id: 'd', reason: 'no longer open' }],
    })).toBe('Dismissed 2 · 1 skipped (no longer open) · 1 failed — awask did not start. Handed to awask.');
    expect(bulkResultNote({ ok: false, verb: 'cancel', done: [], failed: [], skipped: [], error: 'nope' }))
      .toBe('Refused — nope');
  });
});
