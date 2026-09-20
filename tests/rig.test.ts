import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { ROSTER } from '../src/game/data/roster';
import { characterAsset, REQUIRED_ACTIONS } from '../src/game/assets/characterAssets';
import { createFighterRig, rigFromModel, validateCharacterModel } from '../src/game/render/FighterRig';

// Synthetic geometry is confined to tests. It verifies the loader contract,
// never visual acceptance, and is not exported into the shipped application.
function fixture(): GLTF {
  const scene = new THREE.Group();
  const bone = new THREE.Bone(); bone.name = 'RootBone';
  const geo = new THREE.BoxGeometry(1, 2, 0.6);
  const count = geo.getAttribute('position').count;
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4));
  const weights = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) weights[i * 4] = 1;
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial({ map: new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1) }));
  mesh.add(bone); mesh.bind(new THREE.Skeleton([bone])); scene.add(mesh);
  for (const name of ['ability', 'head', 'core']) { const socket = new THREE.Object3D(); socket.name = `socket_${name}`; bone.add(socket); }
  const animations = REQUIRED_ACTIONS.map((name, index) => new THREE.AnimationClip(name, 0.4, [new THREE.NumberKeyframeTrack('RootBone.rotation[z]', [0, 0.2, 0.4], [0, 0.1 * (index + 1), 0])]));
  return { scene, scenes: [scene], animations, cameras: [], asset: { version: '2.0' }, parser: {} as GLTF['parser'], userData: {} };
}

describe('reference character asset contract', () => {
  it('retains all 68 identities and rejects every pending model without a primitive fallback', async () => {
    expect(ROSTER).toHaveLength(68);
    for (const fighter of ROSTER) {
      expect(characterAsset(fighter.id).reference).toBe(`/characters/optimized/${fighter.id}.webp`);
      if (characterAsset(fighter.id).status !== 'approved') await expect(createFighterRig(fighter)).rejects.toThrow('not ready');
    }
  });
  it('rejects the former capsule bug: a mesh without skin weights', () => {
    const gltf = fixture();
    const mesh = validateCharacterModel(gltf, 'fixture');
    mesh.geometry.deleteAttribute('skinWeight');
    expect(() => validateCharacterModel(gltf, 'fixture')).toThrow('Incomplete skin');
  });
  it.each([NaN, -0.1, 0.2])('rejects corrupt weights: %s', (weight) => {
    const gltf = fixture();
    validateCharacterModel(gltf, 'fixture').geometry.getAttribute('skinWeight').setX(0, weight);
    expect(() => validateCharacterModel(gltf, 'fixture')).toThrow();
  });
  it('rejects invalid joint indices, flat images, and missing action clips', () => {
    const joint = fixture(); validateCharacterModel(joint, 'fixture').geometry.getAttribute('skinIndex').setX(0, 999);
    expect(() => validateCharacterModel(joint, 'fixture')).toThrow('Invalid skin joint');
    const flat = fixture(); validateCharacterModel(flat, 'fixture').geometry.scale(1, 1, 0);
    expect(() => validateCharacterModel(flat, 'fixture')).toThrow('volume');
    const clip = fixture(); clip.animations.pop();
    expect(() => validateCharacterModel(clip, 'fixture')).toThrow('Missing animation: ko');
  });
  it('keeps a one-shot cast active despite per-frame locomotion requests and makes KO terminal', () => {
    const rig = rigFromModel(fixture(), 'fixture', 'low');
    rig.play('cast'); rig.play('run', false);
    for (let i = 0; i < 4; i++) rig.update(0.05);
    expect(rig.skeleton.bones[0]!.rotation.z).toBeCloseTo(0.3);
    for (let i = 0; i < 12; i++) rig.update(0.05);
    rig.play('run', false);
    for (let i = 0; i < 4; i++) rig.update(0.05);
    expect(rig.skeleton.bones[0]!.rotation.z).toBeCloseTo(0.2);
    rig.play('ko');
    for (let i = 0; i < 12; i++) rig.update(0.05);
    rig.play('run', false); rig.update(0.05);
    expect(rig.skeleton.bones[0]!.rotation.z).toBeCloseTo(0);
    rig.dispose();
  });
  it('disposes owned model resources exactly once', () => {
    const rig = rigFromModel(fixture(), 'fixture', 'high');
    const dispose = vi.spyOn(rig.skinnedMesh.geometry, 'dispose');
    rig.dispose(); rig.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
