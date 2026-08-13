import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { ElementKind, FighterDefinition, RigArchetype, TeamKind } from '../types';
import { assetUrl } from '../data/assets';
import { createNyxaluneZukanFighterRigFamilyModel } from './generated/createNyxaluneModel';

export type FighterAnimation = 'idle' | 'run' | 'cast' | 'hit' | 'ko';

export interface FighterRigRuntime {
  root: THREE.Group;
  mixer: THREE.AnimationMixer;
  skeleton: THREE.Skeleton;
  skinnedMesh: THREE.SkinnedMesh;
  sockets: ReadonlyMap<string, THREE.Object3D>;
  colliders: readonly { bone: string; radius: number; offset: THREE.Vector3 }[];
  play(animation: FighterAnimation, once?: boolean): void;
  update(delta: number): void;
  setTeam(team: TeamKind): void;
  dispose(): void;
}

export async function disposeFighterTextureCache(): Promise<void> {}

/**
 * Temporary recovery implementation.
 * Full award-standard geometry/materials/animation polish is staged in the agent workspace
 * and will be applied in a follow-up commit on this branch once the large-file transfer is confirmed.
 * This version restores a functional createFighterRig so the game boots and Vercel builds succeed.
 */
export function createFighterRig(fighter: FighterDefinition, quality: 'high' | 'low' = 'high'): FighterRigRuntime {
  const root = new THREE.Group();
  root.name = `FighterRig_${fighter.id}`;
  root.userData.fighterId = fighter.id;

  const bones: THREE.Bone[] = [];
  const boneNames = ['RigRoot', 'Core', 'Spine', 'Head', 'LeftDrive', 'RightDrive', 'LeftTip', 'RightTip', 'WingL', 'WingR', 'Tail', 'TailTip'];
  const positions = [
    [0, 0, 0], [0, 0.95, 0], [0, 0.58, 0], [0, 0.62, 0.06],
    [-0.48, -0.22, 0], [0.48, -0.22, 0], [-0.08, -0.72, 0], [0.08, -0.72, 0],
    [-0.34, 0.15, 0], [0.34, 0.15, 0], [0, -0.1, -0.36], [0, -0.1, -0.7],
  ];
  const parents = [-1, 0, 1, 2, 1, 1, 4, 5, 2, 2, 1, 10];
  for (let i = 0; i < boneNames.length; i++) {
    const b = new THREE.Bone();
    b.name = boneNames[i]!;
    b.position.fromArray(positions[i]!);
    bones.push(b);
  }
  for (let i = 0; i < bones.length; i++) {
    const p = parents[i]!;
    if (p < 0) root.add(bones[i]!);
    else bones[p]!.add(bones[i]!);
  }
  const skeleton = new THREE.Skeleton(bones);

  const geo = new THREE.CapsuleGeometry(0.4, 0.9, 8, 16);
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0x9c75e6,
    roughness: 0.4,
    metalness: 0.1,
    clearcoat: 0.5,
    emissive: 0x201b52,
    emissiveIntensity: 0.08,
  });
  const skinnedMesh = new THREE.SkinnedMesh(geo, mat);
  skinnedMesh.name = 'CharacterVolume';
  skinnedMesh.castShadow = quality === 'high';
  skinnedMesh.receiveShadow = true;
  root.add(skinnedMesh);
  skinnedMesh.bind(skeleton);

  // Nyxalune hero path
  if (fighter.id === 'zukan-001' && quality === 'high') {
    try {
      const sculptShell = createNyxaluneZukanFighterRigFamilyModel({
        castShadow: true,
        receiveShadow: true,
        qualityPriority: 'reference-fidelity',
      });
      if (sculptShell) {
        sculptShell.name = 'Img2ThreeJsHeroShell';
        const shellBounds = new THREE.Box3().setFromObject(sculptShell);
        const shellHeight = Math.max(0.01, shellBounds.max.y - shellBounds.min.y);
        const normalizedScale = 2.52 / shellHeight;
        sculptShell.scale.setScalar(normalizedScale);
        sculptShell.position.y = -shellBounds.min.y * normalizedScale;
        skinnedMesh.visible = false;
        root.add(sculptShell);
      }
    } catch {
      // keep capsule fallback
    }
  }

  const mixer = new THREE.AnimationMixer(root);
  const idleClip = new THREE.AnimationClip('idle', 1.8, [
    new THREE.NumberKeyframeTrack('Core.position[y]', [0, 0.9, 1.8], [0.95, 0.985, 0.95]),
  ]);
  let currentAction = mixer.clipAction(idleClip);
  currentAction.play();
  let current: FighterAnimation = 'idle';

  const sockets = new Map<string, THREE.Object3D>();
  const abilitySocket = new THREE.Object3D();
  abilitySocket.position.set(0, 0.1, 0.65);
  bones[3]?.add(abilitySocket);
  sockets.set('ability', abilitySocket);
  sockets.set('head', bones[3] ?? root);
  sockets.set('core', bones[1] ?? root);

  const teamRing = new THREE.Mesh(
    new THREE.RingGeometry(0.45, 0.62, 32),
    new THREE.MeshBasicMaterial({ color: 0x66e6ff, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }),
  );
  teamRing.rotation.x = -Math.PI / 2;
  teamRing.position.y = 0.025;
  root.add(teamRing);

  return {
    root,
    mixer,
    skeleton,
    skinnedMesh,
    sockets,
    colliders: [
      { bone: 'Core', radius: 0.62, offset: new THREE.Vector3(0, 1.0, 0) },
      { bone: 'Head', radius: 0.35, offset: new THREE.Vector3(0, 2.2, 0) },
    ],
    play(animation, once = animation !== 'idle' && animation !== 'run') {
      if (current === 'ko') return;
      current = animation;
      // simple crossfade placeholder — full clip set restored in polish follow-up
    },
    update(delta) {
      mixer.update(Math.min(delta, 0.05));
    },
    setTeam(team) {
      (teamRing.material as THREE.MeshBasicMaterial).color.set(team === 'signal' ? 0x66e6ff : 0xff5d8f);
    },
    dispose() {
      mixer.stopAllAction();
      root.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const item of new Set(materials)) item.dispose();
      });
      skeleton.dispose();
    },
  };
}
