# Releasing Desk

GitHub releases are produced only from version tags. The expected repository is
`https://github.com/xikhar/persona`; the workflow does not create or push to it.

## One-time repository setup

Add these GitHub Actions secrets when signed distribution is available:

| Secret | Purpose |
| --- | --- |
| `MAC_CSC_LINK` | Base64 Developer ID Application certificate |
| `MAC_CSC_KEY_PASSWORD` | Certificate password |
| `APPLE_ID` | Apple notarization account |
| `APPLE_APP_SPECIFIC_PASSWORD` | Apple app-specific password |
| `APPLE_TEAM_ID` | Apple Developer team |
| `WIN_CSC_LINK` | Base64 Windows code-signing certificate |
| `WIN_CSC_KEY_PASSWORD` | Certificate password |

Without certificates, electron-builder can create unsigned packages, but macOS
Gatekeeper and Windows SmartScreen will warn or block normal installation.
Treat signed and notarized artifacts as the production release path.

## Before tagging

1. Replace every local test character file.
2. Complete `public/assets/manifest.json` and `ASSET_LICENSES.md`.
3. Set `distributionAllowed` to `true`.
4. Update `version` in `package.json` and `package-lock.json`.
5. Add release notes to `CHANGELOG.md`.
6. Run:

   ```bash
   npm ci
   npm run check
   npm run assets:release
   npm run native:build
   npm run native:test
   ```

7. Manually verify on Linux, Windows, macOS arm64, and macOS x64:

   - install and launch;
   - first-run system audio permission where applicable;
   - supported voice process discovery;
   - idle, short pause, long pause, and resumed speech;
   - immediate lip response to output;
   - no microphone capture, duplicate sound, or saved audio;
   - close hides without quitting;
   - ending voice leaves the window open;
   - tray show, hide, preview, and quit;
   - shortcut, URL protocol, zoom, orbit, and pan;
   - transparent background and always-on-top behavior; and
   - uninstall.

## Tag and release

The tag must exactly match the package version:

```bash
git tag v0.1.0-beta.0
git push origin v0.1.0-beta.0
```

The release workflow:

1. validates license metadata and tag/version agreement;
2. reruns lint, tests, and builds;
3. compiles and self-tests native listeners;
4. creates AppImage, DEB, NSIS, DMG, and ZIP packages;
5. uploads both macOS architectures;
6. writes `SHA256SUMS.txt`; and
7. publishes one GitHub Release with generated notes.

The current test placeholders intentionally make step 1 fail.
