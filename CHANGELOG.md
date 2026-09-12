# Changelog

## 0.1.0-beta.0 - In progress

Persona's first beta is under active development.

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
