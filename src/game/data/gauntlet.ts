import type { Difficulty, MatchModifiers } from '../simulation/CombatSimulation';

/** The Rift Gauntlet: an eight-stage ladder that escalates team size, AI
 * discipline and finally a Sovereign boss. Progress persists in the profile. */

export interface GauntletStage {
  readonly index: number;
  readonly title: string;
  readonly subtitle: string;
  readonly allies: number;
  readonly enemies: number;
  readonly difficulty: Difficulty;
  readonly modifiers?: Omit<MatchModifiers, 'bossId'>;
  readonly boss?: boolean;
  readonly reward: number;
}

export const GAUNTLET: readonly GauntletStage[] = [
  { index: 0, title: 'First Light', subtitle: 'A lone challenger tests your resolve.', allies: 0, enemies: 1, difficulty: 'novice', reward: 40 },
  { index: 1, title: 'Paired Echoes', subtitle: 'Two rivals, one ally at your side.', allies: 1, enemies: 2, difficulty: 'novice', reward: 50 },
  { index: 2, title: 'The Colonnade', subtitle: 'Full squads meet beneath the arches.', allies: 2, enemies: 3, difficulty: 'adept', reward: 60 },
  { index: 3, title: 'Glass Tide', subtitle: 'The Rift sharpens its aim.', allies: 2, enemies: 3, difficulty: 'adept', modifiers: { riftHp: 1.1 }, reward: 70 },
  { index: 4, title: 'Outnumbered', subtitle: 'Hold the line with a single ally.', allies: 1, enemies: 3, difficulty: 'adept', reward: 90 },
  { index: 5, title: 'Wardens of Quiet', subtitle: 'Master-class tacticians read every telegraph.', allies: 2, enemies: 3, difficulty: 'master', reward: 100 },
  { index: 6, title: 'Eclipse Court', subtitle: 'Four champions of the Rift stand ready.', allies: 2, enemies: 4, difficulty: 'master', modifiers: { riftHp: 0.9 }, reward: 120 },
  { index: 7, title: 'The Sovereign', subtitle: 'A colossus of the Rift awakens. Break it.', allies: 2, enemies: 1, difficulty: 'master', boss: true, reward: 250 },
];
