import { readFile, writeFile } from 'node:fs/promises';

const rosterSource = await readFile(new URL('../src/game/data/roster.ts', import.meta.url), 'utf8');
const archetypeSource = await readFile(new URL('../src/game/data/archetypes.ts', import.meta.url), 'utf8');
const rows = [...rosterSource.matchAll(/\[(\d+), '([^']+)', '([^']+)', '(earth|hydro|gale|plasma|nature|void)', '(Builder|Creator|Strategist)'\]/g)];
const priorityMatch = archetypeSource.match(/const priority: RigArchetype\[\] = \[([^\]]+)\]/);
const priority = priorityMatch?.[1]?.match(/'([^']+)'/g)?.map((value) => value.slice(1, -1)) ?? [];
const groups = new Map();
for (const match of archetypeSource.matchAll(/\s+(biped|quadruped|avian|serpentine|construct|swarm): \[([^\]]*)\]/g)) {
  groups.set(match[1], match[2].split(',').map((value) => Number(value.trim())).filter(Boolean));
}
const archetypeFor = (index) => priority.find((archetype) => groups.get(archetype)?.includes(index)) ?? 'biped';
const fighters = rows.map((match) => {
  const index = Number(match[1]);
  const id = `zukan-${String(index).padStart(3, '0')}`;
  return {
    id,
    name: match[2],
    element: match[4],
    archetype: archetypeFor(index),
    source: `/characters/optimized/${id}.webp`,
    runtime: {
      format: 'three-skinned-mesh',
      skeleton: 'zukan-unified-v2',
      visualSeed: index,
      materialSlots: ['projection', 'body', 'limb', 'accent', 'eyes'],
      actions: ['idle', 'run', 'cast', 'hit', 'ko'],
      textureRoute: 'segmented-front-projection-on-volumetric-shell',
      sockets: ['ability', 'head', 'core'],
      heroFactory: index === 1 ? 'src/game/render/generated/createNyxaluneModel.ts' : null,
    },
  };
});
if (fighters.length !== 68) throw new Error(`Expected 68 fighters, found ${fighters.length}`);
await writeFile(
  new URL('../public/characters/rig-manifest.json', import.meta.url),
  `${JSON.stringify({ schemaVersion: 1, generatedAt: '2026-08-13', fighters }, null, 2)}\n`,
);
