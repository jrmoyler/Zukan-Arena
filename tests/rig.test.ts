import { describe, expect, it } from 'vitest';
import { Box3, type Object3D } from 'three';
import { ROSTER } from '../src/game/data/roster';
import { createFighterRig } from '../src/game/render/FighterRig';

describe('fighter rig contract', () => {
  it('builds every fighter as a volumetric SkinnedMesh with bones, actions, sockets, and colliders', () => {
    const archetypes = new Set<string>();
    for (const fighter of ROSTER) {
      const rig = createFighterRig(fighter, 'low');
      archetypes.add(fighter.archetype);
      expect(rig.skinnedMesh.isSkinnedMesh, fighter.id).toBe(true);
      expect(rig.skinnedMesh.geometry.getAttribute('skinIndex'), fighter.id).toBeDefined();
      expect(rig.skinnedMesh.geometry.getAttribute('skinWeight'), fighter.id).toBeDefined();
      const weights = rig.skinnedMesh.geometry.getAttribute('skinWeight');
      expect(Array.from({ length: weights.count }, (_, index) => weights.getY(index)).some((weight) => weight > 0), fighter.id).toBe(true);
      expect(rig.skeleton.bones.length, fighter.id).toBeGreaterThanOrEqual(12);
      expect(rig.sockets.has('ability'), fighter.id).toBe(true);
      expect(rig.colliders.length, fighter.id).toBeGreaterThanOrEqual(2);
      rig.play('run');
      rig.update(1 / 60);
      rig.dispose();
    }
    expect([...archetypes].sort()).toEqual(['avian', 'biped', 'construct', 'quadruped', 'serpentine', 'swarm']);
  });

  it('preserves low morphology bind heights during the idle loop', () => {
    const serpent = ROSTER.find(({ archetype }) => archetype === 'serpentine');
    expect(serpent).toBeDefined();
    const rig = createFighterRig(serpent!, 'low');
    rig.update(0.45);
    const core = rig.skeleton.getBoneByName('Core');
    expect(core?.position.y).toBeLessThan(0.7);
    rig.dispose();
  });

  it('normalizes and animates the visible img2threejs Nyxalune hero shell', () => {
    const nyxalune = ROSTER[0]!;
    const rig = createFighterRig(nyxalune, 'high');
    const shell = rig.root.getObjectByName('Img2ThreeJsHeroShell');
    expect(shell).toBeDefined();
    const box = new Box3().setFromObject(shell!);
    expect(box.max.y - box.min.y).toBeLessThan(3);
    const runtime = shell!.userData.sculptRuntime as { nodes: Record<string, Object3D> };
    const arm = runtime.nodes['upper-arm-l'];
    expect(arm).toBeDefined();
    const before = arm!.quaternion.clone();
    rig.play('run', false);
    rig.update(0.18);
    expect(arm!.quaternion.angleTo(before)).toBeGreaterThan(0.01);
    rig.dispose();
  });
});
