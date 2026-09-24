import { useEffect, useMemo, useRef, useState } from 'react';

import { cardWhere, formatAge } from '../../deck/deck-types';
import { bulkResultNote, type BulkFn, type BulkVerb } from './bridge';
import {
  AGE_LABELS,
  EMPTY_FILTERS,
  PAGE_SIZE,
  ageBucket,
  choiceForDigit,
  deadlineLabel,
  defaultLabel,
  facetCounts,
  filterCards,
  groupCards,
  hasDefault,
  kindOf,
  moveCursor,
  orderedChoices,
  pagesToReveal,
  projectOf,
  sortNewestFirst,
  urgencyClass,
  type AgeBucket,
  type DecisionCard,
  type DecisionFilters,
  type GroupBy,
} from './model';
import { SteerBox } from './SteerBox';
import './decisions.css';

/** Without the bulk IPC, "Answer with default" falls back to one answer() per
 *  card — and every answer posts its own line to #agents. Capped so a fallback
 *  build cannot flood the channel with 298 lines. */
export const FALLBACK_ANSWER_MAX = 20;

const KIND_CHIP_LIMIT = 6;

export interface DecisionsPageProps {
  cards: DecisionCard[];
  nowMs: number;
  /** `?card=<id>`: open the list with this card expanded and on screen. */
  focusId?: string | null;
  onAnswer: (id: string, choice: string) => void;
  onPopout: (id: string) => void;
  onOpenQueue: () => void;
  /** null when this build has no bulk IPC — Dismiss is hidden, answer falls back. */
  bulk: BulkFn | null;
  /** Ids the bulk call handed to awask, for optimistic removal. */
  onBulkDone: (ids: string[]) => void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export function DecisionsPage({
  cards,
  nowMs,
  focusId = null,
  onAnswer,
  onPopout,
  onOpenQueue,
  bulk,
  onBulkDone,
}: DecisionsPageProps) {
  const [filters, setFilters] = useState<DecisionFilters>(EMPTY_FILTERS);
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [shown, setShown] = useState(PAGE_SIZE);
  const [expandedId, setExpandedId] = useState<string | null>(focusId);
  const [cursorId, setCursorId] = useState<string | null>(focusId);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirming, setConfirming] = useState<BulkVerb | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkNote, setBulkNote] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const sorted = useMemo(() => sortNewestFirst(cards), [cards]);
  const filtered = useMemo(() => filterCards(sorted, filters, nowMs), [sorted, filters, nowMs]);
  const facets = useMemo(() => facetCounts(sorted, filters, nowMs), [sorted, filters, nowMs]);
  const filteredIds = useMemo(() => filtered.map((c) => c.id), [filtered]);

  // Paging: 50 at a time, but never hide the card the owner opened (deep link or
  // keyboard) — the limit grows to reveal it instead of an effect nudging state.
  const reveal = expandedId ? pagesToReveal(filteredIds, expandedId) : null;
  const limit = Math.max(shown, reveal ?? 0);
  const page = filtered.slice(0, limit);
  const groups = groupCards(page, groupBy, nowMs);
  const groupTotals = useMemo(() => {
    const totals = new Map<string, number>();
    for (const group of groupCards(filtered, groupBy, nowMs)) totals.set(group.key, group.cards.length);
    return totals;
  }, [filtered, groupBy, nowMs]);
  // Keyboard order is the order ON SCREEN, which grouping changes.
  const flatIds = groups.flatMap((g) => g.cards.map((c) => c.id));
  const byId = useMemo(() => new Map(sorted.map((c) => [c.id, c])), [sorted]);

  // Selection only ever means cards that are still open AND match the filter.
  const selectedVisible = filtered.filter((c) => selected.has(c.id));
  const selectedWithDefault = selectedVisible.filter(hasDefault);
  const allVisibleSelected = filtered.length > 0 && selectedVisible.length === filtered.length;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selectedVisible.length > 0 && !allVisibleSelected;
    }
  }, [selectedVisible.length, allVisibleSelected]);

  // Deep link: scroll the focused card into view once it has arrived.
  const focusPresent = focusId ? byId.has(focusId) : false;
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!focusId || !focusPresent || scrolledFor.current === focusId) return;
    scrolledFor.current = focusId;
    const el = listRef.current?.querySelector(`[data-card-id="${CSS.escape(focusId)}"]`);
    el?.scrollIntoView({ block: 'center' });
  }, [focusId, focusPresent]);

  const moveTo = (id: string | null) => {
    setCursorId(id);
    if (!id) return;
    const el = listRef.current?.querySelector(`[data-card-id="${CSS.escape(id)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  };

  const toggleSelect = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setConfirming(null);
  };

  const answer = (id: string, key: string) => {
    onAnswer(id, key);
    // Keep the cursor on the SAME screen position: the next card slides up.
    const at = flatIds.indexOf(id);
    const next = flatIds[at + 1] ?? flatIds[at - 1] ?? null;
    if (expandedId === id) setExpandedId(null);
    if (cursorId === id) setCursorId(next);
  };

  // One window listener, reading the latest render through a ref.
  const keyHandler = useRef<(event: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    keyHandler.current = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target)) {
        if (event.key === 'Escape' && event.target === searchRef.current) searchRef.current?.blur();
        return;
      }
      const index = cursorId ? flatIds.indexOf(cursorId) : -1;
      if (event.key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault();
        moveTo(flatIds[moveCursor(index, 1, flatIds.length)] ?? null);
      } else if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault();
        moveTo(flatIds[moveCursor(index, -1, flatIds.length)] ?? null);
      } else if (event.key === 'Enter' && cursorId) {
        event.preventDefault();
        setExpandedId((current) => (current === cursorId ? null : cursorId));
      } else if (event.key === 'Escape') {
        setExpandedId(null);
      } else if (event.key === 'x' && cursorId) {
        toggleSelect(cursorId);
      } else if (event.key === '/') {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (/^[1-9]$/.test(event.key) && cursorId && expandedId === cursorId) {
        const card = byId.get(cursorId);
        const key = card ? choiceForDigit(card, Number(event.key)) : null;
        if (card && key) {
          event.preventDefault();
          answer(card.id, key);
        }
      }
    };
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keyHandler.current(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  const setFilter = (patch: Partial<DecisionFilters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setShown(PAGE_SIZE);
    setConfirming(null);
  };

  const runBulk = (verb: BulkVerb) => {
    const targets = verb === 'answer-default' ? selectedWithDefault : selectedVisible;
    if (targets.length === 0 || bulkBusy) return;
    if (confirming !== verb) {
      setConfirming(verb);
      return;
    }
    setConfirming(null);
    const ids = targets.map((c) => c.id);
    if (!bulk) {
      // Fallback build: one answer() per card, capped (see FALLBACK_ANSWER_MAX).
      if (verb !== 'answer-default' || ids.length > FALLBACK_ANSWER_MAX) return;
      for (const card of targets) onAnswer(card.id, card.defaultKey);
      setSelected(new Set());
      setBulkNote(`Answered ${ids.length} with their default. Handed to awask.`);
      return;
    }
    setBulkBusy(true);
    setBulkNote(`${verb === 'cancel' ? 'Dismissing' : 'Answering'} ${ids.length}…`);
    void bulk(verb, ids, verb === 'cancel' ? 'dismissed in bulk from the desk inbox' : undefined)
      .then((result) => {
        if (result.done.length) onBulkDone(result.done);
        setBulkNote(bulkResultNote(result));
        setSelected((current) => {
          const next = new Set(current);
          for (const id of result.done) next.delete(id);
          return next;
        });
      })
      .finally(() => setBulkBusy(false));
  };

  const answerDisabled = bulkBusy || selectedWithDefault.length === 0
    || (!bulk && selectedWithDefault.length > FALLBACK_ANSWER_MAX);

  return (
    <div className="dx-page" aria-label="Decisions">
      <div className="dx-triage">
        <div className="dx-triage-row">
          <input
            ref={searchRef}
            className="dx-input dx-search"
            type="search"
            placeholder={`Search ${cards.length} cards — title, summary, project, id   ( / )`}
            value={filters.query}
            onChange={(event) => setFilter({ query: event.target.value })}
          />
          <div className="dx-seg" role="group" aria-label="Group by">
            <span className="dx-seg-label">Group</span>
            {(['none', 'project', 'age'] as GroupBy[]).map((mode) => (
              <button
                key={mode}
                type="button"
                className="dx-seg-btn"
                aria-pressed={groupBy === mode}
                onClick={() => setGroupBy(mode)}
              >
                {mode === 'none' ? 'None' : mode === 'project' ? 'Project' : 'Age'}
              </button>
            ))}
          </div>
          <button type="button" className="dx-btn dx-ghost" title="Every waiting card in its own answer window" onClick={onOpenQueue}>
            Answer window
          </button>
        </div>
        <div className="dx-triage-row" role="group" aria-label="Filter by age">
          <button type="button" className="dx-chip" aria-pressed={filters.age === null} onClick={() => setFilter({ age: null })}>
            Any age <span className="dx-chip-n">{facets.age.today + facets.age.week + facets.age.older}</span>
          </button>
          {(Object.keys(AGE_LABELS) as AgeBucket[]).map((bucket) => (
            <button
              key={bucket}
              type="button"
              className="dx-chip"
              aria-pressed={filters.age === bucket}
              disabled={facets.age[bucket] === 0 && filters.age !== bucket}
              onClick={() => setFilter({ age: filters.age === bucket ? null : bucket })}
            >
              {AGE_LABELS[bucket]} <span className="dx-chip-n">{facets.age[bucket]}</span>
            </button>
          ))}
          <span className="dx-sep" aria-hidden="true" />
          {facets.kinds.slice(0, KIND_CHIP_LIMIT).map(({ kind, count }) => (
            <button
              key={kind}
              type="button"
              className="dx-chip"
              aria-pressed={filters.kind === kind}
              title={`Only ${kind} cards`}
              onClick={() => setFilter({ kind: filters.kind === kind ? null : kind })}
            >
              {kind} <span className="dx-chip-n">{count}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="dx-bulkbar">
        <label className="dx-check-label" title="Select every card that matches the current search and filters">
          <input
            ref={selectAllRef}
            type="checkbox"
            className="dx-check"
            checked={allVisibleSelected}
            disabled={filtered.length === 0}
            onChange={() => {
              setSelected(allVisibleSelected ? new Set() : new Set(filteredIds));
              setConfirming(null);
            }}
          />
          {selectedVisible.length > 0
            ? `${selectedVisible.length} selected`
            : `Select all ${filtered.length} matching`}
        </label>
        {selectedVisible.length > 0 ? (
          <>
            <button
              type="button"
              className={`dx-btn ${confirming === 'answer-default' ? 'dx-primary' : ''}`}
              disabled={answerDisabled}
              title={!bulk && selectedWithDefault.length > FALLBACK_ANSWER_MAX
                ? `This build answers at most ${FALLBACK_ANSWER_MAX} at once without the bulk channel`
                : 'Answer every selected card that declares a default with that default; the rest are left alone'}
              onClick={() => runBulk('answer-default')}
            >
              {confirming === 'answer-default'
                ? `Confirm — answer ${selectedWithDefault.length}`
                : `Answer with default (${selectedWithDefault.length})`}
            </button>
            {bulk ? (
              <button
                type="button"
                className={`dx-btn dx-danger ${confirming === 'cancel' ? 'is-armed' : ''}`}
                disabled={bulkBusy}
                title="Withdraw the selected cards — each asking session is told, and stops waiting"
                onClick={() => runBulk('cancel')}
              >
                {confirming === 'cancel' ? `Confirm — dismiss ${selectedVisible.length}` : `Dismiss (${selectedVisible.length})`}
              </button>
            ) : null}
            <button type="button" className="dx-btn dx-ghost" onClick={() => { setSelected(new Set()); setConfirming(null); }}>
              Clear
            </button>
          </>
        ) : null}
        <span className="dx-grow" />
        {bulkNote ? <span className="dx-note" role="status">{bulkNote}</span> : null}
        <span className="dx-keys" title="Keyboard">
          <kbd>j</kbd><kbd>k</kbd> move · <kbd>Enter</kbd> open · <kbd>1</kbd>–<kbd>9</kbd> answer · <kbd>x</kbd> select
        </span>
      </div>

      {focusId && !focusPresent && cards.length > 0 ? (
        <p className="dx-note dx-focus-gone">Card {focusId} is no longer open — it was answered or withdrawn.</p>
      ) : null}

      <div className="dx-list" role="list" ref={listRef}>
        {cards.length === 0 ? (
          <div className="dx-empty"><strong>Nothing waiting</strong>Every session is unblocked.</div>
        ) : filtered.length === 0 ? (
          <div className="dx-empty">
            <strong>No card matches</strong>
            <button type="button" className="dx-btn dx-ghost" onClick={() => setFilter(EMPTY_FILTERS)}>Clear filters</button>
          </div>
        ) : (
          groups.map((group) => (
            <div className="dx-group" key={group.key}>
              {group.label ? (
                <h3 className="dx-group-head">
                  {group.label}
                  <span className="dx-chip-n">{groupTotals.get(group.key) ?? group.cards.length}</span>
                </h3>
              ) : null}
              {group.cards.map((card) => (
                <DecisionListRow
                  key={card.id}
                  card={card}
                  nowMs={nowMs}
                  open={expandedId === card.id}
                  cursor={cursorId === card.id}
                  selected={selected.has(card.id)}
                  canDismiss={Boolean(bulk)}
                  onToggle={() => {
                    setCursorId(card.id);
                    setExpandedId((current) => (current === card.id ? null : card.id));
                  }}
                  onSelect={() => toggleSelect(card.id)}
                  onAnswer={(key) => answer(card.id, key)}
                  onPopout={() => onPopout(card.id)}
                  onDismiss={() => {
                    if (!bulk) return;
                    void bulk('cancel', [card.id], 'dismissed from the desk inbox').then((result) => {
                      if (result.done.length) onBulkDone(result.done);
                      setBulkNote(bulkResultNote(result));
                    });
                  }}
                />
              ))}
            </div>
          ))
        )}
        {filtered.length > page.length ? (
          <button type="button" className="dx-more" onClick={() => setShown(limit + PAGE_SIZE)}>
            Show {Math.min(PAGE_SIZE, filtered.length - page.length)} more · {filtered.length - page.length} not shown
          </button>
        ) : null}
      </div>
    </div>
  );
}

function DecisionListRow({
  card,
  nowMs,
  open,
  cursor,
  selected,
  canDismiss,
  onToggle,
  onSelect,
  onAnswer,
  onPopout,
  onDismiss,
}: {
  card: DecisionCard;
  nowMs: number;
  open: boolean;
  cursor: boolean;
  selected: boolean;
  canDismiss: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onAnswer: (key: string) => void;
  onPopout: () => void;
  onDismiss: () => void;
}) {
  const choices = orderedChoices(card);
  const kind = kindOf(card);
  const due = deadlineLabel(card, nowMs);
  const where = cardWhere(card);
  const consequence = (key: string) => card.options.find((o) => o.key === key)?.consequence ?? '';
  const stale = ageBucket(card.createdAt, nowMs) === 'older';
  return (
    <div
      className={`dx-row${open ? ' is-open' : ''}${cursor ? ' is-cursor' : ''}${selected ? ' is-selected' : ''}`}
      role="listitem"
      data-card-id={card.id}
    >
      <div className="dx-row-line">
        <input
          type="checkbox"
          className="dx-check"
          checked={selected}
          aria-label={`Select ${card.title}`}
          onChange={onSelect}
        />
        <button type="button" className="dx-row-main" aria-expanded={open} onClick={onToggle}>
          <span className={`dx-dot dx-urg-${urgencyClass(card.urgency)}`} title={`${card.urgency || 'normal'} urgency`} />
          <span className="dx-row-text">
            <span className="dx-row-title">{card.title}</span>
            {card.summary && !open ? <span className="dx-row-sum">{card.summary}</span> : null}
          </span>
          {kind !== 'decision' ? <span className="dx-tag">{kind}</span> : null}
          <span className="dx-tag dx-project" title={where}>{projectOf(card)}</span>
          {hasDefault(card) ? <span className="dx-tag dx-has-default" title={`Default: ${defaultLabel(card)}`}>default</span> : null}
          <time className={`dx-age${stale ? ' is-stale' : ''}`} title={card.createdAt ? new Date(card.createdAt * 1000).toLocaleString() : ''}>
            {formatAge(card.createdAt, nowMs)}
          </time>
        </button>
      </div>
      {open ? (
        <div className="dx-detail">
          {card.summary ? <p className="dx-detail-summary">{card.summary}</p> : null}
          <p className="dx-detail-meta">
            <span className="dx-mono">{card.id}</span>
            {where ? <span title={card.cwd}>{where}</span> : null}
            {card.agent && card.agent !== where ? <span>{card.agent}</span> : null}
            {due ? <span className="dx-due">{due}{hasDefault(card) ? ` — then “${defaultLabel(card)}” applies` : ''}</span> : null}
            {card.recipe ? <span title="The answer RUNS something (a card recipe), not just records it">acts: {card.recipe}</span> : null}
          </p>
          <div className="dx-options">
            {choices.length === 0 ? (
              <button type="button" className="dx-btn dx-primary" onClick={onPopout} title="This card has no options here — open it in its answer window">
                Open answer window
              </button>
            ) : (
              choices.map((choice, index) => (
                <button
                  key={choice.key}
                  type="button"
                  className={`dx-btn${choice.primary ? ' dx-primary' : ''}`}
                  title={consequence(choice.key) || `Answer “${choice.label}” — recorded, and the asking session is told right away`}
                  onClick={() => onAnswer(choice.key)}
                >
                  {index < 9 ? <kbd>{index + 1}</kbd> : null}
                  {choice.label}
                </button>
              ))
            )}
          </div>
          {choices.some((c) => consequence(c.key)) ? (
            <ul className="dx-consequences">
              {choices.filter((c) => consequence(c.key)).map((c) => (
                <li key={c.key}><strong>{c.label}</strong> — {consequence(c.key)}</li>
              ))}
            </ul>
          ) : null}
          <div className="dx-detail-foot">
            <SteerBox cardId={card.id} />
            <span className="dx-grow" />
            <button type="button" className="dx-btn dx-ghost" title="Open this card in its own pop-out answer window" onClick={onPopout}>
              Pop out
            </button>
            {canDismiss ? (
              <button type="button" className="dx-btn dx-ghost dx-danger" title="Withdraw this card — the asking session is told and stops waiting" onClick={onDismiss}>
                Dismiss
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
