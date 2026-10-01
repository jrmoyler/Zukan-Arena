import { Vector2, Vector3 } from 'three';

import {
  effectivenessMultiplier,
  effectivenessOf,
  kitFor,
  type Effectiveness,
  type FighterKit,
} from '../data/kits';
import type { ElementKind, FighterDefinition, MatchResult, TeamKind } from '../types';
import { createAiMemory, thinkAi, type AiMemory, type AiProfile, AI_PROFILES } from './ai';
import { ARENA_BOUNDS, PICKUP_RADIUS, PILLARS } from './arena';

export { ARENA_BOUNDS, PICKUP_RADIUS, PILLARS };

/** Authoritative, deterministic combat model. Rendering, audio and UI only read
 * state and drain events; nothing outside this file mutates combat numbers. */

export const MAX_ENERGY = 100;
export const ENERGY_REGEN_PER_SECOND = 9.5;
export const FIGHTER_RADIUS = 0.42;
export const FIGHTER_SEPARATION = FIGHTER_RADIUS * 2;
export const COUNTDOWN_SECONDS = 3;
export const ROUND_END_SECONDS = 2.8;
export const SLOW_MULTIPLIER = 0.58;
export const DEEP_SLOW_MULTIPLIER = 0.4;
export const PICKUP_RESPAWN_SECONDS = 16;
export const PICKUP_HEAL = 60;
export const PICKUP_ULT = 22;
export const ULT_PER_DAMAGE_DEALT = 0.32;
export const ULT_PER_DAMAGE_TAKEN = 0.2;
/** Combat vitality is the roster's canonical vitality scaled for 30–45s rounds. */
export const VITALITY_SCALE = 3.2;


const MAX_TIMESTEP = 0.05;
const AI_THINK_INTERVAL = 0.1;

export type Difficulty = 'novice' | 'adept' | 'master';
export type MatchPhase = 'countdown' | 'fight' | 'roundEnd' | 'ended';
export type AttackKind = 'basic' | 'skill' | 'ultimate';
export type StatusKind = 'slow' | 'root' | 'stun' | 'knockback';

export interface FighterStats {
  damageDealt: number;
  damageTaken: number;
  healing: number;
  knockouts: number;
  ultimates: number;
}

export interface FighterState {
  readonly id: string;
  readonly definition: FighterDefinition;
  readonly team: TeamKind;
  readonly kit: FighterKit;
  readonly maxHp: number;
  readonly power: number;
  /** Visual and hitbox scale; bosses are larger. */
  readonly scale: number;
  readonly boss: boolean;
  hp: number;
  energy: number;
  ult: number;
  readonly position: Vector3;
  readonly velocity: Vector3;
  /** Unit vector on the ground plane the fighter is aiming toward. */
  readonly facing: Vector3;
  readonly cooldowns: { basic: number; skill: number; dash: number };
  dashTime: number;
  readonly dashDirection: Vector3;
  dashSpeed: number;
  invulnerableFor: number;
  slowedFor: number;
  slowMultiplier: number;
  rootedFor: number;
  stunnedFor: number;
  /** Seconds since this fighter last took damage (training dummies use it). */
  sinceDamaged: number;
  alive: boolean;
  /** True while a signature or ultimate is winding up. */
  castingFor: number;
  readonly stats: FighterStats;
  readonly ai: AiMemory;
  aiEnabled: boolean;
}

export interface Projectile {
  readonly id: number;
  readonly ownerId: string;
  readonly team: TeamKind;
  readonly element: ElementKind;
  readonly position: Vector3;
  readonly velocity: Vector3;
  readonly radius: number;
  readonly damage: number;
  readonly range: number;
  readonly pierce: boolean;
  traveled: number;
  readonly hitIds: Set<string>;
}

export interface PendingImpact {
  readonly id: number;
  readonly casterId: string;
  readonly team: TeamKind;
  readonly element: ElementKind;
  readonly kind: 'skill' | 'ultimate';
  readonly target: Vector3;
  readonly radius: number;
  readonly damage: number;
  readonly startedAt: number;
  readonly resolvesAt: number;
}

export interface Pickup {
  readonly position: Vector3;
  active: boolean;
  respawnAt: number;
}

export interface FighterResult {
  readonly id: string;
  readonly team: TeamKind;
  readonly stats: Readonly<FighterStats>;
}

export interface CombatMatchSummary {
  readonly matchId: string;
  readonly seasonId: 'S02';
  readonly result: MatchResult;
  readonly roundsWon: number;
  readonly roundsLost: number;
  readonly durationMs: number;
  readonly knockouts: number;
  readonly mvpId: string;
  readonly fighters: readonly FighterResult[];
  readonly rosterIds: readonly string[];
  readonly opponentIds: readonly string[];
}

export type CombatEvent =
  | { type: 'phase'; phase: MatchPhase; round: number }
  | { type: 'shot'; projectileId: number; ownerId: string; element: ElementKind; origin: Vector3; direction: Vector3 }
  | { type: 'projectileEnd'; projectileId: number; element: ElementKind; position: Vector3; hit: boolean }
  | { type: 'cast'; impactId: number; casterId: string; element: ElementKind; kind: 'skill' | 'ultimate'; origin: Vector3; target: Vector3; radius: number; delay: number; team: TeamKind }
  | { type: 'impact'; impactId: number; casterId: string; element: ElementKind; kind: 'skill' | 'ultimate'; target: Vector3; radius: number; hits: number }
  | { type: 'damage'; targetId: string; sourceId: string; amount: number; effectiveness: Effectiveness; critical: boolean; kind: AttackKind; position: Vector3 }
  | { type: 'heal'; targetId: string; amount: number }
  | { type: 'status'; targetId: string; status: StatusKind; duration: number }
  | { type: 'dash'; fighterId: string; from: Vector3; to: Vector3 }
  | { type: 'ultReady'; fighterId: string }
  | { type: 'knockout'; targetId: string; sourceId: string }
  | { type: 'pickupSpawn'; position: Vector3 }
  | { type: 'pickup'; fighterId: string }
  | { type: 'roundEnd'; round: number; winner: TeamKind | 'draw'; score: Readonly<Record<TeamKind, number>> }
  | { type: 'matchEnd'; summary: CombatMatchSummary };

export interface MatchModifiers {
  /** Multiplies every rift fighter's vitality. */
  readonly riftHp?: number;
  /** Multiplies every rift fighter's damage. */
  readonly riftPower?: number;
  /** Fighter id promoted to a boss (large, durable, hard-hitting). */
  readonly bossId?: string;
}

export interface MatchConfig {
  /** Signal team; index 0 is the player when playerControlled. */
  readonly signal: readonly FighterDefinition[];
  readonly rift: readonly FighterDefinition[];
  readonly difficulty: Difficulty;
  readonly roundsToWin: number;
  readonly roundSeconds: number;
  readonly seed: number;
  readonly playerControlled?: boolean;
  /** Rift fighters become immortal, passive targets. */
  readonly training?: boolean;
  readonly modifiers?: MatchModifiers;
}

export interface PlayerInput {
  readonly movement: Vector2;
  readonly aim: Vector3;
  basicHeld: boolean;
}

type QueuedAction = 'skill' | 'ultimate' | 'dash';

/** Rift damage scaling per difficulty keeps Novice forgiving without changing kits. */
const DIFFICULTY_DAMAGE: Record<Difficulty, number> = { novice: 0.7, adept: 0.92, master: 1.08 };

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

function formation(team: TeamKind, index: number, count: number): Vector3 {
  const side = team === 'signal' ? -1 : 1;
  const spread = count <= 1 ? 0 : (index / (count - 1) - 0.5) * Math.min(7.2, 2.6 * (count - 1));
  return new Vector3(side * (6.3 - Math.abs(spread) * 0.12), 0, spread);
}

export class CombatSimulation {
  readonly fighters = new Map<string, FighterState>();
  readonly projectiles: Projectile[] = [];
  readonly impacts: PendingImpact[] = [];
  readonly pickup: Pickup = { position: new Vector3(0, 0, 0), active: false, respawnAt: 8 };
  readonly input: PlayerInput = { movement: new Vector2(), aim: new Vector3(), basicHeld: false };
  readonly config: MatchConfig;
  readonly playerId: string | null;
  readonly score: Record<TeamKind, number> = { signal: 0, rift: 0 };

  phase: MatchPhase = 'countdown';
  round = 1;
  /** Seconds elapsed in the current phase. */
  phaseTime = 0;
  /** Seconds of active fighting in the current round. */
  roundTime = 0;
  /** Total simulated seconds. */
  elapsed = 0;
  summary?: CombatMatchSummary;

  private readonly random: () => number;
  private readonly events: CombatEvent[] = [];
  private readonly queued = new Set<QueuedAction>();
  private nextId = 1;
  private aiAccumulator = 0;
  private fightSeconds = 0;

  constructor(config: MatchConfig) {
    if (config.signal.length < 1 || config.rift.length < 1) {
      throw new RangeError('A match needs at least one fighter per team.');
    }
    const ids = [...config.signal, ...config.rift].map(({ id }) => id);
    if (new Set(ids).size !== ids.length) throw new RangeError('Combat fighter IDs must be unique.');

    this.config = config;
    this.random = makeRandom(config.seed);
    this.playerId = config.playerControlled === false ? null : config.signal[0]!.id;
    config.signal.forEach((definition) => this.addFighter(definition, 'signal'));
    config.rift.forEach((definition) => this.addFighter(definition, 'rift'));
    this.resetRound();
    this.emit({ type: 'phase', phase: 'countdown', round: this.round });
  }

  get player(): FighterState | undefined {
    return this.playerId ? this.fighters.get(this.playerId) : undefined;
  }

  get ended(): boolean {
    return this.phase === 'ended';
  }

  get roundTimeLeft(): number {
    return Math.max(0, this.config.roundSeconds - this.roundTime);
  }

  snapshot(): FighterState[] {
    return [...this.fighters.values()];
  }

  team(team: TeamKind): FighterState[] {
    return this.snapshot().filter((fighter) => fighter.team === team);
  }

  /** Returns and clears every event emitted since the last drain. */
  drainEvents(): CombatEvent[] {
    return this.events.splice(0, this.events.length);
  }

  /** Queue a one-shot player action, consumed on the next fight-phase update. */
  queue(action: QueuedAction): void {
    if (this.phase === 'fight') this.queued.add(action);
  }

  update(deltaSeconds: number): void {
    if (this.phase === 'ended' || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
    const delta = Math.min(deltaSeconds, MAX_TIMESTEP);
    this.elapsed += delta;
    this.phaseTime += delta;

    if (this.phase === 'countdown') {
      this.tickTimers(delta, false);
      if (this.phaseTime >= COUNTDOWN_SECONDS) this.setPhase('fight');
      return;
    }
    if (this.phase === 'roundEnd') {
      this.tickTimers(delta, false);
      this.updateProjectiles(delta);
      this.updateMotion(delta);
      if (this.phaseTime >= ROUND_END_SECONDS) this.advanceRound();
      return;
    }

    this.roundTime += delta;
    this.fightSeconds += delta;
    this.tickTimers(delta, true);
    this.resolveImpacts();
    this.updatePlayer();
    this.aiAccumulator += delta;
    const think = this.aiAccumulator >= AI_THINK_INTERVAL;
    if (think) this.aiAccumulator = 0;
    for (const fighter of this.fighters.values()) {
      if (fighter.id !== this.playerId && fighter.alive && fighter.aiEnabled) {
        thinkAi(this, fighter, this.aiProfileFor(fighter), delta, think);
      }
    }
    this.updateMotion(delta);
    this.updateProjectiles(delta);
    this.updatePickup();
    this.updateTraining();
    this.checkRoundEnd();
  }

  // ---------------------------------------------------------------- actions

  /** Fires a basic bolt from `casterId` toward `aim`. */
  tryBasic(casterId: string, aim: Vector3): boolean {
    const caster = this.fighters.get(casterId);
    if (!caster || !this.canAct(caster) || caster.cooldowns.basic > 0) return false;
    const direction = aim.clone().sub(caster.position).setY(0);
    if (direction.lengthSq() < 0.0001) direction.copy(caster.facing);
    direction.normalize();
    caster.facing.copy(direction);
    const { basic } = caster.kit;
    caster.cooldowns.basic = basic.cooldown;
    const origin = caster.position.clone().addScaledVector(direction, FIGHTER_RADIUS * caster.scale + 0.1);
    const projectile: Projectile = {
      id: this.nextId++,
      ownerId: caster.id,
      team: caster.team,
      element: caster.definition.element,
      position: origin.setY(0),
      velocity: direction.clone().multiplyScalar(basic.speed),
      radius: basic.radius * (caster.boss ? 1.6 : 1),
      damage: basic.damage,
      range: basic.range,
      pierce: basic.pierce,
      traveled: 0,
      hitIds: new Set(),
    };
    this.projectiles.push(projectile);
    this.emit({ type: 'shot', projectileId: projectile.id, ownerId: caster.id, element: projectile.element, origin: origin.clone(), direction: direction.clone() });
    return true;
  }

  /** Starts the fighter's elemental signature at `target` (clamped to range and arena). */
  tryCast(casterId: string, target: Vector3): boolean {
    const caster = this.fighters.get(casterId);
    if (!caster || !this.canAct(caster)) return false;
    const skill = caster.kit.skill;
    if (caster.cooldowns.skill > 0 || caster.energy < skill.energy) return false;
    caster.cooldowns.skill = skill.cooldown;
    caster.energy -= skill.energy;
    this.startImpact(caster, 'skill', target, skill.range, skill.radius, skill.damage, skill.impactDelay);
    return true;
  }

  /** Unleashes the ultimate when fully charged. */
  tryUltimate(casterId: string, target: Vector3): boolean {
    const caster = this.fighters.get(casterId);
    if (!caster || !this.canAct(caster)) return false;
    const { ultimate, skill } = caster.kit;
    if (caster.ult < ultimate.charge) return false;
    caster.ult = 0;
    caster.stats.ultimates += 1;
    this.startImpact(
      caster,
      'ultimate',
      target,
      skill.range + 1,
      skill.radius * ultimate.radiusMultiplier,
      skill.damage * ultimate.damageMultiplier,
      ultimate.impactDelay,
    );
    return true;
  }

  /** Dashes along `direction` (falls back to facing). Grants brief invulnerability. */
  tryDash(fighterId: string, direction: Vector3): boolean {
    const fighter = this.fighters.get(fighterId);
    if (!fighter || !fighter.alive || this.phase !== 'fight') return false;
    if (fighter.cooldowns.dash > 0 || fighter.stunnedFor > 0 || fighter.rootedFor > 0 || fighter.dashTime > 0) return false;
    const heading = direction.clone().setY(0);
    if (heading.lengthSq() < 0.0001) heading.copy(fighter.facing);
    heading.normalize();
    const { dash } = fighter.kit;
    fighter.cooldowns.dash = dash.cooldown;
    fighter.dashTime = dash.duration;
    fighter.dashSpeed = dash.distance / dash.duration;
    fighter.dashDirection.copy(heading);
    fighter.invulnerableFor = Math.max(fighter.invulnerableFor, dash.invulnerability);
    const to = fighter.position.clone().addScaledVector(heading, dash.distance);
    this.clampToArena(to);
    this.emit({ type: 'dash', fighterId, from: fighter.position.clone(), to });
    return true;
  }

  /** True when the segment between two points is not blocked by a pillar. */
  hasLineOfSight(from: Vector3, to: Vector3): boolean {
    return PILLARS.every((pillar) => !segmentHitsCircle(from, to, pillar.x, pillar.z, pillar.radius));
  }

  randomValue(): number {
    return this.random();
  }

  // --------------------------------------------------------------- internal

  private aiProfileFor(fighter: FighterState): AiProfile {
    if (fighter.team === 'signal') return AI_PROFILES.ally;
    return AI_PROFILES[this.config.difficulty];
  }

  private addFighter(definition: FighterDefinition, team: TeamKind): void {
    const modifiers = this.config.modifiers ?? {};
    const boss = team === 'rift' && modifiers.bossId === definition.id;
    const hpScale = team === 'rift' ? (modifiers.riftHp ?? 1) * (boss ? 5.5 : 1) : 1;
    const powerScale = team === 'rift'
      ? (modifiers.riftPower ?? 1) * (boss ? 1.45 : 1) * (this.config.playerControlled === false ? 1 : DIFFICULTY_DAMAGE[this.config.difficulty])
      : 1;
    const maxHp = Math.round(definition.maxHp * VITALITY_SCALE * hpScale);
    this.fighters.set(definition.id, {
      id: definition.id,
      definition,
      team,
      kit: kitFor(definition),
      maxHp,
      power: definition.power * powerScale,
      scale: boss ? 1.75 : 1,
      boss,
      hp: maxHp,
      energy: MAX_ENERGY,
      ult: 0,
      position: new Vector3(),
      velocity: new Vector3(),
      facing: new Vector3(team === 'signal' ? 1 : -1, 0, 0),
      cooldowns: { basic: 0, skill: 0, dash: 0 },
      dashTime: 0,
      dashDirection: new Vector3(),
      dashSpeed: 0,
      invulnerableFor: 0,
      slowedFor: 0,
      slowMultiplier: 1,
      rootedFor: 0,
      stunnedFor: 0,
      sinceDamaged: 99,
      alive: true,
      castingFor: 0,
      stats: { damageDealt: 0, damageTaken: 0, healing: 0, knockouts: 0, ultimates: 0 },
      ai: createAiMemory(this.fighters.size),
      aiEnabled: !(team === 'rift' && this.config.training),
    });
  }

  private resetRound(): void {
    this.projectiles.length = 0;
    this.impacts.length = 0;
    this.queued.clear();
    this.roundTime = 0;
    this.pickup.active = false;
    this.pickup.respawnAt = 8;
    for (const team of ['signal', 'rift'] as const) {
      const members = this.team(team);
      members.forEach((fighter, index) => {
        fighter.position.copy(formation(team, index, members.length));
        fighter.velocity.setScalar(0);
        fighter.facing.set(team === 'signal' ? 1 : -1, 0, 0);
        fighter.hp = fighter.maxHp;
        fighter.energy = MAX_ENERGY;
        fighter.cooldowns.basic = 0;
        fighter.cooldowns.skill = 0;
        fighter.cooldowns.dash = 0;
        fighter.dashTime = 0;
        fighter.invulnerableFor = 0;
        fighter.slowedFor = 0;
        fighter.rootedFor = 0;
        fighter.stunnedFor = 0;
        fighter.castingFor = 0;
        fighter.alive = true;
      });
    }
    if (this.player) this.input.aim.copy(this.player.position).add(new Vector3(4, 0, 0));
  }

  private setPhase(phase: MatchPhase): void {
    this.phase = phase;
    this.phaseTime = 0;
    this.emit({ type: 'phase', phase, round: this.round });
  }

  private emit(event: CombatEvent): void {
    this.events.push(event);
  }

  private canAct(fighter: FighterState): boolean {
    return fighter.alive && this.phase === 'fight' && fighter.stunnedFor <= 0 && fighter.dashTime <= 0;
  }

  private tickTimers(delta: number, regen: boolean): void {
    for (const fighter of this.fighters.values()) {
      if (!fighter.alive) continue;
      fighter.cooldowns.basic = Math.max(0, fighter.cooldowns.basic - delta);
      fighter.cooldowns.skill = Math.max(0, fighter.cooldowns.skill - delta);
      fighter.cooldowns.dash = Math.max(0, fighter.cooldowns.dash - delta);
      if (regen) fighter.energy = Math.min(MAX_ENERGY, fighter.energy + delta * ENERGY_REGEN_PER_SECOND);
      fighter.invulnerableFor = Math.max(0, fighter.invulnerableFor - delta);
      fighter.slowedFor = Math.max(0, fighter.slowedFor - delta);
      if (fighter.slowedFor <= 0) fighter.slowMultiplier = 1;
      fighter.rootedFor = Math.max(0, fighter.rootedFor - delta);
      fighter.stunnedFor = Math.max(0, fighter.stunnedFor - delta);
      fighter.castingFor = Math.max(0, fighter.castingFor - delta);
      fighter.sinceDamaged += delta;
    }
  }

  private updatePlayer(): void {
    const player = this.player;
    if (!player?.alive) {
      this.queued.clear();
      return;
    }
    const aim = this.input.aim;
    const toAim = aim.clone().sub(player.position).setY(0);
    if (toAim.lengthSq() > 0.01 && player.stunnedFor <= 0) player.facing.copy(toAim.normalize());

    const movement = this.input.movement.clone();
    if (movement.lengthSq() > 1) movement.normalize();
    const speed = player.definition.speed * player.slowMultiplier;
    if (player.dashTime <= 0) {
      if (player.rootedFor > 0 || player.stunnedFor > 0) player.velocity.setScalar(0);
      else player.velocity.set(movement.x, 0, movement.y).multiplyScalar(speed);
    }

    for (const action of this.queued) {
      if (action === 'dash') {
        const direction = movement.lengthSq() > 0.01 ? new Vector3(movement.x, 0, movement.y) : player.facing.clone();
        this.tryDash(player.id, direction);
      } else if (action === 'skill') {
        this.tryCast(player.id, aim);
      } else {
        this.tryUltimate(player.id, aim);
      }
    }
    this.queued.clear();
    if (this.input.basicHeld) this.tryBasic(player.id, aim);
  }

  private updateMotion(delta: number): void {
    for (const fighter of this.fighters.values()) {
      if (!fighter.alive) continue;
      if (fighter.dashTime > 0) {
        const step = Math.min(delta, fighter.dashTime);
        fighter.position.addScaledVector(fighter.dashDirection, fighter.dashSpeed * step);
        fighter.velocity.copy(fighter.dashDirection).multiplyScalar(fighter.dashSpeed);
        fighter.dashTime -= step;
        if (fighter.dashTime <= 0) fighter.velocity.multiplyScalar(0.15);
      } else if (this.phase === 'fight' && fighter.stunnedFor <= 0 && fighter.rootedFor <= 0) {
        fighter.position.addScaledVector(fighter.velocity, delta);
      } else {
        fighter.velocity.multiplyScalar(0.8);
      }
      this.collideWithPillars(fighter);
      this.clampToArena(fighter.position);
    }
    this.resolveSeparation();
  }

  private collideWithPillars(fighter: FighterState): void {
    const bodyRadius = FIGHTER_RADIUS * fighter.scale;
    for (const pillar of PILLARS) {
      const dx = fighter.position.x - pillar.x;
      const dz = fighter.position.z - pillar.z;
      const distance = Math.hypot(dx, dz);
      const minimum = pillar.radius + bodyRadius;
      if (distance < minimum) {
        const nx = distance > 0.0001 ? dx / distance : 1;
        const nz = distance > 0.0001 ? dz / distance : 0;
        fighter.position.x = pillar.x + nx * minimum;
        fighter.position.z = pillar.z + nz * minimum;
      }
    }
  }

  private resolveSeparation(): void {
    const living = this.snapshot().filter(({ alive }) => alive);
    for (let first = 0; first < living.length; first += 1) {
      const a = living[first]!;
      for (let second = first + 1; second < living.length; second += 1) {
        const b = living[second]!;
        const minimum = FIGHTER_RADIUS * (a.scale + b.scale);
        const dx = b.position.x - a.position.x;
        const dz = b.position.z - a.position.z;
        const distance = Math.hypot(dx, dz);
        if (distance > 0 && distance < minimum) {
          const push = (minimum - distance) * 0.5;
          const nx = dx / distance;
          const nz = dz / distance;
          a.position.x -= nx * push;
          a.position.z -= nz * push;
          b.position.x += nx * push;
          b.position.z += nz * push;
        }
      }
    }
    for (const fighter of living) this.clampToArena(fighter.position);
  }

  private updateProjectiles(delta: number): void {
    for (let index = this.projectiles.length - 1; index >= 0; index -= 1) {
      const projectile = this.projectiles[index]!;
      const step = projectile.velocity.clone().multiplyScalar(delta);
      const from = projectile.position.clone();
      projectile.position.add(step);
      projectile.traveled += step.length();
      let ended = projectile.traveled >= projectile.range
        || Math.abs(projectile.position.x) > ARENA_BOUNDS.x + 0.6
        || Math.abs(projectile.position.z) > ARENA_BOUNDS.z + 0.6
        || !this.hasLineOfSight(from, projectile.position);
      let hit = false;
      if (!ended && this.phase === 'fight') {
        for (const fighter of this.fighters.values()) {
          if (!fighter.alive || fighter.team === projectile.team || projectile.hitIds.has(fighter.id)) continue;
          const reach = projectile.radius + FIGHTER_RADIUS * fighter.scale;
          if (distanceToSegmentXZ(fighter.position, from, projectile.position) > reach) continue;
          projectile.hitIds.add(fighter.id);
          const owner = this.fighters.get(projectile.ownerId);
          if (owner) this.damage(owner, fighter, projectile.damage, false, 'basic');
          hit = true;
          if (!projectile.pierce) {
            ended = true;
            break;
          }
        }
      }
      if (ended) {
        this.projectiles.splice(index, 1);
        this.emit({ type: 'projectileEnd', projectileId: projectile.id, element: projectile.element, position: projectile.position.clone(), hit });
      }
    }
  }

  private startImpact(
    caster: FighterState,
    kind: 'skill' | 'ultimate',
    target: Vector3,
    range: number,
    radius: number,
    damage: number,
    delay: number,
  ): void {
    const constrained = target.clone().setY(0);
    const offset = constrained.clone().sub(caster.position);
    if (offset.length() > range) constrained.copy(caster.position).add(offset.setLength(range));
    this.clampToArena(constrained);
    const facing = constrained.clone().sub(caster.position).setY(0);
    if (facing.lengthSq() > 0.01) caster.facing.copy(facing.normalize());
    caster.castingFor = Math.min(0.45, delay);
    const impact: PendingImpact = {
      id: this.nextId++,
      casterId: caster.id,
      team: caster.team,
      element: caster.definition.element,
      kind,
      target: constrained,
      radius,
      damage,
      startedAt: this.elapsed,
      resolvesAt: this.elapsed + delay,
    };
    this.impacts.push(impact);
    this.emit({
      type: 'cast',
      impactId: impact.id,
      casterId: caster.id,
      element: impact.element,
      kind,
      origin: caster.position.clone(),
      target: constrained.clone(),
      radius,
      delay,
      team: caster.team,
    });
  }

  private resolveImpacts(): void {
    for (let index = this.impacts.length - 1; index >= 0; index -= 1) {
      const impact = this.impacts[index]!;
      if (impact.resolvesAt > this.elapsed) continue;
      this.impacts.splice(index, 1);
      const caster = this.fighters.get(impact.casterId);
      const hits = caster ? this.applyImpact(caster, impact) : 0;
      this.emit({ type: 'impact', impactId: impact.id, casterId: impact.casterId, element: impact.element, kind: impact.kind, target: impact.target.clone(), radius: impact.radius, hits });
    }
  }

  private applyImpact(caster: FighterState, impact: PendingImpact): number {
    const ultimate = impact.kind === 'ultimate';
    const affected = this.snapshot()
      .filter((fighter) => fighter.alive && fighter.team !== caster.team)
      .map((fighter) => ({ fighter, distance: fighter.position.distanceTo(impact.target) }))
      .filter(({ fighter, distance }) => distance <= impact.radius + FIGHTER_RADIUS * (fighter.scale - 1))
      .sort((first, second) => first.distance - second.distance);
    const kind: AttackKind = ultimate ? 'ultimate' : 'skill';

    if (impact.element === 'plasma') {
      const chain = affected.slice(0, ultimate ? 6 : 3);
      chain.forEach(({ fighter }, index) => {
        this.damage(caster, fighter, impact.damage * (1 - index * (ultimate ? 0.1 : 0.18)), index === 0, kind);
        if (ultimate) this.applyStatus(fighter, 'stun', 0.5);
      });
      return chain.length;
    }

    let drained = 0;
    for (const { fighter, distance } of affected) {
      const falloff = 1 - (distance / impact.radius) * 0.35;
      const dealt = this.damage(caster, fighter, impact.damage * falloff, distance < impact.radius * 0.35, kind);
      drained += dealt;
      if (!fighter.alive) continue;
      switch (impact.element) {
        case 'earth':
          this.applyStatus(fighter, 'slow', 1.55);
          if (ultimate) this.applyStatus(fighter, 'stun', 1.2);
          break;
        case 'hydro':
          this.applyStatus(fighter, 'slow', ultimate ? 3 : 1.55, ultimate ? DEEP_SLOW_MULTIPLIER : SLOW_MULTIPLIER);
          break;
        case 'nature':
          this.applyStatus(fighter, 'root', ultimate ? 2.4 : 1.25);
          break;
        case 'gale': {
          const push = fighter.position.clone().sub(impact.target).setY(0);
          if (push.lengthSq() < 0.001) push.copy(caster.facing);
          fighter.position.add(push.normalize().multiplyScalar(ultimate ? 3.2 : 1.15));
          this.clampToArena(fighter.position);
          this.collideWithPillars(fighter);
          this.emit({ type: 'status', targetId: fighter.id, status: 'knockback', duration: 0.3 });
          if (ultimate) this.applyStatus(fighter, 'slow', 1.4);
          break;
        }
        case 'void':
          break;
      }
    }

    if (impact.element === 'void' && affected.length > 0) {
      if (ultimate) {
        const allies = this.team(caster.team).filter(({ alive }) => alive);
        for (const ally of allies) this.heal(caster, ally, Math.round((drained * 0.5) / allies.length) + 6);
      } else {
        this.heal(caster, caster, Math.min(14, affected.length * 4));
      }
    }
    if (impact.element === 'nature' && ultimate) {
      for (const ally of this.team(caster.team)) {
        if (ally.alive && ally.position.distanceTo(impact.target) <= impact.radius + 2.5) this.heal(caster, ally, 18);
      }
    }
    return affected.length;
  }

  private applyStatus(fighter: FighterState, status: StatusKind, duration: number, slowMultiplier = SLOW_MULTIPLIER): void {
    if (status === 'slow') {
      fighter.slowedFor = Math.max(fighter.slowedFor, duration);
      fighter.slowMultiplier = Math.min(fighter.slowMultiplier, slowMultiplier);
    } else if (status === 'root') {
      fighter.rootedFor = Math.max(fighter.rootedFor, duration);
    } else if (status === 'stun') {
      fighter.stunnedFor = Math.max(fighter.stunnedFor, duration * (fighter.boss ? 0.4 : 1));
    }
    this.emit({ type: 'status', targetId: fighter.id, status, duration });
  }

  private damage(source: FighterState, target: FighterState, baseDamage: number, critical: boolean, kind: AttackKind): number {
    if (!target.alive || target.invulnerableFor > 0) return 0;
    const effectiveness = effectivenessOf(source.definition.element, target.definition.element);
    const scaled = baseDamage * source.power * effectivenessMultiplier(effectiveness) * (critical ? 1.22 : 1);
    const amount = Math.max(1, Math.round(scaled));
    const immortal = this.config.training && target.team === 'rift';
    target.hp = immortal ? Math.max(1, target.hp - amount) : Math.max(0, target.hp - amount);
    target.sinceDamaged = 0;
    target.stats.damageTaken += amount;
    source.stats.damageDealt += amount;
    this.chargeUlt(source, amount * ULT_PER_DAMAGE_DEALT);
    this.chargeUlt(target, amount * ULT_PER_DAMAGE_TAKEN);
    this.emit({ type: 'damage', targetId: target.id, sourceId: source.id, amount, effectiveness, critical, kind, position: target.position.clone() });
    if (target.hp <= 0) {
      target.alive = false;
      target.velocity.setScalar(0);
      target.dashTime = 0;
      source.stats.knockouts += 1;
      this.emit({ type: 'knockout', targetId: target.id, sourceId: source.id });
    }
    return amount;
  }

  private heal(source: FighterState, target: FighterState, amount: number): void {
    if (!target.alive || amount <= 0) return;
    const healed = Math.min(amount, target.maxHp - target.hp);
    if (healed <= 0) return;
    target.hp += healed;
    source.stats.healing += healed;
    this.emit({ type: 'heal', targetId: target.id, amount: healed });
  }

  private chargeUlt(fighter: FighterState, amount: number): void {
    const charge = fighter.kit.ultimate.charge;
    if (fighter.ult >= charge) return;
    fighter.ult = Math.min(charge, fighter.ult + amount);
    if (fighter.ult >= charge) this.emit({ type: 'ultReady', fighterId: fighter.id });
  }

  private updatePickup(): void {
    if (this.config.training) return;
    if (!this.pickup.active) {
      if (this.roundTime >= this.pickup.respawnAt) {
        this.pickup.active = true;
        this.emit({ type: 'pickupSpawn', position: this.pickup.position.clone() });
      }
      return;
    }
    for (const fighter of this.fighters.values()) {
      if (!fighter.alive) continue;
      if (fighter.position.distanceTo(this.pickup.position) > PICKUP_RADIUS + FIGHTER_RADIUS * fighter.scale) continue;
      this.pickup.active = false;
      this.pickup.respawnAt = this.roundTime + PICKUP_RESPAWN_SECONDS;
      this.heal(fighter, fighter, PICKUP_HEAL);
      this.chargeUlt(fighter, PICKUP_ULT);
      this.emit({ type: 'pickup', fighterId: fighter.id });
      break;
    }
  }

  private updateTraining(): void {
    if (!this.config.training) return;
    for (const dummy of this.team('rift')) {
      if (dummy.sinceDamaged > 2.4 && dummy.hp < dummy.maxHp) dummy.hp = dummy.maxHp;
    }
  }

  private checkRoundEnd(): void {
    const signalAlive = this.team('signal').some(({ alive }) => alive);
    const riftAlive = this.team('rift').some(({ alive }) => alive);
    const timeUp = this.roundTime >= this.config.roundSeconds;
    if (signalAlive && riftAlive && !timeUp) return;
    if (this.config.training && !timeUp && signalAlive) return;

    let winner: TeamKind | 'draw';
    if (!signalAlive && !riftAlive) winner = 'draw';
    else if (!riftAlive) winner = 'signal';
    else if (!signalAlive) winner = 'rift';
    else {
      const health = (team: TeamKind) => this.team(team).reduce((total, fighter) => total + fighter.hp / fighter.maxHp, 0) / this.team(team).length;
      const difference = health('signal') - health('rift');
      winner = Math.abs(difference) < 0.005 ? 'draw' : difference > 0 ? 'signal' : 'rift';
    }
    if (winner !== 'draw') this.score[winner] += 1;
    this.phase = 'roundEnd';
    this.phaseTime = 0;
    this.projectiles.length = 0;
    this.impacts.length = 0;
    this.emit({ type: 'roundEnd', round: this.round, winner, score: { ...this.score } });
    this.emit({ type: 'phase', phase: 'roundEnd', round: this.round });
  }

  private advanceRound(): void {
    const needed = this.config.roundsToWin;
    const maxRounds = needed * 2 + 1;
    if (this.score.signal >= needed || this.score.rift >= needed || this.round >= maxRounds) {
      this.finishMatch();
      return;
    }
    this.round += 1;
    this.resetRound();
    this.setPhase('countdown');
  }

  private finishMatch(): void {
    const result: MatchResult = this.score.signal > this.score.rift ? 'win' : 'loss';
    const fighters = this.snapshot().map(({ id, team, stats }) => ({ id, team, stats: { ...stats } }));
    const signal = fighters.filter(({ team }) => team === 'signal');
    const contribution = (stats: FighterStats) => stats.damageDealt + stats.knockouts * 40 + stats.healing * 0.8;
    const mvp = [...signal].sort((a, b) => contribution(b.stats) - contribution(a.stats))[0]!;
    this.summary = {
      matchId: `match-${(this.config.seed >>> 0).toString(16).padStart(8, '0')}-${Math.round(this.elapsed * 1000)}`,
      seasonId: 'S02',
      result,
      roundsWon: this.score.signal,
      roundsLost: this.score.rift,
      durationMs: Math.round(this.fightSeconds * 1000),
      knockouts: signal.reduce((total, fighter) => total + fighter.stats.knockouts, 0),
      mvpId: mvp.id,
      fighters,
      rosterIds: signal.map(({ id }) => id),
      opponentIds: fighters.filter(({ team }) => team === 'rift').map(({ id }) => id),
    };
    this.phase = 'ended';
    this.phaseTime = 0;
    this.emit({ type: 'phase', phase: 'ended', round: this.round });
    this.emit({ type: 'matchEnd', summary: this.summary });
  }

  private clampToArena(position: Vector3): void {
    position.x = Math.max(-ARENA_BOUNDS.x, Math.min(ARENA_BOUNDS.x, position.x));
    position.z = Math.max(-ARENA_BOUNDS.z, Math.min(ARENA_BOUNDS.z, position.z));
    position.y = 0;
  }
}

/** Shortest XZ distance from `point` to segment `a`→`b`. */
export function distanceToSegmentXZ(point: Vector3, a: Vector3, b: Vector3): number {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const lengthSq = abx * abx + abz * abz;
  const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((point.x - a.x) * abx + (point.z - a.z) * abz) / lengthSq)) : 0;
  return Math.hypot(point.x - (a.x + abx * t), point.z - (a.z + abz * t));
}

function segmentHitsCircle(a: Vector3, b: Vector3, cx: number, cz: number, radius: number): boolean {
  return distanceToSegmentXZ(new Vector3(cx, 0, cz), a, b) < radius;
}
