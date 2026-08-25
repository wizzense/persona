import { useEffect, useState } from 'react';

import { setDragMode, useDragMode } from '../hooks/useDragMode';

/**
 * Floating beads — the notification + quick-action layer that floats over the
 * avatar (owner redesign 2026-08-25: "make it like floating beads... make real
 * icons and make floating icons appear in the desk/avatar box... move away
 * from nested menus").
 *
 * LEFT-click a bead runs its action directly; RIGHT-click opens the full Desk
 * panel (same as right-clicking the avatar). The bell carries the live
 * decision-card count — the one thing the owner wants to see without clicking
 * anything at all.
 */

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  );
}

function ChipIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5z" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </svg>
  );
}

interface BeadDeckBridge {
  getState(): Promise<{ openCount: number }>;
  open(): void;
  action(name: string): Promise<boolean>;
}

function bridgeDeck(): BeadDeckBridge | null {
  const bridge = window.deskBridge as unknown as { deck?: BeadDeckBridge } | undefined;
  return bridge?.deck ?? null;
}

interface BeadProps {
  label: string;
  count?: number;
  onLeftClick: () => void;
  children: React.ReactNode;
}

function Bead({ label, count, onLeftClick, children }: BeadProps) {
  return (
    <button
      type="button"
      className="bead"
      title={count && count > 0 ? `${label} — ${count} waiting (right-click for the panel)` : `${label} (right-click for the panel)`}
      aria-label={label}
      onClick={onLeftClick}
      onContextMenu={(event) => {
        event.preventDefault();
        bridgeDeck()?.open();
      }}
    >
      {children}
      {count != null && count > 0 ? (
        <span className="bead-badge" aria-label={`${count} waiting`}>{count > 99 ? '99+' : count}</span>
      ) : null}
    </button>
  );
}

/** The floating bead cluster — bell (decisions), models, talk, panel. */
export function Beads() {
  const [openCount, setOpenCount] = useState(0);

  useEffect(() => {
    const deck = bridgeDeck();
    if (!deck) return;
    let alive = true;
    void deck.getState().then((state) => {
      if (alive && state) setOpenCount(state.openCount ?? 0);
    });
    const bridge = window.deskBridge as unknown as {
      subscribe?: (l: (event: { type?: string; openCount?: number }) => void) => () => void;
    } | undefined;
    let unsubscribe = () => {};
    try {
      unsubscribe = bridge?.subscribe?.((event) => {
        if (event.type === 'decisions-changed') {
          setOpenCount(event.openCount ?? 0);
        }
      }) ?? (() => {});
    } catch {
      /* no bridge (browser preview) — the initial pull already answered */
    }
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  const [hintDismissed, setHintDismissed] = useState(
    () => {
      try { return window.localStorage.getItem('desk.beads-hint-dismissed') === '1'; }
      catch { return false; }
    },
  );
  const dismissHint = () => {
    setHintDismissed(true);
    try { window.localStorage.setItem('desk.beads-hint-dismissed', '1'); } catch { /* best-effort */ }
  };

  const dragMode = useDragMode();
  const deck = bridgeDeck();
  return (
    <div className="beads" aria-label="Desk quick actions">
      <Bead
        label="Notifications"
        count={openCount}
        onLeftClick={() => deck?.open()}
      >
        <BellIcon />
      </Bead>
      <Bead label="Browse models" onLeftClick={() => void deck?.action('models')}>
        <ChipIcon />
      </Bead>
      <Bead label="Talk to Aither" onLeftClick={() => void deck?.action('talk')}>
        <ChatIcon />
      </Bead>
      <Bead label="Desk panel" onLeftClick={() => deck?.open()}>
        <GridIcon />
      </Bead>
      {/* The VISIBLE drag-mode toggle — the resolution of the three-way gesture
          fight (v1 move-only, v2 Shift-move, v3 Shift-rotate all failed with
          the owner, 2026-08-25). Plain drag does exactly what this says;
          clicking flips it. Default: rotate. */}
      <Bead
        label={`Drag mode: ${dragMode === 'rotate' ? 'Rotate' : 'Move'} — click to switch`}
        onLeftClick={() => setDragMode(dragMode === 'rotate' ? 'move' : 'rotate')}
      >
        <span className="bead-mode-label">
          {dragMode === 'rotate' ? 'ROT' : 'MOVE'}
        </span>
      </Bead>
      {/* First-run discoverability: the owner asked "where are the buttons" with
          the cluster live on screen (2026-08-25) -- an edge-corner column of
          round icons does not announce itself. One dismissible note, persisted,
          so it never nags twice. */}
      {hintDismissed ? null : (
        <div className="bead-hint" role="note">
          <span>Drag the avatar to rotate · click the ROT/MOVE bead to switch to moving it · right-click for controls</span>
          <button
            type="button"
            className="bead-hint-x"
            aria-label="Dismiss hint"
            onClick={dismissHint}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
