import { useCallback, useEffect, useRef, useState } from 'react';
import { EMPTY_DECK_STATE, formatAge, type DeckState, type RelayRow } from '../deck/deck-types';

/**
 * The CHAT window — `?chat=1`, opened by the chat bead. Not the deck, not a
 * terminal: a dedicated chat surface over the company room (#agents relay).
 * Clicking a message opens the direct thread under it (the per-agent
 * conversation — main's `desk:relay-thread`), replies go back through the
 * same bridge actions the deck uses, so this window is a VIEW, never a
 * second chat implementation.
 */

interface BridgeDeck {
  getState(): Promise<DeckState>;
  action(name: string, arg?: string): Promise<boolean>;
  relayThread(messageId: string): Promise<RelayRow[]>;
}

function bridgeDeck(): BridgeDeck | null {
  const bridge = window.deskBridge as unknown as { deck?: BridgeDeck } | undefined;
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

export function ChatView() {
  const [state, setState] = useState<DeckState>(EMPTY_DECK_STATE);
  const [thread, setThread] = useState<{ anchorId: string; rows: RelayRow[] } | null>(null);
  const [draft, setDraft] = useState('');
  const [nowMs, setNowMs] = useState(() => Date.now());
  const listRef = useRef<HTMLDivElement>(null);

  const pull = useCallback(() => {
    void bridgeDeck()
      ?.getState()
      .then((s) => s && setState(s))
      .catch(() => {});
  }, []);

  useEffect(() => {
    pull();
    const unsubscribe = bridgeSubscribe((event) => {
      if (event.type === 'deck-state' || event.type === 'decisions-changed') pull();
    });
    const tick = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => {
      unsubscribe();
      window.clearInterval(tick);
    };
  }, [pull]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [state.relay, thread]);

  const openThread = (row: RelayRow) => {
    void bridgeDeck()
      ?.relayThread(row.id ?? '')
      .then((rows) => setThread({ anchorId: row.id ?? '', rows }))
      .catch(() => {});
  };

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    const deck = bridgeDeck();
    if (!deck) return;
    if (thread) {
      const anchorId = thread.anchorId;
      void deck.action(
        'relay-thread-reply',
        JSON.stringify({ channel: state.relayChannel, messageId: anchorId, text }),
      );
      window.setTimeout(() => {
        void deck.relayThread(anchorId).then((rows) => setThread({ anchorId, rows })).catch(() => {});
      }, 800);
    } else {
      void deck.action('relay-post', text);
    }
  };

  const rows = thread ? thread.rows : state.relay;

  return (
    <main className="chat-view">
      <header className="chat-head">
        <span className="chat-head-title">
          {thread ? 'Direct chat' : `${state.relayChannel} — the company room`}
        </span>
        {thread ? (
          <button className="chat-back" onClick={() => setThread(null)} title="Back to the room">
            ← room
          </button>
        ) : null}
      </header>
      <div className="chat-list" ref={listRef}>
        {rows.length === 0 ? (
          <p className="chat-empty">
            {thread ? 'No replies in this thread yet.' : 'The room is quiet — say something.'}
          </p>
        ) : (
          rows.map((row, index) => (
            <button
              className={`chat-row${thread ? ' chat-row-static' : ''}`}
              key={`${row.id}-${index}`}
              onClick={() => !thread && openThread(row)}
              title={thread ? undefined : 'Open this conversation'}
            >
              <span className="chat-author">{row.author || 'unknown'}</span>
              <span className="chat-age">{formatAge(row.at, nowMs)}</span>
              <p className="chat-text">{row.text}</p>
            </button>
          ))
        )}
      </div>
      <footer className="chat-compose">
        <input
          className="chat-input"
          placeholder={thread ? 'Reply in thread…' : `Post to ${state.relayChannel}…`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') send();
          }}
        />
        <button className="chat-send" onClick={send}>Send</button>
      </footer>
    </main>
  );
}
