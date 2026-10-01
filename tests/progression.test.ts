import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { computeRewards, DEFAULT_PROFILE, levelFromXp, masteryRank, profile, recordMatch, xpToNext } from '../src/game/core/Profile';
import cutouts from '../src/game/data/cutouts.json';
import { GAUNTLET } from '../src/game/data/gauntlet';
import { ROSTER } from '../src/game/data/roster';
import { draftFighters, draftMatch, pickBoss } from '../src/game/data/teams';
import { spriteDimensions } from '../src/game/render/FighterSprite';
import type { CombatMatchSummary } from '../src/game/simulation/CombatSimulation';

function summary(result: 'win' | 'loss', playerKos: number): CombatMatchSummary {
  return {
    matchId: 'match-test',
    seasonId: 'S02',
    result,
    roundsWon: result === 'win' ? 2 : 1,
    roundsLost: result === 'win' ? 0 : 2,
    durationMs: 90_000,
    knockouts: playerKos,
    mvpId: 'zukan-001',
    fighters: [
      { id: 'zukan-001', team: 'signal', stats: { damageDealt: 300, damageTaken: 120, healing: 0, knockouts: playerKos, ultimates: 1 } },
      { id: 'zukan-002', team: 'rift', stats: { damageDealt: 100, damageTaken: 300, healing: 0, knockouts: 0, ultimates: 0 } },
    ],
    rosterIds: ['zukan-001'],
    opponentIds: ['zukan-002'],
  };
}

describe('progression', () => {
  it('walks an increasing XP curve', () => {
    expect(levelFromXp(0)).toEqual({ level: 1, into: 0, needed: xpToNext(1) });
    expect(levelFromXp(xpToNext(1))).toMatchObject({ level: 2, into: 0 });
    expect(xpToNext(5)).toBeGreaterThan(xpToNext(1));
  });

  it('rewards wins, knockouts and difficulty', () => {
    const loss = computeRewards(summary('loss', 0), 'zukan-001', 'adept');
    const win = computeRewards(summary('win', 2), 'zukan-001', 'adept');
    const masterWin = computeRewards(summary('win', 2), 'zukan-001', 'master');
    expect(win.xp).toBeGreaterThan(loss.xp);
    expect(win.glimmer).toBeGreaterThan(loss.glimmer);
    expect(masterWin.xp).toBeGreaterThan(win.xp);
    expect(computeRewards(summary('win', 2), 'zukan-001', 'adept', 50).glimmer).toBe(win.glimmer + 50);
  });

  it('records matches into the profile, mastery and Zukan discoveries', () => {
    profile.reset(DEFAULT_PROFILE);
    const first = recordMatch(summary('win', 3), 'zukan-001', 'adept');
    expect(first.newDiscoveries).toEqual(['zukan-001', 'zukan-002']);
    expect(first.streak).toBe(1);
    const second = recordMatch(summary('win', 1), 'zukan-001', 'adept');
    expect(second.newDiscoveries).toEqual([]);
    const state = profile.get();
    expect(state.matches).toBe(2);
    expect(state.wins).toBe(2);
    expect(state.bestStreak).toBe(2);
    expect(state.fighters['zukan-001']).toMatchObject({ played: 2, wins: 2, knockouts: 4 });
    expect(state.xp).toBe(first.xp + second.xp);
    recordMatch(summary('loss', 0), 'zukan-001', 'adept');
    expect(profile.get().streak).toBe(0);
    expect(masteryRank(state.fighters['zukan-001']!.masteryXp)).toBeGreaterThanOrEqual(1);
    profile.reset(DEFAULT_PROFILE);
  });
});

describe('squad drafting', () => {
  it('is deterministic, unique and element-diverse', () => {
    const player = ROSTER[0]!;
    const first = draftMatch(player, 2, 3, 42);
    expect(first).toEqual(draftMatch(player, 2, 3, 42));
    const ids = [player.id, ...first.allies.map(({ id }) => id), ...first.enemies.map(({ id }) => id)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(first.allies.map(({ element }) => element)).has(player.element)).toBe(false);
    const six = draftFighters(6, new Set(), 7);
    expect(new Set(six.map(({ element }) => element)).size).toBe(6);
  });

  it('crowns a sturdy Sovereign outside the player squad', () => {
    const boss = pickBoss(new Set(['zukan-017']), 3);
    expect(boss.id).not.toBe('zukan-017');
    expect(['quadruped', 'construct']).toContain(boss.archetype);
  });

  it('escalates the Gauntlet to a single boss stage', () => {
    expect(GAUNTLET).toHaveLength(8);
    expect(GAUNTLET.filter(({ boss }) => boss)).toHaveLength(1);
    expect(GAUNTLET.at(-1)?.boss).toBe(true);
    expect(GAUNTLET.map(({ index }) => index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('HD-2D sprite assets', () => {
  it('ships a segmented cutout with layout metadata for every fighter', () => {
    const meta = cutouts as Record<string, { w: number; h: number; footX: number; footY: number; palette: string[] }>;
    for (const fighter of ROSTER) {
      const entry = meta[fighter.id];
      expect(entry, fighter.id).toBeDefined();
      expect(entry!.footX).toBeGreaterThan(0);
      expect(entry!.footX).toBeLessThan(1);
      expect(entry!.footY).toBeGreaterThan(0.8);
      expect(existsSync(new URL(`../public/characters/cutout/${fighter.id}.webp`, import.meta.url).pathname), fighter.id).toBe(true);
      const { width, height } = spriteDimensions(fighter.id);
      expect(height).toBeGreaterThanOrEqual(1.2);
      expect(height).toBeLessThanOrEqual(2.1);
      expect(width / height).toBeCloseTo(entry!.w / entry!.h, 5);
    }
  });
});
