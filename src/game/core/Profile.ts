import type { CombatMatchSummary, Difficulty } from '../simulation/CombatSimulation';
import { Store } from './storage';

/** Persistent player progression: account level, currency, per-fighter mastery,
 * Zukan discoveries and Gauntlet progress. */

export interface FighterRecord {
  played: number;
  wins: number;
  knockouts: number;
  masteryXp: number;
}

export interface Profile {
  version: 2;
  xp: number;
  glimmer: number;
  matches: number;
  wins: number;
  knockouts: number;
  streak: number;
  bestStreak: number;
  fighters: Record<string, FighterRecord>;
  discovered: string[];
  gauntletBest: number;
  gauntletClears: number;
  lastFighterId: string;
  tutorialSeen: boolean;
  playSeconds: number;
}

export const DEFAULT_PROFILE: Profile = {
  version: 2,
  xp: 0,
  glimmer: 0,
  matches: 0,
  wins: 0,
  knockouts: 0,
  streak: 0,
  bestStreak: 0,
  fighters: {},
  discovered: [],
  gauntletBest: -1,
  gauntletClears: 0,
  lastFighterId: 'zukan-001',
  tutorialSeen: false,
  playSeconds: 0,
};

export const profile = new Store<Profile>('profile', DEFAULT_PROFILE);

/** XP required to advance from `level` to `level + 1`. */
export function xpToNext(level: number): number {
  return 140 + (level - 1) * 70;
}

export function levelFromXp(xp: number): { level: number; into: number; needed: number } {
  let level = 1;
  let remaining = xp;
  while (remaining >= xpToNext(level)) {
    remaining -= xpToNext(level);
    level += 1;
  }
  return { level, into: remaining, needed: xpToNext(level) };
}

export const MASTERY_THRESHOLDS = [0, 120, 360, 800, 1500] as const;
export const MASTERY_TITLES = ['Initiate', 'Bonded', 'Adept', 'Paragon', 'Ascendant'] as const;

export function masteryRank(masteryXp: number): number {
  let rank = 0;
  MASTERY_THRESHOLDS.forEach((threshold, index) => {
    if (masteryXp >= threshold) rank = index;
  });
  return rank;
}

export interface MatchRewards {
  xp: number;
  glimmer: number;
  masteryXp: number;
  levelBefore: number;
  levelAfter: number;
  masteryBefore: number;
  masteryAfter: number;
  newDiscoveries: string[];
  streak: number;
}

const DIFFICULTY_REWARD: Record<Difficulty, number> = { novice: 0.8, adept: 1, master: 1.35 };

export function computeRewards(
  summary: CombatMatchSummary,
  playerId: string,
  difficulty: Difficulty,
  bonusGlimmer = 0,
): { xp: number; glimmer: number; masteryXp: number } {
  const won = summary.result === 'win';
  const player = summary.fighters.find(({ id }) => id === playerId);
  const kos = player?.stats.knockouts ?? 0;
  const multiplier = DIFFICULTY_REWARD[difficulty];
  const xp = Math.round((45 + summary.roundsWon * 25 + kos * 12 + (won ? 70 : 0)) * multiplier);
  const glimmer = Math.round((15 + kos * 8 + (won ? 45 : 0)) * multiplier) + bonusGlimmer;
  const masteryXp = Math.round(30 + kos * 15 + (won ? 50 : 10) + (summary.mvpId === playerId ? 25 : 0));
  return { xp, glimmer, masteryXp };
}

/** Applies a finished match to the profile and reports what changed. */
export function recordMatch(
  summary: CombatMatchSummary,
  playerId: string,
  difficulty: Difficulty,
  bonusGlimmer = 0,
): MatchRewards {
  const before = profile.get();
  const { xp, glimmer, masteryXp } = computeRewards(summary, playerId, difficulty, bonusGlimmer);
  const won = summary.result === 'win';
  const record = before.fighters[playerId] ?? { played: 0, wins: 0, knockouts: 0, masteryXp: 0 };
  const player = summary.fighters.find(({ id }) => id === playerId);
  const seen = new Set(before.discovered);
  const newDiscoveries = [...summary.rosterIds, ...summary.opponentIds].filter((id) => !seen.has(id));
  const streak = won ? before.streak + 1 : 0;
  const nextRecord: FighterRecord = {
    played: record.played + 1,
    wins: record.wins + (won ? 1 : 0),
    knockouts: record.knockouts + (player?.stats.knockouts ?? 0),
    masteryXp: record.masteryXp + masteryXp,
  };
  profile.update({
    xp: before.xp + xp,
    glimmer: before.glimmer + glimmer,
    matches: before.matches + 1,
    wins: before.wins + (won ? 1 : 0),
    knockouts: before.knockouts + summary.knockouts,
    streak,
    bestStreak: Math.max(before.bestStreak, streak),
    fighters: { ...before.fighters, [playerId]: nextRecord },
    discovered: [...before.discovered, ...newDiscoveries],
    lastFighterId: playerId,
    playSeconds: before.playSeconds + summary.durationMs / 1000,
  });
  return {
    xp,
    glimmer,
    masteryXp,
    levelBefore: levelFromXp(before.xp).level,
    levelAfter: levelFromXp(before.xp + xp).level,
    masteryBefore: masteryRank(record.masteryXp),
    masteryAfter: masteryRank(nextRecord.masteryXp),
    newDiscoveries,
    streak,
  };
}

export function discover(ids: readonly string[]): string[] {
  const current = profile.get();
  const seen = new Set(current.discovered);
  const fresh = ids.filter((id) => !seen.has(id));
  if (fresh.length) profile.update({ discovered: [...current.discovered, ...fresh] });
  return fresh;
}
