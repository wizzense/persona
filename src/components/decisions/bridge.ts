/**
 * Feature-detected bridge calls the Decisions page needs beyond answer().
 *
 * `deck.bulk` is served by electron/decisions-bulk.cjs through the
 * "desk:deck-bulk" IPC. A build whose preload does not expose it gets null,
 * and the page hides the controls that need it instead of offering a button
 * that does nothing.
 */

import { normalizeWakes, type DeckDecision, type DeckState } from '../../deck/deck-types';

export type BulkVerb = 'answer-default' | 'cancel';

export interface BulkResult {
  ok: boolean;
  verb: string;
  done: string[];
  failed: string[];
  skipped: Array<{ id: string; reason: string }>;
  error?: string;
  summary?: string;
}

export type BulkFn = (verb: BulkVerb, ids: string[], note?: string) => Promise<BulkResult>;

interface DeckBulkBridge {
  bulk?: (verb: string, ids: string[], note?: string) => Promise<BulkResult>;
  steer?: (id: string, text: string) => Promise<boolean>;
}

function deckBridge(): DeckBulkBridge | null {
  const bridge = window.deskBridge as unknown as { deck?: DeckBulkBridge } | undefined;
  return bridge?.deck ?? null;
}

/** The bulk verb, or null when this build's preload does not carry it. */
export function bulkApi(): BulkFn | null {
  const deck = deckBridge();
  if (!deck || typeof deck.bulk !== 'function') return null;
  const call = deck.bulk.bind(deck);
  return async (verb, ids, note) => {
    try {
      const result = await call(verb, ids, note);
      if (result && typeof result === 'object' && Array.isArray(result.done)) return result;
      return { ok: false, verb, done: [], failed: ids, skipped: [], error: 'the desk answered nothing usable' };
    } catch (error) {
      return {
        ok: false, verb, done: [], failed: ids, skipped: [],
        error: error instanceof Error ? error.message : 'the desk did not answer',
      };
    }
  };
}

/** The steer verb, or null on an older build. */
export function steerApi(): ((id: string, text: string) => Promise<boolean>) | null {
  const deck = deckBridge();
  if (!deck || typeof deck.steer !== 'function') return null;
  return deck.steer.bind(deck);
}

/** main's deck-state push -> DeckState. The pull spreads main's object, the
 *  push rebuilds it here — so a field this copy omits is there once and gone
 *  after the first push (totalCount was: the inbox's "N FYI" vanished). */
export function deckStateFromPush(event: Record<string, unknown>): DeckState {
  return {
    decisions: (event.decisions as DeckDecision[]) ?? [],
    openCount: (event.openCount as number) ?? 0,
    // Optional: an older main does not send it, and the header then omits FYI.
    totalCount: typeof event.totalCount === 'number' ? event.totalCount : undefined,
    deskVisible: (event.deskVisible as boolean) ?? false,
    slots: (event.slots as DeckState['slots']) ?? [],
    agents: (event.agents as string[]) ?? [],
    characters: (event.characters as string[]) ?? [],
    characterModels: (event.characterModels as Record<string, string>) ?? {},
    activeCharacter: (event.activeCharacter as string) ?? '',
    agentCharacters: (event.agentCharacters as Record<string, string>) ?? {},
    relay: (event.relay as DeckState['relay']) ?? [],
    relayChannel: (event.relayChannel as string) ?? '#agents',
    room: (event.room as DeckState['room']) ?? [],
    roomStatus: (event.roomStatus as string) ?? 'not started',
    wakes: normalizeWakes(event.wakes),
  };
}

/** One sentence for the bulk bar after a run. */
export function bulkResultNote(result: BulkResult): string {
  if (!result.ok) return `Refused — ${result.error || 'the desk did not take it'}`;
  const verb = result.verb === 'cancel' ? 'Dismissed' : 'Answered';
  const parts = [`${verb} ${result.done.length}`];
  if (result.skipped.length) {
    const reasons = [...new Set(result.skipped.map((s) => s.reason))].join('; ');
    parts.push(`${result.skipped.length} skipped (${reasons})`);
  }
  if (result.failed.length) parts.push(`${result.failed.length} failed — awask did not start`);
  return `${parts.join(' · ')}. Handed to awask.`;
}
