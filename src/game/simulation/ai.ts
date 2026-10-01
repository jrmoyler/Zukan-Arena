import { Vector3 } from 'three';

import type { FighterRole } from '../types';
import { PICKUP_RADIUS, PILLARS } from './arena';
import type { CombatSimulation, FighterState, PendingImpact } from './CombatSimulation';

/**
 * Utility-style combat AI. Each fighter re-evaluates its target and intent on a
 * fixed think interval, then steers every tick. Difficulty never grants stat
 * bonuses; it changes reaction time, aim discipline, how often telegraphs are
 * respected, and how deliberately signatures and ultimates are spent.
 */

export interface AiProfile {
  /** Seconds before a newly noticed threat is reacted to. */
  readonly reaction: number;
  /** Radians of aim noise at full scale. */
  readonly aimError: number;
  /** Probability of dodging any given telegraph. */
  readonly dodge: number;
  /** Probability per think of firing when a shot is available. */
  readonly fireRate: number;
  /** Probability per think of using an available signature. */
  readonly skillRate: number;
  /** Enemies the ultimate must threaten before it is spent. */
  readonly ultThreshold: number;
  /** Lead factor applied to predicted target motion (0 = none, 1 = perfect). */
  readonly lead: number;
  /** Metres of "virtual distance" removed when scoring the player as a target. */
  readonly focusPlayer: number;
}

export const AI_PROFILES = {
  novice: { reaction: 0.55, aimError: 0.38, dodge: 0.12, fireRate: 0.42, skillRate: 0.22, ultThreshold: 2, lead: 0.2, focusPlayer: -0.5 },
  adept: { reaction: 0.3, aimError: 0.16, dodge: 0.5, fireRate: 0.72, skillRate: 0.5, ultThreshold: 2, lead: 0.65, focusPlayer: 0.5 },
  master: { reaction: 0.14, aimError: 0.06, dodge: 0.85, fireRate: 0.95, skillRate: 0.8, ultThreshold: 1, lead: 0.95, focusPlayer: 1.2 },
  ally: { reaction: 0.28, aimError: 0.14, dodge: 0.55, fireRate: 0.75, skillRate: 0.55, ultThreshold: 2, lead: 0.7, focusPlayer: 0 },
} as const satisfies Record<string, AiProfile>;

export interface AiMemory {
  /** Personal phase so squads do not strafe in lockstep. */
  readonly phase: number;
  targetId: string | null;
  strafeSign: number;
  strafeTimer: number;
  /** Impact ids already judged, mapped to whether this fighter will dodge. */
  readonly judged: Map<number, boolean>;
  readonly desired: Vector3;
}

const PREFERRED_RANGE: Record<FighterRole, number> = {
  Builder: 3.4,
  Creator: 4.8,
  Strategist: 6.2,
};

export function createAiMemory(seed: number): AiMemory {
  return {
    phase: (seed * 1.618) % (Math.PI * 2),
    targetId: null,
    strafeSign: seed % 2 === 0 ? 1 : -1,
    strafeTimer: 0,
    judged: new Map(),
    desired: new Vector3(),
  };
}

export function thinkAi(sim: CombatSimulation, fighter: FighterState, profile: AiProfile, delta: number, think: boolean): void {
  const memory = fighter.ai;
  if (think) chooseTarget(sim, fighter, profile);
  const target = memory.targetId ? sim.fighters.get(memory.targetId) : undefined;
  if (!target?.alive) {
    memory.targetId = null;
    fighter.velocity.multiplyScalar(0.85);
    return;
  }

  const toTarget = target.position.clone().sub(fighter.position).setY(0);
  const distance = Math.max(0.001, toTarget.length());
  const towardTarget = toTarget.clone().divideScalar(distance);
  if (fighter.stunnedFor <= 0) fighter.facing.copy(towardTarget);

  // ------------------------------------------------------------- steering
  const steering = new Vector3();
  const lowHealth = fighter.hp / fighter.maxHp < 0.3 && sim.team(fighter.team).filter(({ alive }) => alive).length > 1;
  const preferred = PREFERRED_RANGE[fighter.definition.role] + (lowHealth ? 2.5 : 0);
  if (distance > preferred + 0.6) steering.add(towardTarget);
  else if (distance < preferred - 0.8) steering.addScaledVector(towardTarget, -0.9);

  memory.strafeTimer -= delta;
  if (memory.strafeTimer <= 0) {
    memory.strafeTimer = 1.1 + sim.randomValue() * 1.6;
    if (sim.randomValue() < 0.45) memory.strafeSign *= -1;
  }
  const strafe = new Vector3(-towardTarget.z, 0, towardTarget.x).multiplyScalar(memory.strafeSign * 0.7);
  steering.add(strafe);

  // Seek the bloom when hurt or when it is clearly closer than the fight.
  if (sim.pickup.active) {
    const toPickup = sim.pickup.position.clone().sub(fighter.position).setY(0);
    const pickupDistance = toPickup.length();
    const wants = fighter.hp / fighter.maxHp < 0.65 || pickupDistance < distance * 0.5;
    if (wants && pickupDistance > PICKUP_RADIUS * 0.5) steering.addScaledVector(toPickup.normalize(), 1.4);
  }

  // Respect telegraphs from the other team.
  let dashFrom: Vector3 | null = null;
  for (const impact of sim.impacts) {
    if (impact.team === fighter.team) continue;
    const threat = evaluateThreat(sim, fighter, impact, profile);
    if (!threat) continue;
    steering.add(threat.escape.multiplyScalar(2.6));
    if (threat.urgent) dashFrom = threat.escape;
  }

  // Soft repulsion from pillars and arena edges keeps paths clean.
  for (const pillar of PILLARS) {
    const dx = fighter.position.x - pillar.x;
    const dz = fighter.position.z - pillar.z;
    const d = Math.hypot(dx, dz);
    if (d < pillar.radius + 1.1 && d > 0.001) steering.add(new Vector3(dx / d, 0, dz / d).multiplyScalar(0.6));
  }
  steering.x -= Math.sign(fighter.position.x) * Math.max(0, Math.abs(fighter.position.x) - 7.8) * 0.8;
  steering.z -= Math.sign(fighter.position.z) * Math.max(0, Math.abs(fighter.position.z) - 4.4) * 0.8;

  if (steering.lengthSq() > 1) steering.normalize();
  const speed = fighter.definition.speed * 0.86 * fighter.slowMultiplier;
  memory.desired.copy(steering).multiplyScalar(speed);
  if (fighter.dashTime <= 0) {
    if (fighter.rootedFor > 0 || fighter.stunnedFor > 0) fighter.velocity.setScalar(0);
    else fighter.velocity.lerp(memory.desired, Math.min(1, delta * 9));
  }

  if (dashFrom && fighter.cooldowns.dash <= 0) sim.tryDash(fighter.id, dashFrom);
  if (!think) return;

  // ---------------------------------------------------------------- offence
  const lead = target.velocity.clone().multiplyScalar(profile.lead * Math.min(0.6, distance / fighter.kit.basic.speed + 0.05));
  const predicted = target.position.clone().add(lead);

  if (fighter.ult >= fighter.kit.ultimate.charge) {
    const radius = fighter.kit.skill.radius * fighter.kit.ultimate.radiusMultiplier;
    const center = bestCluster(sim, fighter, radius, fighter.kit.skill.range + 1);
    const finishing = target.hp / target.maxHp < 0.4 && distance < fighter.kit.skill.range;
    if (center && (center.count >= profile.ultThreshold || finishing || sim.roundTimeLeft < 12)) {
      sim.tryUltimate(fighter.id, center.point);
      return;
    }
  }

  const skill = fighter.kit.skill;
  if (fighter.cooldowns.skill <= 0 && fighter.energy >= skill.energy && distance <= skill.range + 0.5 && sim.randomValue() < profile.skillRate) {
    const center = bestCluster(sim, fighter, skill.radius, skill.range);
    const point = center && center.count >= 2 ? center.point : jitter(sim, predicted, profile.aimError * 1.6);
    if (sim.tryCast(fighter.id, point)) return;
  }

  if (fighter.cooldowns.basic <= 0 && distance <= fighter.kit.basic.range && sim.randomValue() < profile.fireRate) {
    if (sim.hasLineOfSight(fighter.position, target.position)) {
      const aim = rotateAround(fighter.position, predicted, (sim.randomValue() - 0.5) * 2 * profile.aimError);
      sim.tryBasic(fighter.id, aim);
    }
  }
}

function chooseTarget(sim: CombatSimulation, fighter: FighterState, profile: AiProfile): void {
  let best: FighterState | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of sim.fighters.values()) {
    if (!candidate.alive || candidate.team === fighter.team) continue;
    const distance = candidate.position.distanceTo(fighter.position);
    const health = candidate.hp / candidate.maxHp;
    let score = distance + health * 3.5;
    if (candidate.id === sim.playerId) score -= profile.focusPlayer;
    if (candidate.id === fighter.ai.targetId) score -= 0.9;
    if (!sim.hasLineOfSight(fighter.position, candidate.position)) score += 1.5;
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  fighter.ai.targetId = best?.id ?? null;
}

function evaluateThreat(sim: CombatSimulation, fighter: FighterState, impact: PendingImpact, profile: AiProfile): { escape: Vector3; urgent: boolean } | null {
  const offset = fighter.position.clone().sub(impact.target).setY(0);
  const distance = offset.length();
  if (distance > impact.radius + 0.7) return null;
  const age = sim.elapsed - impact.startedAt;
  if (age < profile.reaction) return null;
  let dodges = fighter.ai.judged.get(impact.id);
  if (dodges === undefined) {
    dodges = sim.randomValue() < profile.dodge;
    fighter.ai.judged.set(impact.id, dodges);
    if (fighter.ai.judged.size > 24) {
      const oldest = fighter.ai.judged.keys().next().value;
      if (oldest !== undefined) fighter.ai.judged.delete(oldest);
    }
  }
  if (!dodges) return null;
  const escape = distance > 0.05 ? offset.divideScalar(distance) : new Vector3(-fighter.facing.z, 0, fighter.facing.x);
  const remaining = impact.resolvesAt - sim.elapsed;
  return { escape, urgent: remaining < 0.32 && distance < impact.radius * 0.85 };
}

function bestCluster(sim: CombatSimulation, fighter: FighterState, radius: number, range: number): { point: Vector3; count: number } | null {
  let best: { point: Vector3; count: number } | null = null;
  for (const candidate of sim.fighters.values()) {
    if (!candidate.alive || candidate.team === fighter.team) continue;
    if (candidate.position.distanceTo(fighter.position) > range + radius * 0.5) continue;
    const point = candidate.position.clone().addScaledVector(candidate.velocity, 0.35);
    let count = 0;
    for (const other of sim.fighters.values()) {
      if (other.alive && other.team !== fighter.team && other.position.distanceTo(point) <= radius * 0.9) count += 1;
    }
    if (!best || count > best.count) best = { point, count };
  }
  return best;
}

function jitter(sim: CombatSimulation, point: Vector3, amount: number): Vector3 {
  return point.clone().add(new Vector3((sim.randomValue() - 0.5) * amount * 2, 0, (sim.randomValue() - 0.5) * amount * 2));
}

function rotateAround(origin: Vector3, point: Vector3, angle: number): Vector3 {
  const dx = point.x - origin.x;
  const dz = point.z - origin.z;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return new Vector3(origin.x + dx * cos - dz * sin, 0, origin.z + dx * sin + dz * cos);
}
