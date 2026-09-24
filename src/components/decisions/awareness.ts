/**
 * System awareness, pure: the five snapshot sources main serves
 * (system / voice / vision / desktop / connect) turned into one sentence each.
 * Every source fails soft by contract — an unavailable backend yields its
 * reason, never a broken panel. SystemAwareness.tsx renders
 * collapseAwareness(awarenessRows(...)).
 */

import { sharedCause, transportNote } from '../../deck/deck-types';
import type { AwarenessRow } from './model';

type SnapshotSource = Record<string, unknown> | null | undefined;
export interface AwarenessState {
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

const FAIL_PREFIX = /^(unreachable|down|unavailable) — /;

/** A source line -> an awareness row: failure prefix stripped, transport errors in words. */
function toRow(label: string, line: string): AwarenessRow {
  return { label, text: transportNote(line.replace(FAIL_PREFIX, '')), failing: FAIL_PREFIX.test(line) };
}

/** The per-source sentences, pure over the five snapshots. */
export function awarenessRows(awareness: Record<string, AwarenessState | undefined>): AwarenessRow[] {
  const sys = awareness.system;
  const voice = awareness.voice;
  const vision = awareness.vision;
  const desktop = awareness.desktop;
  const connect = awareness.connect;

  const systemObj = sys?.system as { services?: unknown[] } | null | undefined;
  const agentsObj = sys?.agents as { activities?: unknown[] } | null | undefined;
  const count = (obj: object | null | undefined, list?: unknown[]) =>
    Array.isArray(list) ? list.length
      : obj && typeof obj === 'object' && !noteOf(obj as SnapshotSource) ? Object.keys(obj).length : null;
  const services = count(systemObj, systemObj?.services);
  const agents = count(agentsObj, agentsObj?.activities);
  const systemLine = !sys
    ? 'unreachable — not read yet'
    : !sys.ok
      ? `unreachable — ${sys.reason ?? ''}`
      : services === null && agents === null
        ? `unavailable — ${noteOf(systemObj as SnapshotSource) || 'the platform did not answer'}`
        : `${services ?? '?'} service key(s) · ${agents ?? '?'} agent activity key(s)`;

  const voiceLine = (() => {
    if (!voice?.ok) return `unreachable — ${voice?.reason ?? ''}`;
    const status = voice.status as { status?: string; error?: string } | null | undefined;
    if (status?.status === 'error') return `down — ${status.error ?? 'service error'}`;
    return noteOf(voice.status as SnapshotSource) || 'up';
  })();

  const visionLine = (() => {
    if (!vision?.ok) return `unreachable — ${vision?.reason ?? ''}`;
    const error = (vision.status as { error?: string } | null | undefined)?.error;
    if (error) return `down — ${error}`;
    return noteOf(vision.status as SnapshotSource) || 'up';
  })();

  const desktopLine = (() => {
    if (!desktop?.ok) return `unreachable — ${desktop?.reason ?? ''}`;
    const win = desktop.window as
      | { available?: boolean; process?: string; title?: string; message?: string; reason?: string }
      | null | undefined;
    if (win?.available === false) return `unavailable — ${win.message ?? win.reason ?? 'platform'}`;
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
    const tt = connect.terminals?.total ?? 0;
    const ttNote = connect.terminals?.note;
    return `${ws?.profile ?? 'no active workspace profile'} · ${tt} terminal session(s)${ttNote ? ` — ${ttNote}` : ''}`;
  })();

  const rows = [
    toRow('System', systemLine),
    toRow('Voice', voiceLine),
    toRow('Vision', visionLine),
    toRow('Desktop', desktopLine),
    toRow('Workspace', connectLine),
  ];
  // A note that is itself a transport failure ("ECONNREFUSED …", "401") is a
  // failure even without the prefix — sharedCause's vocabulary decides.
  return rows.map((row) => (row.failing || sharedCause([row.text, row.text]) ? { ...row, failing: true } : row));
}
