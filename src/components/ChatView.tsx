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
  // Who the composer is addressing: null = the room, "agent" = a direct thread.
  // When the agent has no feed message yet, posts go out as @agent mentions.
  const [chatTarget, setChatTarget] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  // Send failures are VISIBLE now -- main returns the real post result
  // (the relay 403s an unjoined identity on #agents), and the old
  // fire-and-forget version let the chat window believe every message
  // sent (2026-08-25).
  const [sendError, setSendError] = useState<string | null>(null);
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

  /** Pick a conversation: the room, or the direct thread under the chosen
   *  agent's most recent room message (no per-agent channels exist — the
   *  thread IS the conversation, same doctrine as the deck's chat pane). */
  const pickTarget = (agent: string | null) => {
    setChatTarget(agent);
    if (!agent) {
      setThread(null);
      return;
    }
    const latest = [...state.relay].reverse().find((row) => row.author === agent);
    if (latest) {
      openThread(latest);
    } else {
      // No feed message yet: compose @agent mentions into the room.
      setThread({ anchorId: '', rows: [] });
    }
  };

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    const deck = bridgeDeck();
    if (!deck) {
      setSendError('Desk bridge unavailable — reopen the chat window.');
      return;
    }
    setDraft('');
    setSendError(null);
    // Restore the draft on failure so a refused message is not silently eaten.
    const fail = (message: string) => {
      setDraft(text);
      setSendError(message);
    };
    if (thread && thread.anchorId) {
      const anchorId = thread.anchorId;
      void deck
        .action(
          'relay-thread-reply',
          JSON.stringify({ channel: state.relayChannel, messageId: anchorId, text }),
        )
        .then((ok) => {
          if (ok !== true) {
            fail(typeof ok === 'string' && ok ? `Not sent — ${ok}` : 'Not sent — the relay refused the reply.');
            return;
          }
          window.setTimeout(() => {
            void deck
              .relayThread(anchorId)
              .then((rows) => setThread({ anchorId, rows }))
              .catch(() => {});
          }, 800);
        })
        .catch(() => fail('Not sent — the relay is unreachable.'));
    } else {
      const payload = chatTarget ? `@${chatTarget} ${text}` : text;
      void deck
        .action('relay-post', payload)
        .then((ok) => {
          if (ok !== true) {
            fail(typeof ok === 'string' && ok ? `Not sent — ${ok}` : 'Not sent — the relay refused the post.');
            return;
          }
          // Belt and braces: main refreshes the feed and now pushes it to this
          // window too, but pull once more so the sent message shows even if
          // the push is missed.
          window.setTimeout(() => pull(), 900);
        })
        .catch(() => fail('Not sent — the relay is unreachable.'));
    }
  };

  const rows = thread ? thread.rows : state.relay;
  const title = thread && thread.anchorId
    ? `Direct chat — ${chatTarget ?? 'thread'}`
    : chatTarget
      ? `${chatTarget} — direct`
      : `${state.relayChannel} — the company room`;

  return (
    <main className="chat-view">
      <header className="chat-head">
        <span className="chat-head-title" title={title}>{title}</span>
        <select
          className="chat-target"
          value={chatTarget ?? ''}
          onChange={(event) => pickTarget(event.target.value || null)}
          title="Who you are talking to"
        >
          <option value="">{state.relayChannel} (room)</option>
          {state.agents.map((agent) => (
            <option key={agent} value={agent}>{agent}</option>
          ))}
        </select>
        <button
          className="chat-ctl"
          onClick={() => window.deskBridge?.minimize()}
          title="Minimize"
        >─</button>
        <button
          className="chat-ctl chat-ctl-close"
          onClick={() => window.deskBridge?.close()}
          title="Close"
        >×</button>
      </header>
      <div className="chat-list" ref={listRef}>
        {rows.length === 0 ? (
          <p className="chat-empty">
            {thread ? 'No replies in this thread yet.' : 'The room is quiet — say something.'}
          </p>
        ) : (
          rows.map((row, index) => {
            // The desk posts as the owner identity — own messages align right
            // as bubbles so a just-sent message is unmistakably visible.
            const own = row.author === 'david';
            return (
              <button
                className={`chat-row${thread ? ' chat-row-static' : ''}${own ? ' chat-own' : ''}`}
                key={`${row.id}-${index}`}
                onClick={() => !thread && openThread(row)}
                title={thread ? undefined : 'Open this conversation'}
              >
                <span className="chat-meta">
                  <span className="chat-author">{row.author || 'unknown'}</span>
                  <span className="chat-age">{formatAge(row.at, nowMs)}</span>
                </span>
                <span className="chat-bubble">{row.text}</span>
              </button>
            );
          })
        )}
      </div>
      <footer className="chat-compose">
        <input
          className="chat-input"
          placeholder={thread ? 'Reply in thread…' : `Post to ${state.relayChannel}…`}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            if (sendError) setSendError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') send();
          }}
        />
        <button className="chat-send" onClick={send}>Send</button>
        {sendError && (
          <p
            className="chat-send-error"
            style={{ color: '#ff7a7a', fontSize: 11, margin: 0 }}
          >
            {sendError}
          </p>
        )}
      </footer>
    </main>
  );
}
