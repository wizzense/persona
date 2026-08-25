# Desk asset licenses

The MIT license covers Desk's application source. It does not grant rights
to the VRM or VRMA files under `public/assets/`.

## Bundled default character — Gyigi by Robotnik

`public/assets/model.vrm` is redistributed under the VRM 1.0 license recorded
in the file's own embedded metadata (verified 2026-08-25 by direct glb
inspection of `extensions.VRMC_vrm.meta`):

| field | value |
|---|---|
| name | Gyigi v1.1 |
| author | Robotnik (contact: Discord `baldy.mcnosehair`) |
| license reference | https://vrm.dev/licenses/1.0/ |
| commercialUsage | `corporation` — corporate commercial use permitted |
| allowRedistribution | `true` |
| creditNotation | `required` — see attribution below |
| modification | `allowModificationRedistribution` |
| avatarPermission | `everyone` |
| political/religious use | disallowed by author |
| antisocial/hate use | disallowed by author |

**Attribution (required by the author):** *"Gyigi" v1.1 by Robotnik — VRoid Hub*.
This attribution is reproduced in the application's About surface and in the
release notes. If the default model is ever replaced, move this attribution to
the archive below rather than deleting it.

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

The stable asset contract (`scripts/check-assets.cjs`) reflects this: exactly
one redistributed asset (`model.vrm`) is required and licensed; runtime media
(animations, `model-slot<N>.vrm` slot copies) is allowed but never required.

## Bundled environment

Desk includes the `dawn.exr` environment from `@pmndrs/assets`. The asset
collection is published under CC0 1.0 and sources its HDR environments from
Poly Haven.

## Replacing the default model

Use the exact filename `model.vrm` so no code change is needed. Then:

1. Verify the new file's EMBEDDED VRM meta (`extensions.VRM.meta` or
   `extensions.VRMC_vrm.meta`) permits corporate commercial use AND
   redistribution — character.json sidecars are NOT licenses.
2. Edit `public/assets/manifest.json`: `license` (the embedded license
   reference plus its material terms) and `source` (author + origin).
3. If the author requires credit, add the attribution above and to the About
   surface before tagging.
4. Run `npm run assets:release`.

The release gate enforces the metadata and the distribution flag; verifying
the embedded license is the repository author's job, which this file documents
because the check cannot read inside a glb.
