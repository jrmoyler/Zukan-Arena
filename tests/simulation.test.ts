import { Vector2, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { ABILITIES } from '../src/game/data/abilities';
import { ROSTER } from '../src/game/data/roster';
import { effectivenessOf, kitFor, ULTIMATES } from '../src/game/data/kits';
import {
  ARENA_BOUNDS,
  COUNTDOWN_SECONDS,
  CombatSimulation,
  PICKUP_HEAL,
  PILLARS,
  VITALITY_SCALE,
  type CombatEvent,
  type MatchConfig,
} from '../src/game/simulation/CombatSimulation';
import type { ElementKind, FighterDefinition, FighterRole } from '../src/game/types';

const expectedRosterNames = [
  'Nyxalune',
  'Coralyn',
  'Mallowkin',
  'Tidel Pip',
  'Cirru Bluebell',
  'Mossprig',
  'Prism Chorus',
  'Vesper Talon',
  'Sylva Crown',
  'Aeris Nightwing',
  'Tigris Undertow',
  'Brassburrow',
  'Gaiadorn',
  'Umbra Thread',
  'Axolume',
  'Oakenhart',
  'Onyx Mane',
  'Cairnhoof',
  'Terra Shell',
  'Zephyra Flare',
  'Rax Embercoil',
  'Pebbleward',
  'Riptide Wyrm',
  'Briar Owl',
  'Lunavex',
  'Dunehop',
  'Sirocco Ink',
  'Bublune',
  'Rosette Drift',
  'Helix Sprout',
  'Verdant Drake',
  'Volt Sentinel',
  'Marshal Amp',
  'Solspark',
  'Copperwing',
  'Glacielle',
  'Arcloom',
  'Auric Tinker',
  'Thornkin',
  'Redline Ravager',
  'Amethyst Rift',
  'Bastion Block',
  'Circuit Cub',
  'Skyglass',
  'Maris Bell',
  'Basalt Claw',
  'Astra Owl',
  'Nullstar',
  'Glitchwisp',
  'Luminor Loam',
  'Gilded Bud',
  'Crimson Surge',
  'Viridian Skyrake',
  'Shardshade',
  'Relay-01',
  'Aquavine',
  'Velocity Veil',
  'Quiet Mint',
  'Sunstone Scout',
  'Nimbus Drop',
  'Pale Rose Revenant',
  'Trealin Tide',
  'Cloverling',
  'Kora-9',
  'Starlace Warden',
  'Coral Pollen',
  'Hushcloak',
  'Longevita Aqua',
] as const;

function fighter(
  index: number,
  element: ElementKind,
  role: FighterRole = 'Builder',
  overrides: Partial<FighterDefinition> = {},
): FighterDefinition {
  return {
    id: `test-${index}`,
    index,
    name: `Test Fighter ${index}`,
    epithet: 'Simulation Fixture',
    element,
    role,
    archetype: 'biped',
    portrait: `/test-${index}.webp`,
    maxHp: 200,
    speed: 4,
    power: 1,
    ...overrides,
  };
}

function createSimulation(overrides: Partial<MatchConfig> = {}): CombatSimulation {
  return new CombatSimulation({
    signal: [fighter(1, 'earth'), fighter(2, 'hydro'), fighter(3, 'gale')],
    rift: [fighter(4, 'earth'), fighter(5, 'hydro'), fighter(6, 'gale')],
    difficulty: 'adept',
    roundsToWin: 2,
    roundSeconds: 75,
    seed: 0x5eed,
    ...overrides,
  });
}

/** A 1v1 duel with AI disabled so mechanics can be measured precisely. */
function createDuel(playerElement: ElementKind, enemyElement: ElementKind, overrides: Partial<MatchConfig> = {}): CombatSimulation {
  const simulation = createSimulation({
    signal: [fighter(1, playerElement)],
    rift: [fighter(4, enemyElement)],
    ...overrides,
  });
  for (const state of simulation.snapshot()) state.aiEnabled = false;
  advance(simulation, COUNTDOWN_SECONDS + 0.01);
  return simulation;
}

function advance(simulation: CombatSimulation, seconds: number): CombatEvent[] {
  const events: CombatEvent[] = [];
  let remaining = seconds;
  while (remaining > 1e-9) {
    const step = Math.min(1 / 60, remaining);
    simulation.update(step);
    events.push(...simulation.drainEvents());
    remaining -= step;
  }
  return events;
}

function place(simulation: CombatSimulation, id: string, x: number, z: number): void {
  simulation.fighters.get(id)!.position.set(x, 0, z);
}

describe('roster canon', () => {
  it('preserves the recovered 68-fighter order and unique canonical IDs', () => {
    expect(ROSTER.map(({ name }) => name)).toEqual(expectedRosterNames);
    expect(ROSTER.map(({ id }) => id)).toEqual(
      Array.from({ length: 68 }, (_, offset) => `zukan-${String(offset + 1).padStart(3, '0')}`),
    );
    expect(new Set(ROSTER.map(({ id }) => id)).size).toBe(68);
  });

  it('keeps the recovered element and role balance', () => {
    const elementCounts: Record<ElementKind, number> = {
      earth: 0,
      hydro: 0,
      gale: 0,
      plasma: 0,
      nature: 0,
      void: 0,
    };
    const roleCounts: Record<FighterRole, number> = { Builder: 0, Creator: 0, Strategist: 0 };

    for (const entry of ROSTER) {
      elementCounts[entry.element] += 1;
      roleCounts[entry.role] += 1;
    }

    expect(elementCounts).toEqual({ earth: 12, hydro: 12, gale: 11, plasma: 11, nature: 11, void: 11 });
    expect(roleCounts).toEqual({ Builder: 23, Creator: 23, Strategist: 22 });
  });

  it('derives the original live stats and rig archetypes', () => {
    expect(ROSTER[0]).toMatchObject({
      name: 'Nyxalune',
      maxHp: 114,
      speed: 4.18,
      power: 1.04,
      archetype: 'biped',
    });
    expect(ROSTER[6]).toMatchObject({ name: 'Prism Chorus', archetype: 'swarm' });
    expect(ROSTER[12]).toMatchObject({
      name: 'Gaiadorn',
      maxHp: 134,
      speed: 3.58,
      power: 0.98,
      archetype: 'quadruped',
    });
  });
});

describe('ability canon', () => {
  it('preserves all six live combat definitions', () => {
    expect(ABILITIES).toEqual({
      earth: {
        element: 'earth', label: 'Fault Crown', cooldown: 5.6, energy: 24, damage: 27,
        radius: 2.1, range: 6.7, impactDelay: 0.46,
        description: expect.any(String),
      },
      hydro: {
        element: 'hydro', label: 'Tidal Lens', cooldown: 4.9, energy: 21, damage: 21,
        radius: 2.6, range: 7.4, impactDelay: 0.48,
        description: expect.any(String),
      },
      gale: {
        element: 'gale', label: 'Silk Cyclone', cooldown: 4.2, energy: 18, damage: 17,
        radius: 3, range: 8, impactDelay: 0.5,
        description: expect.any(String),
      },
      plasma: {
        element: 'plasma', label: 'Arc Filament', cooldown: 3.8, energy: 20, damage: 23,
        radius: 1.9, range: 8.8, impactDelay: 0.23,
        description: expect.any(String),
      },
      nature: {
        element: 'nature', label: 'Verdant Bind', cooldown: 5.1, energy: 22, damage: 19,
        radius: 2.4, range: 7.2, impactDelay: 0.66,
        description: expect.any(String),
      },
      void: {
        element: 'void', label: 'Eventide Well', cooldown: 6.4, energy: 28, damage: 31,
        radius: 2.25, range: 6.5, impactDelay: 0.58,
        description: expect.any(String),
      },
    });
  });
});

describe('kits and resonance', () => {
  it('derives a four-slot kit from element and role', () => {
    const kit = kitFor({ element: 'void', role: 'Strategist' });
    expect(kit.skill).toBe(ABILITIES.void);
    expect(kit.basic.pierce).toBe(true);
    expect(kit.ultimate).toBe(ULTIMATES.void);
    expect(kit.dash.invulnerability).toBeGreaterThan(0.2);
  });

  it('forms two closed resonance triangles', () => {
    expect(effectivenessOf('earth', 'plasma')).toBe('resonant');
    expect(effectivenessOf('plasma', 'hydro')).toBe('resonant');
    expect(effectivenessOf('hydro', 'earth')).toBe('resonant');
    expect(effectivenessOf('gale', 'nature')).toBe('resonant');
    expect(effectivenessOf('nature', 'void')).toBe('resonant');
    expect(effectivenessOf('void', 'gale')).toBe('resonant');
    expect(effectivenessOf('plasma', 'earth')).toBe('resisted');
    expect(effectivenessOf('earth', 'gale')).toBe('neutral');
  });
});

describe('CombatSimulation', () => {
  it('opens each round with a countdown that freezes fighters inside the arena', () => {
    const simulation = createSimulation();
    expect(simulation.phase).toBe('countdown');
    const before = simulation.snapshot().map(({ position }) => position.clone());
    simulation.input.movement.set(1, 0);
    advance(simulation, COUNTDOWN_SECONDS - 0.1);
    simulation.snapshot().forEach(({ position }, index) => expect(position.distanceTo(before[index]!)).toBeLessThan(1e-6));
    advance(simulation, 0.2);
    expect(simulation.phase).toBe('fight');
    for (const { position, team } of simulation.snapshot()) {
      expect(Math.abs(position.x)).toBeLessThanOrEqual(ARENA_BOUNDS.x);
      expect(Math.abs(position.z)).toBeLessThanOrEqual(ARENA_BOUNDS.z);
      expect(Math.sign(position.x)).toBe(team === 'signal' ? -1 : 1);
    }
  });

  it('scales canonical vitality for combat', () => {
    const simulation = createSimulation();
    expect(simulation.player!.maxHp).toBe(Math.round(200 * VITALITY_SCALE));
    expect(simulation.player!.hp).toBe(simulation.player!.maxHp);
  });

  it('clamps player movement to the arena bounds', () => {
    const simulation = createDuel('earth', 'gale');
    simulation.input.movement.copy(new Vector2(-1, 0));
    advance(simulation, 2);
    expect(simulation.player!.position.x).toBeCloseTo(-ARENA_BOUNDS.x, 5);
  });

  it('fires basic bolts that travel, hit, and respect cooldown', () => {
    const simulation = createDuel('earth', 'gale');
    place(simulation, 'test-1', -2, 0);
    place(simulation, 'test-4', 2, 0);
    const target = simulation.fighters.get('test-4')!;
    expect(simulation.tryBasic('test-1', target.position)).toBe(true);
    expect(simulation.tryBasic('test-1', target.position)).toBe(false);
    const events = advance(simulation, 0.5);
    const hit = events.find((event) => event.type === 'damage');
    expect(hit).toMatchObject({ targetId: 'test-4', kind: 'basic', amount: kitFor({ element: 'earth', role: 'Builder' }).basic.damage });
    expect(target.hp).toBeLessThan(target.maxHp);
  });

  it('blocks bolts with porcelain pillars', () => {
    const simulation = createDuel('earth', 'gale');
    const pillar = PILLARS[0]!;
    place(simulation, 'test-1', pillar.x - 2, pillar.z);
    place(simulation, 'test-4', pillar.x + 2, pillar.z);
    expect(simulation.hasLineOfSight(simulation.player!.position, simulation.fighters.get('test-4')!.position)).toBe(false);
    simulation.tryBasic('test-1', simulation.fighters.get('test-4')!.position);
    const events = advance(simulation, 0.6);
    expect(events.some((event) => event.type === 'damage')).toBe(false);
    expect(events.some((event) => event.type === 'projectileEnd' && !event.hit)).toBe(true);
  });

  it('telegraphs signatures, spends energy, and applies canonical earth damage and slow', () => {
    const simulation = createDuel('earth', 'gale');
    place(simulation, 'test-1', -2, 0);
    place(simulation, 'test-4', 2, 0);
    const target = simulation.fighters.get('test-4')!;
    expect(simulation.tryCast('test-1', target.position.clone())).toBe(true);
    expect(simulation.player!.energy).toBe(76);
    expect(simulation.player!.cooldowns.skill).toBe(ABILITIES.earth.cooldown);
    expect(simulation.impacts).toHaveLength(1);
    expect(target.hp).toBe(target.maxHp);
    const events = advance(simulation, ABILITIES.earth.impactDelay + 0.02);
    // 27 base damage, centred (x1.22 critical), neutral matchup.
    expect(events).toContainEqual(expect.objectContaining({ type: 'damage', targetId: 'test-4', amount: 33, critical: true, kind: 'skill' }));
    expect(target.slowedFor).toBeGreaterThan(1.4);
  });

  it('scales damage by elemental resonance', () => {
    const resonant = createDuel('hydro', 'earth');
    const resisted = createDuel('hydro', 'plasma');
    for (const simulation of [resonant, resisted]) {
      place(simulation, 'test-1', -2, 0);
      place(simulation, 'test-4', 2, 0);
      simulation.tryBasic('test-1', simulation.fighters.get('test-4')!.position);
    }
    const resonantHit = advance(resonant, 0.5).find((event) => event.type === 'damage');
    const resistedHit = advance(resisted, 0.5).find((event) => event.type === 'damage');
    const bolt = kitFor({ element: 'hydro', role: 'Builder' }).basic.damage;
    expect(resonantHit).toMatchObject({ effectiveness: 'resonant', amount: Math.round(bolt * 1.25) });
    expect(resistedHit).toMatchObject({ effectiveness: 'resisted', amount: Math.round(bolt * 0.8) });
  });

  it('roots with nature and knocks fighters away from gale impact centres', () => {
    const nature = createDuel('nature', 'earth');
    place(nature, 'test-1', -2, 0);
    place(nature, 'test-4', 2, 0);
    nature.tryCast('test-1', nature.fighters.get('test-4')!.position.clone());
    advance(nature, ABILITIES.nature.impactDelay + 0.02);
    expect(nature.fighters.get('test-4')!.rootedFor).toBeGreaterThan(1.15);

    const gale = createDuel('gale', 'earth');
    place(gale, 'test-1', -2, 0);
    place(gale, 'test-4', 2, 0);
    const pushed = gale.fighters.get('test-4')!;
    gale.tryCast('test-1', new Vector3(1, 0, 0));
    advance(gale, ABILITIES.gale.impactDelay + 0.02);
    expect(pushed.position.x).toBeCloseTo(3.15, 5);
  });

  it('grants dash invulnerability that negates impacts', () => {
    const simulation = createDuel('earth', 'gale');
    place(simulation, 'test-1', -2, 0);
    place(simulation, 'test-4', 2, 0);
    const enemy = simulation.fighters.get('test-4')!;
    enemy.aiEnabled = false;
    simulation.tryCast('test-4', simulation.player!.position.clone());
    advance(simulation, ABILITIES.gale.impactDelay - 0.1);
    expect(simulation.tryDash('test-1', new Vector3(0, 0, 1))).toBe(true);
    expect(simulation.player!.invulnerableFor).toBeGreaterThan(0);
    advance(simulation, 0.15);
    expect(simulation.player!.hp).toBe(simulation.player!.maxHp);
    expect(simulation.player!.position.z).toBeGreaterThan(2);
  });

  it('charges ultimates from combat and amplifies the signature', () => {
    const simulation = createDuel('earth', 'gale');
    place(simulation, 'test-1', -2, 0);
    place(simulation, 'test-4', 2, 0);
    const player = simulation.player!;
    expect(simulation.tryUltimate('test-1', new Vector3(2, 0, 0))).toBe(false);
    player.ult = 100;
    expect(simulation.tryUltimate('test-1', new Vector3(2, 0, 0))).toBe(true);
    expect(player.ult).toBe(0);
    const events = advance(simulation, ULTIMATES.earth.impactDelay + 0.02);
    const hit = events.find((event) => event.type === 'damage' && event.kind === 'ultimate');
    expect(hit && hit.type === 'damage' ? hit.amount : 0).toBeGreaterThan(55);
    expect(simulation.fighters.get('test-4')!.stunnedFor).toBeGreaterThan(1);
    expect(player.ult).toBeGreaterThan(0);
  });

  it('awards a round on elimination and ends a best-of-three match', () => {
    const simulation = createDuel('earth', 'gale');
    const enemy = simulation.fighters.get('test-4')!;
    const finish = () => {
      place(simulation, 'test-1', -1, 0);
      place(simulation, 'test-4', 1, 0);
      enemy.hp = 1;
      simulation.tryBasic('test-1', enemy.position);
      return advance(simulation, 0.4);
    };
    const first = finish();
    expect(first).toContainEqual(expect.objectContaining({ type: 'knockout', targetId: 'test-4' }));
    expect(first).toContainEqual(expect.objectContaining({ type: 'roundEnd', winner: 'signal', round: 1 }));
    advance(simulation, 3 + COUNTDOWN_SECONDS);
    expect(simulation.round).toBe(2);
    expect(simulation.phase).toBe('fight');
    expect(enemy.hp).toBe(enemy.maxHp);
    for (const state of simulation.snapshot()) state.aiEnabled = false;
    finish();
    const tail = advance(simulation, 3.2);
    const end = tail.find((event) => event.type === 'matchEnd');
    expect(end && end.type === 'matchEnd' ? end.summary : undefined).toMatchObject({ result: 'win', roundsWon: 2, roundsLost: 0, knockouts: 2, mvpId: 'test-1' });
    expect(simulation.ended).toBe(true);
  });

  it('decides timed-out rounds on remaining vitality', () => {
    const simulation = createDuel('earth', 'gale', { roundSeconds: 5 });
    simulation.fighters.get('test-4')!.hp = 50;
    const events = advance(simulation, 5.1);
    expect(events).toContainEqual(expect.objectContaining({ type: 'roundEnd', winner: 'signal' }));
  });

  it('keeps training dummies alive and restores them', () => {
    const simulation = createDuel('earth', 'gale', { training: true });
    const dummy = simulation.fighters.get('test-4')!;
    place(simulation, 'test-1', -1, 0);
    place(simulation, 'test-4', 1, 0);
    dummy.hp = 2;
    dummy.sinceDamaged = 0;
    simulation.tryBasic('test-1', dummy.position);
    advance(simulation, 0.3);
    expect(dummy.alive).toBe(true);
    expect(dummy.hp).toBe(1);
    advance(simulation, 2.6);
    expect(dummy.hp).toBe(dummy.maxHp);
  });

  it('spawns a centre bloom that heals and charges whoever claims it', () => {
    const simulation = createDuel('earth', 'gale');
    const player = simulation.player!;
    player.hp = 100;
    const spawn = advance(simulation, 8.1);
    expect(spawn.some((event) => event.type === 'pickupSpawn')).toBe(true);
    place(simulation, 'test-1', 0, 0);
    const claim = advance(simulation, 0.05);
    expect(claim).toContainEqual({ type: 'pickup', fighterId: 'test-1' });
    expect(player.hp).toBe(100 + PICKUP_HEAL);
    expect(player.ult).toBeGreaterThan(20);
  });

  it('plays out full AI matches deterministically per seed', () => {
    const run = (seed: number) => {
      const simulation = createSimulation({ seed, playerControlled: false });
      advance(simulation, 200);
      return {
        ended: simulation.ended,
        score: { ...simulation.score },
        hp: simulation.snapshot().map(({ hp }) => hp),
        damage: simulation.snapshot().map(({ stats }) => stats.damageDealt),
      };
    };
    const first = run(12345);
    expect(first).toEqual(run(12345));
    expect(first).not.toEqual(run(54321));
    expect(first.ended).toBe(true);
    expect(first.damage.every((value) => value > 0)).toBe(true);
  });
});
