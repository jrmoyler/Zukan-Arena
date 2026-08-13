# Solana Zukan Arena 3D

A game-first reconstruction of the original Zukan Arena as a living 3D arena battler. The wallet gate and card billboards are gone: all 68 fighters now enter combat as textured `THREE.SkinnedMesh` characters with real bone weights, shared action contracts, morphology-specific bodies, physical materials, shadows, sockets, and hit volumes.

## Play

- Move with WASD or arrow keys.
- Aim with the pointer and click (or press Space) to cast.
- Press 1–6 to cast Fault Crown, Tidal Lens, Silk Cyclone, Arc Filament, Verdant Bind, or Eventide Well.
- Press Escape to pause. Losing window focus pauses safely.
- Touch controls and tap-to-cast are enabled on narrow screens.

Each match is the recovered 3v4 Rift Skirmish: 120 seconds, 100 maximum energy, 9.5 energy regenerated per second, and the original cooldown, radius, range, impact timing, damage, slow, root, knockback, chain and drain behavior.

## What changed

- Six morphology routes: biped, quadruped, avian, serpentine, construct, and swarm.
- Five skeletal actions on every fighter: idle, run, cast, hit and KO.
- Image-derived, background-segmented front projections wrapped onto volumetric meshes—never camera-facing portrait planes in combat.
- A procedural PBR Porcelain Biome Colosseum with limestone, ceramic, bronze, traction stone, water channels, foliage, banners, pollen and crowd drones.
- Rebuilt elemental effects with deterministic, bounded pools and reduced-motion variants.
- A searchable, filterable 68-fighter archive with a large realtime 3D preview, identity, stats and signature ability.
- Game-first boot: no wallet or chain connection is required.

## Reconstruction scope

The supplied references are single, opaque, mostly front-facing portraits; 20 are below 256 px in at least one dimension. A single image cannot contain the hidden rear/side anatomy needed for exact 360-degree recovery. The runtime therefore preserves the visible likeness through front-projected texture evidence and uses art-directed, element-matched material continuation on unseen surfaces. Nyxalune is the audited `img2threejs` hero specimen with camera solution, landmark extraction, detail inventory, strict sculpt specification and extracted PBR evidence in `docs/`.

See `public/characters/rig-manifest.json` for the complete fighter-to-skeleton contract.

## Development

Requires Node.js 24 or newer.

```bash
npm install
npm run dev
```

Production verification:

```bash
npm run check
```

This runs strict TypeScript, Vitest parity/rig-contract tests, and the Vite production build.

## Architecture

```text
src/game/data/             canonical roster and six abilities
src/game/simulation/       deterministic combat authority
src/game/render/           living arena, skinned rigs and elemental VFX
src/game/audio/            synthesized cast and impact sound
src/game/Game.ts           renderer, input, camera and UI orchestration
public/characters/         68 source portraits and runtime rig manifest
docs/                      img2threejs evidence and reconstruction contract
```

Built with Three.js r185, Vite 8, TypeScript 7, Vitest 4 and Rapier 0.20.

