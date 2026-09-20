# Character overhaul — 2026-09-20

## Acceptance remains open

The user requires exact duplicates of the supplied references, with no toy-like primitive substitutes. No replacement model has met that requirement in this branch. All 68 identities and source portraits remain intact. Hidden surfaces must be authored consistently and reviewed; they cannot be claimed to be observed in a single front reference.

## Main-branch defects confirmed

- `Game.ts` always threw `Full Game.ts restore in progress; see artifacts` from its constructor.
- `FighterRig.ts` used one purple capsule for 67 fighters, without skin indices/weights, with only an idle clip and a no-op `play()` method.
- The high-quality Nyxalune route used an unapproved procedural shell; mobile bypassed it.
- The stylesheet omitted essential HUD, health/energy bar, modal and touch-control styling and forced a 640px minimum height.
- Portrait URLs pointed at mutable GitHub main rather than the deployed revision.

The constructor/controller is recovered from `20b8063` and adapted for asynchronous authored models. The old procedural character route is no longer imported. Its historical evidence is retained in Git history and the existing intake documents; it is not accepted art.

## Generation blocker

Provider: connected Fal account, Meshy V7 image-to-3D endpoint `meshy/v7/image-to-3d`.
The first Nyxalune pilot returned HTTP 403 `balance_exhausted`, before creating a job. No request ID or output model exists. Do not retry until the balance is replenished. Do not switch accounts.

Published base price reported by the provider was $0.80/generation; that alone is not a quotation for the complete textured, rigged 68-character batch. Check the full selected settings and actual pricing before a batch. First complete and inspect one pilot.

Pilot source: `public/characters/optimized/zukan-001-reference.png`.
Requested settings: standard model, 2k geometry, 40,000 target polygons, textures/PBR enabled, symmetry off. Texture direction: exact indigo creature, violet eyes, justice crest, ivory collar/shoulder armor, embroidered cape and tabard, gold lattice boots, curled tail; exclude room/background. No result has been accepted.

## Approval format

`public/characters/model-approvals.json` starts empty. A review candidate may use:

```json
{"zukan-001":{"status":"review"}}
```

An approved entry must additionally contain `modelSha256`, `referenceSha256` (matching the manifest), `reviewer`, `reviewedAt`, and `evidence`, an array of committed paths under `docs/character-review/`. The reviewer must be a real person or identified review process; never invent sign-off. Capture front, three-quarter, side, rear and action views, and document source-view versus inferred detail.

The asset verifier checks hashes, embedded assets, distinct model files, glTF validity, skin presence, named actions, sockets and evidence files. Runtime validation also checks every joint index, finite geometry and normalized weights, texture presence, action clips, sockets and non-flat bounds. None of these checks proves visual likeness.

## Current behavior

- Archive and title show original artwork labeled as reference artwork while models are pending. References are not combat meshes or billboards.
- No substitute creature is spawned on a missing or invalid model.
- A match preloads its exact seven-character lineup, disposes partial loads on failure/cancellation, and starts only after all models load.
- Cast/hit clips cannot be interrupted by per-frame run/idle requests; KO is terminal.
- Babylon.js provides an independent GLB comparison page at `/review.html`; it is a separate entry point and does not run a second engine in the game.

## Remaining work before merge/release

1. Generate/sculpt and refine all 68 models against the original references.
2. Author and review the five action clips and sockets on every model, preserving individualized morphology.
3. Complete matched-reference visual comparisons. Review faces, silhouettes, proportions, colors, materials, costume emblems, appendages and deformation.
4. Finish arena/environment art direction in context with final characters. The existing arena is retained; no exact-reference environment claim is made.
5. Run full rendered combat, all-six-power checks, pause/resume, results/replay and resource recovery using the final assets.
6. Validate desktop/mobile layouts and actual Galaxy A15 frame pacing and memory. Browser emulation is not physical-device evidence.
7. Pass `npm run release:check` and retain the full 68-character scope.

## Verification evidence

- Blender 4.5.14 LTS official Linux build installed at `/workspace/tools/blender-4.5.14-linux-x64/blender`. Headless startup and glTF exporter availability both passed. The OS package path failed due to a libpython package-version conflict; the official portable build succeeded.
- `npm run check`: 19/19 tests, TypeScript and Vite production build passed.
- `node scripts/verify-character-assets.mjs --require-approved`: exits 1 with 0/68 approved, as required for this incomplete branch.
- Vercel marked the first PR deployment Ready.
- Cloud browser opened the actual deployment and displayed the WebGL 2 compatibility screen. This browser cannot supply rendered 3D or mobile fidelity evidence.
- GitHub Actions job 106099084795 never started. Its check annotation states: "The job was not started because your account is locked due to a billing issue." This is an external CI blocker, not a passing gate.
- The Blender export script rejects an unrigged default scene with missing authored actions, as expected.
- Merge-ready PRs additionally run the all-68-approved asset gate; ready-for-review changes trigger the workflow.
