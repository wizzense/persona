<p align="center">
  <img src="./public/assets/avatar.png" alt="Persona avatar" width="144" />
</p>

<h1 align="center">Persona</h1>

<p align="center">
  The AitherOS desktop hub — a realtime character presence that bridges your
  desktop to the whole Aitherium world.
</p>

---

Persona began as a desktop character for voice conversations. It has grown into
the **hub that connects your physical desktop to everything else**, seamlessly,
whether the backend is aitherium.com or your own local node:

- **Avatar presence** — VRM characters with lip-sync, reacting to any app's
  voice output (the original core, still here).
- **Living Desktop host** — one tray switch between the Living Desktop,
  Desktop Anywhere, the AitherShell cockpit, and GobboNet, rendered over your
  real desktop (ghost mode) or in their own windows.
- **Agent embodiment** — the local MCP server (`:47831`) lets any agent drive
  the avatar, and the bridge server relays voice/animation events from native
  listeners.
- **Decision cards** — the tray tracks the open decision-card queue
  (`~/.aither/decisions`), raises a native notification when an agent needs
  you, and one click opens the shared answer window (see
  `electron/decision-cards.cjs`).

## Platform support

| Platform    | Automatic voice output listener | Distribution               |
| ----------- | ------------------------------- | -------------------------- |
| Linux       | PipeWire process-stream capture | AppImage and DEB           |
| Windows     | WASAPI process-loopback capture | NSIS installer             |
| macOS 14.2+ | Core Audio process tap          | DMG and ZIP, arm64 and x64 |

Linux requires `pw-dump` and `pw-record` on `PATH`. Windows process-loopback
requires Windows 10 build 20348 or newer. macOS asks once for System Audio
Recording permission.

Each listener is scoped to the supported application's playback process. Persona
does not capture the microphone, save audio, produce speech, transcribe content,
or send audio over the network.

## Try Persona locally

Requirements:

- Node.js 24 or newer
- npm
- A desktop session with hardware-accelerated graphics

Character media is not part of the repository. Before launching, place local
test media or redistributable media in the exact slots documented below.

```bash
npm install
npm run demo
```

`npm run demo` builds the current renderer and launches Persona with normal
automatic voice-output detection.

For a background launch:

```bash
npm start -- --background
```

## Connect Persona to Codex

With Persona running, register its local MCP server:

```bash
codex mcp add persona --url http://127.0.0.1:47831/mcp
```

New Codex sessions can then ask Persona to play an installed animation, show or
hide its window, and report whether the local character and voice listener are
active. Persona remains a separate desktop application; the MCP connection
only exposes its own visual controls.

The window intentionally contains no controls:

- Scroll to zoom.
- Left-drag to orbit.
- Right-drag to pan.
- Use your window manager's move gesture to reposition the window.

On Hyprland, Persona also applies floating, pinned, topmost, full-opacity,
no-blur, no-shadow, and decoration-free properties. macOS uses an all-Spaces
topmost window. Other desktops use the strongest supported Electron window
hints.

## Build native packages

Build on the operating system you are targeting:

```bash
npm run dist:linux
npm run dist:windows
npm run dist:mac
```

Outputs are written to `release/`. Windows needs Visual Studio Build Tools with
the C++ desktop workload. macOS needs Xcode Command Line Tools and macOS 14.2+
SDK support.

GitHub Actions runs the full JavaScript, renderer, native compile, and native
self-test suite on Linux, Windows, and macOS. Prerelease tags shaped like
`v0.1.0-beta.0` create native packages and a checksum file, but only after the
asset release gate passes. See [Releasing](docs/RELEASING.md).

## Replace the character assets before publishing

Character media is intentionally excluded from Git. Local test files must not
be distributed. Persona's stable replacement slots are:

```text
assets/
├── model.vrm
├── manifest.json
└── animations/
    ├── idle.vrma
    ├── talk1.vrma
    ├── talk2.vrma
    ├── talk3.vrma
    ├── greeting.vrma
    ├── happy.vrma
    ├── finger-gun.vrma
    └── dance.vrma
```

Replace files in place, then complete every license and source field in
`manifest.json` and set `distributionAllowed` to `true`. Remove the VRM and
VRMA ignore rules only when those exact files are safe to publish. The release
workflow will fail closed until then. Read [Asset licenses](ASSET_LICENSES.md).

## Development

```bash
npm run check
npm run native:build
npm run native:test
```

The native listener is required before running Persona from source on macOS or
Windows. Linux captures activity through PipeWire and does not build a helper.

More detail:

- [Architecture and development](docs/DEVELOPMENT.md)
- [Codex and integration API](docs/INTEGRATIONS.md)
- [Release process](docs/RELEASING.md)
- [Security policy](SECURITY.md)

Persona application source is licensed under the [MIT License](LICENSE).
Bundled character assets are excluded from that license and remain test-only
until replaced and documented.
