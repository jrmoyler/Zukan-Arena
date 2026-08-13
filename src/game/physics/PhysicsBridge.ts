import type { FighterState } from '../simulation/CombatSimulation';

type RapierModule = typeof import('@dimforge/rapier3d-compat');
type RapierWorld = InstanceType<RapierModule['World']>;
type RapierBody = InstanceType<RapierModule['RigidBody']>;

/**
 * Rapier mirrors the deterministic simulation with real kinematic capsules.
 * Combat numbers remain authoritative in CombatSimulation; this layer supplies
 * 3D contact bodies, arena containment and a route for future obstacle queries.
 */
export class PhysicsBridge {
  private readonly world: RapierWorld;
  private readonly bodies = new Map<string, RapierBody>();

  private constructor(rapier: RapierModule, fighters: readonly FighterState[]) {
    this.world = new rapier.World({ x: 0, y: -9.81, z: 0 });
    const floor = this.world.createRigidBody(rapier.RigidBodyDesc.fixed().setTranslation(0, -0.2, 0));
    this.world.createCollider(rapier.ColliderDesc.cuboid(9.2, 0.2, 5.6).setFriction(0.9), floor);
    for (const fighter of fighters) {
      const body = this.world.createRigidBody(
        rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(fighter.position.x, 0.82, fighter.position.z),
      );
      const radius = fighter.definition.archetype === 'quadruped' ? 0.54 : fighter.definition.archetype === 'swarm' ? 0.62 : 0.43;
      this.world.createCollider(
        rapier.ColliderDesc.capsule(0.56, radius).setFriction(0.2).setRestitution(0.08),
        body,
      );
      this.bodies.set(fighter.id, body);
    }
  }

  static async create(fighters: readonly FighterState[]): Promise<PhysicsBridge> {
    const rapier = await import('@dimforge/rapier3d-compat');
    await rapier.init();
    return new PhysicsBridge(rapier, fighters);
  }

  sync(fighters: readonly FighterState[]): void {
    for (const fighter of fighters) {
      this.bodies.get(fighter.id)?.setNextKinematicTranslation({
        x: fighter.position.x,
        y: fighter.alive ? 0.82 : 0.22,
        z: fighter.position.z,
      });
    }
    this.world.step();
  }

  dispose(): void {
    this.bodies.clear();
    this.world.free();
  }
}

