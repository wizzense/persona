/**
 * Desk-panel types + pure helpers — the shared shape of what main's
 * `deckState()` sends and what the deck renders. Kept dependency-free so the
 * vitest arms exercise exactly this logic.
 */

export interface DeckDecision {
  id: string;
  title: string;
  summary: string;
  urgency: string;
  createdAt: number;
  options: Array<{ key: string; label: string; recommended: boolean }>;
  defaultKey: string;
  tab: string;
  cwd: string;
  agent: string;
}

export interface DeckSlot {
  slotId: string;
  name: string;
  agent: string;
}

export interface RelayRow {
  channel: string;
  author: string;
  text: string;
  at: number;
  /** The relay message id — the anchor for the per-agent chat THREAD. */
  id: string | null;
  threadId: string | null;
  replyCount: number;
  /** True when the author is an agent (not a session/human). */
  agent: boolean;
}

export interface DeckState {
  decisions: DeckDecision[];
  openCount: number;
  deskVisible: boolean;
  slots: DeckSlot[];
  agents: string[];
  characters: string[];
  activeCharacter: string;
  agentCharacters: Record<string, string>;
  relay: RelayRow[];
  relayChannel: string;
}

export const EMPTY_DECK_STATE: DeckState = {
  decisions: [],
  openCount: 0,
  deskVisible: false,
  slots: [],
  agents: [],
  characters: [],
  activeCharacter: '',
  agentCharacters: {},
  relay: [],
  relayChannel: '#agents',
};

/** WHERE a card came from, so a row can name it — a toast with no identity is
 *  noise the owner cannot act on when a dozen sessions are open. */
export function cardWhere(card: DeckDecision): string {
  return card.tab || card.cwd || card.agent;
}

/** "just now" / "4m" / "2h" / "3d" — wall-clock age, not a timestamp, because
 *  the queue sorts oldest-first and the owner reads "how long have I kept this
 *  session waiting", not a date. */
export function formatAge(createdAtSec: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor(nowMs / 1000) - createdAtSec);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** The one button the owner is most likely to want: the raiser's default key
 *  wins, then a recommended option, then the first option. */
export function primaryChoice(
  card: DeckDecision,
): { key: string; label: string } | null {
  const first = card.options[0];
  if (!first) return null;
  const byKey = (key: string) => card.options.find((o) => o.key === key);
  const pick = byKey(card.defaultKey) ?? card.options.find((o) => o.recommended) ?? first;
  return { key: pick.key, label: pick.label };
}

/** The defer path: the first NON-recommended option, so a card's "ack / later"
 *  pair renders as [ack (primary)] [Not now]. Falls back to the first option
 *  when every option is recommended (a card with nothing but strong choices). */
export function secondaryChoice(
  card: DeckDecision,
): { key: string; label: string } | null {
  if (card.options.length === 0) return null;
  const defer = card.options.find((o) => !o.recommended);
  if (!defer) return null;
  if (card.options.length === 1) return null;
  return { key: defer.key, label: defer.label };
}
