import { Vector2, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { ABILITIES } from '../src/game/data/abilities';
import { ROSTER } from '../src/game/data/roster';
import {
  ARENA_BOUNDS,
  MATCH_DURATION_SECONDS,
  CombatSimulation,
  type CombatSimulationHooks,
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
    speed: 0,
    power: 1,
    ...overrides,
  };
}

function createSimulation(
  playerElement: ElementKind = 'earth',
  hooks: CombatSimulationHooks = {},
  seed = 0x5eed,
): CombatSimulation {
  return new CombatSimulation(
    fighter(1, playerElement, 'Builder', { speed: 10 }),
    [fighter(2, 'hydro'), fighter(3, 'gale')],
    [fighter(4, 'earth'), fighter(5, 'hydro'), fighter(6, 'gale'), fighter(7, 'plasma')],
    hooks,
    seed,
  );
}

function advance(simulation: CombatSimulation, seconds: number): void {
  let remaining = seconds;
  while (remaining > 0) {
    const step = Math.min(0.05, remaining);
    simulation.update(step);
    remaining -= step;
  }
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

describe('CombatSimulation', () => {
  it('starts the exact 3v4 formation inside the recovered arena bounds', () => {
    const simulation = createSimulation();
    const snapshot = simulation.snapshot();

    expect(snapshot.map(({ team }) => team)).toEqual([
      'signal', 'signal', 'signal', 'rift', 'rift', 'rift', 'rift',
    ]);
    const expectedPositions = [
      [-6.6, 0, -1.4], [-5.25, 0, 0], [-3.9, 0, 1.4],
      [5.1, 0, -3.2], [6.4, 0, -1.15], [5.1, 0, 0.9], [6.4, 0, 2.95],
    ];
    snapshot.forEach(({ position }, index) => {
      const expected = expectedPositions[index];
      expect(expected).toBeDefined();
      expect(position.x).toBeCloseTo(expected![0]!, 10);
      expect(position.y).toBeCloseTo(expected![1]!, 10);
      expect(position.z).toBeCloseTo(expected![2]!, 10);
    });
    expect(ARENA_BOUNDS).toEqual({ x: 9.2, z: 5.6 });
    expect(MATCH_DURATION_SECONDS).toBe(120);
  });

  it('clamps movement to bounds while regenerating 9.5 energy per second', () => {
    const simulation = createSimulation();
    simulation.input.movement.copy(new Vector2(-1, 0));

    advance(simulation, 1);

    expect(simulation.player.position.x).toBe(-9.2);
    expect(simulation.player.position.z).toBe(-1.4);
    expect(simulation.player.energy).toBe(100);
  });

  it('spends energy, starts cooldown, resolves delayed damage, and applies earth slow', () => {
    const damage: Array<{ targetId: string; amount: number; critical: boolean }> = [];
    const simulation = createSimulation('earth', { onDamage: (event) => damage.push(event) });
    simulation.input.movement.copy(new Vector2(1, 0));
    advance(simulation, 0.65);
    simulation.input.movement.set(0, 0);
    const target = simulation.snapshot().find(({ id }) => id === 'test-4');
    expect(target).toBeDefined();

    expect(simulation.tryCast('test-1', 'earth', target!.position.clone())).toBe(true);
    expect(simulation.player.energy).toBe(76);
    expect(simulation.player.cooldowns.earth).toBe(5.6);
    expect(target!.hp).toBe(200);

    advance(simulation, 0.5);

    expect(target!.hp).toBe(167);
    expect(target!.slowedFor).toBeGreaterThan(1.4);
    expect(damage).toContainEqual({ targetId: 'test-4', amount: 33, critical: true });
    expect(simulation.player.energy).toBeCloseTo(80.75, 5);
    expect(simulation.player.cooldowns.earth).toBeCloseTo(5.1, 5);
  });

  it('rejects unavailable casts and constrains cast targets to ability range and arena bounds', () => {
    const casts: Array<{ target: Vector3 }> = [];
    const simulation = createSimulation('plasma', {
      onCast: ({ target }) => casts.push({ target: target.clone() }),
    });

    expect(simulation.tryCast('test-1', 'plasma', new Vector3(500, 40, -500))).toBe(true);
    expect(simulation.tryCast('test-1', 'plasma', new Vector3())).toBe(false);
    expect(casts).toHaveLength(1);
    expect(casts[0]!.target.y).toBe(0);
    expect(casts[0]!.target.x).toBeGreaterThanOrEqual(-9.2);
    expect(casts[0]!.target.x).toBeLessThanOrEqual(9.2);
    expect(casts[0]!.target.z).toBeGreaterThanOrEqual(-5.6);
    expect(casts[0]!.target.z).toBeLessThanOrEqual(5.6);
    expect(casts[0]!.target.distanceTo(simulation.player.position)).toBeLessThanOrEqual(8.8);
  });

  it('roots with nature and knocks targets away from gale impact centers', () => {
    const natureSimulation = createSimulation('nature');
    natureSimulation.input.movement.set(1, 0);
    advance(natureSimulation, 0.65);
    natureSimulation.input.movement.set(0, 0);
    const rootedTarget = natureSimulation.snapshot().find(({ id }) => id === 'test-4')!;
    expect(natureSimulation.tryCast('test-1', 'nature', rootedTarget.position.clone())).toBe(true);
    advance(natureSimulation, 0.7);
    expect(rootedTarget.rootedFor).toBeGreaterThan(1.15);

    const galeSimulation = createSimulation('gale');
    galeSimulation.input.movement.set(1, 0);
    advance(galeSimulation, 0.65);
    galeSimulation.input.movement.set(0, 0);
    const pushedTarget = galeSimulation.snapshot().find(({ id }) => id === 'test-4')!;
    const beforeX = pushedTarget.position.x;
    const impactCenter = pushedTarget.position.clone().add(new Vector3(-1, 0, 0));
    expect(galeSimulation.tryCast('test-1', 'gale', impactCenter)).toBe(true);
    advance(galeSimulation, 0.55);
    expect(pushedTarget.position.x).toBeCloseTo(beforeX + 1.15, 5);
  });

  it('is deterministic for equal seeds and diverges for different seeds', () => {
    const first = createSimulation('earth', {}, 12345);
    const second = createSimulation('earth', {}, 12345);
    const other = createSimulation('earth', {}, 54321);
    for (const simulation of [first, second, other]) {
      for (const state of simulation.snapshot()) {
        if (state.id !== simulation.playerId) state.definition.speed = 4;
      }
    }
    advance(first, 8);
    advance(second, 8);
    advance(other, 8);

    const compact = (simulation: CombatSimulation) => simulation.snapshot().map((state) => ({
      id: state.id,
      hp: state.hp,
      energy: state.energy,
      position: state.position.toArray(),
      cooldowns: state.cooldowns,
    }));

    expect(compact(first)).toEqual(compact(second));
    expect(compact(first)).not.toEqual(compact(other));
  });

  it('ends unresolved matches at 120 seconds with the canonical reward summary', () => {
    const summaries: Parameters<NonNullable<CombatSimulationHooks['onMatchEnd']>>[0][] = [];
    const simulation = createSimulation('earth', { onMatchEnd: (summary) => summaries.push(summary) });
    simulation.player.definition.speed = 0;

    advance(simulation, 120.1);

    expect(simulation.ended).toBe(true);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      seasonId: 'S01',
      result: 'loss',
      durationMs: 120_000,
      knockouts: 0,
      xp: 20,
      glb: 10,
      rosterIds: ['test-1', 'test-2', 'test-3'],
    });
  });
});
