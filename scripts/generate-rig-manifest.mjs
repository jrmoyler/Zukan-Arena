import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../', import.meta.url);
const source = await readFile(new URL('src/game/data/roster.ts', root), 'utf8');
const approvals = JSON.parse(await readFile(new URL('public/characters/model-approvals.json', root), 'utf8'));
const rows = [...source.matchAll(/\[(\d+), '([^']+)', '([^']+)', '(earth|hydro|gale|plasma|nature|void)', '(Builder|Creator|Strategist)'\]/g)];
const fighters = await Promise.all(rows.map(async (match) => {
  const id = `zukan-${match[1].padStart(3, '0')}`;
  const reference = `characters/optimized/${id}.webp`;
  const bytes = await readFile(new URL(`public/${reference}`, root));
  return {
    id, name: match[2], element: match[4], source: `/${reference}`,
    sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    runtime: {
      format: 'glb', model: `/characters/models/${id}.glb`,
      status: approvals[id]?.status ?? 'pending',
      actions: ['idle', 'run', 'cast', 'hit', 'ko'],
      sockets: ['socket_ability', 'socket_head', 'socket_core'],
      fallback: null,
    },
  };
}));
if (fighters.length !== 68) throw new Error(`Expected 68 fighters, got ${fighters.length}`);
await writeFile(new URL('public/characters/rig-manifest.json', root), `${JSON.stringify({ schemaVersion: 2, fighters }, null, 2)}\n`);
