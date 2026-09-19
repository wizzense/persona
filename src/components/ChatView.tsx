import { useCallback, useEffect, useRef, useState } from 'react';
import { EMPTY_DECK_STATE, formatAge, type DeckState, type RelayRow, type RoomRow } from '../deck/deck-types';
import {
  channelEmptyText,
  chatPickerGroups,
  chatTargetFromValue,
  chatTargetValue,
  directEmptyText,
  loadChatTarget,
  saveChatTarget,
  type ChatSource,
  type TargetStorage,
} from '../deck/chat-target';

/**
 * The CHAT window — `?chat=1`, opened by the chat bead. Not the deck, not a
 * terminal: a dedicated chat surface over the company room. Two halves of
 * that room exist and both are here (owner, 2026-09-08: "full integration
 * into aitherrelay + aitherroom ... so I can just chat in there and have
 * things get done"):
 *
 *  - the RELAY channel (#agents): humans + cloud agents; a message addressed
 *    "@desk …" is executed by the desk's own CommandAgent (relay-poller) and
 *    acked in-thread. Needs the fleet.
 *  - the LOCAL ROOM (awdk daemon :8362): every Claude Code tab's tool calls
 *    plus the desk's command requests/replies. Typing here RUNS the sentence
 *    through the CommandAgent directly — fleet up or down — and the reply
 *    lands as a room event, so awsh `/room` and adk see the same exchange.
 *
 * When the relay refuses or does not answer, a post falls back to the local
 * executor and the window switches to the room view, saying so. Clicking a
 * relay message opens the direct thread under it (main's `desk:relay-thread`);
 * replies go back through the same bridge actions the deck uses, so this
 * window is a VIEW, never a second chat implementation.
 */

interface BridgeDeck {
  getState(): Promise<DeckState>;
  action(name: string, arg?: string): Promise<boolean | string>;
  relayThread(messageId: string): Promise<RelayRow[]>;
}

/** A room event rendered like a relay row (same list component). */
function roomAsRow(row: RoomRow): RelayRow {
  return {
    channel: 'room',
    author: row.author,
    text: row.kind === 'command_request' ? `› ${row.text}` : row.text,
    at: row.at,
    id: row.id,
    threadId: null,
    replyCount: 0,
    agent: row.agent,
  };
}

function bridgeDeck(): BridgeDeck | null {
  const bridge = window.deskBridge as unknown as { deck?: BridgeDeck } | undefined;
  return bridge?.deck ?? null;
}

/** localStorage, or null where the page cannot reach it (a blocked file://
 *  frame throws on the ACCESSOR, not just on the call). */
function targetStorage(): TargetStorage | null {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
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

export function ChatView() {
  const [state, setState] = useState<DeckState>(EMPTY_DECK_STATE);
  // The pane comes up where the owner LEFT it (2026-09-18: "switching to
  // aither direct is clunky" -- every open landed on #agents and the direct
  // target had to be picked again). The remembered target is restored before
  // the first render; the thread anchor is resolved once the feed arrives.
  const [remembered] = useState(() => loadChatTarget(targetStorage()));
  const [thread, setThread] = useState<{ anchorId: string; rows: RelayRow[] } | null>(() =>
    remembered.source === 'relay' && remembered.agent ? { anchorId: '', rows: [] } : null,
  );
  // Who the composer is addressing: null = the room, "agent" = a direct thread.
  // When the agent has no feed message yet, posts go out as @agent mentions.
  const [chatTarget, setChatTarget] = useState<string | null>(remembered.agent);
  // relay = #agents (needs the fleet); room = the local awdk-daemon room,
  // where typing RUNS the sentence through the desk's CommandAgent.
  const [source, setSource] = useState<ChatSource>(remembered.source);
  // Multiplayer attach (2026-09-19): a live Claude Code session mirrors its
  // turns into `#session-<id>` on the relay and reads steering back out of
  // it. `channel` is the one this pane is attached to; its rows are fetched
  // from the relay directly (not the #agents feed), and polled while attached
  // because a session's turns arrive on the agent's clock, not the owner's.
  const [channel, setChannel] = useState<string | null>(remembered.channel ?? null);
  const [channelRows, setChannelRows] = useState<RelayRow[]>([]);
  const [sessionChannels, setSessionChannels] = useState<string[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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

  // The live-session list: what the relay currently publishes. Refreshed on
  // a slow clock -- sessions open and close on the order of minutes.
  useEffect(() => {
    let alive = true;
    const load = () => {
      void bridgeDeck()
        ?.action('relay-channels', '')
        .then((names) => { if (alive && Array.isArray(names)) setSessionChannels(names as string[]); })
        .catch(() => {});
    };
    load();
    const t = window.setInterval(load, 20_000);
    return () => { alive = false; window.clearInterval(t); };
  }, []);

  // The attached session's turns: polled every 4 s while attached. A turn
  // is a relay message, so this is the same read the awrelay CLI does.
  useEffect(() => {
    if (source !== 'channel' || !channel) return;
    let alive = true;
    const load = () => {
      void bridgeDeck()
        ?.action('relay-history', JSON.stringify({ channel, limit: 120 }))
        .then((rows) => { if (alive && Array.isArray(rows)) setChannelRows(rows as RelayRow[]); })
        .catch(() => {});
    };
    load();
    const t = window.setInterval(load, 4_000);
    return () => { alive = false; window.clearInterval(t); };
  }, [source, channel]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [state.relay, state.room, thread, source, channelRows]);

  // Remember the target on every change, so the next open is one motion.
  useEffect(() => {
    saveChatTarget(targetStorage(), { source, agent: chatTarget, channel: channel ?? undefined });
  }, [source, chatTarget, channel]);

  const openThread = useCallback((row: RelayRow) => {
    void bridgeDeck()
      ?.relayThread(row.id ?? '')
      .then((rows) => setThread({ anchorId: row.id ?? '', rows }))
      .catch(() => {});
  }, []);

  // A direct target with no anchor yet (restored before the feed arrived, or
  // the agent had not spoken) attaches to the agent's latest message as soon
  // as one exists -- without this the restored pane sits on an empty thread
  // while the conversation is one row down in the feed.
  const anchorMissing = Boolean(thread && !thread.anchorId);
  useEffect(() => {
    if (source !== 'relay' || !chatTarget || !anchorMissing) return;
    const latest = [...state.relay].reverse().find((row) => row.author === chatTarget && row.id);
    if (latest) openThread(latest);
  }, [source, chatTarget, anchorMissing, state.relay, openThread]);

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
    setNotice(null);
    // Restore the draft on failure so a refused message is not silently eaten.
    const fail = (message: string) => {
      setDraft(text);
      setSendError(message);
    };
    // The local executor: the sentence runs through the desk's CommandAgent
    // (fleet verbs -> FleetControl, anything else -> a headless agent), the
    // request and the reply land in the room, and the room view refreshes.
    const runLocally = (why: string | null) => {
      setSource('room');
      setThread(null);
      setRunning(text);
      if (why) setNotice(why);
      return deck
        .action('command-send', text)
        .then((res) => {
          setRunning(null);
          if (typeof res === 'string' && res.startsWith('ERROR:')) fail(res);
          pull();
        })
        .catch((err) => {
          setRunning(null);
          fail(`Not run — ${err instanceof Error ? err.message : String(err)}`);
        });
    };
    if (source === 'room') {
      void runLocally(null);
      return;
    }
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
    } else if (source === 'channel' && channel) {
      // Steering a live session: the message lands in its channel, and the
      // session's mirror hook drops it into that session's steer mailbox at
      // the end of the agent's current turn -- so it is honoured on the next.
      void deck
        .action('relay-post', JSON.stringify({ channel, text }))
        .then((ok) => {
          if (ok !== true) {
            fail(typeof ok === 'string' && ok ? `Not sent — ${ok}` : 'Not sent — the relay refused.');
            return;
          }
          setNotice(`Sent to ${channel} — the agent picks it up on its next turn.`);
        })
        .catch(() => fail('Not sent — the relay is unreachable.'));
    } else {
      const payload = chatTarget ? `@${chatTarget} ${text}` : text;
      void deck
        .action('relay-post', payload)
        .then((ok) => {
          if (ok !== true) {
            // A relay that is DOWN (the fleet is held, the container is
            // masked) must not eat the sentence: run it here instead. A real
            // refusal (403, agent-only) is reported, not worked around.
            const detail = typeof ok === 'string' && ok ? ok : 'the relay refused the post';
            if (!chatTarget && /did not answer|unreachable|restart|no answer|status 0/i.test(detail)) {
              void runLocally(`Relay down (${detail}) — ran it locally instead; this is the room view.`);
              return;
            }
            fail(`Not sent — ${detail}`);
            return;
          }
          // Belt and braces: main refreshes the feed and now pushes it to this
          // window too, but pull once more so the sent message shows even if
          // the push is missed.
          window.setTimeout(() => pull(), 900);
        })
        .catch(() => void runLocally('Relay unreachable — ran it locally instead; this is the room view.'));
    }
  };

  const roomRows = state.room.map(roomAsRow);
  const rows = thread ? thread.rows
    : source === 'channel' ? channelRows
      : source === 'room' ? roomRows : state.relay;
  const title = thread && thread.anchorId
    ? `Direct chat — ${chatTarget ?? 'thread'}`
    : source === 'channel' && channel
      ? `${channel} — live session (watch & steer)`
      : source === 'room'
      ? `room — local (${state.roomStatus === 'ok' ? 'awdk daemon' : state.roomStatus})`
      : chatTarget
        ? `${chatTarget} — direct`
        : `${state.relayChannel} — the company room`;
  const pickerGroups = chatPickerGroups({
    relayChannel: state.relayChannel,
    agents: state.agents,
    slots: state.slots,
    current: source === 'relay' ? chatTarget : null,
    sessionChannels,
  });

  return (
    <main className="chat-view">
      <header className="chat-head">
        <span className="chat-head-title" title={title}>{title}</span>
        <select
          className="chat-target"
          value={chatTargetValue({ source, agent: chatTarget, channel: channel ?? undefined })}
          onChange={(event) => {
            const next = chatTargetFromValue(event.target.value);
            if (next.source === 'channel' && next.channel) {
              setSource('channel');
              setChannel(next.channel);
              setChannelRows([]);
              setThread(null);
              setChatTarget(null);
              return;
            }
            if (next.source === 'room') {
              setSource('room');
              setThread(null);
              setChatTarget(null);
              return;
            }
            setSource('relay');
            pickTarget(next.agent);
          }}
          title="Where you are talking: the company room (needs the fleet), the local room (runs the sentence here), or one agent directly"
        >
          {pickerGroups.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.options.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </optgroup>
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
            {thread
              ? (chatTarget
                ? directEmptyText(chatTarget, state.relayChannel, Boolean(thread.anchorId))
                : 'No replies in this thread yet.')
              : source === 'channel' && channel
                ? channelEmptyText(channel)
                : source === 'room'
                  ? (state.roomStatus === 'ok' ? 'Nothing said in the room yet — tell the desk what to do.' : `Room unavailable: ${state.roomStatus} (start the awdk daemon: aither harness serve).`)
                  : 'The room is quiet — say something.'}
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
        {(running || notice) && (
          <p className="chat-notice" style={{ color: '#9ec1ff', fontSize: 11, margin: '0 0 4px' }}>
            {running ? `running: ${running}` : notice}
          </p>
        )}
        <input
          className="chat-input"
          placeholder={
            thread && thread.anchorId
              ? `Reply to ${chatTarget ?? 'the thread'}…`
              : chatTarget
                ? `Message ${chatTarget} (posts to ${state.relayChannel} as @${chatTarget})…`
                : source === 'channel' && channel
                  ? `Steer ${channel} — the agent reads this on its next turn…`
                  : source === 'room'
                    ? 'Tell the desk what to do — it runs here…'
                    : `Post to ${state.relayChannel}…`
          }
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
