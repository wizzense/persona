import {
  useCallback, useEffect, useMemo, useRef, useState,
  type CSSProperties, type DragEvent, type HTMLAttributes, type ReactNode,
} from 'react';

import { renderVrmThumbnail } from '../thumbnails';
import { bulkApi, deckStateFromPush } from './decisions/bridge';
import { DecisionsPage } from './decisions/DecisionsPage';
import { ageBucket, type DecisionCard } from './decisions/model';
import { SystemAwareness } from './decisions/SystemAwareness';
import './decisions/decisions.css';
import {
  EMPTY_DECK_STATE,
  clockLabel,
  clockTone,
  formatAge,
  normalizeWakes,
  cardLabel,
  dueLabel,
  reasonLabel,
  staleLabel,
  wakeActionMessage,
  wakeAgeLabel,
  wakeBadge,
  type DeckState,
  type RelayRow,
  type WakeActionResult,
  type WakeRow,
} from '../deck/deck-types';

/**
 * The Desk panel — the "full UI/UX" that opens on right-click (owner redesign
 * 2026-08-25: floating beads instead of nested menus). Loaded by the same
 * bundle with `?deck=1`; every action routes through main's deck IPC, which
 * reuses the same functions the old menus used, so the panel is a VIEW, not a
 * second implementation.
 */

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
  /** Most verbs answer a boolean; the wake verbs answer the daemon's
   *  {ok, detail, exitCode, started, pid} so the row can say what happened. */
  action(name: string, arg?: string): Promise<boolean | WakeActionResult>;
  /** The thread under a relay message — the per-agent direct chat read path. */
  relayThread(messageId: string): Promise<RelayRow[]>;
}

function bridgeDeck(): BridgeDeck | null {
  const bridge = window.deskBridge as unknown as {
    deck?: BridgeDeck;
  } | undefined;
  return bridge?.deck ?? null;
}

/** The drop bridge is a top-level deskBridge method (preload), not part of
 *  deck. */
function bridgeFileDropped(file: File): Promise<DropVerdict> {
  const bridge = window.deskBridge as unknown as {
    fileDropped?: (f: File) => Promise<DropVerdict>;
  } | undefined;
  if (!bridge?.fileDropped) return Promise.resolve({ ok: false, reason: 'drop bridge unavailable' });
  try {
    return bridge.fileDropped(file);
  } catch {
    return Promise.resolve({ ok: false, reason: 'drop bridge unavailable' });
  }
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

/** The inbox's sub-pages. Decisions own the scroll; messages, wakes and the
 *  awareness panel sit behind their own tabs instead of stacking under 300 cards. */
type InboxTab = 'decisions' | 'messages' | 'wakes' | 'system';

/** `?card=<id>` — the console reloads the Inbox pane with it (console.html) so
 *  "show me THIS card" opens the list with that card expanded. Read once. */
function focusCardFromUrl(): string | null {
  try {
    const id = new URLSearchParams(window.location.search).get('card');
    return id ? id : null;
  } catch {
    return null;
  }
}

/** WAKES — awrise's scheduled jobs.
 *
 * Order matters here, and it is the point of the section: the CLOCK line comes
 * before any job row. A list of enabled jobs with a silent clock looks healthy
 * and is not, and that is the failure this pane exists to catch. The staleness
 * chip comes first of all, because rows from a snapshot taken an hour ago must
 * never be read as live.
 *
 * Every action goes to main -> the harness daemon. The pane spawns nothing and
 * parses no scheduler state: one reader, one semantics, every surface.
 */
function WakesSection({
  wakes,
  nowMs,
  notes,
  pending,
  onAction,
}: {
  wakes: DeckState['wakes'];
  nowMs: number;
  notes: Record<string, string>;
  pending: Set<string>;
  onAction: (verb: 'enable' | 'disable' | 'run', name: string) => void;
}) {
  const stale = wakes.source === 'stale';
  const live = wakes.source === 'daemon' && wakes.installed === true;
  const notice = stale
    ? staleLabel(wakes, nowMs)
    : wakes.installed === false
      ? 'awrise not installed — no scheduled jobs on this host.'
      : wakes.error
        ? wakes.error
        : wakes.source === 'none'
          ? 'Reading the scheduler…'
          : '';
  return (
    <section className="deck-section" aria-label="Wakes">
      <h2 className="deck-section-head">
        <span className="deck-section-icon"><ChipIcon /></span>
        Wakes
        {wakes.failing > 0 ? <span className="deck-section-count">{wakes.failing}</span> : null}
      </h2>
      {notice ? <p className="deck-empty">{notice}</p> : null}
      {/* The clock, BEFORE any row. */}
      {wakes.installed !== false && wakes.source !== 'none' ? (
        <p className={`deck-wake-clock deck-wake-clock-${clockTone(wakes)}`}>
          {clockLabel(wakes, nowMs)}
        </p>
      ) : null}
      {wakes.schema === 1 ? (
        <p className="deck-empty">
          {wakes.migration || 'the awrise job file is v1 — run `awrise list` on this host to migrate it'}
        </p>
      ) : null}
      {wakes.wakes.length === 0 ? (
        live ? <p className="deck-empty">No wakes scheduled.</p> : null
      ) : (
        wakes.wakes.map((wake: WakeRow) => {
          const badge = wakeBadge(wake);
          return (
            <div className="deck-wake-row" key={wake.name}>
              <span className={`deck-wake-badge deck-wake-${badge}`}>{badge}</span>
              <span className="deck-wake-text">
                <strong title={wake.run || wake.name}>{wake.name}</strong>
                <span className="deck-wake-meta">
                  {wake.every || (wake.at ? `at ${wake.at}` : 'no schedule')}
                  {' · '}
                  {wakeAgeLabel(wake, nowMs)}
                  {` · ${dueLabel(wake.nextDueAt, nowMs)}`}
                  {wake.consecutiveFailures > 0 ? ` · ${wake.consecutiveFailures}x failed` : ''}
                  {/* awrise raises the failing-streak card through the awask
                      ladder; naming its id ties this row to the card already
                      sitting in the Decisions section above. No card code here. */}
                  {wake.cardId ? ` · ${cardLabel(wake.cardId)}` : ''}
                </span>
                {/* The REASON, never truncated away entirely: the full text is
                    the title, so "failure" is always one hover from "why". */}
                {wake.lastReason ? (
                  <span className="deck-wake-reason" title={wake.lastReason}>
                    {wake.lastState ? `${wake.lastState} — ` : ''}
                    {reasonLabel(wake.lastReason).length > 60 ? `${reasonLabel(wake.lastReason).slice(0, 60)}…` : reasonLabel(wake.lastReason)}
                  </span>
                ) : null}
                {notes[wake.name] ? (
                  <span className="deck-wake-note">{notes[wake.name]}</span>
                ) : null}
              </span>
              <span className="deck-wake-actions">
                <button
                  className="deck-btn"
                  disabled={!live || pending.has(wake.name)}
                  title={wake.enabled ? 'Stop scheduling this wake' : 'Schedule this wake again'}
                  onClick={() => onAction(wake.enabled ? 'disable' : 'enable', wake.name)}
                >
                  {wake.enabled ? 'Disable' : 'Enable'}
                </button>
                <button
                  className="deck-btn deck-btn-primary"
                  disabled={!live || wake.running || pending.has(wake.name)}
                  title="Fire this wake once now — the schedule and the streak are unchanged"
                  onClick={() => onAction('run', wake.name)}
                >
                  Run now
                </button>
              </span>
            </div>
          );
        })
      )}
    </section>
  );
}

/**
 * One relay message. The KIND is a chip and the addressee a quiet "to ..." -- both
 * came out of the awrelay envelope main strips from the body (relay-feed.cjs
 * splitEnvelope); they used to be a line of raw JSON after every message. The body
 * is clamped to two lines for scanning and OPENS on click: a finding cut off at
 * "Ladder that answers this in 10 min: Stopping line = systemctl; n" with no way to
 * read the rest was a message the owner could not actually receive.
 */
function RelayRowView({ row, nowMs }: { row: RelayRow; nowMs: number }) {
  const [open, setOpen] = useState(false);
  const kind = (row.kind || '').toLowerCase();
  return (
    <div
      className={`deck-relay-row ${open ? 'deck-relay-row-open' : ''}`}
      role="button"
      tabIndex={0}
      title={open ? 'Click to collapse' : 'Click to read the whole message'}
      onClick={() => setOpen((value) => !value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpen((value) => !value); }
      }}
    >
      <span className="deck-relay-author">{row.author || 'unknown'}</span>
      {kind ? <span className={`deck-relay-kind deck-relay-kind-${kind}`}>{kind}</span> : null}
      {row.to && row.to.length ? <span className="deck-relay-to">to {row.to.join(', ')}</span> : null}
      <span className="deck-relay-age">{formatAge(row.at, nowMs)}</span>
      <p className="deck-relay-text">{row.text}</p>
    </div>
  );
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
        Messages — {channel}
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
          <RelayRowView key={`${row.id ?? row.at}-${index}`} row={row} nowMs={nowMs} />
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
  // ── Push-to-talk (2026-08-29) ──────────────────────────────────────
  // Mic button + Ctrl+Space toggle: capture -> gateway transcribe -> the
  // transcript is filled in and sent, so "talk to the avatar" is one click.
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const toggleTalk = useCallback(async () => {
    const bridge = (window as unknown as {
      deskBridge?: { voiceTranscribe?: (b64: string, fmt: string) => Promise<string> };
    }).deskBridge;
    if (!bridge?.voiceTranscribe) {
      setDraft('(voice bridge unavailable)');
      return;
    }
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const rec = new MediaRecorder(stream, { mimeType: mime });
      chunksRef.current = [];
      rec.ondataavailable = (event) => { if (event.data.size > 0) chunksRef.current.push(event.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunksRef.current, { type: mime });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        for (const b of bytes) binary += String.fromCharCode(b);
        const b64 = btoa(binary);
        setRecording(false);
        const text = await bridge.voiceTranscribe!(b64, "webm");
        if (text.startsWith("ERROR:")) {
          setDraft(text);
          return;
        }
        if (text.trim()) {
          setDraft(text.trim());
          // "Talk to the avatar": the transcript goes out immediately.
          onSend(text.trim());
        }
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch (error) {
      setDraft(`(mic unavailable: ${error instanceof Error ? error.message : String(error)})`);
    }
  }, [recording, onSend]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.code === "Space") {
        event.preventDefault();
        void toggleTalk();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleTalk]);
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
          <RelayRowView key={`${row.id ?? 'chat'}-${index}`} row={row} nowMs={nowMs} />
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
        <button
          className={`deck-btn ${recording ? "deck-btn-record" : "deck-btn-mic"}`}
          title={recording ? "Stop recording (Ctrl+Space)" : "Push to talk — click to record (Ctrl+Space)"}
          onClick={() => void toggleTalk()}
        >
          {recording ? "● Stop" : "🎤 Talk"}
        </button>
      </div>
    </section>
  );
}

/**
 * A failure reason the owner can actually read. `reason` is typed string, but main hands back
 * whatever failed, and an object in a template literal renders as "[object Object]" — which is
 * what the market row showed on a 404. A string stays itself; an Error or a
 * {message|error|reason} object yields its text; anything else becomes JSON. Capped, so a wall
 * of JSON cannot take the pane over.
 */
export function reasonText(reason: unknown, fallback = 'unreachable'): string {
  const cap = (s: string) => (s.length > 160 ? `${s.slice(0, 157)}…` : s);
  if (reason == null) return fallback;
  if (typeof reason === 'string') return cap(reason.trim() || fallback);
  if (typeof reason === 'number' || typeof reason === 'boolean') return String(reason);
  if (reason instanceof Error) return cap(reason.message || fallback);
  if (typeof reason === 'object') {
    const o = reason as Record<string, unknown>;
    for (const key of ['message', 'error', 'reason', 'detail', 'statusText']) {
      const v = o[key];
      if (typeof v === 'string' && v.trim()) return cap(v.trim());
    }
    try { return cap(JSON.stringify(reason)); } catch { return fallback; }
  }
  return fallback;
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

/** Stable per-character hue so the roster reads as tiles instead of a text
 *  dump: the same name always gets the same colour, across restarts and
 *  machines (owner, 2026-09-10: "just a long list of avatars… not pleasant"). */
function avatarHue(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return hash % 360;
}

/** One or two glyphs for the tile — the first letters of the first two
 *  slug segments ("fdl-1-0-vrm1---downloadable" -> "FD"), falling back to the
 *  first character for short or CJK names. */
function avatarInitials(name: string): string {
  const parts = name.split(/[-_\s]+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((part) => part[0]).join('');
  return (letters || name.slice(0, 2)).toUpperCase();
}

function ModelsMarketSection({
  characters,
  characterModels,
  activeCharacter,
  agentCharacters,
  onAction,
}: {
  characters: string[];
  characterModels: Record<string, string>;
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
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  const runMarket = useCallback((q: string) => {
    const deck = window.deskBridge as unknown as {
      deck?: { marketBrowse?: (q: string) => Promise<typeof market> };
    } | undefined;
    if (!deck?.deck?.marketBrowse) return;
    setMarketBusy(true);
    void deck.deck.marketBrowse(q).catch((err: unknown) => (
      { ok: false, listings: [], reason: reasonText(err) }
    )).then((res) => {
      setMarket(res ?? { ok: false, listings: [], reason: 'unreachable' });
      // a rejected bridge call is a reason too, not a silent empty grid
      setMarketBusy(false);
    });
  }, []);

  useEffect(() => {
    runMarket('');
  }, [runMarket]);

  // Real previews (owner, 2026-09-10): cached thumbnail if one exists, else
  // render the character's own model offscreen ONCE and store it beside the
  // model. Serialized by thumbnails.ts; failed names stay on the monogram
  // tile for this session rather than retrying in a loop.
  const previewsAttempted = useRef<Set<string>>(new Set());
  useEffect(() => {
    const bridge = window.deskBridge as unknown as {
      deck?: {
        characterThumb?: (name: string) => Promise<string | null>;
        saveCharacterThumb?: (name: string, dataUrl: string) => Promise<boolean>;
      };
    } | undefined;
    const api = bridge?.deck;
    if (!api?.characterThumb) return;
    let cancelled = false;
    for (const name of characters) {
      if (previewsAttempted.current.has(name)) continue;
      const modelUrl = characterModels[name];
      previewsAttempted.current.add(name);
      void (async () => {
        const cached = await api.characterThumb!(name).catch(() => null);
        if (cancelled) return;
        if (cached) {
          setThumbs((prev) => ({ ...prev, [name]: cached }));
          return;
        }
        if (!modelUrl) return;
        const rendered = await renderVrmThumbnail(name, modelUrl);
        if (cancelled || !rendered) return;
        setThumbs((prev) => ({ ...prev, [name]: rendered }));
        void api.saveCharacterThumb?.(name, rendered);
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [characters, characterModels]);

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
        <button
          className="deck-chip deck-add-character"
          title="Add a character — enroll a downloaded .vrm, get one from VRoid Hub, or open the characters folder"
          onClick={() => onAction('add-character')}
        >
          + Add
        </button>
      </p>
      {characters.length === 0 ? (
        <div className="deck-avatar-empty">
          <p>No characters yet — Desk ships none.</p>
          <button className="deck-chip" onClick={() => onAction('add-character')}>
            Get one from VRoid Hub…
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <p className="deck-empty">Nothing matches “{query.trim()}”.</p>
      ) : (
        <div className="deck-avatar-grid" role="list">
          {filtered.map((name) => {
            const owner = ownedBy(name);
            return (
              <button
                key={name}
                role="listitem"
                className={`deck-avatar-card${name === activeCharacter ? ' is-active' : ''}`}
                title={owner
                  ? `Switch the desk to ${name} (assigned to ${owner})`
                  : `Switch the desk to ${name}`}
                onClick={() => onAction('switch-character', name)}
              >
                <span
                  className="deck-avatar-tile"
                  style={{ '--avatar-hue': String(avatarHue(name)) } as CSSProperties}
                >
                  {thumbs[name] ? (
                    <img className="deck-avatar-img" src={thumbs[name]} alt="" draggable={false} />
                  ) : (
                    avatarInitials(name)
                  )}
                </span>
                <span className="deck-avatar-name">{name}</span>
                {owner ? <span className="deck-avatar-agent">{owner}</span> : null}
                {name === activeCharacter ? <span className="deck-avatar-live">active</span> : null}
              </button>
            );
          })}
        </div>
      )}
      <p className="deck-empty">
        Aitherium market {marketBusy ? '— searching…' : market.ok ? `— ${(market.listings ?? []).length} packs` : `— ${reasonText(market.reason)}`}
      </p>
      {(market.listings ?? []).slice(0, 10).map((l) => (
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


/**
 * The Console's two content panes, sharing ONE deck-state subscription.
 *
 * `inbox` is decisions, wakes and the agents' messages — what the bell, the tray badge and
 * the taskbar overlay open. `characters` is bodies: who is on the stage, the spawn chips and
 * the installed/market roster. They were one scroll until 2026-09-20; the owner's word for it
 * was "mixed", and the rail already separates NOW from PRESENCE.
 *
 * A view PROP, not a second component: the subscription below is ~80 lines of getState plus
 * the deck-state push, and two copies of it would drift or double-subscribe.
 */
export function Deck({ view = 'inbox' }: { view?: 'inbox' | 'characters' } = {}) {
  const isCharacters = view === 'characters';
  const [state, setState] = useState<DeckState>(EMPTY_DECK_STATE);
  const [tab, setTab] = useState<InboxTab>('decisions');
  const [focusId] = useState(focusCardFromUrl);
  // Feature-detected once: a preload without deck.bulk hides Dismiss.
  const [bulk] = useState(bulkApi);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const answering = useRef<Set<string>>(new Set());
  // The per-agent DIRECT chat (owner ask 2026-08-25): one open conversation at
  // a time, anchored on the agent's most recent #agents message — the relay
  // thread under it IS the conversation (no per-agent channels exist).
  const [chatTarget, setChatTarget] = useState<string | null>(null);
  const [chatRootId, setChatRootId] = useState<string | null>(null);
  const [chatRows, setChatRows] = useState<RelayRow[]>([]);
  // Drop-to-avatar (2026-08-29): the drag state + the verdict list. The
  // verdicts are LOCAL to this panel (the relay feed is where the agent
  // conversation continues — main posts the notice there itself).
  // Wake actions: the daemon's answer per job (an inline line under the row)
  // and the names with a mutation in flight, so a second click is ignored here
  // rather than relying on the daemon's 409 as the first line of defence.
  const [wakeNotes, setWakeNotes] = useState<Record<string, string>>({});
  const [wakePending, setWakePending] = useState<Set<string>>(() => new Set());
  const [dragOver, setDragOver] = useState(false);
  const [drops, setDrops] = useState<DropVerdict[]>([]);
  const [dropBusy, setDropBusy] = useState(false);

  /** Route one dropped File through main's MIME router; the verdict lands in
   *  the drop list (and, on success, main speaks it + posts it to #agents). */
  const handleDrop = useCallback((files: FileList | null) => {
    if (!files || files.length === 0 || dropBusy) return;
    const file = files[0]; // one at a time — sequential is honest about time
    setDropBusy(true);
    setDrops((current) => [
      { ok: false, name: file.name, reason: 'processing…' },
      ...current,
    ].slice(0, 12));
    void bridgeFileDropped(file).then((verdict) => {
      setDrops((current) => [
        verdict,
        ...current.filter((d) => d.name !== file.name),
      ].slice(0, 12));
    }).finally(() => setDropBusy(false));
  }, [dropBusy]);

  useEffect(() => {
    const deck = bridgeDeck();
    if (!deck) return;
    let alive = true;
    void deck.getState().then((next) => {
      // Same normalisation as the push path — the initial PULL carries main's
      // raw feed too, and skipping it here made the section render once with
      // undefined clock fields.
      if (alive && next) setState({ ...next, wakes: normalizeWakes(next.wakes) });
    });
    const unsubscribe = bridgeSubscribe((event) => {
      // A field missing from the push copy is dropped on the first push after
      // the initial pull — that copy lives in deckStateFromPush, under test.
      if (event.type === 'deck-state') setState(deckStateFromPush(event));
    });
    const tick = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => {
      alive = false;
      unsubscribe();
      window.clearInterval(tick);
    };
  }, []);

  // "Browse models" opens the deck at the TOP (quick actions first — the
  // 2026-08-25 ordering fix), but the Models & market section sits below
  // notifications and system awareness, so the button read as dead
  // (owner, 2026-08-27). Main sends scroll-to-section on that action;
  // scroll the section into view here.
  useEffect(() => {
    return bridgeSubscribe((event) => {
      if (event.type !== 'scroll-to-section') return;
      const label =
        event.section === 'models' ? 'Models and market' : String(event.section ?? '');
      if (!label) return;
      const el = document.querySelector(`[aria-label="${label}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
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

  /** Optimistic removal for the ids a bulk call handed to awask; the watcher's
   *  next deck-state push confirms or corrects, exactly like a single answer. */
  const handleBulkDone = useCallback((ids: string[]) => {
    const gone = new Set(ids);
    setState((current) => {
      const decisions = current.decisions.filter((c) => !gone.has(c.id));
      const removed = current.decisions.length - decisions.length;
      return {
        ...current,
        decisions,
        openCount: Math.max(0, current.openCount - removed),
        totalCount: current.totalCount === undefined ? undefined : Math.max(0, current.totalCount - removed),
      };
    });
  }, []);

  const runAction = useCallback((name: string, arg?: string) => {
    void bridgeDeck()?.action(name, arg);
  }, []);

  /** Fire one wake verb and SAY what came back. `run` answers 202 with a pid
   *  long before the wake finishes — reporting that as plain success would be
   *  the lie this line exists to prevent. */
  const handleWakeAction = useCallback((verb: 'enable' | 'disable' | 'run', name: string) => {
    setWakePending((current) => {
      if (current.has(name)) return current;
      const next = new Set(current);
      next.add(name);
      return next;
    });
    void bridgeDeck()
      ?.action(`wake-${verb}`, name)
      .then((result) => {
        setWakeNotes((current) => ({ ...current, [name]: wakeActionMessage(verb, result) }));
      })
      .catch(() => {
        setWakeNotes((current) => ({ ...current, [name]: `${verb} failed: the desk did not answer` }));
      })
      .finally(() => {
        setWakePending((current) => {
          const next = new Set(current);
          next.delete(name);
          return next;
        });
      });
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

  const drag = {
    onDragOver: (event: DragEvent) => {
      event.preventDefault();
      setDragOver(true);
    },
    onDragLeave: () => setDragOver(false),
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      setDragOver(false);
      handleDrop(event.dataTransfer.files);
    },
  };
  const dropOverlay = dragOver ? (
    <div className="deck-drop-overlay">
      <div className="deck-drop-overlay-box">
        <strong>Drop on Aither</strong>
        <span>I'll look at it, or put it in the knowledge base</span>
      </div>
    </div>
  ) : null;
  // Drop-to-avatar verdicts: newest first. The verdict line is the whole
  // feedback — images/audio get a description/transcript, docs get
  // chunk/entity counts, failures get the reason.
  const dropsSection = drops.length > 0 ? (
    <section className="deck-section" aria-label="Drops">
      <h2 className="deck-section-head">
        <span className="deck-section-icon"><DeskIcon /></span>
        Drops
      </h2>
      {drops.map((drop, index) => (
        <div className={`deck-drop-row ${drop.ok ? 'deck-drop-ok' : 'deck-drop-err'}`} key={`${drop.name}-${index}`}>
          <span className="deck-drop-kind">
            {drop.ok ? (drop.kind ?? 'file') : '✗'}
          </span>
          <span className="deck-drop-text">
            <strong>{drop.name}</strong>
            {drop.summary ? <span>{drop.summary}</span> : null}
            {drop.reason ? <span className="deck-drop-reason">{drop.reason}</span> : null}
          </span>
        </div>
      ))}
    </section>
  ) : null;

  if (!isCharacters) {
    return (
      <InboxPage
        state={state}
        nowMs={nowMs}
        tab={tab}
        onTab={setTab}
        focusId={focusId}
        bulk={bulk}
        drag={drag}
        overlay={dropOverlay}
        drops={dropsSection}
        onAnswer={handleAnswer}
        onBulkDone={handleBulkDone}
        runAction={runAction}
        wakes={(
          <WakesSection
            wakes={state.wakes}
            nowMs={nowMs}
            notes={wakeNotes}
            pending={wakePending}
            onAction={handleWakeAction}
          />
        )}
      />
    );
  }

  return (
    <main
      className="deck"
      {...drag}
    >
      {dropOverlay}
      <header className="deck-header">
        <span className="deck-header-icon"><DeskIcon /></span>
        <h1 className="deck-title">Characters</h1>
        <button
          className="deck-close"
          aria-label="Close panel"
          title="Close this panel"
          onClick={() => bridgeDeck()?.close()}
        >
          <CloseIcon />
        </button>
      </header>

      <div className="deck-body">
        {dropsSection}
        {/* The inbox (decisions, wakes, messages, awareness) is its own pane —
            InboxPage below; this view is bodies only (owner, 2026-09-20). */}
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
          characterModels={state.characterModels ?? {}}
          activeCharacter={state.activeCharacter}
          agentCharacters={state.agentCharacters}
          onAction={runAction}
        />
      </div>

      <footer className="deck-footer">
        characters · {state.slots.length} on stage · {state.characters.length} installed
      </footer>
    </main>
  );
}

/**
 * The Inbox pane (`?deck=1`), redesigned 2026-09-23 (owner: "completely redesign
 * all of this"). It showed "298 waiting · 1 of 302" and paged cards one at a
 * time, with wakes, #agents and five identical awareness errors stacked under
 * the card. Now: a page head with a one-line status, sub-tabs, and the
 * Decisions LIST (search, facets, bulk, keyboard) owning the scroll; messages,
 * wakes and awareness each behind their own tab.
 */
function InboxPage({
  state,
  nowMs,
  tab,
  onTab,
  focusId,
  bulk,
  drag,
  overlay,
  drops,
  wakes,
  onAnswer,
  onBulkDone,
  runAction,
}: {
  state: DeckState;
  nowMs: number;
  tab: InboxTab;
  onTab: (tab: InboxTab) => void;
  focusId: string | null;
  bulk: ReturnType<typeof bulkApi>;
  drag: Pick<HTMLAttributes<HTMLElement>, 'onDragOver' | 'onDragLeave' | 'onDrop'>;
  overlay: ReactNode;
  drops: ReactNode;
  wakes: ReactNode;
  onAnswer: (id: string, choice: string) => void;
  onBulkDone: (ids: string[]) => void;
  runAction: (name: string, arg?: string) => void;
}) {
  const cards = state.decisions as DecisionCard[];
  const status = useMemo(() => {
    const fyi = (state.totalCount ?? 0) - state.openCount;
    const today = cards.filter((c) => ageBucket(c.createdAt, nowMs) === 'today').length;
    const oldest = cards.reduce((min, c) => (c.createdAt && c.createdAt < min ? c.createdAt : min), Infinity);
    const parts = [state.openCount > 0 ? `${state.openCount} waiting` : 'all clear'];
    if (fyi > 0) parts.push(`${fyi} FYI`);
    if (cards.length > 0) parts.push(`${today} new today`);
    if (Number.isFinite(oldest)) parts.push(`oldest ${formatAge(oldest, nowMs)}`);
    return parts.join(' · ');
  }, [cards, nowMs, state.openCount, state.totalCount]);

  const tabs: Array<{ id: InboxTab; label: string; count: number; loud: boolean }> = [
    { id: 'decisions', label: 'Decisions', count: cards.length, loud: state.openCount > 0 },
    { id: 'messages', label: 'Messages', count: state.relay.length, loud: false },
    { id: 'wakes', label: 'Wakes', count: state.wakes.failing || state.wakes.wakes.length, loud: state.wakes.failing > 0 },
    { id: 'system', label: 'System', count: 0, loud: false },
  ];

  return (
    <main className="dx-shell" {...drag}>
      {overlay}
      <header className="dx-head">
        <h1>Decisions</h1>
        <span className="dx-sub" role="status">{status}</span>
        <span className="dx-grow" />
        <button
          type="button"
          className="deck-close"
          aria-label="Close panel"
          title="Close the inbox (the bell, the tray badge and the console's Inbox tab reopen it)"
          onClick={() => bridgeDeck()?.close()}
        >
          <CloseIcon />
        </button>
      </header>
      <nav className="dx-tabs" role="tablist" aria-label="Inbox sections">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            className="dx-tab"
            aria-selected={tab === t.id}
            onClick={() => onTab(t.id)}
          >
            {t.label}
            {t.count > 0 ? <span className={`dx-count${t.loud ? '' : ' is-quiet'}`}>{t.count}</span> : null}
          </button>
        ))}
      </nav>
      <div className="dx-body">
        <div className="dx-stack">
          {drops}
          {tab === 'decisions' ? (
            <DecisionsPage
              cards={cards}
              nowMs={nowMs}
              focusId={focusId}
              onAnswer={onAnswer}
              onPopout={(id) => runAction('popout-card', id)}
              onOpenQueue={() => runAction('popup')}
              bulk={bulk}
              onBulkDone={onBulkDone}
            />
          ) : null}
          {tab === 'messages' ? (
            <div className="dx-card">
              <RelaySection
                relay={state.relay}
                channel={state.relayChannel}
                nowMs={nowMs}
                onPost={(text) => runAction('relay-post', text)}
              />
            </div>
          ) : null}
          {tab === 'wakes' ? <div className="dx-card">{wakes}</div> : null}
          {tab === 'system' ? <SystemAwareness /> : null}
        </div>
      </div>
    </main>
  );
}
