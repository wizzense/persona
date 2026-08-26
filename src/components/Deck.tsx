import { useCallback, useEffect, useRef, useState } from 'react';

import { setDragMode, useDragMode } from '../hooks/useDragMode';
import {
  EMPTY_DECK_STATE,
  cardWhere,
  formatAge,
  primaryChoice,
  secondaryChoice,
  type DeckDecision,
  type DeckState,
  type RelayRow,
} from '../deck/deck-types';

/**
 * The Desk panel — the "full UI/UX" that opens on right-click (owner redesign
 * 2026-08-25: floating beads instead of nested menus). Loaded by the same
 * bundle with `?deck=1`; every action routes through main's deck IPC, which
 * reuses the same functions the old menus used, so the panel is a VIEW, not a
 * second implementation.
 */

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  );
}

function ChipIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5z" />
    </svg>
  );
}

function MonitorIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 17l6-5-6-5M12 19h8" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13h10l1-13" />
    </svg>
  );
}

function DetachIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 4h5v5M20 4l-9 9" />
      <path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
    </svg>
  );
}

function DeskIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3a9 9 0 0 0 0 18" />
      <path d="M12 8.8a3.2 3.2 0 0 0 0 6.4" />
    </svg>
  );
}

interface BridgeDeck {
  getState(): Promise<DeckState>;
  open(): void;
  close(): void;
  answer(id: string, choice: string): Promise<boolean>;
  action(name: string, arg?: string): Promise<boolean>;
  /** The thread under a relay message — the per-agent direct chat read path. */
  relayThread(messageId: string): Promise<RelayRow[]>;
}

function bridgeDeck(): BridgeDeck | null {
  const bridge = window.deskBridge as unknown as {
    deck?: BridgeDeck;
  } | undefined;
  return bridge?.deck ?? null;
}

function bridgeSubscribe(listener: (event: Record<string, unknown>) => void): () => void {
  const bridge = window.deskBridge as unknown as {
    subscribe?: (l: (event: Record<string, unknown>) => void) => () => void;
  } | undefined;
  if (!bridge?.subscribe) return () => {};
  try {
    return bridge.subscribe(listener);
  } catch {
    return () => {};
  }
}

const URGENCY_TONE: Record<string, string> = {
  critical: '#ff5d5d',
  high: '#ff9f43',
  normal: '#7aa2ff',
  low: '#5d7f8f',
};

function urgencyTone(urgency: string): string {
  return URGENCY_TONE[urgency] ?? URGENCY_TONE.normal;
}

function RelaySection({
  relay,
  channel,
  nowMs,
  onPost,
}: {
  relay: DeckState['relay'];
  channel: string;
  nowMs: number;
  onPost: (text: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    onPost(text);
  };
  return (
    <section className="deck-section" aria-label="Relay">
      <h2 className="deck-section-head">
        <span className="deck-section-icon"><ChatIcon /></span>
        {channel} — the sessions' channel
      </h2>
      <div className="deck-relay-compose">
        <input
          className="deck-relay-input"
          placeholder={`Post to ${channel}…`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit();
          }}
        />
        <button className="deck-btn deck-btn-primary" title={`Post to ${channel} — visible to every connected session`} onClick={submit}>Send</button>
      </div>
      {relay.length === 0 ? (
        <p className="deck-empty">Relay unavailable or quiet — nothing recent in {channel}.</p>
      ) : (
        relay.map((row, index) => (
          <div className="deck-relay-row" key={`${row.at}-${index}`}>
            <span className="deck-relay-author">{row.author || 'unknown'}</span>
            <span className="deck-relay-age">{formatAge(row.at, nowMs)}</span>
            <p className="deck-relay-text">{row.text}</p>
          </div>
        ))
      )}
    </section>
  );
}

/** The per-agent DIRECT chat pane (owner ask 2026-08-25): the relay thread
 *  under the agent's most recent #agents message IS the conversation — one
 *  agent at a time, composed with the same chrome as the group feed. */
function AgentChatPane({
  agent,
  rows,
  nowMs,
  onSend,
  onClose,
}: {
  agent: string;
  rows: RelayRow[];
  nowMs: number;
  onSend: (text: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState('');
  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    onSend(text);
  };
  return (
    <section className="deck-section" aria-label={`Chat with ${agent}`}>
      <h2 className="deck-section-head">
        <span className="deck-section-icon"><ChatIcon /></span>
        <span className="deck-row-label" title={`Direct conversation with ${agent}`}>
          Chat with {agent}
        </span>
        <button
          className="deck-icon-btn deck-close-inline"
          aria-label="Close chat"
          title="Close this chat"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </h2>
      {rows.length === 0 ? (
        <p className="deck-empty">
          Nothing yet — send a message and {agent} answers here. The group chat
          is the {`#agents`} feed below.
        </p>
      ) : (
        rows.map((row, index) => (
          <div className="deck-relay-row" key={`${row.id ?? 'chat'}-${index}`}>
            <span className="deck-relay-author">{row.author}</span>
            <span className="deck-relay-age">{formatAge(row.at, nowMs)}</span>
            <p className="deck-relay-text">{row.text}</p>
          </div>
        ))
      )}
      <div className="deck-relay-compose">
        <input
          className="deck-relay-input"
          placeholder={`Talk to ${agent}…`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit();
          }}
        />
        <button
          className="deck-btn deck-btn-primary"
          title={`Send to ${agent}`}
          onClick={submit}
        >
          Send
        </button>
      </div>
    </section>
  );
}

/** One listing from the Aitherium marketplace (the subset the desk renders). */
interface MarketListing {
  id: string;
  name?: string;
  listing_type?: string;
  short_description?: string;
  description?: string;
  url?: string;
  pricing?: { model?: string; cost_per_unit?: number; unit_label?: string };
  tags?: string[];
}

function ModelsMarketSection({
  characters,
  activeCharacter,
  agentCharacters,
  onAction,
}: {
  characters: string[];
  activeCharacter: string;
  agentCharacters: Record<string, string>;
  onAction: (name: string, arg?: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [market, setMarket] = useState<{
    ok: boolean;
    listings: MarketListing[];
    reason?: string;
  }>({ ok: false, listings: [] });
  const [marketBusy, setMarketBusy] = useState(false);

  const runMarket = useCallback((q: string) => {
    const deck = window.deskBridge as unknown as {
      deck?: { marketBrowse?: (q: string) => Promise<typeof market> };
    } | undefined;
    if (!deck?.deck?.marketBrowse) return;
    setMarketBusy(true);
    void deck.deck.marketBrowse(q).then((res) => {
      setMarket(res ?? { ok: false, listings: [], reason: 'unreachable' });
      setMarketBusy(false);
    });
  }, []);

  useEffect(() => {
    runMarket('');
  }, [runMarket]);

  const needle = query.trim().toLowerCase();
  const filtered = characters.filter((c) => c.toLowerCase().includes(needle));
  const ownedBy = (name: string) => {
    const agent = Object.entries(agentCharacters).find(([, c]) => c === name);
    return agent ? agent[0] : '';
  };
  const price = (l: MarketListing) => {
    const p = l.pricing;
    if (!p) return 'free';
    if (p.model === 'free') return 'free';
    return `${p.cost_per_unit ?? '?'}${p.unit_label ? `/${p.unit_label}` : ''}${p.model ? ` · ${p.model}` : ''}`;
  };

  return (
    <section className="deck-section" aria-label="Models and market">
      <h2 className="deck-section-head">
        <span className="deck-section-icon"><ChipIcon /></span>
        Models &amp; market
      </h2>
      <input
        className="deck-relay-input"
        placeholder="Filter characters… or search the aitherium market"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') runMarket(query.trim());
        }}
      />
      <p className="deck-empty">
        Installed — {filtered.length} of {characters.length} characters
      </p>
      {filtered.slice(0, 40).map((name) => {
        const owner = ownedBy(name);
        return (
          <button
            key={name}
            className="deck-row"
            title={owner
              ? `Switch the desk to ${name} (assigned to ${owner})`
              : `Switch the desk to ${name}`}
            onClick={() => onAction('switch-character', name)}
          >
            <span className="deck-row-label">
              {name}
              {owner ? <span className="deck-card-age"> · {owner}</span> : null}
            </span>
            {name === activeCharacter ? (
              <span className="deck-count-live">active</span>
            ) : null}
          </button>
        );
      })}
      {filtered.length > 40 ? (
        <p className="deck-empty">+{filtered.length - 40} more — narrow the filter</p>
      ) : null}
      <p className="deck-empty">
        Aitherium market {marketBusy ? '— searching…' : market.ok ? `— ${market.listings.length} packs` : `— ${market.reason ?? 'unreachable'}`}
      </p>
      {market.listings.slice(0, 10).map((l) => (
        <div className="deck-row deck-row-static" key={l.id}>
          <span className="deck-row-label">
            {l.name ?? l.id}
            <span className="deck-card-age"> · {l.listing_type ?? 'pack'} · {price(l)}</span>
          </span>
          <button
            className="deck-chip"
            title={l.short_description ?? l.description ?? ''}
            onClick={() => l.url && onAction('market-open', l.url)}
          >
            Open
          </button>
        </div>
      ))}
    </section>
  );
}

/** The panel-side drag-mode toggle — same state plane as the bead
 *  (useDragMode), so both surfaces always agree. Default rotate; move is one
 *  labeled click away, and the row's label names the CURRENT mode so nothing
 *  is ever a hidden modifier again. */
function DragModeRow() {
  const mode = useDragMode();
  return (
    <button
      className="deck-row"
      title={mode === 'rotate'
        ? 'Plain drag rotates the camera. Click to make plain drag MOVE the avatar instead.'
        : 'Plain drag moves the avatar. Click to make plain drag ROTATE the camera instead.'}
      onClick={() => setDragMode(mode === 'rotate' ? 'move' : 'rotate')}
    >
      <span className="deck-row-icon"><MonitorIcon /></span>
      <span className="deck-row-label">Drag mode: {mode === 'rotate' ? 'Rotate' : 'Move'} — click to switch</span>
    </button>
  );
}

function ChevronLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 5l-7 7 7 7" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 5l7 7-7 7" />
    </svg>
  );
}

/** Flip THROUGH the cards one at a time instead of scrolling a stack — the
 *  owner's words: "you flip through them" (2026-08-25). One card owns the
 *  stage; prev/next arrows page through; the pop-out button spawns that card's
 *  own Tk answer window (awask window <id>), so the pop-up action cards stay
 *  reachable FROM the desk rather than living on a separate surface. */
function CardFlipper({
  cards,
  nowMs,
  onAnswer,
  onPopout,
}: {
  cards: DeckDecision[];
  nowMs: number;
  onAnswer: (id: string, choice: string) => void;
  onPopout: (id: string) => void;
}) {
  const [index, setIndex] = useState(0);
  // An answered card shrinks the list; keep the index legal and on the SAME
  // visual position (the next card slides into view).
  const clamped = Math.min(index, Math.max(0, cards.length - 1));
  const card = cards[clamped];
  return (
    <div className="deck-flipper">
      <div className="deck-flipper-nav">
        <button
          className="deck-icon-btn"
          title="Previous card"
          disabled={clamped === 0}
          onClick={() => setIndex(Math.max(0, clamped - 1))}
        >
          <ChevronLeftIcon />
        </button>
        <span className="deck-flipper-count">
          {clamped + 1} of {cards.length}
        </span>
        <button
          className="deck-icon-btn"
          title="Next card"
          disabled={clamped >= cards.length - 1}
          onClick={() => setIndex(Math.min(cards.length - 1, clamped + 1))}
        >
          <ChevronRightIcon />
        </button>
        <button
          className="deck-chip deck-flipper-popout"
          title="Open this card in its own pop-out answer window"
          onClick={() => onPopout(card.id)}
        >
          Pop out
        </button>
      </div>
      <DecisionRow card={card} nowMs={nowMs} onAnswer={onAnswer} />
    </div>
  );
}

function DecisionRow({
  card,
  nowMs,
  onAnswer,
}: {
  card: DeckDecision;
  nowMs: number;
  onAnswer: (id: string, choice: string) => void;
}) {
  const primary = primaryChoice(card);
  const secondary = secondaryChoice(card);
  const where = cardWhere(card);
  return (
    <article className="deck-card">
      <header className="deck-card-head">
        <span className="deck-urgency-dot" style={{ background: urgencyTone(card.urgency) }} />
        <h3 className="deck-card-title">{card.title}</h3>
        <time className="deck-card-age">{formatAge(card.createdAt, nowMs)}</time>
      </header>
      {card.summary ? <p className="deck-card-summary">{card.summary}</p> : null}
      {where ? <p className="deck-card-where">{where}</p> : null}
      <footer className="deck-card-actions">
        {primary ? (
          <button
            className="deck-btn deck-btn-primary"
            title={`Answer "${primary.label}" — recorded, and the asking session is told right away`}
            onClick={() => onAnswer(card.id, primary.key)}
          >
            {primary.label}
          </button>
        ) : (
          <button
            className="deck-btn deck-btn-primary"
            title="Open this card in the full answer window"
            onClick={() => void bridgeDeck()?.action('popup')}
          >
            Open answer window
          </button>
        )}
        {secondary ? (
          <button
            className="deck-btn"
            title={`Answer "${secondary.label}" instead`}
            onClick={() => onAnswer(card.id, secondary.key)}
          >
            {secondary.label}
          </button>
        ) : null}
      </footer>
    </article>
  );
}

/**
 * System awareness (#9): one panel over the five snapshot sources main
 * serves (system / voice / vision / desktop / connect). Every source fails
 * soft by contract — an unavailable backend renders its reason, never a
 * broken panel.
 */
type SnapshotSource = Record<string, unknown> | null | undefined;
interface AwarenessState {
  ok: boolean;
  system?: SnapshotSource;
  agents?: SnapshotSource;
  status?: SnapshotSource;
  window?: SnapshotSource;
  context?: SnapshotSource;
  workspace?: SnapshotSource;
  terminals?: { total?: number; note?: string } | null;
  reason?: string;
}

function noteOf(src: SnapshotSource): string {
  if (!src || typeof src !== 'object') return '';
  const note = (src as Record<string, unknown>).note;
  return typeof note === 'string' ? note : '';
}

function SystemSection() {
  const [awareness, setAwareness] = useState<Record<string, AwarenessState | undefined>>({});
  const [busy, setBusy] = useState(false);

  const runAwareness = useCallback(() => {
    const bridge = window.deskBridge as unknown as {
      system?: {
        snapshot?: () => Promise<AwarenessState>;
        voice?: () => Promise<AwarenessState>;
        vision?: () => Promise<AwarenessState>;
        desktop?: () => Promise<AwarenessState>;
        connect?: () => Promise<AwarenessState>;
      };
    } | undefined;
    if (!bridge?.system) return;
    setBusy(true);
    const guard = (name: string) => (res: AwarenessState | undefined) => {
      setAwareness((prev) => ({ ...prev, [name]: res ?? { ok: false, reason: 'unreachable' } }));
    };
    void bridge.system.snapshot?.().then(guard('system')).finally(() => setBusy(false));
    void bridge.system.voice?.().then(guard('voice'));
    void bridge.system.vision?.().then(guard('vision'));
    void bridge.system.desktop?.().then(guard('desktop'));
    void bridge.system.connect?.().then(guard('connect'));
  }, []);

  useEffect(() => {
    runAwareness();
  }, [runAwareness]);

  const sys = awareness.system;
  const voice = awareness.voice;
  const vision = awareness.vision;
  const desktop = awareness.desktop;
  const connect = awareness.connect;

  const systemObj = sys?.system as { services?: unknown[] } | null | undefined;
  const agentsObj = sys?.agents as { activities?: unknown[] } | null | undefined;
  const serviceCount = Array.isArray(systemObj?.services)
    ? systemObj.services.length
    : systemObj && typeof systemObj === 'object' && !noteOf(systemObj)
      ? Object.keys(systemObj).length
      : '?';
  const agentsCount = Array.isArray(agentsObj?.activities)
    ? agentsObj.activities.length
    : agentsObj && typeof agentsObj === 'object' && !noteOf(agentsObj)
      ? Object.keys(agentsObj).length
      : '?';

  const voiceLine = (() => {
    if (!voice?.ok) return `unreachable — ${voice?.reason ?? ''}`;
    const status = voice.status as { status?: string; error?: string } | null | undefined;
    if (status?.status === 'error') return `down — ${status.error ?? 'service error'}`;
    const note = noteOf(voice.status as SnapshotSource);
    if (note) return note;
    return 'up';
  })();

  const visionLine = (() => {
    if (!vision?.ok) return `unreachable — ${vision?.reason ?? ''}`;
    const error = (vision.status as { error?: string } | null | undefined)?.error;
    if (error) return `down — ${error}`;
    const note = noteOf(vision.status as SnapshotSource);
    if (note) return note;
    return 'up';
  })();

  const desktopLine = (() => {
    if (!desktop?.ok) return `unreachable — ${desktop?.reason ?? ''}`;
    const win = desktop.window as
      | { available?: boolean; process?: string; title?: string; message?: string; reason?: string }
      | null | undefined;
    if (win?.available === false) {
      return `unavailable — ${win.message ?? win.reason ?? 'platform'}`;
    }
    const winNote = noteOf(desktop.window as SnapshotSource);
    if (winNote) return winNote;
    if (win?.process) return `${win.process}${win.title ? ` — ${win.title}` : ''}`;
    return 'no window data';
  })();

  const connectLine = (() => {
    if (!connect?.ok) return `unreachable — ${connect?.reason ?? ''}`;
    const ws = connect.workspace as { profile?: string | null } | null | undefined;
    const wsNote = noteOf(connect.workspace as SnapshotSource);
    if (wsNote) return wsNote;
    const profile = ws?.profile ?? 'no active workspace profile';
    const tt = connect.terminals?.total ?? 0;
    const ttNote = connect.terminals?.note;
    return `${profile} · ${tt} terminal session(s)${ttNote ? ` — ${ttNote}` : ''}`;
  })();

  return (
    <section className="deck-section" aria-label="System awareness">
      <h2 className="deck-section-head">
        <span className="deck-section-icon"><MonitorIcon /></span>
        System awareness
        <button
          className="deck-chip"
          title="Refresh every awareness source"
          onClick={() => runAwareness()}
          disabled={busy}
        >
          {busy ? '…' : 'Refresh'}
        </button>
      </h2>
      <div className="deck-row deck-row-static">
        <span className="deck-row-label">System</span>
        <span className="deck-row-label">{serviceCount} service key(s) · {agentsCount} agent activity key(s)</span>
      </div>
      <div className="deck-row deck-row-static">
        <span className="deck-row-label">Voice</span>
        <span className="deck-row-label">{voiceLine}</span>
      </div>
      <div className="deck-row deck-row-static">
        <span className="deck-row-label">Vision</span>
        <span className="deck-row-label">{visionLine}</span>
      </div>
      <div className="deck-row deck-row-static">
        <span className="deck-row-label">Desktop</span>
        <span className="deck-row-label">{desktopLine}</span>
      </div>
      <div className="deck-row deck-row-static">
        <span className="deck-row-label">Workspace</span>
        <span className="deck-row-label">{connectLine}</span>
      </div>
    </section>
  );
}

export function Deck() {
  const [state, setState] = useState<DeckState>(EMPTY_DECK_STATE);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const answering = useRef<Set<string>>(new Set());
  // The per-agent DIRECT chat (owner ask 2026-08-25): one open conversation at
  // a time, anchored on the agent's most recent #agents message — the relay
  // thread under it IS the conversation (no per-agent channels exist).
  const [chatTarget, setChatTarget] = useState<string | null>(null);
  const [chatRootId, setChatRootId] = useState<string | null>(null);
  const [chatRows, setChatRows] = useState<RelayRow[]>([]);

  useEffect(() => {
    const deck = bridgeDeck();
    if (!deck) return;
    let alive = true;
    void deck.getState().then((next) => {
      if (alive && next) setState(next);
    });
    const unsubscribe = bridgeSubscribe((event) => {
      if (event.type === 'deck-state') {
        setState({
          decisions: (event.decisions as DeckDecision[]) ?? [],
          openCount: (event.openCount as number) ?? 0,
          deskVisible: (event.deskVisible as boolean) ?? false,
          slots: (event.slots as DeckState['slots']) ?? [],
          agents: (event.agents as string[]) ?? [],
          characters: (event.characters as string[]) ?? [],
          activeCharacter: (event.activeCharacter as string) ?? '',
          agentCharacters: (event.agentCharacters as Record<string, string>) ?? {},
          relay: (event.relay as DeckState['relay']) ?? [],
          relayChannel: (event.relayChannel as string) ?? '#agents',
        });
      }
    });
    const tick = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => {
      alive = false;
      unsubscribe();
      window.clearInterval(tick);
    };
  }, []);

  const handleAnswer = useCallback((id: string, choice: string) => {
    if (answering.current.has(id)) return; // one click per card per render
    answering.current.add(id);
    // Optimistic removal — the watcher will confirm (or correct) on the next
    // deck-state push, so a slow awask spawn cannot make the button lie.
    setState((current) => ({
      ...current,
      decisions: current.decisions.filter((c) => c.id !== id),
      openCount: Math.max(0, current.openCount - 1),
    }));
    void bridgeDeck()?.answer(id, choice).then(() => {
      answering.current.delete(id);
    });
  }, []);

  const runAction = useCallback((name: string, arg?: string) => {
    void bridgeDeck()?.action(name, arg);
  }, []);

  /** Open the per-agent DIRECT chat: the relay thread under the agent's most
   *  recent #agents message IS the conversation (no per-agent channels
   *  exist; the group chat is #agents itself). Falls back to the agent's own
   *  feed messages when it has no thread yet. */
  const openChat = useCallback((agent: string) => {
    setChatTarget(agent);
    const agentRows = state.relay
      .filter((row) => row.agent && (row.author === agent || row.author.startsWith(`${agent}+`)))
      .sort((a, b) => b.at - a.at);
    const newest = agentRows[0] ?? null;
    const rootId = newest?.id ?? null;
    setChatRootId(rootId);
    setChatRows(newest ? [newest] : []);
    if (rootId) {
      void bridgeDeck()
        ?.relayThread(rootId)
        .then((rows) => setChatRows(rows.length > 0 ? rows : [newest]))
        .catch(() => {});
    }
  }, [state.relay]);

  /** Send one message in the open direct chat: a thread-reply when an anchor
   *  message exists, else a plain channel post mentioning the agent (the
   *  agent's next message becomes the anchor on refresh). */
  const sendChat = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !chatTarget) return;
    setChatRows((rows) => [
      ...rows,
      {
        channel: state.relayChannel,
        author: 'you',
        text: trimmed,
        at: Math.floor(Date.now() / 1000),
        id: null,
        threadId: chatRootId,
        replyCount: 0,
        agent: false,
      },
    ]);
    if (chatRootId) {
      runAction(
        'relay-thread-reply',
        JSON.stringify({ channel: state.relayChannel, messageId: chatRootId, text: trimmed }),
      );
      // The relay accepts asynchronously — refetch the thread once the post
      // has had time to land, so the agent's reply appears here too.
      window.setTimeout(() => {
        void bridgeDeck()
          ?.relayThread(chatRootId)
          .then((rows) => setChatRows(rows))
          .catch(() => {});
      }, 800);
    } else {
      runAction('relay-post', `@${chatTarget} ${trimmed}`);
    }
  }, [chatRootId, chatTarget, runAction, state.relayChannel]);

  return (
    <main className="deck">
      <header className="deck-header">
        <span className="deck-header-icon"><DeskIcon /></span>
        <h1 className="deck-title">Desk</h1>
        <span className={`deck-count ${state.openCount > 0 ? 'deck-count-live' : ''}`}>
          {state.openCount > 0 ? `${state.openCount} waiting` : 'all clear'}
        </span>
        <button
          className="deck-close"
          aria-label="Close panel"
          title="Close this panel (right-click a bead or the avatar to reopen it)"
          onClick={() => bridgeDeck()?.close()}
        >
          <CloseIcon />
        </button>
      </header>

      <div className="deck-body">
        {/* Ordering IS the UX: quick actions come FIRST (the owner had to scroll
            past relay + notifications to reach them -- "you have to scroll all
            the way down to get to quick actions", 2026-08-25). Scroll-heavy
            content (the relay feed) goes last; the terminal action (quit) sits
            at the very bottom where a destructive button belongs. */}
        <section className="deck-section" aria-label="Quick actions">
          <h2 className="deck-section-head">
            <span className="deck-section-icon"><GridIcon /></span>
            Quick actions
          </h2>
          <button className="deck-row" title="Open a chat with Aither" onClick={() => runAction('talk')}>
            <span className="deck-row-icon"><ChatIcon /></span>
            <span className="deck-row-label">Talk to Aither</span>
          </button>
          <button className="deck-row" title="Open the model browser" onClick={() => runAction('models')}>
            <span className="deck-row-icon"><ChipIcon /></span>
            <span className="deck-row-label">Browse models</span>
          </button>
          <button className="deck-row" title="Agent packs and avatars on aitherium" onClick={() => runAction('marketplace')}>
            <span className="deck-row-icon"><GridIcon /></span>
            <span className="deck-row-label">Agent marketplace</span>
          </button>
          <button className="deck-row" title="Open the decision queue window" onClick={() => runAction('popup')}>
            <span className="deck-row-icon"><TerminalIcon /></span>
            <span className="deck-row-label">Decision queue (answer window)</span>
          </button>
          <button className="deck-row" title="Show or hide the floating beads on your desktop" onClick={() => runAction('toggle-desk')}>
            <span className="deck-row-icon"><MonitorIcon /></span>
            <span className="deck-row-label">
              {state.deskVisible ? 'Hide the desk' : 'Show the desk'}
            </span>
          </button>
          <div className="deck-row deck-row-static">
            <span className="deck-row-label">Avatar window size</span>
            <button className="deck-chip" title="Shrink the avatar window" onClick={() => runAction('shrink')}>Smaller</button>
            <button className="deck-chip" title="Enlarge the avatar window" onClick={() => runAction('grow')}>Bigger</button>
          </div>
          <button className="deck-row" title="Reset the avatar layout and reload — clears every saved position and size, back to default placement" onClick={() => runAction('reset-layout')}>
            <span className="deck-row-icon"><DeskIcon /></span>
            <span className="deck-row-label">Reset avatar layout</span>
          </button>
          <button className="deck-row" title="Show or hide a dashed boundary around the avatar window so you can see its edges while arranging it" onClick={() => runAction('toggle-window-outline')}>
            <span className="deck-row-icon"><MonitorIcon /></span>
            <span className="deck-row-label">Show window boundaries</span>
          </button>
          <DragModeRow />
        </section>

        <section className="deck-section" aria-label="Notifications">
          <h2 className="deck-section-head">
            <span className="deck-section-icon"><BellIcon /></span>
            Notifications
          </h2>
          {state.decisions.length === 0 ? (
            <p className="deck-empty">Nothing waiting — every session is unblocked.</p>
          ) : (
            <CardFlipper
              cards={state.decisions}
              nowMs={nowMs}
              onAnswer={handleAnswer}
              onPopout={(id) => runAction('popout-card', id)}
            />
          )}
          <button
            className="deck-row"
            title="Opens Living Desktop with the notification area"
            onClick={() => runAction('living-desktop')}
          >
            <span className="deck-row-icon"><MonitorIcon /></span>
            <span className="deck-row-label">Show the notification area in Living Desktop</span>
          </button>
        </section>

        <SystemSection />

        <section className="deck-section" aria-label="Avatars">
          <h2 className="deck-section-head">
            <span className="deck-section-icon"><DeskIcon /></span>
            Avatars
          </h2>
          <p className="deck-empty">
            Fleet: {state.agents.length} agents on the roster · {state.characters.length} characters installed
          </p>
          {state.slots.length === 0 ? (
            <p className="deck-empty">Just the default character on screen.</p>
          ) : (
            state.slots.map((slot) => (
              <div className="deck-row deck-row-static" key={slot.slotId}>
                {/* The label ellipsizes in CSS; the title keeps the full name one
                    hover away instead of truncating it with no way to read it. */}
                <span
                  className="deck-row-label"
                  title={slot.agent ? `${slot.agent} — ${slot.name}` : slot.name}
                >
                  {slot.agent ? `${slot.agent} — ${slot.name}` : slot.name}
                </span>
                {slot.agent ? (
                  <button
                    className="deck-icon-btn"
                    title={`Chat with ${slot.agent} — the conversation lives as the relay thread under this agent's messages`}
                    onClick={() => openChat(slot.agent)}
                  >
                    <ChatIcon />
                  </button>
                ) : null}
                <button
                  className="deck-icon-btn"
                  title="Detach to own window"
                  onClick={() => runAction('detach-slot', slot.slotId)}
                >
                  <DetachIcon />
                </button>
                <button
                  className="deck-icon-btn deck-icon-btn-danger"
                  title="Remove avatar"
                  onClick={() => runAction('remove-slot', slot.slotId)}
                >
                  <TrashIcon />
                </button>
              </div>
            ))
          )}
          <p className="deck-empty">Add an agent's avatar to the scene:</p>
          {/* No 12-chip cap: the roster is 13 and chips wrap, so the cap only ever
              hid the LAST agent (viviane) behind a "+1 more" badge for no reason. */}
          <div className="deck-chips">
            {state.agents.map((agent) => (
              <button
                key={agent}
                className="deck-chip"
                title={state.agentCharacters[agent]
                  ? `Spawn ${agent} (avatar: ${state.agentCharacters[agent]})`
                  : `Spawn ${agent}`}
                onClick={() => runAction('spawn-agent', agent)}
              >
                {agent}
                {state.agentCharacters[agent] ? (
                  <span className="deck-chip-avatar"> · {state.agentCharacters[agent]}</span>
                ) : null}
              </button>
            ))}
          </div>
        </section>

        {chatTarget ? (
          <AgentChatPane
            agent={chatTarget}
            rows={chatRows}
            nowMs={nowMs}
            onSend={sendChat}
            onClose={() => setChatTarget(null)}
          />
        ) : null}

        <ModelsMarketSection
          characters={state.characters}
          activeCharacter={state.activeCharacter}
          agentCharacters={state.agentCharacters}
          onAction={runAction}
        />

        <RelaySection
          relay={state.relay}
          channel={state.relayChannel}
          nowMs={nowMs}
          onPost={(text) => runAction('relay-post', text)}
        />

        <section className="deck-section" aria-label="Desk">
          <h2 className="deck-section-head">
            <span className="deck-section-icon"><MonitorIcon /></span>
            Desk
          </h2>
          <button className="deck-row deck-row-danger" title="Quit Desk entirely — tray icon and all windows close" onClick={() => runAction('quit')}>
            <span className="deck-row-label">Quit Desk</span>
          </button>
        </section>
      </div>

      <footer className="deck-footer">
        desk · decision cards: {state.openCount}
      </footer>
    </main>
  );
}
