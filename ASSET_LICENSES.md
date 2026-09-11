# Desk asset licenses

The MIT license covers Desk's application source. It grants no rights to any
VRM or VRMA file — and Desk ships none.

## Desk ships no character models

Owner decision, 2026-09-10: no character is bundled, by default or otherwise.
The app loads a model **you** provide, under **your** license:

- **Get one from VRoid Hub** — <https://hub.vroid.com/en/> — or export your own
  with VRoid Studio (<https://vroid.com/en/studio>). Any VRM 1.0 file you have
  the rights to works.
- Enroll it at runtime: tray ▸ **Characters ▸ Enroll newest Downloads .vrm**,
  `install-model.ps1 <file>`, or the VRoid Hub flow in the desk panel
  (`vroid-sync.py`). It lands in `characters/<slug>/model.vrm`, and the app
  copies it into `public/assets/` to render — both paths are gitignored and
  per-user.
- Verify your model's own embedded license
  (`extensions.VRMC_vrm.meta` ⇒ `license`, `avatarPermission`,
  `creditNotation`) before relying on commercial use or redistribution —
  `character.json` sidecars are not licenses.

## Animations — never redistributed

The `.vrma` animation files (idle, talk1–3, greeting, happy, finger-gun,
dance) are VRoid Hub "personality motions". They are downloaded per-user
through VRoid Hub's own license flow at character-enroll time
(`vroid-sync.py`, `install_motions`) and their redistribution terms are not
ours to grant. Therefore:

- they are intentionally ignored by Git and absent from every release
  package — a fresh install has no animation files;
- the renderer tolerates their absence: `useVrmAnimation.play` logs
  `[desk] animation load failed` and completes once-callbacks without
  crashing, and the avatar stays in its idle pose;
- enrolling any character from the roster fills the animation slots for that
  user, under that user's own VRoid Hub license.

The asset contract (`scripts/check-assets.cjs`) asserts the inverse of its
former rule: `manifest.assets` is empty and a release **fails** if any
`.vrm`/`.vrma` is present under `public/assets/` — "ships no models" is
checked, not assumed.

## Bundled environment

Desk includes the `dawn.exr` environment from `@pmndrs/assets`. The asset
collection is published under CC0 1.0 and sources its HDR environments from
Poly Haven.

## Previously bundled (archived attribution)

Releases up to and including `v0.1.0-beta.0` shipped `public/assets/model.vrm`,
"Gyigi" v1.1 by Robotnik (VRoid Hub), redistributed under the VRM 1.0 license
in its embedded metadata, which required credit. The attribution is archived
here because those releases keep that obligation; current releases contain no
model and no such obligation.
