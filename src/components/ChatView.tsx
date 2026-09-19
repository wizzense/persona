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
  type StageBody,
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

/** RoomStage.status()'s own shape (room-stage.cjs `status()`), not carried in
 *  DeckState (deck-types.ts is peer-held — plan U20/U21 conflicts) even
 *  though main's deckState() already sends it under `roomStage`. Declared
 *  LOCALLY, read with a cast, same doctrine chat-target.ts uses for
 *  StageBody. Only the fields this view needs. */
interface RawStageBody {
  slotId?: string;
  agent?: string;
  actorId?: string;
  actorKind?: string;
}
interface RoomStageStatus {
  onStage?: RawStageBody[];
}

/** Bodies on stage, addressable ones only. A body is addressable when its
 *  actor is a `claude_code` session — room-publisher.cjs: "a claude_code
 *  actor's room actor.id IS the session id" — anything else (a service or
 *  relay-mirrored actor) has no mailbox to steer into, so it is left out
 *  rather than offered and refused later. No session TITLE is available here
 *  (main does not yet join RoomStage.status() with room-publisher's
 *  sessionTitles() into deckState — plan U18's join point, not this file's);
 *  stageBodyOptions() already falls back to the agent name and disambiguates
 *  same-named bodies by session id, so the picker still shows distinct rows. */
function stageBodiesFrom(state: DeckState): StageBody[] {
  const roomStage = (state as unknown as { roomStage?: RoomStageStatus } | undefined)?.roomStage;
  const onStage = roomStage?.onStage;
  if (!Array.isArray(onStage)) return [];
  const out: StageBody[] = [];
  for (const b of onStage) {
    if (!b || b.actorKind !== 'claude_code' || !b.actorId) continue;
    out.push({ slotId: String(b.slotId || ''), agent: b.agent || null, actorId: b.actorId, actorKind: b.actorKind, sessionId: b.actorId });
  }
  return out;
}

/** The empty text for a session steer view: names where typing goes, because
 *  nothing here reads back the session's own turns (that would need the
 *  relay-mirror `channel` attach, not this mailbox-only lane). */
function sessionEmptyText(label: string | null, sessionId: string | null): string {
  const who = label || (sessionId ? sessionId.slice(0, 8) : 'that session');
  return `Nothing sent to ${who} yet. What you type is queued for its next turn boundary — this is a mailbox, not a live read-back.`;
}

/** One sent steer, with its receipt filled in once room-steer answers. */
interface SentSteer {
  id: string;
  text: string;
  at: number;
  /** null while the answer is in flight. */
  receipt: string | null;
  refused: boolean;
}

/**
 * The dispatcher's own wording for a room-steer answer, never guessed past
 * what the answer actually says (owner risk on U21: "claiming delivery for
 * something that is only queued"). Handles every shape this can arrive in:
 *  - a rich receipt {ok, channel, landed_now, detail} once main (U28) wires
 *    room-steer to await steer_dispatch's steering_receipt;
 *  - a bare boolean/string (the generic action() shape every OTHER verb in
 *    this file uses) if it lands before that;
 *  - a rejected promise (handled by the caller, not here).
 * `channel: "pty"` is the ONLY path that says "delivered" — on this box every
 * live session is origin=discovered, so pty essentially always misses and
 * mailbox is the real channel (steer_dispatch.py, plan U11). Anything ok but
 * without channel info is reported as queued, never delivered, because
 * "the agent has it now" and "queued for its next turn boundary" are
 * different facts and the owner acts on this sentence.
 */
function receiptFor(answer: unknown): { refused: boolean; text: string } {
  const QUEUED = "queued — lands at that session's next turn boundary";
  if (answer && typeof answer === 'object') {
    const a = answer as Record<string, unknown>;
    if (a.ok === false) {
      const reason = (typeof a.detail === 'string' && a.detail) || (typeof a.error === 'string' && a.error) || 'the room refused the steer';
      return { refused: true, text: reason };
    }
    if (a.channel === 'pty' || a.landed_now === true) return { refused: false, text: 'delivered' };
    if (a.channel === 'mailbox') return { refused: false, text: QUEUED };
    if (a.channel === 'none') {
      const reason = (typeof a.detail === 'string' && a.detail) || 'refused — no delivery channel for this session';
      return { refused: true, text: reason };
    }
    // ok, but no channel fact yet: still queued, never a guessed "delivered".
    return { refused: false, text: QUEUED };
  }
  if (answer === true) return { refused: false, text: QUEUED };
  const reason = (typeof answer === 'string' && answer) || 'the room refused the steer';
  return { refused: true, text: reason };
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
  // ONE live session (a body on stage), addressed through room-steer -> the
  // steer mailbox, distinct from `channel` above (a relay-mirrored channel
  // anyone can attach to). `sessionLabel` is read off the picked <option>'s
  // own text at selection time — no session-title lookup is wired to this
  // window (see stageBodiesFrom) — and falls back to the id at render time.
  const [sessionId, setSessionId] = useState<string | null>(
    remembered.source === 'session' ? remembered.session ?? null : null,
  );
  const [sessionLabel, setSessionLabel] = useState<string | null>(null);
  const [sentSteers, setSentSteers] = useState<SentSteer[]>([]);
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
    saveChatTarget(targetStorage(), {
      source,
      agent: chatTarget,
      channel: channel ?? undefined,
      session: sessionId ?? undefined,
    });
  }, [source, chatTarget, channel, sessionId]);

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
    if (source === 'session') {
      // A body on stage, steered through the room spine (plan U18/U19/U28) —
      // NEVER command-send: that would spawn a fresh `claude -p` at a
      // hardcoded cwd and answer from an empty context, which looks like the
      // addressed session replying with amnesia.
      if (!sessionId) {
        fail('Not sent — no session selected.');
        return;
      }
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const label = sessionLabel || sessionId;
      setNotice(null);
      // The message is shown as SENT the moment the spine is asked to take
      // it; the receipt line under it fills in once room-steer answers. A
      // dispatcher-level refusal (self-address, hop limit, unknown actor) is
      // a fact about DELIVERY, not about whether the room accepted the
      // steer, so it renders inline rather than restoring the draft.
      setSentSteers((prev) => [...prev, { id, text, at: Date.now(), receipt: null, refused: false }]);
      void deck
        .action('room-steer', JSON.stringify({ to: sessionId, text, label }))
        .then((res) => {
          const { refused, text: receiptText } = receiptFor(res);
          setSentSteers((prev) => prev.map((s) => (s.id === id ? { ...s, receipt: receiptText, refused } : s)));
        })
        .catch((err) => {
          const msg = `Not sent — ${err instanceof Error ? err.message : String(err)}`;
          setSentSteers((prev) => prev.map((s) => (s.id === id ? { ...s, receipt: msg, refused: true } : s)));
        });
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
      : source === 'room' ? roomRows
        : source === 'session' ? [] // rendered from sentSteers below — a mailbox has no read-back feed
          : state.relay;
  const title = thread && thread.anchorId
    ? `Direct chat — ${chatTarget ?? 'thread'}`
    : source === 'channel' && channel
      ? `${channel} — live session (watch & steer)`
      : source === 'room'
      ? `room — local (${state.roomStatus === 'ok' ? 'awdk daemon' : state.roomStatus})`
      : source === 'session' && sessionId
        ? `${sessionLabel || sessionId.slice(0, 8)} — session (steer)`
        : chatTarget
          ? `${chatTarget} — direct`
          : `${state.relayChannel} — the company room`;
  const stageBodies = stageBodiesFrom(state);
  const pickerGroups = chatPickerGroups({
    relayChannel: state.relayChannel,
    agents: state.agents,
    slots: state.slots,
    current: source === 'relay' ? chatTarget : null,
    sessionChannels,
    bodies: stageBodies,
    currentSession: source === 'session' ? sessionId : null,
  });

  return (
    <main className="chat-view">
      <header className="chat-head">
        <span className="chat-head-title" title={title}>{title}</span>
        <select
          className="chat-target"
          value={chatTargetValue({
            source,
            agent: chatTarget,
            channel: channel ?? undefined,
            session: sessionId ?? undefined,
          })}
          onChange={(event) => {
            const next = chatTargetFromValue(event.target.value);
            if (next.source === 'session' && next.session) {
              // Label read off the picked <option> itself (its text is
              // already the distinct, collision-resolved label
              // stageBodyOptions built) — no separate title lookup exists
              // for this window to call.
              const label = event.target.selectedOptions[0]?.text ?? next.session;
              setSource('session');
              setSessionId(next.session);
              setSessionLabel(label);
              setChannel(null);
              setChannelRows([]);
              setThread(null);
              setChatTarget(null);
              return;
            }
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
        {source === 'session' ? (
          // A mailbox has no read-back feed (that is what `channel` attach
          // is for) -- this view shows what the owner sent and, under each
          // one, the honest receipt: queued/delivered/refused, never a guess.
          sentSteers.length === 0 ? (
            <p className="chat-empty">{sessionEmptyText(sessionLabel, sessionId)}</p>
          ) : (
            sentSteers.map((s) => (
              <div className="chat-row chat-row-static chat-own" key={s.id}>
                <span className="chat-meta">
                  <span className="chat-author">you → {sessionLabel || (sessionId ? sessionId.slice(0, 8) : 'session')}</span>
                  <span className="chat-age">{formatAge(s.at, nowMs)}</span>
                </span>
                <span className="chat-bubble">{s.text}</span>
                {/* The receipt line — under the sent message, per plan U21.
                    Scoped inline style (Deck.tsx/styles.css are peer-held). */}
                <span
                  className="chat-meta chat-receipt"
                  style={{ fontSize: 11, opacity: 0.75, color: s.refused ? '#ff9a9a' : '#9ec1ff' }}
                >
                  {s.receipt ?? 'sending…'}
                </span>
              </div>
            ))
          )
        ) : rows.length === 0 ? (
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
                  : source === 'session' && sessionId
                    ? `Message ${sessionLabel || sessionId.slice(0, 8)} — queued for its next turn boundary…`
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
