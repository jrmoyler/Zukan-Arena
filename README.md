# Zukan Arena — reference reconstruction (draft)

**This branch is not release-ready. All 68 reference portraits are retained, but no replacement character GLBs are approved yet. Matches deliberately do not start with missing character models.**

Main at `e41cef8` contained a constructor that always threw and a shared purple capsule recovery rig. This branch restores the complete menu/combat controller, removes that rig, and introduces an authored GLB pipeline. It does not claim the requested exact-reference overhaul is complete.

## Tools

Node.js 24+, Three.js (game renderer), Anime.js (menu motion), Babylon.js (independent model comparison in `/review.html`), Blender (authored mesh/rig export), glTF Transform and Khronos glTF Validator (asset preparation and validation).

```sh
npm ci
npm run dev
npm run check
```

`npm run check` verifies code and any approved assets. It is **not** visual acceptance. `npm run release:check` additionally requires all 68 characters to have hash-bound approvals and evidence; it currently fails intentionally because every character is pending.

## Reconstruction pipeline

1. Use the original portrait in `public/characters/optimized/` as the identity reference. Generate or sculpt a bespoke volumetric mesh. Do not substitute common primitive rigs, portrait billboards, or projected artwork wrapped over generic anatomy.
2. Refine in Blender. Author UV/PBR materials, skeletal weights, `idle`, `run`, `cast`, `hit`, `ko` actions and `socket_ability`, `socket_head`, `socket_core` attachments.
3. Export with `scripts/blender-character-export.py`, then run `node scripts/prepare-character.mjs source.glb public/characters/models/zukan-NNN.glb`. Keep the original source outside the runtime assets. No automatic geometry decimation is performed.
4. Mark the character `review` in `model-approvals.json` to examine the GLB beside its reference in `/review.html`. The main game accepts only `approved` entries.
5. Capture matched-camera evidence, inspect animation deformation and test in Three.js. Record actual approval evidence and SHA-256 hashes as documented in `docs/character-overhaul.md`. Never mark models approved solely because a tool generated them or automated checks pass.
6. Run `npm run release:check` before release.

## Preserved combat rules

The recovered controller retains the 3v4 Rift Skirmish simulation, 120-second matches, six elemental abilities, energy/cooldown/damage rules, aim, touch movement, pause, results and the 68-member roster. These rules pass simulation tests; end-to-end combat rendering still needs the replacement GLBs.

WASD/arrows move; pointer aims; click/Space casts; 1–6 cast elemental forces; Escape pauses. Touch uses the directional pad and force buttons. Missing assets keep the archive available and prevent an incomplete match from starting.

## Known blocker

The reference-to-3D pilot was rejected before job creation because the connected Fal account has exhausted its balance. No generation job was started, and no reconstruction results exist. See `docs/character-overhaul.md` for the exact next steps and open acceptance gates.
