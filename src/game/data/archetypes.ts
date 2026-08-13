import type { RigArchetype } from '../types';

const archetypeGroups: Record<RigArchetype, number[]> = {
  biped: [1, 2, 3, 4, 5, 6, 24, 28, 29, 30, 31, 32, 33, 34, 37, 38, 39, 40, 41, 43, 45, 48, 49, 50, 51, 52, 54, 55, 58, 59, 60, 61, 63, 64, 66, 67, 68],
  quadruped: [8, 9, 11, 12, 13, 15, 16, 17, 18, 19, 21, 22, 25, 26, 36, 42, 46],
  avian: [10, 20, 27, 35, 44, 47, 53, 57, 65],
  serpentine: [14, 23, 56, 62],
  construct: [32, 33, 37, 38, 42, 43, 49, 55, 64],
  swarm: [7],
};

const priority: RigArchetype[] = ['swarm', 'serpentine', 'avian', 'quadruped', 'construct', 'biped'];

export function archetypeFor(index: number): RigArchetype {
  for (const archetype of priority) {
    if (archetypeGroups[archetype].includes(index)) return archetype;
  }
  return 'biped';
}

export const ARCHETYPE_GROUPS = archetypeGroups;
