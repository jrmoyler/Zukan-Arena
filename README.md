# Zukan Arena

An elemental 3D arena battler starring all 68 Zukan. Pick a fighter, draft a squad, and win best-of-three rounds in a porcelain colosseum — on desktop, mobile or gamepad, installed as an app, online or offline.

## Play

| Action | Keyboard & mouse | Gamepad | Touch |
| --- | --- | --- | --- |
| Move | `WASD` / arrows | Left stick | Drag the left half of the screen |
| Aim | Mouse | Right stick (or aim assist) | Automatic, or drag a skill button |
| Basic bolt | Hold left click / `J` | `RT` | Hold the gold button |
| Signature | Right click / `Q` | `X` / `LB` | Hold, drag to aim, release |
| Dash | `Space` / `Shift` | `A` / `LT` | Dash button |
| Ultimate | `E` / `R` / middle click | `Y` / `RB` | Hold ★, drag to aim, release |
| Pause | `Esc` / `P` | `Start` | Pause button |

Menus work with mouse, keyboard (arrows / Tab / Enter / Esc) and gamepad (d-pad, `A`, `B`).

## Game systems

- **Kits.** Every fighter carries four slots: a role-shaped basic bolt (Builders hit hard, Creators fire fast, Strategists pierce), the canonical elemental signature, a dash with invulnerability frames, and an ultimate charged by dealing and taking damage.
- **Telegraphs.** Signatures and ultimates mark the ground before they land. The Rift's markers are red, so you can step out or dash through them.
- **Elemental resonance.** There are two triangles: Earth › Plasma › Hydro › Earth and Gale › Nature › Void › Gale. A resonant hit deals +25% damage and a resisted hit deals −20%.
- **Arena.** Four porcelain plinths block movement and bolts. A Resonance Bloom surfaces at the centre and heals whoever claims it and charges their ultimate.
- **Rounds.** The first team to two rounds wins. A round ends on a full squad knockout, or on remaining vitality when the 75-second clock runs out.
- **Modes:**
  - **Skirmish:** 1v1, 2v2 or 3v3, against Novice, Adept or Master AI.
  - **Rift Gauntlet:** an eight-stage ladder that ends against a colossal Sovereign boss.
  - **Training Grounds:** regenerating dummies and a damage-per-second readout.
- **Progression:** Archivist level, Glimmer currency, a mastery rank for each fighter, win streaks, and a Zukan encyclopedia. You record an entry by fielding that fighter or facing it in battle.
- **AI.** It uses utility scoring. It picks targets by distance and vitality, keeps its distance by role, dodges telegraphs, uses cover, contests the Bloom, and saves ultimates for clusters. Difficulty changes reaction time, aim, dodge rate and focus fire. It never changes stats.
- **Feel.** Hit-stop, slow motion on knockouts and ultimates, trauma-based camera shake, zoom punches, cut-in banners for ultimates, a damage vignette, floating combat text and a kill feed.
- **Audio.** Everything is synthesized with Web Audio: per-element sound effects, generative menu and battle music whose battle layers respond to match intensity, and a stereo convolution reverb. There are no audio files.
- **Accessibility.** Reduced motion follows the system setting or can be forced on or off. Other options: colour-safe team colours, HUD scaling, screen-shake strength, toggles for damage numbers and aim assist, and full keyboard and gamepad navigation.

## Progressive Web App

- An installable manifest that opens fullscreen in landscape, with maskable icons.
- A hand-written service worker, emitted by `build/pwa.ts`, precaches the app shell and all 68 fighter sprites. After the first visit the game works fully offline.
- New versions wait in the background, and an in-game toast offers **Update** to switch over.
- An in-game **Install app** entry appears when the browser offers installation.

## Visual direction

Fighters are staged HD-2D-style: each original portrait is segmented into a cutout, then posed in the 3D arena as a paper-craft sprite. A custom shader gives every sprite:

- a team outline, hit flash, a dissolve on knockout and a jelly lean;
- contact occlusion where it meets the floor;
- fog and shadow casting.

All motion is procedural: breathing, hop cycles, squash and stretch, paper-turn mirroring, dash afterimages and victory hops.

## Development

Requires Node.js 24+.

```bash
npm install
npm run dev        # http://localhost:5173
npm run check      # manifest + typecheck + tests + production build
```

The service worker is only emitted by `vite build`; use `npm run build && npm run preview` to test offline behaviour.

### Art pipeline

The fighter sprites are generated offline and committed, so the game never segments images at runtime.

```bash
pip install "rembg[cpu]"
npm run generate:cutouts     # art/portraits → public/characters/cutout + src/game/data/cutouts.json
npm run generate:manifest    # public/characters/manifest.json (checked in CI)
npm run generate:icons       # PWA icons from the SVG crest (uses Playwright's Chromium)
```

## Architecture

```text
src/main.ts                    boot splash, WebGL check, App start
src/game/App.ts                shell: screens, modals, frame loop, match flow, PWA hooks
src/game/simulation/           deterministic combat model, AI, arena geometry
src/game/battle/               BattleController: sim → sprites, effects, audio, HUD
src/game/render/               Stage (renderer, camera rig, post), FighterSprite (HD-2D),
                               BattleEffects, ElementalVfx, LivingArena, MenuScene
src/game/ui/                   HUD, world overlay, screens, panels, icons
src/game/core/                 input (keyboard/mouse/gamepad/touch), settings, profile
src/game/data/                 roster, abilities, kits, gauntlet, drafting, sprite metadata
src/game/audio/AudioEngine.ts  procedural music and sound
src/pwa/register.ts            service-worker registration, install and update API
build/pwa.ts                   Vite plugin that writes dist/sw.js
art/portraits/                 source portraits (pipeline input, not deployed)
```

The simulation is the single source of truth. It advances on a fixed 60 Hz step and emits events (shots, casts, impacts, damage, knockouts, rounds). Presentation code only reads state and drains those events, so the same seed always replays the same match. This is covered by the Vitest suite.

Built with Three.js r185, Vite 8, TypeScript 7 and Vitest 4.
