# Developing Desk

## Architecture

Desk has four intentionally narrow layers:

1. Native listeners discover a supported voice process and calculate a
   normalized output level.
2. The Electron main process owns lifecycle, window behavior, tray commands,
   URL handling, the local adapter, and Desk's MCP controls.
3. The sandboxed preload exposes only normalized Desk events.
4. React and Three.js render the model, blend VRMA motion, and drive VRM
   expressions.

No renderer code has filesystem, process, or raw-audio access.

## MCP contract

`electron/mcp-server.cjs` owns the Codex-facing tool schemas and translates
validated tool calls into narrow main-process callbacks. It does not receive
the Electron application object, renderer access, arbitrary animation paths, or
shell execution.

The existing loopback server routes `POST /mcp` into a fresh stateless
Streamable HTTP transport for each request. This keeps the MCP layer
request-response only: Desk does not need sessions, server-initiated
notifications, or an additional listening port.

When extending the server:

- prefer a small product action over exposing an internal Electron primitive;
- validate every argument with a closed schema;
- mark read-only and side-effecting tools accurately;
- keep the server instructions self-contained; and
- add a protocol-level client test for discovery, valid calls, and rejected
  input.

## Listener contract

All operating systems implement:

- `onSession(active)` for coarse lifecycle;
- `onActivity("listening" | "speaking")`;
- `onLevel(0..1)` for lip movement; and
- `onStatus(...)` for diagnostics.

`AudioActivityGate` owns the shared short-silence behavior. Lips follow every
level immediately. The body remains in its talking motion for 900 ms of silence
before returning to listening, preventing sentence gaps from causing abrupt
animation changes.

Linux implements the contract directly with PipeWire commands. macOS and
Windows helpers write newline-delimited JSON to stdout:

```json
{"type":"ready","source":"Windows process audio"}
{"type":"level","level":0.21}
```

## Commands

```bash
npm run lint
npm test
npm run assets:check
npm run build
npm run native:build
npm run native:test
```

`npm run check` runs the platform-neutral checks together.

The native build command:

- does nothing on Linux because the runtime uses installed PipeWire commands;
- compiles Objective-C++ against Core Audio on macOS; and
- locates Visual Studio Build Tools and compiles C++ against WASAPI on Windows.

Linux packaging detects NixOS and runs `fpm` from `nixpkgs#fpm`, avoiding the
upstream bundled FPM wrapper's `/bin/bash` assumption. Other distributions use
electron-builder's bundled packaging tool.

## Test coverage

The Node suite covers MCP discovery and tool calls, the bridge boundary, URL
protocol, Hyprland rules, PipeWire selection and PCM normalization, process
discovery on macOS and Windows, native NDJSON parsing, shared pause smoothing,
listener lifecycle, asset safety, and release checksums.

Vitest covers the stable animation replacement contract. GitHub Actions then
compiles and self-tests the native helper on its real operating system and
builds the renderer on all three platforms.

Headless CI cannot create a real Codex voice call or approve operating-system
audio permissions. Before a release, manually run the checklist in
[RELEASING.md](RELEASING.md) on each platform.

## Native API references

- Apple: [Capturing system audio with Core Audio taps](https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps)
- Microsoft: [Application loopback audio capture](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/)
