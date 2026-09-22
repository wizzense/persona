import { useEffect, useState } from 'react';


/**
 * Floating beads — the notification + quick-action layer that floats over the
 * avatar (owner redesign 2026-08-25: "make it like floating beads... make real
 * icons and make floating icons appear in the desk/avatar box... move away
 * from nested menus").
 *
 * LEFT-click a bead runs its command; RIGHT-click opens THE menu — the same one
 * the tray shows. The bell carries the live decision-card count — the one thing
 * the owner wants to see without clicking anything at all.
 *
 * The beads are ROWS of electron/command-registry.cjs (surface `beads`), not a
 * list typed here. They used to be: the chat bead said "Talk to Aither" while the
 * tray's "Talk to the agents" meant the microphone, and the overlay had no bead
 * because nobody remembered to type one. A bead is an id, a label and an icon
 * NAME; this file owns only how an icon name is drawn.
 */

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
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

function DesktopIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

/** Icon NAME (registry data) -> drawing. An unknown name draws the grid rather
 *  than nothing: a bead with no glyph is a button nobody can read. */
const ICONS: Record<string, () => React.ReactElement> = {
  bell: BellIcon, chat: ChatIcon, grid: GridIcon, desktop: DesktopIcon, mic: MicIcon,
};

interface CommandRow { id: string; label: string; icon: string | null; group: string }

/** What the rail shows before main answers (and in a browser preview with no
 *  bridge). Same ids the registry declares, so a click still lands. */
const FALLBACK_ROWS: CommandRow[] = [
  { id: 'inbox.open', label: 'Inbox', icon: 'bell', group: 'go' },
  { id: 'chat.open', label: 'Chat with Aither…', icon: 'chat', group: 'talk' },
  { id: 'console.open', label: 'Aither Console…', icon: 'grid', group: 'go' },
];

interface BeadDeckBridge {
  getState(): Promise<{ openCount: number }>;
  open(): void;
  action(name: string): Promise<boolean>;
  commands?(surface: string): Promise<CommandRow[]>;
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
      title={label}
      aria-label={label}
      onClick={onLeftClick}
      onContextMenu={(event) => {
        event.preventDefault();
        void bridgeDeck()?.action('menu');
      }}
    >
      {children}
      {count != null && count > 0 ? (
        <span className="bead-badge" aria-label={`${count} waiting`}>{count > 99 ? '99+' : count}</span>
      ) : null}
    </button>
  );
}

/** The floating bead cluster — bell (inbox), talk, console, drag mode.
 *  CONSOLIDATED 2026-09-13: the bell and the grid used to open the same deck
 *  panel and the chip duplicated a tray item; every bead now names ONE door
 *  that exists nowhere else on the avatar. */
export function Beads() {
  const [openCount, setOpenCount] = useState(0);
  const [rows, setRows] = useState<CommandRow[]>(FALLBACK_ROWS);

  useEffect(() => {
    const deck = bridgeDeck();
    if (!deck) return;
    let alive = true;
    // Labels carry live facts ("Inbox — 3 decisions waiting", "Hide overlay"), so
    // the rows are re-read whenever main says something changed.
    const pullRows = () => {
      void deck.commands?.('beads').then((next) => {
        if (alive && Array.isArray(next) && next.length) setRows(next);
      }).catch(() => { /* older main: keep the fallback rows */ });
    };
    pullRows();
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
          pullRows();
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

  // Gestures v5 (2026-09-18): no drag-mode state. One button, one meaning.
  const showHint = () => {
    setHintDismissed(false);
    try { window.localStorage.removeItem('desk.beads-hint-dismissed'); } catch { /* best-effort */ }
  };
  const deck = bridgeDeck();
  return (
    <div className="beads" aria-label="Desk beads">
      {rows.map((row) => {
        const Icon = ICONS[row.icon ?? ''] ?? GridIcon;
        return (
          <Bead
            key={row.id}
            label={row.label}
            count={row.id === 'inbox.open' ? openCount : undefined}
            onLeftClick={() => void deck?.action(row.id)}
          >
            <Icon />
          </Bead>
        );
      })}
      {/* Gestures v5 (2026-09-18): the ROT/MOVE toggle was the fourth gesture
          design and the owner's verdict was "I'm confused". One button, one
          meaning — left-drag MOVES a body, right-drag TURNS it, the wheel SIZES
          it, right-click opens its menu; empty space orbits. This bead only
          re-shows the legend. */}
      <Bead
        label="Gestures: left-drag moves a body · right-drag turns it · wheel sizes it · right-click its menu · empty space orbits"
        onLeftClick={showHint}
      >
        <span className="bead-mode-label">?</span>
      </Bead>
      {/* First-run discoverability: the owner asked "where are the buttons" with
          the cluster live on screen (2026-08-25) -- an edge-corner column of
          round icons does not announce itself. One dismissible note, persisted,
          so it never nags twice. */}
      {hintDismissed ? null : (
        <div className="bead-hint" role="note">
          <span>Left-drag a body to move it · right-drag to turn it · scroll to size it · right-click for its menu · drag empty space to look around · the grid opens the console</span>
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
