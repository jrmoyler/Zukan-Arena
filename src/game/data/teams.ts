import { ELEMENT_ORDER } from './abilities';
import { ROSTER } from './roster';
import type { ElementKind, FighterDefinition } from '../types';

/**
 * Deterministic squad drafting. Picks spread across elements so matches show
 * off the roster and resonance matchups instead of mirror teams.
 */

function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
}

export function draftFighters(count: number, exclude: ReadonlySet<string>, seed: number, avoidElements: readonly ElementKind[] = []): FighterDefinition[] {
  const random = seeded(seed);
  const pool = ROSTER.filter(({ id }) => !exclude.has(id));
  const picks: FighterDefinition[] = [];
  const usedElements = new Set<ElementKind>(avoidElements);
  for (let index = 0; index < count && pool.length; index += 1) {
    const fresh = ELEMENT_ORDER.filter((element) => !usedElements.has(element));
    const wanted = fresh.length ? fresh : [...ELEMENT_ORDER];
    const element = wanted[Math.floor(random() * wanted.length)]!;
    const candidates = pool.filter((fighter) => fighter.element === element);
    const choice = (candidates.length ? candidates : pool)[Math.floor(random() * (candidates.length || pool.length))]!;
    picks.push(choice);
    usedElements.add(choice.element);
    pool.splice(pool.indexOf(choice), 1);
  }
  return picks;
}

export function draftMatch(player: FighterDefinition, allies: number, enemies: number, seed: number): { allies: FighterDefinition[]; enemies: FighterDefinition[] } {
  const exclude = new Set([player.id]);
  const allyPicks = draftFighters(allies, exclude, seed, [player.element]);
  for (const ally of allyPicks) exclude.add(ally.id);
  const enemyPicks = draftFighters(enemies, exclude, seed * 31 + 7);
  return { allies: allyPicks, enemies: enemyPicks };
}

/** The Sovereign: the sturdiest fighter not already on the player's squad. */
export function pickBoss(exclude: ReadonlySet<string>, seed: number): FighterDefinition {
  const candidates = ROSTER.filter(({ id, archetype }) => !exclude.has(id) && (archetype === 'quadruped' || archetype === 'construct'))
    .sort((a, b) => b.maxHp - a.maxHp)
    .slice(0, 6);
  const random = seeded(seed);
  return candidates[Math.floor(random() * candidates.length)] ?? ROSTER[16]!;
}
