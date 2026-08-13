import { Vector2, Vector3 } from 'three';

import { ABILITIES, ELEMENT_ORDER } from '../data/abilities';
import type {
  CastEvent,
  DamageEvent,
  ElementKind,
  FighterDefinition,
  KnockoutEvent,
  MatchResult,
  MatchSummary,
  TeamKind,
} from '../types';

export const ARENA_BOUNDS = Object.freeze({ x: 9.2, z: 5.6 });
export const MATCH_DURATION_SECONDS = 120;
export const MAX_ENERGY = 100;
export const ENERGY_REGEN_PER_SECOND = 9.5;
export const FIGHTER_SEPARATION = 0.85;

const AI_THINK_INTERVAL = 0.14;
const MAX_TIMESTEP = 0.05;

type Cooldowns = Record<ElementKind, number>;

export interface FighterState {
  readonly id: string;
  readonly definition: FighterDefinition;
  readonly team: TeamKind;
  hp: number;
  energy: number;
  readonly position: Vector3;
  readonly velocity: Vector3;
  targetId: string | null;
  readonly cooldowns: Cooldowns;
  alive: boolean;
  score: number;
  rootedFor: number;
  slowedFor: number;
}

export interface CombatMatchSummary extends MatchSummary {
  readonly matchId: string;
  readonly seasonId: 'S01';
  readonly xp: number;
  readonly glb: number;
}

export interface CombatSimulationHooks {
  readonly onCast?: (event: CastEvent) => void;
  readonly onDamage?: (event: DamageEvent) => void;
  readonly onKnockout?: (event: KnockoutEvent) => void;
  readonly onMatchEnd?: (summary: CombatMatchSummary) => void;
}

interface PendingImpact {
  readonly casterId: string;
  readonly element: ElementKind;
  readonly target: Vector3;
  readonly resolvesAt: number;
}

function createCooldowns(): Cooldowns {
  return {
    earth: 0,
    hydro: 0,
    gale: 0,
    plasma: 0,
    nature: 0,
    void: 0,
  };
}

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

function matchIdFor(seed: number, elapsed: number): string {
  return `match-${(seed >>> 0).toString(16).padStart(8, '0')}-${Math.round(elapsed * 1_000)}`;
}

export class CombatSimulation {
  readonly fighters = new Map<string, FighterState>();
  readonly input = { movement: new Vector2(), aim: new Vector3() };
  readonly playerId: string;
  elapsed = 0;
  ended = false;

  private readonly hooks: CombatSimulationHooks;
  private readonly random: () => number;
  private readonly seed: number;
  private readonly pendingImpacts: PendingImpact[] = [];
  private aiThinkAccumulator = 0;

  constructor(
    player: FighterDefinition,
    allies: readonly FighterDefinition[],
    enemies: readonly FighterDefinition[],
    hooks: CombatSimulationHooks = {},
    seed = 0x5eed,
  ) {
    if (allies.length !== 2 || enemies.length !== 4) {
      throw new RangeError('Rift Skirmish requires one player, two allies, and four enemies.');
    }

    const definitions = [player, ...allies, ...enemies];
    if (new Set(definitions.map(({ id }) => id)).size !== definitions.length) {
      throw new RangeError('Combat fighter IDs must be unique.');
    }

    this.playerId = player.id;
    this.hooks = hooks;
    this.seed = seed >>> 0;
    this.random = makeRandom(this.seed);

    [player, ...allies].forEach((definition, index) => {
      this.addFighter(definition, 'signal', new Vector3(-6.6 + index * 1.35, 0, -1.4 + index * 1.4));
    });
    enemies.forEach((definition, index) => {
      this.addFighter(
        definition,
        'rift',
        new Vector3(5.1 + (index % 2) * 1.3, 0, -3.2 + index * 2.05),
      );
    });

    this.input.aim.copy(this.player.position).add(new Vector3(4, 0, 0));
  }

  get player(): FighterState {
    const fighter = this.fighters.get(this.playerId);
    if (!fighter) throw new Error('Player fighter is missing.');
    return fighter;
  }

  snapshot(): FighterState[] {
    return [...this.fighters.values()];
  }

  update(deltaSeconds: number): void {
    if (this.ended || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;

    const delta = Math.min(deltaSeconds, MAX_TIMESTEP);
    this.elapsed += delta;
    this.updateCooldownsEnergyAndStatuses(delta);
    this.resolvePendingImpacts();
    this.updatePlayer(delta);

    this.aiThinkAccumulator += delta;
    const shouldThink = this.aiThinkAccumulator >= AI_THINK_INTERVAL;
    if (shouldThink) this.aiThinkAccumulator = 0;

    for (const fighter of this.fighters.values()) {
      if (fighter.id !== this.playerId && fighter.alive) {
        this.updateAiFighter(fighter, delta, shouldThink);
      }
    }

    this.resolveSeparation();
    this.checkMatchEnd();
  }

  tryCast(casterId: string, element: ElementKind, target: Vector3): boolean {
    if (this.ended) return false;
    const caster = this.fighters.get(casterId);
    if (!caster?.alive) return false;

    const ability = ABILITIES[element];
    if (caster.cooldowns[element] > 0 || caster.energy < ability.energy) return false;

    const constrainedTarget = target.clone();
    constrainedTarget.y = 0;
    const offset = constrainedTarget.clone().sub(caster.position);
    if (offset.length() > ability.range) {
      constrainedTarget.copy(caster.position).add(offset.setLength(ability.range));
    }
    this.clampToArena(constrainedTarget);

    caster.cooldowns[element] = ability.cooldown;
    caster.energy -= ability.energy;
    const castEvent: CastEvent = {
      casterId,
      element,
      origin: caster.position.clone(),
      target: constrainedTarget.clone(),
      team: caster.team,
      power: caster.definition.power,
    };
    this.hooks.onCast?.(castEvent);
    this.pendingImpacts.push({
      casterId,
      element,
      target: constrainedTarget,
      resolvesAt: this.elapsed + ability.impactDelay,
    });
    return true;
  }

  private addFighter(definition: FighterDefinition, team: TeamKind, position: Vector3): void {
    this.fighters.set(definition.id, {
      id: definition.id,
      definition,
      team,
      hp: definition.maxHp,
      energy: MAX_ENERGY,
      position,
      velocity: new Vector3(),
      targetId: null,
      cooldowns: createCooldowns(),
      alive: true,
      score: 0,
      rootedFor: 0,
      slowedFor: 0,
    });
  }

  private updateCooldownsEnergyAndStatuses(delta: number): void {
    for (const fighter of this.fighters.values()) {
      if (!fighter.alive) continue;
      for (const element of ELEMENT_ORDER) {
        fighter.cooldowns[element] = Math.max(0, fighter.cooldowns[element] - delta);
      }
      fighter.energy = Math.min(MAX_ENERGY, fighter.energy + delta * ENERGY_REGEN_PER_SECOND);
      fighter.rootedFor = Math.max(0, fighter.rootedFor - delta);
      fighter.slowedFor = Math.max(0, fighter.slowedFor - delta);
    }
  }

  private updatePlayer(delta: number): void {
    const player = this.player;
    if (!player.alive) return;
    if (player.rootedFor > 0) {
      player.velocity.setScalar(0);
    } else {
      const movement = this.input.movement.clone();
      if (movement.lengthSq() > 1) movement.normalize();
      const slowMultiplier = player.slowedFor > 0 ? 0.58 : 1;
      player.velocity
        .set(movement.x, 0, movement.y)
        .multiplyScalar(player.definition.speed * slowMultiplier);
    }
    this.integrate(player, delta);
  }

  private updateAiFighter(fighter: FighterState, delta: number, shouldThink: boolean): void {
    const currentTarget = fighter.targetId ? this.fighters.get(fighter.targetId) : undefined;
    if (shouldThink || !currentTarget?.alive) {
      fighter.targetId = this.findNearestOpponent(fighter)?.id ?? null;
    }
    const target = fighter.targetId ? this.fighters.get(fighter.targetId) : undefined;
    if (!target?.alive) return;

    const direction = target.position.clone().sub(fighter.position);
    const distance = Math.max(direction.length(), 0.001);
    const desiredRange = fighter.team === 'signal' ? 3 : 3.4 + this.random() * 0.9;
    const strafe = new Vector3(-direction.z, 0, direction.x)
      .normalize()
      .multiplyScalar((this.random() - 0.5) * 0.9);
    const steering = direction
      .normalize()
      .multiplyScalar(distance > desiredRange ? 1 : distance < 2 ? -0.55 : 0.05)
      .add(strafe);

    if (fighter.rootedFor > 0) steering.setScalar(0);
    const slowMultiplier = fighter.slowedFor > 0 ? 0.58 : 1;
    const desiredVelocity = steering.multiplyScalar(fighter.definition.speed * 0.72 * slowMultiplier);
    fighter.velocity.lerp(desiredVelocity, 0.12);
    this.integrate(fighter, delta);

    const element = fighter.definition.element;
    const castChance = fighter.team === 'rift' ? 0.24 : 0.19;
    if (shouldThink && distance <= ABILITIES[element].range && this.random() < castChance) {
      const predictedTarget = target.position
        .clone()
        .addScaledVector(target.velocity, 0.2 + this.random() * 0.25);
      this.tryCast(fighter.id, element, predictedTarget);
    }
  }

  private integrate(fighter: FighterState, delta: number): void {
    fighter.position.addScaledVector(fighter.velocity, delta);
    this.clampToArena(fighter.position);
  }

  private clampToArena(position: Vector3): void {
    position.x = Math.max(-ARENA_BOUNDS.x, Math.min(ARENA_BOUNDS.x, position.x));
    position.z = Math.max(-ARENA_BOUNDS.z, Math.min(ARENA_BOUNDS.z, position.z));
  }

  private resolveSeparation(): void {
    const fighters = this.snapshot().filter(({ alive }) => alive);
    for (let firstIndex = 0; firstIndex < fighters.length; firstIndex += 1) {
      const first = fighters[firstIndex];
      if (!first) continue;
      for (let secondIndex = firstIndex + 1; secondIndex < fighters.length; secondIndex += 1) {
        const second = fighters[secondIndex];
        if (!second) continue;
        const difference = second.position.clone().sub(first.position);
        const distance = difference.length();
        if (distance > 0 && distance < FIGHTER_SEPARATION) {
          const correction = difference
            .normalize()
            .multiplyScalar((FIGHTER_SEPARATION - distance) * 0.5);
          first.position.sub(correction);
          second.position.add(correction);
        }
      }
      this.clampToArena(first.position);
    }
  }

  private resolvePendingImpacts(): void {
    for (let index = this.pendingImpacts.length - 1; index >= 0; index -= 1) {
      const impact = this.pendingImpacts[index];
      if (!impact || impact.resolvesAt > this.elapsed) continue;
      this.pendingImpacts.splice(index, 1);
      const caster = this.fighters.get(impact.casterId);
      if (caster) this.applyAbility(caster, impact.element, impact.target);
    }
  }

  private applyAbility(caster: FighterState, element: ElementKind, target: Vector3): void {
    const ability = ABILITIES[element];
    const affected = this.snapshot()
      .filter((fighter) => fighter.alive && fighter.team !== caster.team)
      .map((fighter) => ({ fighter, distance: fighter.position.distanceTo(target) }))
      .filter(({ distance }) => distance <= ability.radius)
      .sort((first, second) => first.distance - second.distance);

    if (element === 'plasma' && affected.length > 0) {
      affected.slice(0, 3).forEach(({ fighter }, index) => {
        this.damage(caster, fighter, ability.damage * (1 - index * 0.18), index === 0);
      });
      return;
    }

    for (const { fighter, distance } of affected) {
      const distanceMultiplier = 1 - (distance / ability.radius) * 0.35;
      this.damage(caster, fighter, ability.damage * distanceMultiplier, distance < ability.radius * 0.35);
      if (element === 'earth' || element === 'hydro') {
        fighter.slowedFor = Math.max(fighter.slowedFor, 1.55);
      }
      if (element === 'nature') fighter.rootedFor = Math.max(fighter.rootedFor, 1.25);
      if (element === 'gale') {
        const push = fighter.position.clone().sub(target);
        if (push.lengthSq() > 0.001) {
          fighter.position.add(push.normalize().multiplyScalar(1.15));
          this.clampToArena(fighter.position);
        }
      }
    }

    if (element === 'void' && affected.length > 0) {
      caster.hp = Math.min(caster.definition.maxHp, caster.hp + Math.min(14, affected.length * 4));
    }
  }

  private damage(
    source: FighterState,
    target: FighterState,
    baseDamage: number,
    critical: boolean,
  ): void {
    const scaledDamage = baseDamage * source.definition.power * (critical ? 1.22 : 1);
    const amount = Math.max(1, Math.round(scaledDamage));
    target.hp = Math.max(0, target.hp - amount);
    this.hooks.onDamage?.({ targetId: target.id, amount, critical });
    if (target.hp <= 0 && target.alive) {
      target.alive = false;
      target.velocity.setScalar(0);
      source.score += 1;
      this.hooks.onKnockout?.({ targetId: target.id, sourceId: source.id });
    }
  }

  private findNearestOpponent(fighter: FighterState): FighterState | undefined {
    let nearest: FighterState | undefined;
    let nearestDistanceSquared = Number.POSITIVE_INFINITY;
    for (const candidate of this.fighters.values()) {
      if (!candidate.alive || candidate.team === fighter.team) continue;
      const distanceSquared = candidate.position.distanceToSquared(fighter.position);
      if (distanceSquared < nearestDistanceSquared) {
        nearest = candidate;
        nearestDistanceSquared = distanceSquared;
      }
    }
    return nearest;
  }

  private checkMatchEnd(): void {
    const signalAlive = this.snapshot().some(({ team, alive }) => team === 'signal' && alive);
    const riftAlive = this.snapshot().some(({ team, alive }) => team === 'rift' && alive);
    if (signalAlive && riftAlive && this.elapsed < MATCH_DURATION_SECONDS) return;

    this.ended = true;
    const signalKnockouts = this.snapshot()
      .filter(({ team }) => team === 'signal')
      .reduce((total, fighter) => total + fighter.score, 0);
    const won = !riftAlive && signalAlive;
    let result: MatchResult = won ? 'win' : 'loss';
    if (!this.player.alive && !riftAlive) result = 'win';
    const duration = Math.min(this.elapsed, MATCH_DURATION_SECONDS);
    const summary: CombatMatchSummary = {
      matchId: matchIdFor(this.seed, duration),
      seasonId: 'S01',
      result,
      durationMs: Math.round(duration * 1_000),
      knockouts: signalKnockouts,
      xp: 20 + signalKnockouts * 8 + (result === 'win' ? 40 : 0),
      glb: 10 + signalKnockouts * 12 + (result === 'win' ? 100 : 0),
      rosterIds: this.snapshot().filter(({ team }) => team === 'signal').map(({ id }) => id),
    };
    this.hooks.onMatchEnd?.(summary);
  }
}
