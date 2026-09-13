# Changelog

## 0.1.1 - 2026-09-13

- Hair no longer floats after a reboot: the avatar's saved SCALE was the cause.
  three-vrm's spring bones compare collider radii in model units against world
  distances, so a 0.3x avatar wore a 3x head collider that shoved every hair
  chain outward. Spring constants and collider radii now follow the scale.
- One command center. The Aither Console is the front door (tray: double-click
  or "Aither Console…"); its first pane is the Inbox — decision cards and the
  agents' #agents messages. The tray, the avatar's right-click menu and the
  floating beads each list only what lives nowhere else: the tray is console /
  inbox / show-hide / characters; the avatar menu is talk, camera, its window
  and characters; the beads are inbox, talk, console, drag mode.
- A real notification area: the inbox count is drawn on the tray icon, on the
  console's taskbar button (overlay badge) and on its Inbox tab — the same
  number everywhere, from one source.

## 0.1.0 - 2026-09-12

Desk's first release.

- Realtime character animation and amplitude-driven lip sync.
- PipeWire, WASAPI process-loopback, and Core Audio process-tap listeners.
- Transparent desktop presence with manual lifecycle, tray controls, shortcut,
  URL protocol, always-on-top behavior, zoom, orbit, and pan.
- Short-silence speech holding and smooth animation crossfades.
- Bring your own character: no model ships with Desk. Enroll any VRM you have
  the rights to — [VRoid Hub](https://hub.vroid.com/en/) is the guided path —
  and it is stored per-user, never redistributed. The release gate fails
  closed if a model is present.
- Hair, tails and tool chains hang naturally: springs that carry no authored
  gravity (the VRM default) get VRoid Studio's default instead of holding
  whatever level pose the file was authored in.
- Stable, replaceable model and animation slots with a strict release asset
  gate.
- Linux, Windows, macOS arm64, and macOS x64 validation and release workflows.
- The Aither Console: one window over Command, Fleet, Sessions, Cards, Chat and
  the Living Desktop — every pane detachable and reattachable.
- A Sessions pane: the unified directory of every Claude Code session on the
  machine (daemon-owned runs and discovered terminal tabs), with live
  transcript tails and each session's honest steering capability.
- Agent commands answer on the backend YOU chose (a launcher-resolved profile)
  instead of the default sign-in; Fleet status probes retry under load and
  label stale numbers instead of showing "?".
