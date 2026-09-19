# Desk UI/UX reimplementation

Owner, 2026-09-18: *"the whole UI/UX is starting to just become a stacked mess of
things — we need a real proper reimplementation that makes this actually functional."*

This is the plan. It is written against what the tree MEASURES today, not against
a memory of it.

## What is actually wrong (measured 2026-09-18)

| measure | today | why it hurts |
|---|---|---|
| `electron/main.cjs` | 2,461 lines | every surface is orchestrated from one file |
| `new BrowserWindow(...)` | 10, across 7 modules | each window has its own lifecycle, its own idea of "open" |
| preload bridges | 6 | six different APIs for the same shell |
| `ipcMain` channels | 43 | no registry: a capability exists wherever someone wired it |
| menus that list capabilities | 3 (tray, avatar right-click, console bar) | consolidated once on 09-13; the duplication came back |
| `src/components/Deck.tsx` | 1,431 lines | the "panel" is one scrolling component, not a set of routes |
| renderer modes | `?deck=1`, `?chat=1`, avatar | the same bundle means three different apps |

Two defects fixed today are the SHAPE of the problem, not exceptions:

1. **Reattach did not repaint.** Two places held "is this pane detached": the shell's
   DOM and main's window list. Main answered from a stale read (`BrowserWindow.close()`
   is async) and the shell left the placeholder painted over the pane that came back.
   *Two owners of one fact.*
2. **Window size became unreachable.** It hung off exactly ONE gesture — a right-click
   that lands on an avatar body and travels under 6 px — plus two global shortcuts whose
   registration result was discarded. A gesture change on the same day removed it.
   *An affordance with one entry point and no inventory.*

Neither is a visual problem. Both are **missing structure**: nothing in the codebase can
answer "where does this capability appear?" or "where is this surface right now?".

## The shape to build

### 1. One command registry (the spine)

Every capability becomes a declared record, in one module, with no UI in it:

```js
{ id: "window.size.large", label: "Large", scope: "avatar-window",
  surfaces: ["tray", "avatar-menu", "palette"], accel: null, run: () => setWindowSize(800, 1266) }
```

The tray menu, the avatar menu, the console bar and a new **command palette** are all
RENDERED from this list. Duplication becomes data (`surfaces: [...]`), and a capability
that appears nowhere, or in exactly one place, is a test failure rather than a discovery
three weeks later.

### 2. One surface state machine (routes and presentations)

A surface is a **route** (`inbox`, `command`, `fleet`, `sessions`, `chat`, `desktop`,
`stage`). Where it currently lives is a **presentation**: `embedded` (console pane),
`detached` (own window), `overlay` (transparent, click-through) or `hidden`. One module
owns that map, answers `presentationOf(route)`, and emits a change event. The shell and
main both READ it; neither keeps a second copy. Reattach becomes a state transition that
cannot half-land, because there is only one place for it to land.

Standalone windows stop being separate features: `command-window.cjs`,
`fleet-window.cjs`, `sessions-window.cjs`, the deck window and the chat window all become
the `detached` presentation of their route.

### 3. One palette, so no capability is gesture-only

`Ctrl+K` in any Desk window opens the palette over the registry: type "size", get the
presets; type "inbox", go there. Gestures and context menus stay as accelerators for the
mouse — never as the only path.

### 4. The Deck decomposes into routes

`Deck.tsx` (1,431 lines) splits per section (decisions, relay, room, wakes, models). Each
becomes a console route with its own file; the console's rail is the navigation the deck's
scroll position is doing badly today.

### 5. The stage gets real chrome

The avatar stage keeps gestures (left-drag move, right-drag turn, wheel scale) and gains a
visible, non-gestural strip: size, zoom-to-fit, reset layout, per-body menu. The window has
no OS edge to grab — that is a deliberate consequence of frameless + transparent — so the
chrome IS the edge.

## Slices (each shippable, each with a check that can fail)

| # | slice | done when |
|---|---|---|
| 0 | **stop-gaps (landed 2026-09-18)** | reattach repaints; size is on the tray; `console-smoke` drives the BUTTONS and reads the DOM; `window-size-reach.test.cjs` |
| 1 | **command registry + palette (landed 2026-09-18)** — `command-registry.cjs`; tray and size menu rendered from it; Ctrl+K palette in the console | `conformance()` refuses a single-surface command with no written reason; the smoke opens the palette, filters it and runs a command |
| 2 | **surface state machine (landed 2026-09-18)** — `electron/surface-state.cjs` owns where every route is; main pushes the map, the shell renders it | `surface-state.test.cjs` (8 arms); the smoke closes a detached window from OUTSIDE and the rail un-detaches itself — that arm FAILS on the pre-slice-2 files |
| 3 | Deck decomposition into routes; standalone windows become `detached` presentations | no `new BrowserWindow` outside the presentation layer; `main.cjs` under ~1,200 lines |
| 4 | visual pass: one layout grammar, one type scale, dark-first tokens, stage chrome | every surface uses the shared tokens; no per-window CSS colours |
| 5 | gates | palette reachability, keyboard-only pass, and the smoke run wired into `npm run check` |

## Rules this plan is holding itself to

- **One owner per fact.** Every duplicated piece of state gets deleted, not synchronised.
- **No capability with one entry point.** The registry makes that mechanically checkable.
- **A reply is not the UI.** Checks drive the controls the owner uses and then read what
  is on screen — the bridge-level assertion is what let the reattach bug ship.
- **Nothing is reimplemented twice.** A detached window shows the same page the pane does;
  that is why a pane cannot drift from its twin.
