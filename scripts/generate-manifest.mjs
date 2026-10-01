#!/usr/bin/env node
/**
 * Writes public/characters/manifest.json: the public contract describing every
 * fighter and its HD-2D sprite (dimensions, foot anchor, palette). CI fails if
 * the committed manifest drifts from the roster or the cutout metadata.
 */
import { readFile, writeFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const rosterSource = await read('../src/game/data/roster.ts');
const archetypeSource = await read('../src/game/data/archetypes.ts');
const cutouts = JSON.parse(await read('../src/game/data/cutouts.json'));

const rows = [...rosterSource.matchAll(/\[(\d+), '([^']+)', '([^']+)', '(earth|hydro|gale|plasma|nature|void)', '(Builder|Creator|Strategist)'\]/g)];
const priority = archetypeSource.match(/const priority: RigArchetype\[\] = \[([^\]]+)\]/)?.[1]?.match(/'([^']+)'/g)?.map((value) => value.slice(1, -1)) ?? [];
const groups = new Map();
for (const match of archetypeSource.matchAll(/\s+(biped|quadruped|avian|serpentine|construct|swarm): \[([^\]]*)\]/g)) {
  groups.set(match[1], match[2].split(',').map((value) => Number(value.trim())).filter(Boolean));
}
const archetypeFor = (index) => priority.find((archetype) => groups.get(archetype)?.includes(index)) ?? 'biped';

const fighters = rows.map(([, index, name, epithet, element, role]) => {
  const id = `zukan-${String(index).padStart(3, '0')}`;
  const sprite = cutouts[id];
  if (!sprite) throw new Error(`Missing cutout metadata for ${id}; run npm run generate:cutouts`);
  return {
    id,
    name,
    epithet,
    element,
    role,
    archetype: archetypeFor(Number(index)),
    sprite: {
      src: `/characters/cutout/${id}.webp`,
      width: sprite.w,
      height: sprite.h,
      foot: [sprite.footX, sprite.footY],
      palette: sprite.palette,
    },
  };
});
if (fighters.length !== 68) throw new Error(`Expected 68 fighters, found ${fighters.length}`);
await writeFile(
  new URL('../public/characters/manifest.json', import.meta.url),
  `${JSON.stringify({ schemaVersion: 2, renderer: 'hd2d-cutout', fighters }, null, 2)}\n`,
);
console.log(`Wrote manifest for ${fighters.length} fighters.`);
